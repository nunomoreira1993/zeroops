import { randomBytes, randomUUID } from 'node:crypto';
import { ticketWorkPaused } from '../tickets/ticket-purge-health.js';
import { z } from 'zod';
import type {
  AgentEvidence,
  AgentQuestion,
  AgentQuota,
  AgentRun,
  AgentRunStatus,
  AgentRunTrigger,
  AgentToolCall,
  AgentUsage,
  User,
  AgentExecutionMode,
  AgentFusionTier,
} from '../../../../contracts/src/index.js';
import type {
  AgentProfileRunSnapshot,
  RepositoryResourceSnapshot,
} from '../../../../contracts/src/agent-profiles.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { connectorTokenHash } from '../../security/connector-token.js';
import { requireMember, type Queryable } from '../identity/membership.js';
import { findTicket, validateTicketId } from '../tickets/tickets.queries.js';
import { pendingQuestions, runUsage } from './agent-run-events.service.js';
import { currentAgentInstructions } from './agent-instructions.service.js';
import { publishClientQuestions } from './agent-client-channel.js';
import { AgentModelsService } from './agent-models.service.js';
import { skillVersionFiles } from './capability-catalog.js';
import type { CapabilityRunManifest } from '../../../../contracts/src/capabilities.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  LOCAL_WORKER,
  OWNED_BY,
  recordJobEvent,
  validateWorker,
  type FencedOutcome,
  type HeartbeatState,
  type JobEventType,
  type JobLease,
  type WorkerIdentity,
} from './job-leases.js';

export type { AgentEvidence, AgentRun, AgentRunStatus, AgentToolCall };

/** Limite inicial conservador de runs simultâneos por projeto (todos os executores). */
export const DEFAULT_PROJECT_RUN_LIMIT = 2;

/** Contexto genérico entregue ao agente: o pedido e a conversa, sem lógica por tipo de ticket. */
export interface InvestigationContext {
  runId: string;
  /** Posse da tentativa: todas as escritas do executor apresentam este lease. */
  lease: JobLease;
  /** Número da tentativa (1 na primeira execução, >1 após recuperação de um lease expirado). */
  attempt: number;
  /** `implement`: o Copilot propõe uma alteração (diff) sem a publicar. */
  mode: 'investigate' | 'implement';
  /** Projeto do ticket; define as integrações (conectores, Copilot) usadas no run. */
  projectId: string;
  /** Token dos conectores, válido apenas enquanto o run estiver em execução. */
  connectorToken: string;
  /** Projeto e site (plataforma) do ticket: escolhem o código-fonte e o contexto do prompt. */
  project: { name: string; siteKey: string | null };
  ticket: {
    key: string;
    title: string;
    description: string;
    category: string;
    environment: string;
    priority: string;
    status: string;
  };
  instructions: string | null;
  /** Modelo e esforço escolhidos ao pedir o run; `null` usa o modelo da integração. */
  model: string | null;
  reasoningEffort: string | null;
  executionMode?: AgentExecutionMode;
  fusionTier?: AgentFusionTier | null;
  agentProfile?: AgentProfileRunSnapshot | null;
  repositorySnapshotHash?: string | null;
  repositoryResources?: RepositoryResourceSnapshot[];
  allowedTools?: string[] | null;
  /**
   * Skills e especialistas fixados no run (P04) e o conteúdo das versões de skill; o executor
   * verifica os hashes antes de os materializar. `null`/ausente em runs sem capacidades.
   */
  capabilities?: {
    manifest: CapabilityRunManifest;
    files: Record<string, { path: string; content: string; sha256: string }[]>;
  } | null;
  effectiveTools?: string[] | null;
  /** Workspace Git persistente (etapa de desenvolvimento com repositório, P08). */
  developmentWorkspaceId?: string | null;
  /** Instruções do projeto (ambientes, fontes, regras), editáveis em Integrações > Agente. */
  projectInstructions: string;
  conversation: {
    author: string;
    role: string;
    visibility: 'public' | 'internal';
    automated: boolean;
    body: string;
    createdAt: string;
  }[];
}

export interface InvestigationResult {
  summary: string;
  replyDraft: string | null;
  evidence: AgentEvidence[];
  /** Perguntas ao cliente; enviadas automaticamente se o projeto o permitir. */
  clientQuestions?: string[];
  /** Proposta de alteração em formato unified diff (modo `implement`). */
  patch?: string | null;
  proposedTests?: string[];
}

