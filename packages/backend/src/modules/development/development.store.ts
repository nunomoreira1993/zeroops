import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEVELOPMENT_BRANCH_PREFIX,
  developmentScopeInput,
  flowReviewConfig,
  type DevelopmentCommand,
  type DevelopmentFileChange,
  type DevelopmentPublishMode,
  type DeliveryRunView,
  type DevelopmentWorkspaceView,
  type FlowReviewConfig,
  type TicketDevelopmentView,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import type { JobLease } from '../agents/job-leases.js';
import { OWNED_BY } from '../agents/job-leases.js';
import { gitCandidateManifestSchema } from '../executions/candidate-manifest.js';
import type { IdentityCipher } from '../identity/identity-security.js';
import { requireMember, type Queryable } from '../identity/membership.js';
import { findTicket } from '../tickets/tickets.queries.js';
import {
  activeRepository,
  jsonValue,
  repositoryCredentialContext,
  type GitRepositoryRow,
} from './git-repositories.service.js';
import { GIT_SHA } from './git.js';

/** Diff guardado na BD (o diff completo continua no repositório do workspace). */
export const DIFF_LIMIT = 1_000_000;
const LOG_LIMIT = 60_000;

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export const scopeHash = (input: {
  repositoryId: string;
  baseSha: string;
  headSha: string;
  diffSha256: string;
}) => sha256(developmentScopeInput(input));

export interface WorkspaceRow {
  id: string;
  ticket_id: string;
  project_id: string;
  repository_id: string;
  node_id: string;
  execution_id: string | null;
  branch: string;
  base_branch: string;
  base_sha: string | null;
  head_sha: string | null;
  publish_mode: DevelopmentPublishMode;
  state: DevelopmentWorkspaceView['state'];
  owner_run_id: string | null;
  owner_epoch: number | null;
  diff: string | null;
  diff_sha256: string | null;
  diff_truncated: boolean;
  files: unknown;
  tests_passed: boolean;
  retention_until: Date | null;
  cleaned_at: Date | null;
  updated_at: Date;
}

/** Nome da branch de trabalho: prefixo próprio, chave do ticket e identificador do workspace. */
export function workspaceBranch(ticketKey: string, workspaceId: string) {
  const key = ticketKey
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${DEVELOPMENT_BRANCH_PREFIX}${key || 'ticket'}-${workspaceId.slice(0, 8)}`;
}

/**
 * Garante o workspace persistente da etapa `develop` (um por ticket/etapa/repositório). Uma
 * correção após review reutiliza o mesmo workspace, branch e histórico.
 */
export async function ensureWorkspace(
  client: Queryable,
  input: {
    ticketId: string;
    ticketKey: string;
    projectId: string;
    repositoryId: string;
    nodeId: string;
    executionId: string;
    publish: DevelopmentPublishMode;
  },
): Promise<{ workspace: WorkspaceRow } | { unavailable: string }> {
  const repository = await activeRepository(client, input.projectId, input.repositoryId, true);
  if (!repository) return { unavailable: 'O repositório da etapa não existe ou está arquivado.' };
  const existing = (
    await client.query<WorkspaceRow>(
      'SELECT * FROM development_workspaces WHERE ticket_id=$1 AND node_id=$2 AND repository_id=$3 FOR UPDATE',
      [input.ticketId, input.nodeId, input.repositoryId],
    )
  ).rows[0];
  if (existing) {
    await client.query(
      `UPDATE development_workspaces SET execution_id=$2,publish_mode=$3,retention_until=NULL,
         state=CASE WHEN state='cleaned' THEN 'pending' ELSE state END,updated_at=NOW(3)
       WHERE id=$1`,
      [existing.id, input.executionId, input.publish],
    );
    return { workspace: { ...existing, publish_mode: input.publish } };
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO development_workspaces(id,ticket_id,project_id,repository_id,node_id,execution_id,
       branch,base_branch,publish_mode,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
    [
      id,
      input.ticketId,
      input.projectId,
      input.repositoryId,
      input.nodeId,
      input.executionId,
      workspaceBranch(input.ticketKey, id),
      repository.base_branch,
      input.publish,
    ],
  );
  return {
    workspace: (
      await client.query<WorkspaceRow>('SELECT * FROM development_workspaces WHERE id=$1', [id])
    ).rows[0]!,
  };
}

/** Artefacto atual de uma etapa `develop` (o que um review aprova ou rejeita). */
export async function reviewArtifact(client: Queryable, ticketId: string, sourceNode: string) {
  const row = (
    await client.query<WorkspaceRow>(
      `SELECT * FROM development_workspaces WHERE ticket_id=$1 AND node_id=$2
        ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [ticketId, sourceNode],
    )
  ).rows[0];
  if (!row?.base_sha || !row.head_sha || !row.diff_sha256) return null;
  return {
    workspace: row,
    headSha: row.head_sha,
    scopeHash: scopeHash({
      repositoryId: row.repository_id,
      baseSha: row.base_sha,
      headSha: row.head_sha,
      diffSha256: row.diff_sha256,
    }),
  };
}

