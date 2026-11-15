import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { User } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { requireProjectAdmin, type Queryable } from '../identity/membership.js';
import { lockFlowTicket, type FlowEngine } from './flow-engine.js';

/**
 * Migração final (P11): inventário do estado dos fluxos e adoção explícita, auditada e
 * idempotente dos tickets antigos sem execução. Nunca corre no arranque nem reassocia tickets que
 * já têm execução (cada um mantém a versão em que entrou). Sem ações externas.
 */

/** Ticket aberto sem execução, sem encaminhamento, sem incidente aberto e sem run ativo. */
const candidateFilter = `t.project_id=$1 AND t.status NOT IN ('resolved','cancelled')
  AND NOT EXISTS (SELECT 1 FROM flow_executions e WHERE e.ticket_id=t.id)
  AND NOT EXISTS (SELECT 1 FROM ticket_flow_adoptions a WHERE a.ticket_id=t.id)
  AND NOT EXISTS (SELECT 1 FROM ticket_routing tr WHERE tr.ticket_id=t.id)
  AND NOT EXISTS (SELECT 1 FROM health_incidents h WHERE h.ticket_id=t.id AND h.state<>'closed')
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.ticket_id=t.id AND r.status IN ('queued','running'))`;

export interface AdoptionCandidate {
  ticketId: string;
  key: string;
  status: string;
  version: number;
  origin: string;
  createdAt: string;
}

export interface AdoptionPlan {
  projectId: string;
  candidates: AdoptionCandidate[];
  digest: string;
}

const adoptionInputSchema = z.strictObject({
  projectId: z.uuid(),
  disposition: z.enum(['start', 'exclude']),
  reason: z.string().trim().min(10).max(500),
  expect: z.string().regex(/^[a-f0-9]{64}$/),
  ticketIds: z.array(z.uuid()).max(500).optional(),
});

export interface AdoptionResult {
  ticketId: string;
  key: string;
  outcome: 'started' | 'excluded' | 'skipped';
  reason?: string;
  executionId?: string;
  versionId?: string;
}

const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

async function candidates(db: Queryable, projectId: string): Promise<AdoptionCandidate[]> {
  const rows = (
    await db.query<{
      id: string;
      ticket_key: string;
      status: string;
      version: number;
      origin: string;
      created_at: Date;
    }>(
      `SELECT t.id,t.\`key\` AS ticket_key,t.status,t.version,t.origin,t.created_at FROM tickets t
       WHERE ${candidateFilter} ORDER BY t.created_at,t.id LIMIT 1000`,
      [projectId],
    )
  ).rows;
  return rows.map((row) => ({
    ticketId: row.id,
    key: row.ticket_key || row.id,
    status: row.status,
    version: Number(row.version),
    origin: row.origin,
    createdAt: iso(row.created_at),
  }));
}

/** Hash da seleção: qualquer alteração (ticket novo, estado ou versão) obriga a novo dry-run. */
export function adoptionDigest(projectId: string, selected: AdoptionCandidate[]) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        projectId,
        tickets: selected.map((item) => [item.ticketId, item.status, item.version]),
      }),
    )
    .digest('hex');
}

const count = async (db: Queryable, sql: string, values: unknown[]) =>
  Number((await db.query<{ total: number | string }>(sql, values)).rows[0]?.total ?? 0);

const grouped = async (db: Queryable, sql: string, values: unknown[]) =>
  Object.fromEntries(
    (await db.query<{ k: string | number | null; total: number | string }>(sql, values)).rows.map(
      (row) => [String(row.k), Number(row.total)],
    ),
  );

/**
 * P11 — inventário de migração e adoção explícita, auditada e com hash da seleção dos tickets
 * antigos sem execução. Nunca reassocia tickets nem repete efeitos externos.
 */
export class FlowAdoptionService {
  constructor(
    private readonly db: Database,
    private readonly engine: Pick<FlowEngine, 'adoptTicket'>,
  ) {}

  /** Seleção atual (dry-run) e hash a confirmar com `--expect` na aplicação. */
  async plan(actor: User, projectId: string): Promise<AdoptionPlan> {
    await requireProjectAdmin(this.db, actor, projectId);
    const selected = await candidates(this.db, projectId);
    return { projectId, candidates: selected, digest: adoptionDigest(projectId, selected) };
  }