interface AgentRunRow {
  id: string;
  ticket_id: string;
  status: AgentRunStatus;
  run_trigger: AgentRunTrigger;
  instructions: string | null;
  progress: string | null;
  summary: string | null;
  reply_draft: string | null;
  client_questions: string[] | null;
  client_message_id: string | null;
  evidence: AgentEvidence[] | null;
  error_code: string | null;
  cancel_requested: boolean;
  requested_by: string;
  requester_name: string;
  requester_avatar_version: number | null;
  model: string | null;
  reasoning_effort: string | null;
  execution_mode: AgentExecutionMode;
  fusion_tier: AgentFusionTier | null;
  agent_profile_id: string | null;
  agent_profile_version: number | null;
  agent_profile_snapshot: AgentProfileRunSnapshot | null;
  repository_snapshot_hash: string | null;
  repository_resources: RepositoryResourceSnapshot[] | null;
  allowed_tools: string[] | null;
  capability_manifest?: CapabilityRunManifest | null;
  capability_manifest_hash?: string | null;
  effective_tools: string[] | null;
  effective_model: string | null;
  attempt?: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const requestSchema = z.strictObject({
  instructions: z.string().trim().max(4000).optional(),
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{1,100}$/)
    .nullish(),
  reasoningEffort: z
    .string()
    .trim()
    .regex(/^[a-z]{1,20}$/)
    .nullish(),
  executionMode: z.enum(['copilot', 'local']).optional(),
  fusionTier: z.enum(['standard', 'high', 'max']).nullish(),
});

const runColumns =
  'r.*, u.display_name AS requester_name, u.avatar_version AS requester_avatar_version';
const COMMENT_LIMIT = 20000;

