import { randomUUID } from 'node:crypto';
import { ticketWorkPaused } from '../tickets/ticket-purge-health.js';
import {
  actionKey,
  copilotMode,
  copilotStepModel,
  decisionOptions,
  endOutcome,
  FLOW_SUCCESS,
  flowConditionPort,
  flowCopilotBlock,
  flowCopilotOutcome,
  flowDecisionInputSchema,
  flowDecisionNotRequired,
  developmentNodeConfig,
  flowReviewConfig,
  flowRuntimeSupported,
  flowVisitLimitExceeded,
  FLOW_STEP_BUDGET,
  maxVisits,
  portLabel,
  resolveFlowTransition,
  type FlowAssignee,
  type FlowDefinition,
  type FlowNode,
  type FlowReviewConfig,
  type FlowStepOutput,
  type TicketOrigin,
  type TicketStatus,
  type User,
} from '../../../../contracts/src/index.js';
import type {
  AgentProfileRunSnapshot,
  RepositoryResourceSnapshot,
} from '../../../../contracts/src/agent-profiles.js';
import type { CapabilityRunManifest } from '../../../../contracts/src/capabilities.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import {
  AUTO_INVESTIGATION_INSTRUCTIONS,
  copilotReady,
  queueAgentRun,
  teamRequester,
} from '../agents/agent-auto-runs.js';
import type { RunFinishedHook } from '../agents/agent-runs.service.js';
import { AgentModelsService } from '../agents/agent-models.service.js';
import { AgentProfilesService } from '../agents/agent-profiles.service.js';
import {
  eligibleReviewers,
  ensureWorkspace,
  requiredApprovals,
  reviewArtifact,
  reviewDecisionRight,
  scopeHash,
} from '../development/development.store.js';
import { incidentInstructionContext } from '../incidents/incident-instructions.js';
import { closeHealthIncident, type IncidentDelegate } from '../health/health-incident-lifecycle.js';
import { parseInput } from '../identity/identity.validation.js';
import { requireMember, type Queryable } from '../identity/membership.js';
import { appendAutomatedComment, appendHumanComment } from '../tickets/ticket-comments.js';
import { recordTicketMove } from '../tickets/ticket-move.js';
import { findTicket } from '../tickets/tickets.queries.js';
import type { PublicCommentHook, TicketCreatedHook } from '../tickets/tickets.service.js';
import {
  databaseActionEffects,
  defaultFlowActions,
  type FlowActionRegistry,
} from './flow-actions.js';
import {
  ensureDefaultFlows,
  flowForTicket,
  flowSelectionPlan,
  legacyTemplateFlows,
  binaryMigrationFlows,
  migrateFlowToBinary,
  parseDefinition,
  pinnedFlow,
  upgradeTemplateFlow,
  type PublishedFlow,
} from './flow-store.js';
import { acceptRoutingReply, beginRouting } from './ticket-routing.js';

/** Fluxo e versão concretos onde o ticket entra (ativo agora ou fixado no encaminhamento). */
export type StartableFlow = Pick<
  PublishedFlow,
  'id' | 'name' | 'versionId' | 'versionNumber' | 'definition'
>;

const INSTRUCTIONS_LIMIT = 4000;
const PATCH_IN_REPORT_LIMIT = 1500;
/** Etapas processadas numa única transação (protege contra ciclos sem espera). */
const STEP_BUDGET = FLOW_STEP_BUDGET;
/** Novo pedido ao Copilot quando já havia outro run ativo no ticket. */
const RETRY_MS = 60_000;

export interface TicketLock {
  id: string;
  project_id: string;
  status: TicketStatus;
  version: number;
  created_by: string;
  origin: TicketOrigin;
  category: string;
  environment: string;
  priority: string;
  alert_key: string | null;
}

export interface ExecutionRow {
  id: string;
  ticket_id: string;
  project_id: string;
  flow_id: string;
  version_id: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  current_node: string | null;
  current_step_id: string | null;
  execution_context: FlowExecutionContext | null;
  wake_at: Date | null;
  /** Saúde suspensa no ambiente do ticket: a execução fica parada até à retoma. */
  suspended_at?: Date | null;
  started_at: Date;
  finished_at: Date | null;
}

export interface FlowExecutionContext {
  agentInstructions?: string;
  agentProfiles?: Record<string, AgentProfileRunSnapshot>;
  /** Skills e especialistas fixados por etapa no início da execução (P04). */
  capabilitiesByNode?: Record<string, CapabilityRunManifest>;
  repositorySnapshotHash?: string | null;
  repositoryResources?: RepositoryResourceSnapshot[];
  repositoryResourcePathsByNode?: Record<string, string[]>;
  repositorySnapshotHashesByNode?: Record<string, string | null>;
  resourceResolutionError?: { code: string; message: string };
}

export interface StepRow {
  id: string;
  execution_id: string;
  node_id: string;
  attempt: number;
  status: 'active' | 'waiting' | 'completed' | 'failed';
  step_assignee: { label: string; userIds: string[] } | null;
  step_input: StepInput | null;
  step_output: FlowStepOutput | null;
  port: string | null;
  actor_id: string | null;
  agent_run_id: string | null;
  started_at: Date;
  finished_at: Date | null;
}

/** Entrada de uma etapa: de onde veio e o comentário/evidência que a acompanha. */
export interface StepInput {
  from?: { stepId: string; nodeId: string; label: string; port: string; result?: string };
  feedback?: { comment: string; actor: string | null; evidence?: string | null };
  instructions?: string;
}

interface Run {
  client: Queryable;
  ticket: TicketLock;
  execution: ExecutionRow;
  definition: FlowDefinition;
  budget: number;
  /** Adoção de ticket antigo: a primeira etapa não altera o estado já existente do ticket. */
  keepStatus?: boolean;
}

const roleLabels: Record<string, string> = {
  technical: 'Equipa técnica',
  qa: 'QA',
  release: 'Release',
  admin: 'Administração',
  client: 'Cliente',
};

const ticketColumns =
  'id,project_id,status,version,created_by,origin,category,environment,priority,alert_key';

/** Bloqueia o ticket (sempre antes da execução, a mesma ordem em todos os caminhos). */
export async function lockFlowTicket(client: Queryable, ticketId: string) {
  return (
    (
      await client.query<TicketLock>(
        `SELECT ${ticketColumns} FROM tickets WHERE id=$1 FOR UPDATE`,
        [ticketId],
      )
    ).rows[0] ?? null
  );
}

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** Estado do ticket ao entrar numa etapa (null = mantém). */
export function ticketStatusFor(node: FlowNode): TicketStatus | null {
  if (node.ticketStatus) return node.ticketStatus;
  switch (node.op) {
    case 'copilot_task':
      return copilotMode(node) === 'develop' ? 'implementing' : 'investigating';
    case 'action':
      return actionKey(node) === 'deploy' ? 'deploying' : null;
    case 'human_decision': {
      const assignee = node.assignee ?? { kind: 'team' };
      if (assignee.kind === 'ticket_author') return 'awaiting_information';
      if (assignee.kind === 'role') {
        if (assignee.role === 'client') return 'awaiting_information';
        if (assignee.role === 'qa') return 'awaiting_qa';
        if (assignee.role === 'release') return 'awaiting_release';
      }
      return 'awaiting_technical';
    }
    case 'end':
    case 'condition':
      return null;
  }
}