/** Revisores elegíveis atuais (membros ativos), sem o autor quando há separação de funções. */
export async function eligibleReviewers(
  client: Queryable,
  projectId: string,
  review: FlowReviewConfig,
  authorId: string,
) {
  const rows = await client.query<{ id: string; display_name: string; role: string }>(
    `SELECT u.id,u.display_name,m.role FROM project_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.project_id=$1 AND NOT m.disabled AND NOT u.disabled AND m.role<>'client'
      ORDER BY u.display_name`,
    [projectId],
  );
  const users = new Set(review.reviewers.userIds);
  const roles = new Set<string>(review.reviewers.roles);
  return rows.rows
    .filter((row) => users.has(row.id) || roles.has(row.role))
    .filter((row) => !(review.separationOfDuties && row.id === authorId))
    .map((row) => ({ id: row.id, displayName: row.display_name, role: row.role }));
}

/** Número de aprovações exigido pela regra (any = 1; all = todos os elegíveis; quorum = N). */
export function requiredApprovals(review: FlowReviewConfig, eligible: number) {
  if (review.rule === 'all') return Math.max(1, eligible);
  if (review.rule === 'quorum') return review.quorum ?? 1;
  return 1;
}

/**
 * Quem pode decidir num review: só os revisores configurados (utilizadores ou grupos, pertença
 * atual). O administrador só decide fora da lista com `adminOverride` explícito (auditado).
 */
export function reviewDecisionRight(
  member: Pick<User, 'id' | 'role'>,
  review: FlowReviewConfig,
  authorId: string,
): { allowed: boolean; override: boolean } {
  if (member.role === 'client') return { allowed: false, override: false };
  if (review.separationOfDuties && member.id === authorId) {
    return { allowed: false, override: false };
  }
  const listed =
    review.reviewers.userIds.includes(member.id) ||
    (review.reviewers.roles as string[]).includes(member.role);
  if (listed) return { allowed: true, override: false };
  if (member.role === 'admin' && review.adminOverride) return { allowed: true, override: true };
  return { allowed: false, override: false };
}

export { flowReviewConfig };

export interface DevelopmentRunContext {
  workspace: {
    id: string;
    branch: string;
    baseBranch: string;
    baseSha: string | null;
    headSha: string | null;
    publish: DevelopmentPublishMode;
    nodeId: string;
    ticketKey: string;
    ticketTitle: string;
  };
  repository: {
    id: string;
    projectId: string;
    url: string;
    prProvider: 'zeroops' | 'github';
    allowedRefs: string[];
    setupCommands: DevelopmentCommand[];
    testCommands: DevelopmentCommand[];
  };
  credential: string | null;
  /** Feedback de rejeições anteriores (corrigir sobre o mesmo workspace). */
  feedback: string[];
}

export type FencedWrite = 'accepted' | 'stale';

export interface RevisionInput {
  expectedHead: string | null;
  baseSha: string;
  headSha: string;
  diff: string;
  files: DevelopmentFileChange[];
  testsPassed: boolean;
  /** Manifesto Git do candidato (só quando os testes finais passaram). */
  manifest: unknown;
}