function toRun(
  row: AgentRunRow,
  toolCalls: AgentToolCall[] = [],
  pendingQuestion: AgentQuestion | null = null,
  consumption: { usage: AgentUsage | null; quota: AgentQuota | null } = {
    usage: null,
    quota: null,
  },
): AgentRun {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    status: row.status,
    trigger: row.run_trigger,
    instructions: row.instructions,
    progress: row.progress,
    summary: row.summary,
    replyDraft: row.reply_draft,
    clientQuestions: row.client_questions ?? [],
    clientMessageId: row.client_message_id,
    evidence: row.evidence ?? [],
    toolCalls,
    errorCode: row.error_code,
    cancelRequested: row.cancel_requested,
    pendingQuestion,
    usage: consumption.usage,
    quota: consumption.quota,
    model: row.model ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
    executionMode: row.execution_mode ?? 'copilot',
    fusionTier: row.fusion_tier ?? null,
    agentProfile:
      row.agent_profile_id && row.agent_profile_version && row.agent_profile_snapshot
        ? {
            id: row.agent_profile_id,
            version: Number(row.agent_profile_version),
            name: row.agent_profile_snapshot.definition.name,
          }
        : null,
    repositorySnapshotHash: row.repository_snapshot_hash ?? null,
    repositoryResources: (row.repository_resources ?? []).map(
      ({ path, kind, required, sha256, status, selectionReason }) => ({
        path,
        kind,
        required,
        sha256,
        status,
        selectionReason,
      }),
    ),
    allowedTools: row.allowed_tools ?? null,
    capabilities: row.capability_manifest
      ? {
          manifestHash: row.capability_manifest_hash ?? null,
          skills: row.capability_manifest.skills.map(({ name, version, bundleHash }) => ({
            name,
            version,
            bundleHash,
          })),
          specialists: row.capability_manifest.delegates.map(({ name, displayName, version }) => ({
            name,
            displayName,
            version,
          })),
          maxConcurrency: row.capability_manifest.delegation.maxConcurrency,
        }
      : null,
    effectiveTools: row.effective_tools ?? null,
    effectiveModel: row.effective_model ?? null,
    attempt: Number(row.attempt ?? 0),
    requestedBy: {
      id: row.requested_by,
      displayName: row.requester_name,
      avatarVersion: row.requester_avatar_version ?? null,
    },
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function clip(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

async function requireTeam(db: Queryable, actor: User) {
  const member = await requireMember(db, actor, true);
  if (member.role === 'client')
    throw new DomainError('FORBIDDEN', 'A investigação do agente é reservada à equipa.', 403);
  return member;
}

async function audit(
  db: Queryable,
  actorId: string | null,
  ticketId: string,
  action: string,
  details: object,
) {
  await db.query(
    'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), actorId, ticketId, action, details],
  );
}

export interface FinishedRun {
  id: string;
  ticket_id: string;
  project_id: string;
  run_trigger: AgentRunTrigger;
}

type RunningRow = FinishedRun & {
  requested_by: string;
  cancel_requested: boolean;
  client_questions_allowed: boolean;
  flow_step_id?: string | null;
  worker_id?: string | null;
  lease_epoch?: number;
  attempt?: number;
};

/** Reação ao fim de um run, na mesma transação (ex.: fecho do incidente da Saúde). */
export type RunFinishedHook = (
  client: Queryable,
  run: FinishedRun,
  outcome: 'succeeded' | 'failed' | 'cancelled',
) => Promise<void>;

/**
 * Ciclo de vida das execuções do agente: pedido pela equipa, processado pelo executor e
 * concluído com uma nota interna e um rascunho de resposta que só um humano pode enviar.
 */
export class AgentRunsService {
  private readonly models: AgentModelsService;

  constructor(
    private readonly db: Database,
    private readonly finishedHooks: RunFinishedHook[] = [],
  ) {
    this.models = new AgentModelsService(db);
  }

  private async notifyFinished(
    client: Queryable,
    run: FinishedRun,
    outcome: 'succeeded' | 'failed' | 'cancelled',
  ) {
    for (const hook of this.finishedHooks) await hook(client, run, outcome);
  }

  /** Enfileira uma investigação para um membro da equipa, impedindo dois runs ativos no ticket. */
  async request(actor: User, ticketId: string, input: unknown): Promise<AgentRun> {
    const data = requestSchema.parse(input ?? {});
    return this.db.transaction(async (client) => {
      const member = await requireTeam(client, actor);
      if (await ticketWorkPaused(client, member.projectId))
        throw new DomainError('TICKET_WORK_PAUSED', 'Tickets temporariamente em manutenção.', 409);
      const ticket = await findTicket(client, actor, ticketId, true);
      if (['resolved', 'cancelled'].includes(ticket.status))
        throw new DomainError('TICKET_CLOSED', 'O pedido está fechado.', 409);
      const active = await client.query(
        "SELECT id FROM agent_runs WHERE ticket_id=$1 AND status IN ('queued','running') FOR UPDATE",
        [ticket.id],
      );
      if (active.rowCount)
        throw new DomainError('AGENT_RUN_ACTIVE', 'Já existe uma investigação em curso.', 409);
      const model = data.model || null;
      const effort = data.reasoningEffort || null;
      const executionMode = data.executionMode ?? 'copilot';
      const fusionTier = data.fusionTier ?? null;
      await this.models.validate(
        client,
        ticket.project_id,
        model,
        effort,
        executionMode,
        fusionTier,
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO agent_runs(id,ticket_id,project_id,requested_by,instructions,ticket_version,
           model,reasoning_effort,execution_mode,fusion_tier)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          ticket.id,
          ticket.project_id,
          member.id,
          data.instructions || null,
          ticket.version,
          model,
          effort,
          executionMode,
          fusionTier,
        ],
      );
      await audit(client, member.id, ticket.id, 'agent.run_requested', {
        runId: id,
        ...(model && { model }),
        ...(effort && { reasoningEffort: effort }),
        executionMode,
        fusionTier,
      });
      return this.find(client, id);
    });
  }

  /** Lista os runs recentes e as chamadas de conector auditadas para a equipa do projeto. */
  async list(actor: User, ticketId: string): Promise<AgentRun[]> {
    await requireTeam(this.db, actor);
    const ticket = await findTicket(this.db, actor, ticketId);
    const result = await this.db.query<AgentRunRow>(
      `SELECT ${runColumns} FROM agent_runs r JOIN users u ON u.id=r.requested_by
       WHERE r.ticket_id=$1 ORDER BY r.created_at DESC LIMIT 20`,
      [ticket.id],
    );
    if (!result.rowCount) return [];
    const calls = await this.db.query<{
      run_id: string;
      tool: string;
      environment: AgentToolCall['environment'];
      request: string;
      outcome: AgentToolCall['outcome'];
      row_count: number | null;
      duration_ms: number;
      error_code: string | null;
      created_at: Date;
    }>(
      `SELECT c.* FROM agent_run_tool_calls c JOIN agent_runs r ON r.id=c.run_id
       WHERE r.ticket_id=$1 ORDER BY c.created_at`,
      [ticket.id],
    );
    const byRun = new Map<string, AgentToolCall[]>();
    for (const call of calls.rows) {
      const list = byRun.get(call.run_id) ?? [];
      if (list.length < 100)
        list.push({
          tool: call.tool,
          environment: call.environment,
          request: call.request,
          outcome: call.outcome,
          rowCount: call.row_count,
          durationMs: call.duration_ms,
          errorCode: call.error_code,
          createdAt: call.created_at.toISOString(),
        });
      byRun.set(call.run_id, list);
    }
    const questions = await pendingQuestions(
      this.db,
      result.rows.filter((row) => row.status === 'running').map((row) => row.id),
    );
    const usage = await runUsage(
      this.db,
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) =>
      toRun(row, byRun.get(row.id), questions.get(row.id) ?? null, usage.get(row.id)),
    );
  }

  /** Cancela um run em fila ou sinaliza o executor para cancelar um run ativo. */
  async cancel(actor: User, ticketId: string, runId: string): Promise<AgentRun> {
    validateTicketId(runId);
    return this.db.transaction(async (client) => {
      const member = await requireTeam(client, actor);
      const ticket = await findTicket(client, actor, ticketId);
      const run = (
        await client.query<
          FinishedRun & {
            status: AgentRunStatus;
            worker_id: string | null;
            lease_epoch: number;
            attempt: number;
          }
        >(
          'SELECT id,ticket_id,project_id,run_trigger,status,worker_id,lease_epoch,attempt FROM agent_runs WHERE id=$1 AND ticket_id=$2 FOR UPDATE',
          [runId, ticket.id],
        )
      ).rows[0];
      if (!run) throw new DomainError('AGENT_RUN_NOT_FOUND', 'Execução não encontrada.', 404);
      if (run.status === 'queued') {
        await client.query(
          "UPDATE agent_runs SET status='cancelled', finished_at=NOW(3) WHERE id=$1",
          [runId],
        );
        await this.notifyFinished(client, run, 'cancelled');
      } else if (run.status === 'running') {
        await client.query('UPDATE agent_runs SET cancel_requested=1 WHERE id=$1', [runId]);
        await this.event(client, run, 'cancel_requested', { actorId: member.id });
      } else throw new DomainError('AGENT_RUN_FINISHED', 'A execução já terminou.', 409);
      await audit(client, member.id, ticket.id, 'agent.run_cancel_requested', { runId });
      return this.find(client, runId);
    });
  }

  /**
   * Reclama atomicamente o run mais antigo em fila para `worker`. O claim só é aceite se o run
   * continuar `queued` no `UPDATE` (dois executores nunca recebem a mesma tentativa), respeita a
   * manutenção do projeto e o limite de runs simultâneos por projeto, e incrementa a época do lease.
   * Não usa `SKIP LOCKED` (MariaDB 10.3); os candidatos são lidos sem bloqueio e confirmados no `UPDATE`.
   */
  async claimNext(
    worker: WorkerIdentity = LOCAL_WORKER,
    limits: { perProject?: number } = {},
  ): Promise<InvestigationContext | null> {
    validateWorker(worker);
    const perProject = Math.max(1, limits.perProject ?? DEFAULT_PROJECT_RUN_LIMIT);
    const candidates = await this.db.query<{ id: string; project_id: string }>(
      `SELECT r.id, r.project_id FROM agent_runs r
       WHERE r.status='queued'
         AND NOT EXISTS(SELECT 1 FROM ticket_purge_maintenance p WHERE p.project_id=r.project_id AND p.lease_until>NOW(3))
         AND (SELECT COUNT(*) FROM agent_runs c WHERE c.project_id=r.project_id AND c.status='running') < $1
       ORDER BY r.created_at LIMIT 10`,
      [perProject],
    );
    for (const candidate of candidates.rows) {
      const context = await this.tryClaim(candidate, worker, perProject);
      if (context) return context;
    }
    return null;
  }

  private async tryClaim(
    candidate: { id: string; project_id: string },
    worker: WorkerIdentity,
    perProject: number,
  ): Promise<InvestigationContext | null> {
    return this.db.transaction(async (client) => {
      // Mesma ordem de bloqueio que a suspensão da Saúde (projeto antes dos runs).
      await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [candidate.project_id]);
      if (await ticketWorkPaused(client, candidate.project_id)) return null;
      const running = await client.query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM agent_runs WHERE project_id=$1 AND status='running' LOCK IN SHARE MODE",
        [candidate.project_id],
      );
      if (Number(running.rows[0]?.total ?? 0) >= perProject) return null;
      const connectorToken = randomBytes(32).toString('base64url');
      const claimed = await client.query(
        `UPDATE agent_runs SET status='running', worker_id=$2, lease_epoch=lease_epoch+1,
           attempt=attempt+1, lease_until=TIMESTAMPADD(SECOND,$3,NOW(3)), heartbeat_at=NOW(3),
           started_at=COALESCE(started_at,NOW(3)), progress='A preparar contexto',
           connector_token_hash=$4
         WHERE id=$1 AND status='queued'`,
        [candidate.id, worker.workerId, worker.leaseSeconds, connectorTokenHash(connectorToken)],
      );
      if (!claimed.rowCount) return null;
      const run = (
        await client.query<{
          id: string;
          ticket_id: string;
          project_id: string;
          flow_step_id: string | null;
          lease_epoch: number;
          attempt: number;
          instructions: string | null;
          model: string | null;
          reasoning_effort: string | null;
          execution_mode: AgentExecutionMode;
          fusion_tier: AgentFusionTier | null;
          mode: 'investigate' | 'implement';
          agent_profile_snapshot: AgentProfileRunSnapshot | null;
          repository_snapshot_hash: string | null;
          repository_resources: RepositoryResourceSnapshot[] | null;
          allowed_tools: string[] | null;
          capability_manifest: CapabilityRunManifest | null;
          development_workspace_id: string | null;
        }>(
          'SELECT id,ticket_id,project_id,flow_step_id,lease_epoch,attempt,instructions,model,reasoning_effort,execution_mode,fusion_tier,mode,agent_profile_snapshot,repository_snapshot_hash,repository_resources,allowed_tools,capability_manifest,development_workspace_id FROM agent_runs WHERE id=$1',
          [candidate.id],
        )
      ).rows[0];
      if (!run) throw new Error('Run reclamado inexistente.');
      const lease: JobLease = {
        jobId: run.id,
        workerId: worker.workerId,
        epoch: Number(run.lease_epoch),
        leaseSeconds: worker.leaseSeconds,
      };
      await recordJobEvent(client, {
        kind: 'agent_run',
        jobId: run.id,
        projectId: run.project_id,
        ticketId: run.ticket_id,
        flowStepId: run.flow_step_id,
        attempt: Number(run.attempt),
        epoch: lease.epoch,
        workerId: worker.workerId,
        type: 'claimed',
        details: { leaseSeconds: worker.leaseSeconds },
      });
      const ticket = (
        await client.query<InvestigationContext['ticket']>(
          'SELECT `key`,title,description,category,environment,priority,status FROM tickets WHERE id=$1',
          [run.ticket_id],
        )
      ).rows[0];
      if (!ticket) throw new Error('Ticket do run inexistente.');
      const project = (
        await client.query<InvestigationContext['project']>(
          'SELECT name, site_key AS "siteKey" FROM projects WHERE id=$1',
          [run.project_id],
        )
      ).rows[0] ?? { name: 'Projeto', siteKey: null };
      const comments = await client.query<{
        author: string;
        role: string;
        visibility: 'public' | 'internal';
        automated: boolean;
        body: string;
        created_at: Date;
      }>(
        `SELECT u.display_name AS author, COALESCE(m.role,u.role) AS role, c.visibility,
                c.automated, c.body, c.created_at
         FROM ticket_comments c
         JOIN tickets t ON t.id=c.ticket_id
         JOIN users u ON u.id=c.author_id
         LEFT JOIN project_memberships m ON m.user_id=u.id AND m.project_id=t.project_id
         WHERE c.ticket_id=$1 ORDER BY c.created_at`,
        [run.ticket_id],
      );
      return {
        runId: run.id,
        lease,
        attempt: Number(run.attempt),
        mode: run.mode === 'implement' ? 'implement' : 'investigate',
        projectId: run.project_id,
        connectorToken,
        project,
        ticket,
        instructions: run.instructions,
        model: run.model,
        reasoningEffort: run.reasoning_effort,
        executionMode: run.execution_mode ?? 'copilot',
        fusionTier: run.fusion_tier ?? null,
        agentProfile: run.agent_profile_snapshot ?? null,
        repositorySnapshotHash: run.repository_snapshot_hash ?? null,
        repositoryResources: run.repository_resources ?? [],
        allowedTools: run.allowed_tools ?? null,
        developmentWorkspaceId: run.development_workspace_id ?? null,
        capabilities: run.capability_manifest
          ? {
              manifest: run.capability_manifest,
              files: Object.fromEntries(
                await skillVersionFiles(
                  client,
                  run.project_id,
                  run.capability_manifest.skills.map((skill) => skill.versionId),
                ),
              ),
            }
          : null,
        projectInstructions: await currentAgentInstructions(client, run.project_id),
        conversation: comments.rows.map((row) => ({
          author: row.author,
          role: row.role,
          visibility: row.visibility,
          automated: row.automated,
          body: row.body,
          createdAt: row.created_at.toISOString(),
        })),
      };
    });
  }

  /**
   * Renova o lease da tentativa. Devolve `owned=false` se a posse se perdeu (lease expirado,
   * recuperado por outro executor ou run terminado): o executor tem de parar sem novos efeitos.
   */
  async heartbeat(lease: JobLease): Promise<HeartbeatState> {
    const renewed = await this.db.query(
      `UPDATE agent_runs SET lease_until=TIMESTAMPADD(SECOND,$4,NOW(3)), heartbeat_at=NOW(3)
       WHERE ${OWNED_BY()}`,
      [lease.jobId, lease.workerId, lease.epoch, lease.leaseSeconds],
    );
    if (!renewed.rowCount) {
      await this.rejectStale(this.db, lease, 'lease_lost');
      return { owned: false, cancelRequested: true };
    }
    return { owned: true, cancelRequested: await this.isCancelRequested(lease.jobId) };
  }

  /** Indica se a tentativa ainda detém um lease válido (usado antes de efeitos externos). */
  async ownsLease(lease: JobLease) {
    const result = await this.db.query(`SELECT id FROM agent_runs WHERE ${OWNED_BY()}`, [
      lease.jobId,
      lease.workerId,
      lease.epoch,
    ]);
    return Boolean(result.rowCount);
  }

  /** Atualiza o progresso visível do run, apenas pela tentativa que detém o lease. */
  async reportProgress(lease: JobLease, progress: string) {
    const result = await this.db.query(`UPDATE agent_runs SET progress=$4 WHERE ${OWNED_BY()}`, [
      lease.jobId,
      lease.workerId,
      lease.epoch,
      clip(progress, 200),
    ]);
    return Boolean(result.rowCount);
  }

  /** Regista as ferramentas realmente disponibilizadas após intersectar perfil e conectores ativos. */
  async recordEffectiveTools(lease: JobLease, tools: string[]) {
    const result = await this.db.query(
      `UPDATE agent_runs SET effective_tools=$4 WHERE ${OWNED_BY()}`,
      [lease.jobId, lease.workerId, lease.epoch, JSON.stringify([...new Set(tools)].slice(0, 16))],
    );
    return Boolean(result.rowCount);
  }

  /** Indica se foi pedido o cancelamento do run. */
  async isCancelRequested(runId: string) {
    const result = await this.db.query<{ cancel_requested: boolean }>(
      'SELECT cancel_requested FROM agent_runs WHERE id=$1',
      [runId],
    );
    return Boolean(result.rows[0]?.cancel_requested);
  }

  /**
   * Guarda o resultado; a nota interna fica na conversa, a resposta ao cliente fica em rascunho.
   * Só a tentativa com o lease atual conclui; a repetição da mesma conclusão é `duplicate` e uma
   * tentativa antiga é `stale`, sem efeitos.
   */
  async complete(lease: JobLease, result: InvestigationResult): Promise<FencedOutcome> {
    return this.db.transaction(async (client) => {
      // Mesma ordem de bloqueio que a resposta do cliente (ticket antes do run).
      const owner = (
        await client.query<{ ticket_id: string }>('SELECT ticket_id FROM agent_runs WHERE id=$1', [
          lease.jobId,
        ])
      ).rows[0];
      if (owner)
        await client.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE', [owner.ticket_id]);
      const run = await this.lockOwned(client, lease);
      if (!run) return this.rejectStale(client, lease, 'stale_attempt_rejected', 'succeeded');
      if (run.cancel_requested) {
        await this.finish(client, run, 'cancelled', null);
        return 'accepted';
      }
      const runId = run.id;
      // A análise pós-incidente e as etapas do fluxo sem perguntas nunca perguntam ao cliente.
      const questions =
        run.run_trigger === 'incident_review' || !run.client_questions_allowed
          ? []
          : (result.clientQuestions ?? []);
      const clientMessageId = await publishClientQuestions(client, run, questions);
      await client.query(
        `UPDATE agent_runs SET status='succeeded', finished_at=NOW(3), progress=NULL,
           connector_token_hash=NULL, lease_until=NULL, summary=$2, reply_draft=$3, evidence=$4,
           client_questions=$5, client_message_id=$6, patch=$7, proposed_tests=$8 WHERE id=$1`,
        [
          runId,
          result.summary,
          result.replyDraft,
          JSON.stringify(result.evidence),
          questions.length ? JSON.stringify(questions) : null,
          clientMessageId,
          result.patch ?? null,
          result.proposedTests?.length ? JSON.stringify(result.proposedTests) : null,
        ],
      );
      const evidence = result.evidence.length
        ? `\n\n**Evidências**\n${result.evidence.map((item) => `- ${item.source}: ${item.detail}`).join('\n')}`
        : '';
      const asked = questions.length
        ? `\n\n**Perguntas ao cliente** (${clientMessageId ? 'enviadas automaticamente' : 'por enviar: reveja e envie no separador Cliente'})\n${questions.map((item) => `- ${item}`).join('\n')}`
        : '';
      await client.query(
        `INSERT INTO ticket_comments(id,ticket_id,author_id,visibility,body,automated,author_kind,
           agent_run_id)
         VALUES($1,$2,$3,'internal',$4,1,'agent',$5)`,
        [
          randomUUID(),
          run.ticket_id,
          run.requested_by,
          clip(`**Investigação Copilot**\n\n${result.summary}${evidence}${asked}`, COMMENT_LIMIT),
          runId,
        ],
      );
      await audit(client, null, run.ticket_id, 'agent.run_succeeded', {
        runId,
        clientQuestions: questions.length,
        sentToClient: Boolean(clientMessageId),
      });
      await this.event(client, run, 'completed');
      await this.notifyFinished(client, run, 'succeeded');
      return 'accepted';
    });
  }

  /** Regista falha ou cancelamento apenas pela tentativa que detém o lease. */
  async fail(lease: JobLease, errorCode: string): Promise<FencedOutcome> {
    return this.db.transaction(async (client) => {
      const run = await this.lockOwned(client, lease);
      if (!run) return this.rejectStale(client, lease, 'stale_attempt_rejected', 'failed');
      await this.finish(client, run, run.cancel_requested ? 'cancelled' : 'failed', errorCode);
      return 'accepted';
    });
  }

  /**
   * Devolve a tentativa à fila sem a contar como falhada (paragem ordenada do executor). Os runs
   * só produzem efeitos externos na conclusão transacional, por isso a repetição é segura.
   */
  async release(lease: JobLease, reason = 'shutdown'): Promise<FencedOutcome> {
    return this.db.transaction(async (client) => {
      const run = await this.lockOwned(client, lease);
      if (!run) return this.rejectStale(client, lease, 'stale_attempt_rejected');
      if (run.cancel_requested) {
        await this.finish(client, run, 'cancelled', null);
        return 'accepted';
      }
      await client.query(
        `UPDATE agent_runs SET status='queued', worker_id=NULL, lease_until=NULL, heartbeat_at=NULL,
           connector_token_hash=NULL, attempt=GREATEST(attempt-1,0), progress='Em fila (retomado)'
         WHERE id=$1`,
        [run.id],
      );
      await this.event(client, run, 'released', { reason });
      return 'accepted';
    });
  }

  /**
   * Reconciliação por lease (substitui a falha global no arranque): só toca em runs `running` com
   * lease expirado ou sem lease (legado). Cancelados terminam; com tentativas disponíveis voltam à
   * fila com nova época; esgotadas falham com `lease_expired`. Jobs vivos de outros executores não
   * são afetados.
   */
  async recoverExpired(maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    const outcome = { requeued: 0, failed: 0, cancelled: 0 };
    const expired = await this.db.query<{ id: string; ticket_id: string }>(
      "SELECT id,ticket_id FROM agent_runs WHERE status='running' AND (lease_until IS NULL OR lease_until<=NOW(3)) ORDER BY started_at LIMIT 50",
    );
    for (const candidate of expired.rows) {
      await this.db.transaction(async (client) => {
        await client.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE', [candidate.ticket_id]);
        const run = (
          await client.query<
            RunningRow & { worker_id: string | null; lease_epoch: number; attempt: number }
          >(
            `SELECT id,ticket_id,project_id,run_trigger,requested_by,cancel_requested,client_questions_allowed,
                    flow_step_id,worker_id,lease_epoch,attempt
             FROM agent_runs WHERE id=$1 AND status='running'
               AND (lease_until IS NULL OR lease_until<=NOW(3)) FOR UPDATE`,
            [candidate.id],
          )
        ).rows[0];
        if (!run) return;
        if (run.cancel_requested) {
          await this.finish(client, run, 'cancelled', null);
          await this.event(client, run, 'lease_expired_cancelled');
          outcome.cancelled += 1;
        } else if (Number(run.attempt) < maxAttempts) {
          await client.query(
            `UPDATE agent_runs SET status='queued', worker_id=NULL, lease_until=NULL, heartbeat_at=NULL,
               connector_token_hash=NULL, progress='Em fila (executor interrompido)' WHERE id=$1`,
            [run.id],
          );
          await this.event(client, run, 'lease_expired_requeued', {
            previousWorker: run.worker_id,
          });
          outcome.requeued += 1;
        } else {
          await this.finish(client, run, 'failed', 'lease_expired');
          await this.event(client, run, 'lease_expired_failed', { previousWorker: run.worker_id });
          outcome.failed += 1;
        }
      });
    }
    return outcome;
  }

  private async lockOwned(client: Queryable, lease: JobLease) {
    const result = await client.query<RunningRow>(
      `SELECT id,ticket_id,project_id,run_trigger,requested_by,cancel_requested,client_questions_allowed,
              flow_step_id,attempt,lease_epoch,worker_id
       FROM agent_runs WHERE ${OWNED_BY()} FOR UPDATE`,
      [lease.jobId, lease.workerId, lease.epoch],
    );
    return result.rows[0];
  }

  /** Regista a rejeição de uma tentativa sem posse; distingue a repetição da conclusão já aceite. */
  private async rejectStale(
    client: Queryable,
    lease: JobLease,
    type: JobEventType,
    terminal?: AgentRunStatus,
  ): Promise<FencedOutcome> {
    const row = (
      await client.query<{
        project_id: string;
        ticket_id: string;
        flow_step_id: string | null;
        status: AgentRunStatus;
        worker_id: string | null;
        lease_epoch: number;
        attempt: number;
      }>(
        'SELECT project_id,ticket_id,flow_step_id,status,worker_id,lease_epoch,attempt FROM agent_runs WHERE id=$1',
        [lease.jobId],
      )
    ).rows[0];
    if (!row) return 'stale';
    if (
      terminal &&
      row.status === terminal &&
      row.worker_id === lease.workerId &&
      Number(row.lease_epoch) === lease.epoch
    )
      return 'duplicate';
    await recordJobEvent(client, {
      kind: 'agent_run',
      jobId: lease.jobId,
      projectId: row.project_id,
      ticketId: row.ticket_id,
      flowStepId: row.flow_step_id,
      attempt: Number(row.attempt),
      epoch: lease.epoch,
      workerId: lease.workerId,
      type,
      details: { currentEpoch: Number(row.lease_epoch), currentStatus: row.status },
    });
    return 'stale';
  }

  private async event(
    client: Queryable,
    run: FinishedRun & {
      flow_step_id?: string | null;
      worker_id?: string | null;
      lease_epoch?: number;
      attempt?: number;
    },
    type: JobEventType,
    details?: Record<string, unknown>,
  ) {
    await recordJobEvent(client, {
      kind: 'agent_run',
      jobId: run.id,
      projectId: run.project_id,
      ticketId: run.ticket_id,
      flowStepId: run.flow_step_id ?? null,
      attempt: Number(run.attempt ?? 0),
      epoch: Number(run.lease_epoch ?? 0),
      workerId: run.worker_id ?? null,
      type,
      details,
    });
  }

  private async finish(
    client: Queryable,
    run: RunningRow,
    status: 'failed' | 'cancelled',
    errorCode: string | null,
  ) {
    await client.query(
      'UPDATE agent_runs SET status=$2, error_code=$3, finished_at=NOW(3), progress=NULL, connector_token_hash=NULL, lease_until=NULL WHERE id=$1',
      [run.id, status, errorCode],
    );
    await audit(client, null, run.ticket_id, `agent.run_${status}`, { runId: run.id, errorCode });
    if (status === 'failed' && errorCode !== 'lease_expired')
      await this.event(client, run, 'failed', { errorCode });
    await this.notifyFinished(client, run, status);
  }

  private async find(client: Queryable, id: string) {
    const result = await client.query<AgentRunRow>(
      `SELECT ${runColumns} FROM agent_runs r JOIN users u ON u.id=r.requested_by WHERE r.id=$1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('AGENT_RUN_NOT_FOUND', 'Execução não encontrada.', 404);
    return toRun(row);
  }
}