/**
 * Quem pode decidir numa etapa: o responsável configurado ou um administrador do projeto. Num
 * review de desenvolvimento decidem só os revisores configurados (o admin apenas com override).
 */
export function canDecide(
  member: Pick<User, 'id' | 'role'>,
  node: FlowNode,
  ticket: Pick<TicketLock, 'created_by'>,
) {
  const review = flowReviewConfig(node);
  if (review) return reviewDecisionRight(member, review, ticket.created_by).allowed;
  if (member.role === 'admin') return true;
  const assignee: FlowAssignee = node.assignee ?? { kind: 'team' };
  switch (assignee.kind) {
    case 'role':
      return member.role === assignee.role;
    case 'user':
      return member.id === assignee.userId;
    case 'ticket_author':
      return member.id === ticket.created_by;
    case 'team':
      return member.role !== 'client';
  }
}

/**
 * Motor dos fluxos: cada ticket entra na versão publicada no momento e avança etapa a etapa.
 * Tudo corre na transação do chamador com o ticket bloqueado; o estado (etapa atual, decisões,
 * resultados) fica na BD, por isso uma espera humana sobrevive a reinícios da aplicação.
 */
export class FlowEngine {
  constructor(
    private readonly db: Database,
    private readonly actions: FlowActionRegistry = defaultFlowActions,
    private readonly clock: () => Date = () => new Date(),
    private readonly agentProfiles: AgentProfilesService = new AgentProfilesService(db),
  ) {}

  /**
   * Hook de criação: associação explícita da Saúde ou regra estruturada inequívoca entram logo no
   * fluxo; com políticas semânticas coincidentes, os candidatos ficam fixados e o ticket aguarda a
   * classificação (P05) sem executar efeitos de nenhum fluxo candidato.
   */
  readonly onTicketCreated: TicketCreatedHook = async (client, ticket, options) => {
    const locked = await lockFlowTicket(client, ticket.id);
    if (!locked) return;
    const context = options.agentInstructions
      ? { agentInstructions: options.agentInstructions }
      : {};
    // P10: um processo interno (ex.: desenvolvimento de capacidade) escolhe o fluxo publicado
    // explicitamente atribuído ao projeto, sem passar pelo encaminhamento dos tickets normais.
    if (options.flowId) {
      const published = (
        await client.query<{ published_version_id: string | null }>(
          'SELECT published_version_id FROM flows WHERE id=$1 AND project_id=$2',
          [options.flowId, locked.project_id],
        )
      ).rows[0]?.published_version_id;
      const flow = published
        ? await pinnedFlow(client, locked.project_id, options.flowId, published)
        : null;
      if (!flow)
        throw new DomainError(
          'FLOW_NOT_PUBLISHED',
          'O fluxo indicado não tem versão ativa neste projeto.',
          409,
        );
      await this.startWith(client, locked, flow, context);
      return;
    }
    await ensureDefaultFlows(client, locked.project_id);
    const plan = await flowSelectionPlan(client, locked);
    if (plan.kind === 'classify') await beginRouting(client, locked, plan, context);
    else if (plan.flow) await this.startWith(client, locked, plan.flow, context);
  };

  /** Hook do fim de um run do Copilot pedido por uma etapa: guarda o resultado e avança. */
  readonly onRunFinished: RunFinishedHook = async (client, run) => {
    if (run.run_trigger !== 'flow') return;
    const loaded = await this.load(client, run.ticket_id);
    if (!loaded || loaded.execution.suspended_at) return;
    const step = await this.currentStep(loaded);
    if (step?.agent_run_id === run.id && step.status === 'waiting')
      await this.resumeCopilot(loaded, step);
  };