export interface TestRecordInput {
  phase: 'agent' | 'final';
  name: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  testedSha: string | null;
  workingTreeHash: string | null;
  log: string;
  durationMs: number;
}

export interface PublicationInput {
  kind: 'branch' | 'pull_request';
  provider: 'git' | 'zeroops' | 'github';
  state: 'pending' | 'published' | 'uncertain' | 'conflict' | 'failed';
  remoteRef: string | null;
  headSha: string | null;
  number?: number | null;
  url?: string | null;
  error?: string | null;
}

/**
 * Persistência do desenvolvimento. As escritas do executor são protegidas pela posse do run
 * (lease atual) e pela posse do workspace (run + época): uma tentativa antiga nunca move o head
 * nem publica sobre o trabalho de uma tentativa nova.
 */
export class DevelopmentStore {
  constructor(
    private readonly db: Database,
    private readonly cipher?: IdentityCipher,
    /** Entregas do ticket (P09), injetadas para não criar dependência circular entre domínios. */
    private readonly deliveries?: (
      client: Queryable,
      ticketId: string,
    ) => Promise<DeliveryRunView[]>,
  ) {}

  /** Tentativa atual: fixa a posse do workspace e devolve repositório e credencial (executor). */
  async claimWorkspace(lease: JobLease): Promise<DevelopmentRunContext | 'stale' | 'unavailable'> {
    return this.db.transaction(async (client) => {
      const run = (
        await client.query<{ development_workspace_id: string | null; project_id: string }>(
          `SELECT development_workspace_id,project_id FROM agent_runs WHERE ${OWNED_BY()} FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!run) return 'stale';
      if (!run.development_workspace_id) return 'unavailable';
      const workspace = (
        await client.query<WorkspaceRow & { ticket_key: string; ticket_title: string }>(
          `SELECT w.*,t.\`key\` AS ticket_key,t.title AS ticket_title FROM development_workspaces w
             JOIN tickets t ON t.id=w.ticket_id WHERE w.id=$1 AND w.project_id=$2 FOR UPDATE`,
          [run.development_workspace_id, run.project_id],
        )
      ).rows[0];
      if (!workspace) return 'unavailable';
      const repository = await activeRepository(
        client,
        workspace.project_id,
        workspace.repository_id,
      );
      if (!repository) return 'unavailable';
      await client.query(
        `UPDATE development_workspaces SET owner_run_id=$2,owner_epoch=$3,state='active',
           cleaned_at=NULL,updated_at=NOW(3) WHERE id=$1`,
        [workspace.id, lease.jobId, lease.epoch],
      );
      const feedback = await client.query<{ comment_body: string | null; head_sha: string }>(
        `SELECT comment_body,head_sha FROM development_review_decisions
          WHERE workspace_id=$1 AND port<>'success' AND comment_body IS NOT NULL
          ORDER BY created_at DESC LIMIT 3`,
        [workspace.id],
      );
      return {
        workspace: {
          id: workspace.id,
          branch: workspace.branch,
          baseBranch: workspace.base_branch,
          baseSha: workspace.base_sha,
          headSha: workspace.head_sha,
          publish: workspace.publish_mode,
          nodeId: workspace.node_id,
          ticketKey: workspace.ticket_key,
          ticketTitle: workspace.ticket_title,
        },
        repository: this.repositoryContext(repository),
        credential: this.credential(repository),
        feedback: feedback.rows.map(
          (row) => `${row.comment_body} (sobre ${row.head_sha.slice(0, 12)})`,
        ),
      };
    });
  }

  /** Fixa o commit base na primeira tentativa (nunca é alterado depois). */
  async fixBase(lease: JobLease, workspaceId: string, baseSha: string): Promise<FencedWrite> {
    if (!GIT_SHA.test(baseSha)) throw new Error('SHA base inválido.');
    return this.fenced(lease, workspaceId, async (client, workspace) => {
      if (workspace.base_sha && workspace.base_sha !== baseSha)
        throw new Error('O commit base do workspace já está fixado noutro SHA.');
      await client.query(
        'UPDATE development_workspaces SET base_sha=$2,updated_at=NOW(3) WHERE id=$1 AND base_sha IS NULL',
        [workspaceId, baseSha],
      );
    });
  }