  /**
   * Inventário de migração: versões, execuções, esperas, perguntas, aprovações, jobs e
   * dependências do projeto, com hash para comparar antes/depois de um deploy.
   */
  async inventory(actor: User, projectId: string) {
    await requireProjectAdmin(this.db, actor, projectId);
    const p = [projectId];
    const inventory = {
      projectId,
      tickets: await grouped(
        this.db,
        'SELECT status AS k,COUNT(*) AS total FROM tickets WHERE project_id=$1 GROUP BY status',
        p,
      ),
      ticketsWithoutExecution: await grouped(
        this.db,
        `SELECT t.status AS k,COUNT(*) AS total FROM tickets t WHERE t.project_id=$1
          AND NOT EXISTS (SELECT 1 FROM flow_executions e WHERE e.ticket_id=t.id) GROUP BY t.status`,
        p,
      ),
      adoptionCandidates: (await candidates(this.db, projectId)).length,
      adoptions: await grouped(
        this.db,
        'SELECT disposition AS k,COUNT(*) AS total FROM ticket_flow_adoptions WHERE project_id=$1 GROUP BY disposition',
        p,
      ),
      flowVersions: await grouped(
        this.db,
        `SELECT CONCAT('schema',schema_version,'/runtime',runtime_contract_version) AS k,COUNT(*) AS total
         FROM flow_versions WHERE project_id=$1 GROUP BY schema_version,runtime_contract_version`,
        p,
      ),
      versionsInUse: await count(
        this.db,
        `SELECT COUNT(DISTINCT version_id) AS total FROM flow_executions
         WHERE project_id=$1 AND status IN ('running','waiting')`,
        p,
      ),
      executions: await grouped(
        this.db,
        'SELECT status AS k,COUNT(*) AS total FROM flow_executions WHERE project_id=$1 GROUP BY status',
        p,
      ),
      suspendedExecutions: await count(
        this.db,
        'SELECT COUNT(*) AS total FROM flow_executions WHERE project_id=$1 AND suspended_at IS NOT NULL',
        p,
      ),
      waitingSteps: await count(
        this.db,
        `SELECT COUNT(*) AS total FROM flow_execution_steps s JOIN flow_executions e ON e.id=s.execution_id
         WHERE e.project_id=$1 AND s.status='waiting'`,
        p,
      ),
      decisions: await count(
        this.db,
        `SELECT COUNT(*) AS total FROM flow_decisions d JOIN flow_execution_steps s ON s.id=d.step_id
         JOIN flow_executions e ON e.id=s.execution_id WHERE e.project_id=$1`,
        p,
      ),
      pendingAnswers: await count(
        this.db,
        `SELECT COUNT(*) AS total FROM agent_run_inputs i JOIN agent_runs r ON r.id=i.run_id
         WHERE r.project_id=$1 AND i.consumed_at IS NULL`,
        p,
      ),
      legacyApprovals: await count(
        this.db,
        `SELECT COUNT(*) AS total FROM approvals a JOIN tickets t ON t.id=a.ticket_id WHERE t.project_id=$1`,
        p,
      ),
      reviewDecisions: await count(
        this.db,
        `SELECT COUNT(*) AS total FROM development_review_decisions d
         JOIN development_workspaces w ON w.id=d.workspace_id WHERE w.project_id=$1`,
        p,
      ),
      agentRuns: await grouped(
        this.db,
        'SELECT status AS k,COUNT(*) AS total FROM agent_runs WHERE project_id=$1 GROUP BY status',
        p,
      ),
      activeJobs: await count(this.db, 'SELECT COUNT(*) AS total FROM zeroops_active_jobs', []),
      deliveries: await grouped(
        this.db,
        'SELECT state AS k,COUNT(*) AS total FROM delivery_runs WHERE project_id=$1 GROUP BY state',
        p,
      ),
      interventions: await grouped(
        this.db,
        'SELECT status AS k,COUNT(*) AS total FROM incident_interventions WHERE project_id=$1 GROUP BY status',
        p,
      ),
      capabilityDevelopments: await grouped(
        this.db,
        'SELECT state AS k,COUNT(*) AS total FROM capability_developments WHERE project_id=$1 GROUP BY state',
        p,
      ),
      // Associação ticket→versão: alterar qualquer uma muda este hash.
      executionBindingsHash: createHash('sha256')
        .update(
          JSON.stringify(
            (
              await this.db.query<{ ticket_id: string; version_id: string }>(
                'SELECT ticket_id,version_id FROM flow_executions WHERE project_id=$1 ORDER BY ticket_id',
                p,
              )
            ).rows.map((row) => [row.ticket_id, row.version_id]),
          ),
        )
        .digest('hex'),
    };
    return inventory;
  }