  /**
   * Resposta pública do autor a uma etapa que espera por ele. Na análise do Copilot que fez uma
   * pergunta ao cliente, a resposta repete a análise com o comentário; numa decisão antiga
   * atribuída ao autor, segue pela opção «respondeu» (ou sucesso).
   */
  readonly onPublicComment: PublicCommentHook = async (client, actor, ticketId, comment) => {
    const routing = await client.query<{ status: string }>(
      'SELECT status FROM ticket_routing WHERE ticket_id=$1',
      [ticketId],
    );
    if (routing.rows[0]?.status === 'awaiting_reply') {
      const ticket = await lockFlowTicket(client, ticketId);
      if (ticket && !(await ticketWorkPaused(client, ticket.project_id)))
        await acceptRoutingReply(client, actor, ticket, comment);
      return;
    }
    const loaded = await this.load(client, ticketId);
    if (!loaded || loaded.execution.status !== 'waiting' || loaded.execution.suspended_at) return;
    const step = await this.currentStep(loaded);
    const node = step && this.node(loaded, step.node_id);
    if (!step || !node || step.status !== 'waiting') return;
    const latestReply = async () =>
      (
        await client.query<{ body: string }>(
          `SELECT body FROM ticket_comments WHERE ticket_id=$1 AND author_id=$2 AND visibility='public'
            ORDER BY created_at DESC LIMIT 1`,
          [ticketId, actor.id],
        )
      ).rows[0]?.body;
    if (node.op === 'copilot_task') {
      const awaiting = step.step_output?.awaitingClient;
      const fromClient = actor.id === loaded.ticket.created_by || actor.role === 'client';
      if (!awaiting || !fromClient) return;
      const reply = await latestReply();
      const inserted = await client.query(
        `INSERT IGNORE INTO flow_decisions(id,step_id,idempotency_key,actor_id,port,comment_body)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), step.id, `reply:${step.id}`, actor.id, 'needs_information', reply ?? null],
      );
      if (!inserted.rowCount) return;
      return this.complete(
        loaded,
        step,
        'needs_information',
        { ...step.step_output, awaitingClient: null },
        actor.id,
        reply ? { comment: reply, actor: actor.displayName } : undefined,
      );
    }
    if (node.op !== 'human_decision') return;
    const assignee = node.assignee;
    const forAuthor =
      assignee?.kind === 'ticket_author' ||
      (assignee?.kind === 'role' && assignee.role === 'client');
    if (!forAuthor || !canDecide(actor, node, loaded.ticket)) return;
    const options = decisionOptions(node);
    const port =
      options.find((option) => option.port === 'replied')?.port ??
      options.find((option) => option.port === FLOW_SUCCESS)?.port ??
      options[0]?.port;
    if (!port) return;
    const reply = await latestReply();
    const inserted = await client.query(
      `INSERT IGNORE INTO flow_decisions(id,step_id,idempotency_key,actor_id,port,comment_body)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), step.id, `reply:${step.id}`, actor.id, port, reply ?? null],
    );
    if (!inserted.rowCount) return;
    await this.complete(
      loaded,
      step,
      port,
      { comment: reply ?? null, commentVisibility: 'public' },
      actor.id,
      reply ? { comment: reply, actor: actor.displayName } : undefined,
    );
  };

  /** A Saúde delega o fecho do incidente quando o ticket está num fluxo ativo (e acorda-o). */
  readonly incidentDelegate: IncidentDelegate = async (client, ticketId) => {
    const updated = await client.query(
      "UPDATE flow_executions SET wake_at=$2 WHERE ticket_id=$1 AND status IN ('running','waiting')",
      [ticketId, this.clock()],
    );
    return updated.rowCount > 0;
  };

  /**
   * Coloca o ticket no fluxo aplicável (versão publicada agora). Sem efeito se já tiver execução.
   * `startNode` permite retomar tickets antigos numa etapa concreta (ex.: decisão da equipa).
   */
  async start(
    client: Queryable,
    ticket: TicketLock,
    context: { agentInstructions?: string } = {},
    startNode?: string,
  ) {
    const existing = await client.query('SELECT id FROM flow_executions WHERE ticket_id=$1', [
      ticket.id,
    ]);
    if (existing.rowCount) return null;
    await ensureDefaultFlows(client, ticket.project_id);
    const flow = await flowForTicket(client, ticket);
    if (!flow) return null;
    return this.startWith(client, ticket, flow, context, startNode);
  }

  /**
   * Entra numa versão concreta (ex.: a versão fixada pelo encaminhamento), mesmo que entretanto
   * outra tenha sido ativada. Sem efeito se o ticket já tiver execução.
   */
  async startWith(
    client: Queryable,
    ticket: TicketLock,
    flow: StartableFlow,
    context: { agentInstructions?: string } = {},
    startNode?: string,
  ) {
    const existing = await client.query('SELECT id FROM flow_executions WHERE ticket_id=$1', [
      ticket.id,
    ]);
    if (existing.rowCount) return null;
    const resolved = await this.agentProfiles
      .snapshotForExecution(client, ticket.project_id, flow.definition, ticket.id)
      .catch((error: unknown) => ({
        agentProfiles: {},
        capabilitiesByNode: {},
        repositorySnapshotHash: null,
        repositoryResources: [],
        repositoryResourcePathsByNode: {},
        repositorySnapshotHashesByNode: {},
        error: {
          code:
            error instanceof DomainError ? error.code.toLowerCase() : 'resource_resolution_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Não foi possível resolver o contexto técnico desta execução.',
        },
      }));
    const executionContext: FlowExecutionContext = {
      ...context,
      agentProfiles: resolved.agentProfiles,
      ...(Object.keys(resolved.capabilitiesByNode).length
        ? { capabilitiesByNode: resolved.capabilitiesByNode }
        : {}),
      repositorySnapshotHash: resolved.repositorySnapshotHash,
      repositoryResources: resolved.repositoryResources,
      repositoryResourcePathsByNode: resolved.repositoryResourcePathsByNode,
      repositorySnapshotHashesByNode: resolved.repositorySnapshotHashesByNode,
      ...(resolved.error ? { resourceResolutionError: resolved.error } : {}),
    };
    const executionId = randomUUID();
    const now = this.clock();
    await client.query(
      `INSERT INTO flow_executions(id,ticket_id,project_id,flow_id,version_id,status,execution_context,started_at,finished_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        executionId,
        ticket.id,
        ticket.project_id,
        flow.id,
        flow.versionId,
        resolved.error ? 'failed' : 'running',
        executionContext,
        now,
        resolved.error ? now : null,
      ],
    );
    const execution: ExecutionRow = {
      id: executionId,
      ticket_id: ticket.id,
      project_id: ticket.project_id,
      flow_id: flow.id,
      version_id: flow.versionId,
      status: resolved.error ? 'failed' : 'running',
      current_node: null,
      current_step_id: null,
      execution_context: executionContext,
      wake_at: null,
      started_at: now,
      finished_at: null,
    };
    const run: Run = {
      client,
      ticket,
      execution,
      definition: flow.definition,
      budget: STEP_BUDGET,
      keepStatus: Boolean(startNode),
    };
    await this.event(run, null, 'started', null, {
      flow: flow.name,
      version: flow.versionNumber,
      ...(startNode ? { resumedAt: startNode } : {}),
      repositorySnapshotHash: resolved.repositorySnapshotHash,
      resourceCount: resolved.repositoryResources.filter((item) => item.status === 'loaded').length,
    });
    if (resolved.error) {
      await this.event(run, null, 'context_resolution_failed', null, resolved.error);
      return executionId;
    }
    await this.enter(run, startNode ?? flow.definition.start, {});
    return executionId;
  }

  /**
   * Decisão humana idempotente: a mesma chave (duplo clique, reenvio) devolve o resultado já
   * registado; uma segunda decisão sobre a mesma etapa é recusada sem novo avanço.
   */
  async decide(actor: User, ticketId: string, raw: unknown): Promise<{ applied: boolean }> {
    const input = parseInput(flowDecisionInputSchema, raw);
    return this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      await findTicket(client, member, ticketId, true);
      const loaded = await this.load(client, ticketId);
      if (!loaded) throw new DomainError('FLOW_NOT_FOUND', 'Este pedido não está num fluxo.', 404);
      if (loaded.execution.suspended_at)
        throw new DomainError(
          'FLOW_SUSPENDED',
          'A Saúde deste ambiente está suspensa. Retome-a para continuar o fluxo.',
          409,
        );
      const previous = (
        await client.query<{ step_id: string }>(
          'SELECT step_id FROM flow_decisions WHERE idempotency_key=$1',
          [input.idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.step_id !== input.stepId)
          throw new DomainError('INVALID_INPUT', 'Chave de decisão reutilizada.', 400);
        return { applied: false };
      }
      const previousReview = (
        await client.query<{ step_id: string }>(
          'SELECT step_id FROM development_review_decisions WHERE idempotency_key=$1',
          [input.idempotencyKey],
        )
      ).rows[0];
      if (previousReview) {
        if (previousReview.step_id !== input.stepId)
          throw new DomainError('INVALID_INPUT', 'Chave de decisão reutilizada.', 400);
        return { applied: false };
      }
      const step = (
        await client.query<StepRow>(
          'SELECT * FROM flow_execution_steps WHERE id=$1 AND execution_id=$2 FOR UPDATE',
          [input.stepId, loaded.execution.id],
        )
      ).rows[0];
      if (!step) throw new DomainError('FLOW_STEP_NOT_FOUND', 'Etapa não encontrada.', 404);
      if (step.status !== 'waiting' || loaded.execution.current_step_id !== step.id)
        throw new DomainError(
          'FLOW_STEP_NOT_ACTIVE',
          'Esta etapa já avançou. Recarregue a página para ver o estado atual.',
          409,
        );
      const node = this.node(loaded, step.node_id);
      if (node?.op !== 'human_decision')
        throw new DomainError('FLOW_STEP_NOT_ACTIVE', 'Esta etapa não espera uma decisão.', 409);
      const option = decisionOptions(node).find((item) => item.port === input.port);
      if (!option) throw new DomainError('INVALID_INPUT', 'Opção inexistente nesta etapa.', 400);
      if (!canDecide(member, node, loaded.ticket))
        throw new DomainError('FORBIDDEN', 'Não é o responsável por esta etapa.', 403);
      const comment = input.comment?.trim() || null;
      if (option.requiresComment && !comment)
        throw new DomainError('COMMENT_REQUIRED', 'Esta opção exige um comentário.', 400);
      const visibility =
        member.role === 'client' ? 'public' : (option.commentVisibility ?? 'internal');
      const review = flowReviewConfig(node);
      let reviewOutput: FlowStepOutput['review'];
      if (review) {
        const outcome = await this.recordReview(loaded, step, review, member, option.port, {
          comment,
          artifactSha: input.artifactSha,
          idempotencyKey: input.idempotencyKey,
        });
        if (comment)
          await appendHumanComment(
            client,
            member,
            ticketId,
            `**${node.label} — ${option.label}** (commit ${outcome.headSha.slice(0, 12)})\n\n${comment}`,
            visibility,
          );
        if (!outcome.complete) return { applied: true };
        reviewOutput = outcome.output;
      }
      await client.query(
        `INSERT INTO flow_decisions(id,step_id,idempotency_key,actor_id,port,comment_body)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), step.id, input.idempotencyKey, member.id, option.port, comment],
      );
      if (comment && !review)
        await appendHumanComment(
          client,
          member,
          ticketId,
          `**${node.label} — ${option.label}**\n\n${comment}`,
          visibility,
        );
      await this.complete(
        loaded,
        step,
        option.port,
        {
          comment,
          commentVisibility: visibility,
          ...(reviewOutput ? { review: reviewOutput } : {}),
        },
        member.id,
        comment ? { comment, actor: member.displayName } : undefined,
      );
      return { applied: true };
    });
  }

  /**
   * Decisão de review sobre o commit exato da etapa de desenvolvimento: tem de referir o head
   * atual (um commit posterior invalida a página aberta), fica ligada ao âmbito (hash) e conta
   * para a regra any/all/quórum. Uma rejeição devolve a etapa ao desenvolvimento de imediato.
   */
  private async recordReview(
    run: Run,
    step: StepRow,
    review: FlowReviewConfig,
    member: User,
    port: string,
    input: { comment: string | null; artifactSha?: string; idempotencyKey: string },
  ): Promise<{ complete: boolean; headSha: string; output: FlowStepOutput['review'] }> {
    const artifact = await reviewArtifact(run.client, run.ticket.id, review.sourceNode);
    if (!artifact)
      throw new DomainError(
        'REVIEW_ARTIFACT_MISSING',
        'Ainda não existe um commit desenvolvido para rever.',
        409,
      );
    if (input.artifactSha !== artifact.headSha)
      throw new DomainError(
        'REVIEW_ARTIFACT_CHANGED',
        'O commit em revisão mudou. Reveja a versão atual antes de decidir.',
        409,
      );
    const right = reviewDecisionRight(member, review, run.ticket.created_by);
    if (port === FLOW_SUCCESS && !artifact.workspace.tests_passed)
      throw new DomainError(
        'REVIEW_TESTS_FAILED',
        'Os testes finais deste commit não passaram; não pode ser aprovado.',
        409,
      );
    const repeated = await run.client.query(
      `SELECT id FROM development_review_decisions
        WHERE step_id=$1 AND actor_id=$2 AND head_sha=$3 AND invalidated_at IS NULL`,
      [step.id, member.id, artifact.headSha],
    );
    if (repeated.rowCount)
      throw new DomainError('REVIEW_ALREADY_DECIDED', 'Já decidiu sobre este commit.', 409);
    await run.client.query(
      `INSERT INTO development_review_decisions(id,ticket_id,step_id,workspace_id,head_sha,scope_hash,
         actor_id,port,comment_body,idempotency_key,override_used)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        run.ticket.id,
        step.id,
        artifact.workspace.id,
        artifact.headSha,
        artifact.scopeHash,
        member.id,
        port,
        input.comment,
        input.idempotencyKey,
        right.override,
      ],
    );
    const eligible = await eligibleReviewers(
      run.client,
      run.ticket.project_id,
      review,
      run.ticket.created_by,
    );
    const required = requiredApprovals(review, eligible.length);
    const approvals = Number(
      (
        await run.client.query<{ total: number }>(
          `SELECT COUNT(DISTINCT actor_id) AS total FROM development_review_decisions
            WHERE step_id=$1 AND head_sha=$2 AND port=$3 AND invalidated_at IS NULL`,
          [step.id, artifact.headSha, FLOW_SUCCESS],
        )
      ).rows[0]?.total ?? 0,
    );
    const output = { approvals, required, headSha: artifact.headSha };
    await this.event(run, step.id, 'review_decision_recorded', member.id, {
      port,
      headSha: artifact.headSha,
      scopeHash: artifact.scopeHash,
      approvals,
      required,
      override: right.override,
    });
    return {
      complete: port !== FLOW_SUCCESS || approvals >= required,
      headSha: artifact.headSha,
      output,
    };
  }

  /**
   * Trabalho do worker: etapas com prazo vencido (verificações, novo pedido ao Copilot) e etapas do
   * Copilot cujo run acabou sem passar pelo hook (ex.: executor reiniciado).
   */
  async tick(limit = 20) {
    const due = await this.db.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM flow_executions
        WHERE status IN ('running','waiting') AND suspended_at IS NULL AND wake_at IS NOT NULL AND wake_at <= $1
          AND NOT EXISTS(SELECT 1 FROM ticket_purge_maintenance p WHERE p.project_id=flow_executions.project_id AND p.lease_until>NOW(3))
        ORDER BY wake_at LIMIT ${Math.max(1, Math.min(limit, 100))}`,
      [this.clock()],
    );
    const orphans = await this.db.query<{ ticket_id: string }>(
      `SELECT e.ticket_id FROM flow_executions e
         JOIN flow_execution_steps s ON s.id=e.current_step_id
         JOIN agent_runs r ON r.id=s.agent_run_id
        WHERE e.status='waiting' AND e.suspended_at IS NULL AND s.status='waiting' AND r.status NOT IN ('queued','running')
          AND NOT EXISTS(SELECT 1 FROM ticket_purge_maintenance p WHERE p.project_id=e.project_id AND p.lease_until>NOW(3))
        LIMIT ${Math.max(1, Math.min(limit, 100))}`,
    );
    const tickets = [...new Set([...due.rows, ...orphans.rows].map((row) => row.ticket_id))];
    for (const ticketId of tickets)
      await this.db.transaction(async (client) => {
        const loaded = await this.load(client, ticketId);
        if (
          !loaded ||
          !['running', 'waiting'].includes(loaded.execution.status) ||
          loaded.execution.suspended_at
        )
          return;
        await client.query('UPDATE flow_executions SET wake_at=NULL WHERE id=$1', [
          loaded.execution.id,
        ]);
        const step = await this.currentStep(loaded);
        const node = step && this.node(loaded, step.node_id);
        if (!step || !node || step.status === 'completed') return;
        if (node.op === 'action') await this.runAction(loaded, node, step);
        else if (node.op === 'copilot_task') {
          if (step.step_output?.awaitingClient) return;
          if (step.agent_run_id) await this.resumeCopilot(loaded, step);
          else await this.startCopilot(loaded, node, step, step.step_input ?? {});
        }
      });
    return tickets.length;
  }

  /**
   * Adoção explícita (P11) de um ticket antigo sem execução: entra no fluxo ativo do projeto na
   * decisão da equipa, sem repetir trabalho já feito. O chamador já bloqueou o ticket e audita.
   * Devolve null quando não há fluxo ativo aplicável ou o projeto está em manutenção.
   */
  async adoptTicket(client: Queryable, ticket: TicketLock) {
    if (await ticketWorkPaused(client, ticket.project_id)) return null;
    await ensureDefaultFlows(client, ticket.project_id);
    const flow = await flowForTicket(client, ticket);
    if (!flow) return null;
    const resumeAt = flow.definition.nodes.find(
      (node) => node.op === 'human_decision' && (node.assignee?.kind ?? 'team') === 'team',
    );
    if (!(await this.start(client, ticket, {}, resumeAt?.id))) return null;
    return (
      (
        await client.query<{ id: string; flow_id: string; version_id: string }>(
          'SELECT id,flow_id,version_id FROM flow_executions WHERE ticket_id=$1',
          [ticket.id],
        )
      ).rows[0] ?? null
    );
  }

  /** Atualiza fluxos de modelo não personalizados para o modelo atual (nova versão publicada). */
  async upgradeTemplates() {
    let upgraded = 0;
    for (const flowId of await legacyTemplateFlows(this.db))
      if (await this.db.transaction((client) => upgradeTemplateFlow(client, flowId))) upgraded += 1;
    for (const flowId of await binaryMigrationFlows(this.db))
      if (await this.db.transaction((client) => migrateFlowToBinary(client, flowId))) upgraded += 1;
    return upgraded;
  }

  // -------------------------------------------------------------------------------------------

  /** Ticket e execução bloqueados (nesta ordem) com a definição da versão da execução. */
  async load(client: Queryable, ticketId: string): Promise<Run | null> {
    const ticket = await lockFlowTicket(client, ticketId);
    if (!ticket) return null;
    if (await ticketWorkPaused(client, ticket.project_id)) return null;
    const execution = (
      await client.query<ExecutionRow>(
        'SELECT * FROM flow_executions WHERE ticket_id=$1 FOR UPDATE',
        [ticketId],
      )
    ).rows[0];
    if (!execution) return null;
    const version = (
      await client.query<{ flow_definition: unknown; runtime_contract_version: number | null }>(
        'SELECT flow_definition,runtime_contract_version FROM flow_versions WHERE id=$1',
        [execution.version_id],
      )
    ).rows[0];
    if (!version || !flowRuntimeSupported(Number(version.runtime_contract_version ?? 1)))
      return null;
    return {
      client,
      ticket,
      execution,
      definition: parseDefinition(version.flow_definition),
      budget: STEP_BUDGET,
    };
  }

  private node(run: Run, nodeId: string) {
    return run.definition.nodes.find((node) => node.id === nodeId);
  }

  private async currentStep(run: Run) {
    if (!run.execution.current_step_id) return null;
    return (
      (
        await run.client.query<StepRow>(
          'SELECT * FROM flow_execution_steps WHERE id=$1 FOR UPDATE',
          [run.execution.current_step_id],
        )
      ).rows[0] ?? null
    );
  }

  private async event(
    run: Run,
    stepId: string | null,
    kind: string,
    actorId: string | null,
    details: Record<string, unknown>,
  ) {
    await run.client.query(
      `INSERT INTO flow_execution_events(id,execution_id,step_id,kind,actor_id,event_details,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), run.execution.id, stepId, kind, actorId, details, this.clock()],
    );
  }

  private async moveTicket(run: Run, to: TicketStatus, actorId: string | null) {
    const current = (
      await run.client.query<{ status: TicketStatus; version: number }>(
        'SELECT status,version FROM tickets WHERE id=$1',
        [run.ticket.id],
      )
    ).rows[0];
    if (!current || current.status === to) return;
    await recordTicketMove(run.client, {
      ticketId: run.ticket.id,
      projectId: run.ticket.project_id,
      from: current.status,
      to,
      version: current.version,
      actorId,
      action: 'flow.step_entered',
    });
    run.ticket = { ...run.ticket, status: to, version: current.version + 1 };
  }

  private async setExecution(run: Run, changes: Partial<ExecutionRow>) {
    const keys = Object.keys(changes) as (keyof ExecutionRow)[];
    if (!keys.length) return;
    await run.client.query(
      `UPDATE flow_executions SET ${keys.map((key, index) => `${key}=$${index + 2}`).join(',')} WHERE id=$1`,
      [run.execution.id, ...keys.map((key) => changes[key] ?? null)],
    );
    run.execution = { ...run.execution, ...changes };
  }

  /** Responsáveis visíveis da etapa (atribuição do ticket ou membros com o papel). */
  private async assigneeView(run: Run, node: FlowNode) {
    const assignee: FlowAssignee = node.assignee ?? { kind: 'team' };
    const users = async (sql: string, values: unknown[]) =>
      (await run.client.query<{ id: string; display_name: string }>(sql, values)).rows;
    const members = `SELECT u.id,u.display_name FROM project_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.project_id=$1 AND NOT m.disabled AND NOT u.disabled`;
    let found: { id: string; display_name: string }[] = [];
    let label = '';
    switch (assignee.kind) {
      case 'role': {
        found = await users(
          `SELECT u.id,u.display_name FROM ticket_assignments a JOIN users u ON u.id=a.user_id
            WHERE a.ticket_id=$1 AND a.stage=$2 AND NOT u.disabled`,
          [run.ticket.id, assignee.role],
        );
        if (!found.length)
          found = await users(`${members} AND m.role=$2 ORDER BY u.display_name LIMIT 20`, [
            run.ticket.project_id,
            assignee.role,
          ]);
        label = roleLabels[assignee.role] ?? assignee.role;
        break;
      }
      case 'user':
        found = await users(`${members} AND u.id=$2`, [run.ticket.project_id, assignee.userId]);
        label = found[0]?.display_name ?? assignee.name ?? 'Utilizador';
        break;
      case 'ticket_author':
        found = await users('SELECT id,display_name FROM users WHERE id=$1', [
          run.ticket.created_by,
        ]);
        label = 'Autor do pedido';
        break;
      case 'team':
        found = await users(
          `${members} AND m.role IN ('admin','technical') ORDER BY u.display_name LIMIT 20`,
          [run.ticket.project_id],
        );
        label = 'Equipa';
        break;
    }
    const names = found.map((user) => user.display_name).join(', ');
    return {
      label: assignee.kind === 'user' || !names ? label : `${label}: ${names}`,
      userIds: found.map((user) => user.id),
    };
  }

  /** Entra numa etapa e executa-a até haver uma espera (pessoa, Copilot, prazo) ou o fim. */
  private async enter(run: Run, nodeId: string, input: StepInput): Promise<void> {
    const node = this.node(run, nodeId);
    if (!node) return this.fail(run, `A etapa «${nodeId}» não existe na versão do fluxo.`);
    run.budget -= 1;
    if (run.budget < 0)
      return this.fail(run, 'Demasiadas etapas seguidas sem espera: o fluxo foi interrompido.');
    const attempt =
      Number(
        (
          await run.client.query<{ last: number | null }>(
            'SELECT MAX(attempt) AS last FROM flow_execution_steps WHERE execution_id=$1 AND node_id=$2',
            [run.execution.id, node.id],
          )
        ).rows[0]?.last ?? 0,
      ) + 1;
    if (flowVisitLimitExceeded(node, attempt))
      return this.fail(
        run,
        `«${node.label}» atingiu o limite de ${maxVisits(node)} passagens. A equipa tem de rever o pedido.`,
      );
    const stepId = randomUUID();
    const now = this.clock();
    const assignee = node.op === 'human_decision' ? await this.assigneeView(run, node) : null;
    await run.client.query(
      `INSERT INTO flow_execution_steps(id,execution_id,node_id,attempt,step_sequence,status,step_assignee,step_input,started_at)
       SELECT $1,$2,$3,$4,COALESCE(MAX(step_sequence),0)+1,'active',$5,$6,$7
         FROM flow_execution_steps WHERE execution_id=$2`,
      [stepId, run.execution.id, node.id, attempt, assignee, input, now],
    );
    await this.setExecution(run, {
      current_node: node.id,
      current_step_id: stepId,
      status: 'running',
      wake_at: null,
    });
    await this.event(run, stepId, 'step_started', null, { nodeId: node.id, attempt });
    const step: StepRow = {
      id: stepId,
      execution_id: run.execution.id,
      node_id: node.id,
      attempt,
      status: 'active',
      step_assignee: assignee,
      step_input: input,
      step_output: null,
      port: null,
      actor_id: null,
      agent_run_id: null,
      started_at: now,
      finished_at: null,
    };
    if (node.op === 'end') return this.finish(run, node, step);
    const status = run.keepStatus ? null : ticketStatusFor(node);
    run.keepStatus = false;
    if (status) await this.moveTicket(run, status, null);
    switch (node.op) {
      case 'human_decision': {
        if (flowDecisionNotRequired(node, input.from))
          return this.complete(
            run,
            step,
            FLOW_SUCCESS,
            { result: 'skipped', reason: 'Decisão não necessária para este resultado.' },
            null,
          );
        await run.client.query("UPDATE flow_execution_steps SET status='waiting' WHERE id=$1", [
          stepId,
        ]);
        await this.setExecution(run, { status: 'waiting' });
        return;
      }
      case 'copilot_task':
        return this.startCopilot(run, node, step, input);
      case 'action':
        return this.runAction(run, node, step);
      case 'condition': {
        // Avaliação declarativa (sem código): factos do ticket e resultado da etapa anterior.
        const port = flowConditionPort(
          node,
          {
            origin: run.ticket.origin,
            category: run.ticket.category,
            environment: run.ticket.environment,
            priority: run.ticket.priority,
          },
          input.from,
        );
        return this.complete(run, step, port, { result: port }, null);
      }
    }
  }

  /** O motor tem executor para esta ação (usado no manifesto de ativação). */
  supportsAction(key: string) {
    return Object.prototype.hasOwnProperty.call(this.actions, key);
  }

  /**
   * Conclui a etapa e entra no destino. O resultado detalhado (ex.: `forbidden`) fica guardado
   * na etapa e decide a saída: a ligação com esse nome (fluxos antigos) ou sucesso/erro.
   */
  private async complete(
    run: Run,
    step: StepRow,
    result: string,
    output: FlowStepOutput,
    actorId: string | null,
    feedback?: StepInput['feedback'],
  ): Promise<void> {
    const node = this.node(run, step.node_id);
    const transition = resolveFlowTransition(
      run.definition,
      step.node_id,
      result,
      step.step_input?.from?.nodeId ?? null,
    );
    const port = transition.port;
    const detailed = { ...output, result: output.result ?? result };
    await run.client.query(
      `UPDATE flow_execution_steps SET status='completed',port=$2,step_output=$3,actor_id=$4,finished_at=$5
        WHERE id=$1`,
      [step.id, port, detailed, actorId, this.clock()],
    );
    await this.event(run, step.id, 'step_completed', actorId, {
      nodeId: step.node_id,
      port,
      result,
    });
    const from = {
      stepId: step.id,
      nodeId: step.node_id,
      label: node?.label ?? step.node_id,
      port,
      result,
    };
    const next = feedback ? { feedback } : {};
    // `needs_information` repete a etapa com a resposta; `retry` volta à etapa anterior.
    if (transition.kind === 'missing')
      return this.fail(
        run,
        `A saída «${portLabel(node, port)}» de «${node?.label ?? step.node_id}» não tem destino.`,
      );
    await this.enter(run, transition.target, { from, ...next });
  }

  private async fail(run: Run, reason: string) {
    if (run.execution.current_step_id)
      await run.client.query(
        "UPDATE flow_execution_steps SET status='failed',finished_at=$2 WHERE id=$1 AND status<>'completed'",
        [run.execution.current_step_id, this.clock()],
      );
    await this.setExecution(run, { status: 'failed', finished_at: this.clock(), wake_at: null });
    await this.event(run, run.execution.current_step_id, 'failed', null, { reason });
    await this.moveTicket(run, 'blocked', null);
    await appendAutomatedComment(run.client, {
      ticketId: run.ticket.id,
      projectId: run.ticket.project_id,
      authorId: run.ticket.created_by,
      visibility: 'internal',
      body: `**Fluxo interrompido:** ${reason}`,
      authorKind: 'system',
    });
  }

  private async finish(run: Run, node: FlowNode, step: StepRow) {
    const outcome = endOutcome(node);
    await run.client.query(
      "UPDATE flow_execution_steps SET status='completed',finished_at=$2 WHERE id=$1",
      [step.id, this.clock()],
    );
    await this.setExecution(run, {
      status: 'completed',
      finished_at: this.clock(),
      wake_at: null,
    });
    await this.event(run, step.id, 'completed', null, { outcome });
    await this.moveTicket(
      run,
      outcome === 'resolved' ? 'resolved' : outcome === 'cancelled' ? 'cancelled' : 'blocked',
      null,
    );
    await closeHealthIncident(run.client, run.ticket.id);
  }

  /** Último resultado do Copilot nesta execução (para mensagens e notas baseadas nele). */
  private async previousCopilot(run: Run) {
    const rows = await run.client.query<{ step_output: FlowStepOutput | null; node_id: string }>(
      `SELECT step_output,node_id FROM flow_execution_steps
        WHERE execution_id=$1 AND status='completed' AND agent_run_id IS NOT NULL
        ORDER BY step_sequence DESC LIMIT 1`,
      [run.execution.id],
    );
    const output = rows.rows[0]?.step_output;
    return {
      summary: output?.summary ?? null,
      replyDraft: output?.replyDraft ?? null,
      patch: output?.patch ?? null,
    };
  }

  private async runAction(run: Run, node: FlowNode, step: StepRow) {
    const executor = this.actions[actionKey(node)];
    if (!executor) return this.fail(run, `A ação «${actionKey(node)}» não está disponível.`);
    const ticket = {
      id: run.ticket.id,
      projectId: run.ticket.project_id,
      createdBy: run.ticket.created_by,
      origin: run.ticket.origin,
    };
    const result = await executor({
      client: run.client,
      ticket,
      node,
      step: { id: step.id, attempt: step.attempt, startedAt: new Date(step.started_at) },
      execution: { id: run.execution.id, definition: run.definition },
      previous: await this.previousCopilot(run),
      now: this.clock(),
      effects: databaseActionEffects(run.client, ticket),
    });
    if ('wait' in result) {
      await run.client.query(
        "UPDATE flow_execution_steps SET status='waiting',step_output=COALESCE($2,step_output) WHERE id=$1",
        [step.id, result.output ?? null],
      );
      await this.setExecution(run, { status: 'waiting', wake_at: result.wait });
      return;
    }
    await this.complete(run, step, result.port, result.output ?? {}, null, result.feedback);
  }

  /** Instruções do run: etapa, contexto de entrada, comentários que a trouxeram e tentativa anterior. */
  private async copilotInstructions(run: Run, node: FlowNode, step: StepRow, input: StepInput) {
    const mode = copilotMode(node);
    const parts: string[] = [];
    const base =
      node.instructions?.trim() ||
      (mode === 'analysis'
        ? (run.execution.execution_context?.agentInstructions ?? AUTO_INVESTIGATION_INSTRUCTIONS)
        : '');
    if (base) parts.push(base);
    if (node.instructions && mode === 'analysis' && step.attempt === 1)
      if (run.execution.execution_context?.agentInstructions)
        parts.push(run.execution.execution_context.agentInstructions);
    if (input.feedback)
      parts.push(
        `Comentário de ${input.feedback.actor ?? 'um responsável'} em «${input.from?.label ?? 'etapa anterior'}» (${input.from?.port ?? ''}): ${input.feedback.comment}`,
      );
    if (step.attempt > 1) {
      const last = (
        await run.client.query<{ step_output: FlowStepOutput | null; attempt: number }>(
          `SELECT step_output,attempt FROM flow_execution_steps
            WHERE execution_id=$1 AND node_id=$2 AND attempt<$3 ORDER BY attempt DESC LIMIT 1`,
          [run.execution.id, node.id, step.attempt],
        )
      ).rows[0];
      if (last?.step_output?.summary)
        parts.push(
          `Tentativa anterior (#${last.attempt}) desta etapa: ${clip(last.step_output.summary, 900)}`,
        );
    }
    if (mode === 'report') {
      const history = await run.client.query<{
        node_id: string;
        port: string | null;
        step_output: FlowStepOutput | null;
      }>(
        `SELECT node_id,port,step_output FROM flow_execution_steps
          WHERE execution_id=$1 AND status='completed' ORDER BY step_sequence`,
        [run.execution.id],
      );
      const lines = history.rows.map((row) => {
        const item = this.node(run, row.node_id);
        const detail =
          row.step_output?.reason ??
          row.step_output?.external ??
          row.step_output?.comment ??
          row.step_output?.summary ??
          '';
        return `- ${item?.label ?? row.node_id}: ${portLabel(item, row.port ?? '')}${detail ? ` — ${clip(detail, 300)}` : ''}`;
      });
      if (lines.length) parts.push(`Percurso do fluxo até aqui:\n${lines.join('\n')}`);
      const patch = history.rows.findLast((row) => row.step_output?.patch)?.step_output?.patch;
      if (patch)
        parts.push(
          `Alteração preparada pelo Copilot (diff guardado no ticket):\n${clip(patch, PATCH_IN_REPORT_LIMIT)}`,
        );
    }
    if (mode === 'develop') {
      const analyses = await run.client.query<{
        node_id: string;
        step_output: FlowStepOutput | null;
      }>(
        `SELECT node_id,step_output FROM flow_execution_steps
          WHERE execution_id=$1 AND status='completed' AND agent_run_id IS NOT NULL
          ORDER BY step_sequence DESC`,
        [run.execution.id],
      );
      const analysis = analyses.rows.find((row) => {
        const item = this.node(run, row.node_id);
        return item && copilotMode(item) === 'analysis' && row.step_output?.summary;
      });
      if (analysis?.step_output?.summary)
        parts.push(
          `Análise de «${this.node(run, analysis.node_id)?.label ?? analysis.node_id}»: ${clip(analysis.step_output.summary, 1200)}`,
        );
      if (developmentNodeConfig(node).repositoryId)
        parts.push(
          'Trabalha diretamente no checkout Git do repositório (diretório atual), numa branch própria já preparada: altera, cria ou apaga os ficheiros necessários. Não executes comandos git (o ZeroOps faz o commit, calcula o diff completo e publica). Usa a ferramenta zeroops_run_tests para correr os testes configurados; só contam os testes executados pelo ZeroOps. No relatório deixa files vazio.',
        );
      else
        parts.push(
          'Copia para o workspace cada ficheiro do site que alterares, no mesmo caminho relativo, e altera-o aí; reporta-os em files. Indica em proposedTests os testes para o QA.',
        );
    }
    return clip(parts.join('\n\n'), INSTRUCTIONS_LIMIT);
  }

  /** Instruções com o contexto do incidente no fim (nunca cortado: o motor lê o relatório). */
  private async instructionsWithIncident(
    run: Run,
    node: FlowNode,
    step: StepRow,
    input: StepInput,
  ) {
    const incident = await incidentInstructionContext(run.client, {
      ticketId: run.ticket.id,
      projectId: run.ticket.project_id,
      definition: run.definition,
      node,
    });
    const base = await this.copilotInstructions(run, node, step, input);
    if (!incident) return base;
    return `${clip(base, Math.max(500, INSTRUCTIONS_LIMIT - incident.length - 2))}\n\n${incident}`;
  }

  /**
   * Modelo pedido pela etapa (ex.: Copilot Fusion high). Se o catálogo do projeto não o tiver,
   * o run segue com o modelo da integração e fica registado o motivo.
   */
  private async stepModel(run: Run, node: FlowNode, step: StepRow) {
    const requested = copilotStepModel(node);
    if (!requested.model && !requested.executionMode) return undefined;
    const candidate = {
      model: requested.model,
      reasoningEffort: requested.model === 'fusion' ? null : requested.reasoningEffort,
      executionMode: requested.executionMode ?? ('copilot' as const),
      fusionTier: requested.model === 'fusion' ? (requested.fusionTier ?? 'high') : null,
    };
    try {
      await new AgentModelsService(this.db).validate(
        run.client,
        run.ticket.project_id,
        candidate.model,
        candidate.reasoningEffort,
        candidate.executionMode,
        candidate.fusionTier,
      );
      return candidate;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await this.event(run, step.id, 'copilot_model_fallback', null, {
        model: candidate.model,
        fusionTier: candidate.fusionTier,
        reason: error.message,
      });
      return undefined;
    }
  }

  private async startCopilot(run: Run, node: FlowNode, step: StepRow, input: StepInput) {
    const mode = copilotMode(node);
    const profile = run.execution.execution_context?.agentProfiles?.[node.id] ?? null;
    const autoInvestigate = node.config.skipWhenAutoDisabled
      ? Boolean(
          (
            await run.client.query<{ auto: boolean }>(
              'SELECT agent_auto_investigate AS auto FROM projects WHERE id=$1',
              [run.ticket.project_id],
            )
          ).rows[0]?.auto,
        )
      : true;
    const ready = await copilotReady(run.client, run.ticket.project_id);
    const author = (
      await run.client.query<{ role: string }>(
        'SELECT role FROM project_memberships WHERE project_id=$1 AND user_id=$2',
        [run.ticket.project_id, run.ticket.created_by],
      )
    ).rows[0];
    const requestedBy =
      author && author.role !== 'client'
        ? run.ticket.created_by
        : await teamRequester(run.client, run.ticket.project_id);
    const block = flowCopilotBlock(node, {
      profile: profile ? { name: profile.definition.name, modes: profile.definition.modes } : null,
      autoInvestigate,
      copilotReady: ready,
      hasTeamMember: Boolean(requestedBy),
    });
    if (block || !requestedBy)
      return this.complete(
        run,
        step,
        'failed',
        block ?? { errorCode: 'no_team_member', reason: 'Não há membros da equipa ativos.' },
        null,
      );
    const instructions = await this.instructionsWithIncident(run, node, step, input);
    let model;
    if (profile) {
      try {
        await this.agentProfiles.validateModel(
          run.client,
          run.ticket.project_id,
          profile.definition,
        );
        model = {
          model: profile.definition.model,
          reasoningEffort: profile.definition.reasoningEffort,
          executionMode: 'copilot' as const,
          fusionTier: profile.definition.fusionTier,
        };
      } catch (error) {
        return this.complete(
          run,
          step,
          'failed',
          {
            errorCode: 'agent_profile_model_unavailable',
            reason: error instanceof Error ? error.message : 'Modelo do perfil indisponível.',
          },
          null,
        );
      }
    } else {
      model = await this.stepModel(run, node, step);
    }
    const selectedPaths = new Set(
      run.execution.execution_context?.repositoryResourcePathsByNode?.[node.id] ??
        this.agentProfiles.nodeResources(node).map((reference) => reference.path),
    );
    const repositoryResources = (run.execution.execution_context?.repositoryResources ?? []).filter(
      (resource) =>
        selectedPaths.has(resource.path) ||
        (resource.reason?.startsWith('skill_resource:') &&
          selectedPaths.has(
            resource.reason.slice('skill_resource:'.length).split('|', 1)[0] ?? '',
          )),
    );
    const snapshotHashes = run.execution.execution_context?.repositorySnapshotHashesByNode;
    const repositorySnapshotHash =
      snapshotHashes && Object.hasOwn(snapshotHashes, node.id)
        ? (snapshotHashes[node.id] ?? null)
        : (run.execution.execution_context?.repositorySnapshotHash ?? null);
    const tools = profile?.definition.allowedTools ?? null;
    const capabilityManifest =
      profile && run.execution.execution_context?.capabilitiesByNode?.[node.id];
    const development = developmentNodeConfig(node);
    let developmentWorkspaceId: string | null = null;
    if (mode === 'develop' && development.repositoryId) {
      const key = (
        await run.client.query<{ key: string }>('SELECT `key` FROM tickets WHERE id=$1', [
          run.ticket.id,
        ])
      ).rows[0]?.key;
      const ensured = await ensureWorkspace(run.client, {
        ticketId: run.ticket.id,
        ticketKey: key ?? run.ticket.id,
        projectId: run.ticket.project_id,
        repositoryId: development.repositoryId,
        nodeId: node.id,
        executionId: run.execution.id,
        publish: development.publish,
      });
      if ('unavailable' in ensured)
        return this.complete(
          run,
          step,
          'failed',
          { errorCode: 'repository_unavailable', reason: ensured.unavailable },
          null,
        );
      developmentWorkspaceId = ensured.workspace.id;
    }
    const runId = await queueAgentRun(run.client, {
      ticketId: run.ticket.id,
      projectId: run.ticket.project_id,
      requestedBy,
      instructions,
      trigger: 'flow',
      ticketVersion: run.ticket.version,
      mode: mode === 'develop' ? 'implement' : 'investigate',
      flowStepId: step.id,
      clientQuestionsAllowed: mode === 'analysis' && node.config.askClient !== false,
      ...(developmentWorkspaceId ? { developmentWorkspaceId } : {}),
      ...(model ? { model } : {}),
      ...(profile
        ? {
            agentProfile: profile,
            repositorySnapshotHash,
            repositoryResources,
            allowedTools: tools ?? [],
            ...(capabilityManifest ? { capabilityManifest } : {}),
          }
        : repositoryResources.length
          ? {
              repositorySnapshotHash,
              repositoryResources,
            }
          : {}),
    });
    if (!runId) {
      // Outro run ativo no ticket: volta a pedir depois.
      await run.client.query(
        "UPDATE flow_execution_steps SET status='waiting',step_input=$2 WHERE id=$1",
        [step.id, { ...input, instructions }],
      );
      await this.setExecution(run, {
        status: 'waiting',
        wake_at: new Date(this.clock().getTime() + RETRY_MS),
      });
      return;
    }
    await run.client.query(
      "UPDATE flow_execution_steps SET status='waiting',agent_run_id=$2,step_input=$3 WHERE id=$1",
      [step.id, runId, { ...input, instructions }],
    );
    await this.setExecution(run, { status: 'waiting' });
    await this.event(run, step.id, 'copilot_requested', null, { runId, mode });
  }

  private async resumeCopilot(run: Run, step: StepRow) {
    const node = this.node(run, step.node_id);
    if (!node || !step.agent_run_id) return;
    const result = (
      await run.client.query<{
        status: string;
        summary: string | null;
        reply_draft: string | null;
        evidence: unknown;
        patch: string | null;
        proposed_tests: unknown;
        client_message_id: string | null;
        error_code: string | null;
      }>(
        `SELECT status,summary,reply_draft,evidence,patch,proposed_tests,client_message_id,error_code
           FROM agent_runs WHERE id=$1`,
        [step.agent_run_id],
      )
    ).rows[0];
    if (!result || ['queued', 'running'].includes(result.status)) return;
    const json = (value: unknown) => {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return null;
      }
    };
    const evidence = json(result.evidence);
    const tests = json(result.proposed_tests);
    const workspace = (
      await run.client.query<{
        id: string;
        branch: string;
        repository_id: string;
        base_sha: string | null;
        head_sha: string | null;
        diff_sha256: string | null;
        tests_passed: boolean;
        files: unknown;
      }>(
        `SELECT w.id,w.branch,w.repository_id,w.base_sha,w.head_sha,w.diff_sha256,w.tests_passed,w.files
           FROM agent_runs r JOIN development_workspaces w ON w.id=r.development_workspace_id
          WHERE r.id=$1`,
        [step.agent_run_id],
      )
    ).rows[0];
    const files = workspace ? json(workspace.files) : null;
    const output: FlowStepOutput = {
      summary: result.summary ?? undefined,
      replyDraft: result.reply_draft,
      evidence: Array.isArray(evidence) ? (evidence as FlowStepOutput['evidence']) : [],
      patch: result.patch,
      proposedTests: Array.isArray(tests) ? (tests as string[]) : [],
      errorCode: result.error_code,
      ...(workspace?.base_sha && workspace.head_sha && workspace.diff_sha256
        ? {
            development: {
              workspaceId: workspace.id,
              branch: workspace.branch,
              baseSha: workspace.base_sha,
              headSha: workspace.head_sha,
              diffSha256: workspace.diff_sha256,
              scopeHash: scopeHash({
                repositoryId: workspace.repository_id,
                baseSha: workspace.base_sha,
                headSha: workspace.head_sha,
                diffSha256: workspace.diff_sha256,
              }),
              testsPassed: Boolean(workspace.tests_passed),
              files: Array.isArray(files) ? files.length : 0,
            },
          }
        : {}),
    };
    const outcome = flowCopilotOutcome(run.definition, node, {
      succeeded: result.status === 'succeeded',
      askedClient: Boolean(result.client_message_id),
    });
    if (outcome === 'await_client') {
      // A análise perguntou algo ao cliente: a etapa espera pela resposta e depois repete-se.
      await run.client.query(
        'UPDATE flow_execution_steps SET agent_run_id=NULL,step_output=$2 WHERE id=$1',
        [
          step.id,
          { ...output, result: 'needs_information', awaitingClient: { runId: step.agent_run_id } },
        ],
      );
      await this.moveTicket(run, 'awaiting_information', null);
      await this.event(run, step.id, 'awaiting_client', null, { runId: step.agent_run_id });
      return;
    }
    await this.complete(run, step, outcome, output, null);
  }
}