  /** Regista um comando de teste efetivamente executado (exit code, log e versão testada). */
  async recordTest(
    lease: JobLease,
    workspaceId: string,
    test: TestRecordInput,
  ): Promise<FencedWrite> {
    return this.fenced(lease, workspaceId, async (client, workspace) => {
      const log = test.log.length > LOG_LIMIT ? test.log.slice(-LOG_LIMIT) : test.log;
      await client.query(
        `INSERT INTO development_test_runs(id,ticket_id,workspace_id,agent_run_id,run_epoch,phase,name,
           command,exit_code,timed_out,tested_sha,working_tree_hash,log,log_sha256,duration_ms)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          randomUUID(),
          workspace.ticket_id,
          workspaceId,
          lease.jobId,
          lease.epoch,
          test.phase,
          test.name.slice(0, 60),
          test.command.slice(0, 500),
          test.exitCode,
          test.timedOut,
          test.testedSha,
          test.workingTreeHash,
          log,
          sha256(test.log),
          Math.max(0, Math.round(test.durationMs)),
        ],
      );
    });
  }

  /**
   * Avança o head do workspace (CAS sobre o head anterior) e regista a revisão: diff completo do
   * Git, ficheiros A/M/D, testes e manifesto. Um novo head invalida as decisões de review sobre
   * heads anteriores. Uma tentativa antiga ou um head concorrente devolve `stale`.
   */
  async recordRevision(
    lease: JobLease,
    workspaceId: string,
    input: RevisionInput,
  ): Promise<FencedWrite | 'unchanged'> {
    if (!GIT_SHA.test(input.headSha) || !GIT_SHA.test(input.baseSha))
      throw new Error('SHA inválido.');
    let unchanged = false;
    const outcome = await this.fenced(lease, workspaceId, async (client, workspace) => {
      if (workspace.base_sha !== input.baseSha) throw new StaleWrite();
      if ((workspace.head_sha ?? null) !== input.expectedHead) throw new StaleWrite();
      const diffSha256 = sha256(input.diff);
      const diff =
        input.diff.length > DIFF_LIMIT ? `${input.diff.slice(0, DIFF_LIMIT)}\n` : input.diff;
      if (workspace.head_sha === input.headSha) {
        unchanged = true;
        return;
      }
      const manifest = input.manifest ? gitCandidateManifestSchema.parse(input.manifest) : null;
      const candidateHash = manifest ? sha256(JSON.stringify(manifest)) : null;
      const scope = scopeHash({
        repositoryId: workspace.repository_id,
        baseSha: input.baseSha,
        headSha: input.headSha,
        diffSha256,
      });
      await client.query(
        `UPDATE development_workspaces SET head_sha=$2,diff=$3,diff_sha256=$4,diff_truncated=$5,
           files=$6,tests_passed=$7,updated_at=NOW(3) WHERE id=$1`,
        [
          workspaceId,
          input.headSha,
          diff,
          diffSha256,
          input.diff.length > DIFF_LIMIT,
          JSON.stringify(input.files),
          input.testsPassed,
        ],
      );
      await client.query(
        `INSERT INTO development_revisions(id,ticket_id,workspace_id,agent_run_id,run_epoch,base_sha,
           parent_sha,head_sha,diff_sha256,scope_hash,files,tests_passed,manifest,candidate_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          randomUUID(),
          workspace.ticket_id,
          workspaceId,
          lease.jobId,
          lease.epoch,
          input.baseSha,
          input.expectedHead,
          input.headSha,
          diffSha256,
          scope,
          JSON.stringify(input.files),
          input.testsPassed,
          manifest ? JSON.stringify(manifest) : null,
          candidateHash,
        ],
      );
      // Alteração material: as decisões sobre outro head deixam de contar (ficam no histórico).
      await client.query(
        `UPDATE development_review_decisions SET invalidated_at=NOW(3),invalidation_reason='head_changed'
          WHERE workspace_id=$1 AND invalidated_at IS NULL AND head_sha<>$2`,
        [workspaceId, input.headSha],
      );
    });
    return outcome === 'accepted' && unchanged ? 'unchanged' : outcome;
  }