  /**
   * Aplica a disposição aos tickets da seleção confirmada. Cada ticket numa transação curta:
   * revalida a elegibilidade com o ticket bloqueado e regista uma única adoção (PK por ticket).
   */
  async apply(actor: User, raw: unknown) {
    const input = adoptionInputSchema.parse(raw);
    const admin = await requireProjectAdmin(this.db, actor, input.projectId);
    const selected = await candidates(this.db, input.projectId);
    const digest = adoptionDigest(input.projectId, selected);
    if (digest !== input.expect)
      throw new DomainError(
        'STALE_SELECTION',
        'A seleção mudou desde o dry-run. Repita o dry-run e confirme o novo hash.',
        409,
      );
    const wanted = input.ticketIds ? new Set(input.ticketIds) : null;
    if (wanted && [...wanted].some((id) => !selected.some((item) => item.ticketId === id)))
      throw new DomainError('INVALID_INPUT', 'Há tickets fora da seleção confirmada.', 400);
    const results: AdoptionResult[] = [];
    for (const candidate of selected.filter((item) => !wanted || wanted.has(item.ticketId)))
      results.push(
        await this.db.transaction(async (client) => {
          const ticket = await lockFlowTicket(client, candidate.ticketId);
          const still = await count(
            client,
            `SELECT COUNT(*) AS total FROM tickets t WHERE t.id=$2 AND ${candidateFilter}`,
            [input.projectId, candidate.ticketId],
          );
          if (!ticket || !still || Number(ticket.version) !== candidate.version)
            return {
              ticketId: candidate.ticketId,
              key: candidate.key,
              outcome: 'skipped',
              reason: 'changed',
            };
          let execution: { id: string; flow_id: string; version_id: string } | null = null;
          if (input.disposition === 'start') {
            execution = await this.engine.adoptTicket(client, ticket);
            if (!execution)
              return {
                ticketId: candidate.ticketId,
                key: candidate.key,
                outcome: 'skipped',
                reason: 'no_active_flow_or_paused',
              };
          }
          await client.query(
            `INSERT INTO ticket_flow_adoptions
             (ticket_id,project_id,disposition,flow_id,version_id,execution_id,selection_digest,actor_id,reason)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              candidate.ticketId,
              input.projectId,
              input.disposition,
              execution?.flow_id ?? null,
              execution?.version_id ?? null,
              execution?.id ?? null,
              digest,
              admin.id,
              input.reason,
            ],
          );
          await client.query(
            `INSERT INTO audit_events(id,actor_id,ticket_id,action,details)
             VALUES($1,$2,$3,'ticket.flow_adoption',$4)`,
            [
              randomUUID(),
              admin.id,
              candidate.ticketId,
              JSON.stringify({
                disposition: input.disposition,
                reason: input.reason,
                selectionDigest: digest,
                previousStatus: candidate.status,
                executionId: execution?.id ?? null,
                versionId: execution?.version_id ?? null,
              }),
            ],
          );
          return execution
            ? {
                ticketId: candidate.ticketId,
                key: candidate.key,
                outcome: 'started',
                executionId: execution.id,
                versionId: execution.version_id,
              }
            : { ticketId: candidate.ticketId, key: candidate.key, outcome: 'excluded' };
        }),
      );
    return { projectId: input.projectId, digest, disposition: input.disposition, results };
  }
}