  /** Estado atual de uma publicação (reconciliação antes de repetir). */
  async publication(workspaceId: string, kind: 'branch' | 'pull_request') {
    return (
      (
        await this.db.query<{
          state: PublicationInput['state'];
          head_sha: string | null;
          number: number | null;
          url: string | null;
          attempts: number;
        }>(
          'SELECT state,head_sha,number,url,attempts FROM development_publications WHERE idempotency_key=$1',
          [`${workspaceId}:${kind}`],
        )
      ).rows[0] ?? null
    );
  }

  /**
   * Regista (idempotente por workspace/tipo) uma publicação. O PR interno recebe um número
   * sequencial por projeto apenas na primeira publicação; repetições atualizam o mesmo registo.
   */
  async recordPublication(
    lease: JobLease,
    workspaceId: string,
    input: PublicationInput,
  ): Promise<{ outcome: FencedWrite; number: number | null }> {
    let number: number | null = input.number ?? null;
    const outcome = await this.fenced(lease, workspaceId, async (client, workspace) => {
      const key = `${workspaceId}:${input.kind}`;
      const existing = (
        await client.query<{ id: string; number: number | null }>(
          'SELECT id,number FROM development_publications WHERE idempotency_key=$1 FOR UPDATE',
          [key],
        )
      ).rows[0];
      if (input.kind === 'pull_request' && input.provider === 'zeroops' && !number) {
        number = existing?.number ?? null;
        if (!number && input.state === 'published') {
          await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [
            workspace.project_id,
          ]);
          const next = await client.query<{ next: number }>(
            `SELECT COALESCE(MAX(number),0)+1 AS next FROM development_publications
              WHERE project_id=$1 AND provider='zeroops' AND kind='pull_request'`,
            [workspace.project_id],
          );
          number = Number(next.rows[0]?.next ?? 1);
        }
      }
      if (existing) {
        await client.query(
          `UPDATE development_publications SET state=$2,remote_ref=$3,head_sha=$4,number=$5,url=$6,
             attempts=attempts+1,last_error=$7,updated_at=NOW(3) WHERE id=$1`,
          [
            existing.id,
            input.state,
            input.remoteRef,
            input.headSha,
            number,
            input.url ?? null,
            input.error?.slice(0, 500) ?? null,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO development_publications(id,ticket_id,project_id,workspace_id,kind,provider,
             idempotency_key,state,remote_ref,head_sha,number,url,attempts,last_error)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13)`,
          [
            randomUUID(),
            workspace.ticket_id,
            workspace.project_id,
            workspaceId,
            input.kind,
            input.provider,
            key,
            input.state,
            input.remoteRef,
            input.headSha,
            number,
            input.url ?? null,
            input.error?.slice(0, 500) ?? null,
          ],
        );
      }
    });
    return { outcome, number };
  }

  /** Fim da tentativa: o workspace fica preservado (inativo) para correções e review. */
  async releaseWorkspace(lease: JobLease, workspaceId: string, failed: boolean) {
    await this.db.query(
      `UPDATE development_workspaces SET state=$4,updated_at=NOW(3)
        WHERE id=$1 AND owner_run_id=$2 AND owner_epoch=$3 AND state='active'`,
      [workspaceId, lease.jobId, lease.epoch, failed ? 'failed' : 'idle'],
    );
  }

  /**
   * Workspaces a limpar: fluxo do ticket terminado (ou sem fluxo ativo) há mais do que a retenção
   * e sem run em curso. Os artefactos (diff, testes, publicações, decisões) ficam na BD.
   */
  async cleanupCandidates(retentionDays: number, limit = 20) {
    const rows = await this.db.query<{ id: string; project_id: string }>(
      `SELECT w.id,w.project_id FROM development_workspaces w
        WHERE w.state IN ('idle','failed','pending','active')
          AND w.updated_at < TIMESTAMPADD(DAY,-$1,NOW(3))
          AND NOT EXISTS(SELECT 1 FROM flow_executions e WHERE e.ticket_id=w.ticket_id AND e.status IN ('running','waiting'))
          AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.development_workspace_id=w.id AND r.status IN ('queued','running'))
          AND NOT EXISTS(SELECT 1 FROM delivery_runs d WHERE d.workspace_id=w.id AND d.finished_at IS NULL)
        ORDER BY w.updated_at LIMIT ${Math.max(1, Math.min(limit, 100))}`,
      [Math.max(0, retentionDays)],
    );
    return rows.rows;
  }

  /** Marca o workspace como limpo antes de remover o checkout; false se estiver em uso ou já limpo. */
  async markCleaned(workspaceId: string) {
    const result = await this.db.query(
      `UPDATE development_workspaces SET state='cleaned',cleaned_at=NOW(3),owner_run_id=NULL,
         owner_epoch=NULL,updated_at=NOW(3)
        WHERE id=$1 AND state IN ('idle','failed','pending','active')
          AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.development_workspace_id=$1 AND r.status IN ('queued','running'))
          AND NOT EXISTS(SELECT 1 FROM delivery_runs d WHERE d.workspace_id=$1 AND d.finished_at IS NULL)`,
      [workspaceId],
    );
    return Boolean(result.rowCount);
  }

  /** Vista interna do desenvolvimento de um ticket (só equipa; nunca exposta ao cliente). */
  async ticketDevelopment(actor: User, ticketId: string): Promise<TicketDevelopmentView> {
    const member = await requireMember(this.db, actor);
    if (member.role === 'client')
      throw new DomainError('FORBIDDEN', 'Detalhe técnico reservado à equipa.', 403);
    const ticket = await findTicket(this.db, member, ticketId);
    const workspaces = await this.db.query<
      WorkspaceRow & { repository_name: string; repository_url: string; pr_provider: string }
    >(
      `SELECT w.*,r.name AS repository_name,r.url AS repository_url,r.pr_provider
         FROM development_workspaces w JOIN project_git_repositories r ON r.id=w.repository_id
        WHERE w.ticket_id=$1 AND w.project_id=$2 ORDER BY w.created_at`,
      [ticket.id, member.projectId],
    );
    const review = await this.currentReview(member, ticket.id, ticket.created_by);
    const deliveries = this.deliveries ? await this.deliveries(this.db, ticket.id) : [];
    const pipelines = Number(
      (
        await this.db.query<{ total: number }>(
          'SELECT COUNT(*) AS total FROM project_pipelines WHERE project_id=$1 AND NOT archived',
          [member.projectId],
        )
      ).rows[0]?.total ?? 0,
    );
    const views: DevelopmentWorkspaceView[] = [];
    for (const row of workspaces.rows) {
      const [revisions, tests, publications, reviews, run] = await Promise.all([
        this.db.query<{
          id: string;
          agent_run_id: string | null;
          base_sha: string;
          head_sha: string;
          diff_sha256: string;
          scope_hash: string;
          files: unknown;
          tests_passed: boolean;
          candidate_hash: string | null;
          created_at: Date;
        }>(
          'SELECT * FROM development_revisions WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 30',
          [row.id],
        ),
        this.db.query<{
          id: string;
          agent_run_id: string | null;
          phase: 'agent' | 'final';
          name: string;
          command: string;
          exit_code: number | null;
          timed_out: boolean;
          tested_sha: string | null;
          working_tree_hash: string | null;
          log: string;
          log_sha256: string;
          duration_ms: number;
          created_at: Date;
        }>(
          'SELECT * FROM development_test_runs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 40',
          [row.id],
        ),
        this.db.query<{
          id: string;
          kind: 'branch' | 'pull_request';
          provider: 'git' | 'zeroops' | 'github';
          state: PublicationInput['state'];
          head_sha: string | null;
          remote_ref: string | null;
          number: number | null;
          url: string | null;
          attempts: number;
          last_error: string | null;
          updated_at: Date;
        }>('SELECT * FROM development_publications WHERE workspace_id=$1 ORDER BY kind', [row.id]),
        this.db.query<{
          id: string;
          step_id: string;
          actor_id: string;
          display_name: string;
          port: string;
          head_sha: string;
          scope_hash: string;
          comment_body: string | null;
          override_used: boolean;
          invalidated_at: Date | null;
          invalidation_reason: string | null;
          created_at: Date;
        }>(
          `SELECT d.*,u.display_name FROM development_review_decisions d JOIN users u ON u.id=d.actor_id
            WHERE d.workspace_id=$1 ORDER BY d.created_at DESC`,
          [row.id],
        ),
        this.db.query<{ id: string }>(
          `SELECT id FROM agent_runs WHERE development_workspace_id=$1 AND status IN ('queued','running')
            ORDER BY created_at DESC LIMIT 1`,
          [row.id],
        ),
      ]);
      views.push({
        id: row.id,
        nodeId: row.node_id,
        repository: {
          id: row.repository_id,
          name: row.repository_name,
          url: row.repository_url,
          prProvider: row.pr_provider === 'github' ? 'github' : 'zeroops',
        },
        branch: row.branch,
        baseBranch: row.base_branch,
        baseSha: row.base_sha,
        headSha: row.head_sha,
        state: row.state,
        publish: row.publish_mode,
        currentRunId: run.rows[0]?.id ?? null,
        ownerEpoch: row.owner_epoch === null ? null : Number(row.owner_epoch),
        retentionUntil: row.retention_until ? new Date(row.retention_until).toISOString() : null,
        diff: row.diff,
        diffTruncated: Boolean(row.diff_truncated),
        revisions: revisions.rows.map((item) => ({
          id: item.id,
          agentRunId: item.agent_run_id,
          baseSha: item.base_sha,
          headSha: item.head_sha,
          diffSha256: item.diff_sha256,
          scopeHash: item.scope_hash,
          files: jsonValue<DevelopmentFileChange[]>(item.files, []),
          testsPassed: Boolean(item.tests_passed),
          candidateHash: item.candidate_hash,
          createdAt: new Date(item.created_at).toISOString(),
        })),
        tests: tests.rows.map((item) => ({
          id: item.id,
          agentRunId: item.agent_run_id,
          phase: item.phase,
          name: item.name,
          command: item.command,
          exitCode: item.exit_code === null ? null : Number(item.exit_code),
          timedOut: Boolean(item.timed_out),
          testedSha: item.tested_sha,
          workingTreeHash: item.working_tree_hash,
          logSha256: item.log_sha256,
          log: item.log,
          durationMs: Number(item.duration_ms),
          createdAt: new Date(item.created_at).toISOString(),
        })),
        publications: publications.rows.map((item) => ({
          id: item.id,
          kind: item.kind,
          provider: item.provider,
          state: item.state,
          headSha: item.head_sha,
          remoteRef: item.remote_ref,
          number: item.number === null ? null : Number(item.number),
          url: item.url,
          attempts: Number(item.attempts),
          lastError: item.last_error,
          updatedAt: new Date(item.updated_at).toISOString(),
        })),
        reviews: reviews.rows.map((item) => ({
          id: item.id,
          stepId: item.step_id,
          actor: { id: item.actor_id, displayName: item.display_name },
          port: item.port,
          headSha: item.head_sha,
          scopeHash: item.scope_hash,
          comment: item.comment_body,
          override: Boolean(item.override_used),
          invalidatedAt: item.invalidated_at ? new Date(item.invalidated_at).toISOString() : null,
          invalidationReason: item.invalidation_reason,
          createdAt: new Date(item.created_at).toISOString(),
        })),
        review: review && review.sourceNode === row.node_id ? review.view : null,
        pipeline: {
          available: pipelines > 0,
          reason:
            pipelines > 0
              ? null
              : 'Este projeto não tem pipeline de entrega configurada: nada é publicado num ambiente.',
          deliveries: deliveries.filter((item) => item.workspaceId === row.id),
        },
      });
    }
    return { ticketId: ticket.id, workspaces: views };
  }

  /** Etapa de review à espera neste ticket (regra, revisores e aprovações sobre o head atual). */
  private async currentReview(member: User, ticketId: string, authorId: string) {
    const step = (
      await this.db.query<{ id: string; node_id: string; flow_definition: unknown }>(
        `SELECT s.id,s.node_id,v.flow_definition FROM flow_executions e
           JOIN flow_execution_steps s ON s.id=e.current_step_id
           JOIN flow_versions v ON v.id=e.version_id
          WHERE e.ticket_id=$1 AND e.status IN ('running','waiting') AND s.status='waiting'
          ORDER BY e.started_at DESC LIMIT 1`,
        [ticketId],
      )
    ).rows[0];
    if (!step) return null;
    const definition = jsonValue<{
      nodes?: { id: string; op: string; config?: Record<string, unknown> }[];
    }>(step.flow_definition, {});
    const node = definition.nodes?.find((item) => item.id === step.node_id);
    if (!node) return null;
    const review = flowReviewConfig({ op: node.op, config: node.config ?? {} });
    if (!review) return null;
    const artifact = (
      await this.db.query<{ head_sha: string | null }>(
        'SELECT head_sha FROM development_workspaces WHERE ticket_id=$1 AND node_id=$2 ORDER BY updated_at DESC LIMIT 1',
        [ticketId, review.sourceNode],
      )
    ).rows[0];
    const eligible = await eligibleReviewers(this.db, member.projectId, review, authorId);
    const approvals = artifact?.head_sha
      ? Number(
          (
            await this.db.query<{ total: number }>(
              `SELECT COUNT(DISTINCT actor_id) AS total FROM development_review_decisions
                WHERE step_id=$1 AND head_sha=$2 AND port='success' AND invalidated_at IS NULL`,
              [step.id, artifact.head_sha],
            )
          ).rows[0]?.total ?? 0,
        )
      : 0;
    return {
      sourceNode: review.sourceNode,
      view: {
        stepId: step.id,
        nodeId: step.node_id,
        rule: review.rule,
        required: requiredApprovals(review, eligible.length),
        approvals,
        reviewers: eligible.map(({ id, displayName }) => ({ id, displayName })),
        canDecide: reviewDecisionRight(member, review, authorId).allowed,
      },
    };
  }

  private repositoryContext(row: GitRepositoryRow): DevelopmentRunContext['repository'] {
    return {
      id: row.id,
      projectId: row.project_id,
      url: row.url,
      prProvider: row.pr_provider,
      allowedRefs: jsonValue<string[]>(row.allowed_refs, []),
      setupCommands: jsonValue<DevelopmentCommand[]>(row.setup_commands, []),
      testCommands: jsonValue<DevelopmentCommand[]>(row.test_commands, []),
    };
  }

  private credential(row: GitRepositoryRow) {
    if (!row.credential_ciphertext) return null;
    if (!this.cipher) throw new Error('Cifra indisponível para a credencial do repositório.');
    return this.cipher.decrypt(
      row.credential_ciphertext,
      repositoryCredentialContext(row.project_id, row.id),
    );
  }

  /** Escrita protegida: run com lease atual e workspace detido por esta tentativa (run + época). */
  private async fenced(
    lease: JobLease,
    workspaceId: string,
    write: (client: Queryable, workspace: WorkspaceRow) => Promise<void>,
  ): Promise<FencedWrite> {
    if (!z.uuid().safeParse(workspaceId).success) throw new Error('Workspace inválido.');
    try {
      return await this.db.transaction(async (client) => {
        const run = await client.query(
          `SELECT id FROM agent_runs WHERE ${OWNED_BY()} AND development_workspace_id=$4 FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch, workspaceId],
        );
        if (!run.rowCount) return 'stale';
        const workspace = (
          await client.query<WorkspaceRow>(
            'SELECT * FROM development_workspaces WHERE id=$1 AND owner_run_id=$2 AND owner_epoch=$3 FOR UPDATE',
            [workspaceId, lease.jobId, lease.epoch],
          )
        ).rows[0];
        if (!workspace) return 'stale';
        await write(client, workspace);
        return 'accepted';
      });
    } catch (error) {
      if (error instanceof StaleWrite) return 'stale';
      throw error;
    }
  }
}

class StaleWrite extends Error {}
