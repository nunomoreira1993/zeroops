import { createHash, randomUUID } from 'node:crypto';
import {
  manualRouteInputSchema,
  ROUTING_MAX_QUESTIONS,
  type FlowRoutingPolicy,
  type FlowSelectionPlan,
  type RoutingDecision,
  type TicketRoutingStatus,
  type TicketRoutingView,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { teamRequester } from '../agents/agent-auto-runs.js';
import { parseInput } from '../identity/identity.validation.js';
import { requireMember, type Queryable } from '../identity/membership.js';
import {
  projectPermissionContext,
  requireProjectPermission,
} from '../identity/project-permissions.js';
import { appendAutomatedComment } from '../tickets/ticket-comments.js';
import { recordTicketMove } from '../tickets/ticket-move.js';
import { ticketWorkPaused } from '../tickets/ticket-purge-health.js';
import { findTicket } from '../tickets/tickets.queries.js';
import type { FlowEngine, TicketLock } from './flow-engine.js';
import { lockFlowTicket } from './flow-engine.js';
import { pinnedFlow, type PublishedFlow } from './flow-store.js';

/** Prazo da resposta do autor a uma pergunta de encaminhamento. */
export const ROUTING_REPLY_HOURS = 72;
/** Falhas transitórias do classificador antes de o encaminhamento ficar pendente. */
export const ROUTING_MAX_FAILURES = 3;
/** Espera antes de nova tentativa depois de uma falha transitória. */
export const ROUTING_RETRY_SECONDS = 60;

/** Candidato fixado na criação do ticket (versão ativa nesse momento e respetiva política). */
export interface PinnedCandidate {
  key: string;
  flowId: string;
  versionId: string;
  versionNumber: number;
  name: string;
  priority: number;
  manifestHash: string | null;
  policy: FlowRoutingPolicy | null;
}

export interface RoutingRow {
  ticket_id: string;
  project_id: string;
  status: TicketRoutingStatus;
  policy_hash: string;
  candidates: unknown;
  fallback: unknown;
  start_context: unknown;
  questions_asked: number;
  failures: number;
  job_seq: number;
  question_id: string | null;
  question_text: string | null;
  question_at: Date | null;
  reply_due_at: Date | null;
  last_decision: unknown;
  resolution: string | null;
  reason: string | null;
  chosen_flow_id: string | null;
  chosen_version_id: string | null;
  routed_by: string | null;
  routed_at: Date | null;
}

/** Lê uma coluna JSON nova (o wrapper da BD só faz parse das colunas JSON conhecidas). */
export function jsonValue<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export const routingCandidates = (row: RoutingRow) =>
  jsonValue<PinnedCandidate[]>(row.candidates) ?? [];
export const routingFallback = (row: RoutingRow) => jsonValue<PinnedCandidate>(row.fallback);

const pin = (flow: PublishedFlow, key: string): PinnedCandidate => ({
  key,
  flowId: flow.id,
  versionId: flow.versionId,
  versionNumber: flow.versionNumber,
  name: flow.name,
  priority: flow.priority,
  manifestHash: flow.manifestHash,
  policy: flow.policy,
});

/** Acrescenta um evento de auditoria interno ao encaminhamento do ticket. */
export async function routingEvent(
  client: Queryable,
  row: { ticket_id: string; project_id: string },
  kind: string,
  details: Record<string, unknown> = {},
  actorId: string | null = null,
  jobId: string | null = null,
) {
  await client.query(
    `INSERT INTO ticket_routing_events(ticket_id,project_id,kind,actor_id,job_id,details)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [row.ticket_id, row.project_id, kind, actorId, jobId, JSON.stringify(details)],
  );
}

/** Bloqueia a linha de encaminhamento do ticket (depois do ticket, antes dos jobs). */
export async function lockRouting(client: Queryable, ticketId: string) {
  return (
    (
      await client.query<RoutingRow>('SELECT * FROM ticket_routing WHERE ticket_id=$1 FOR UPDATE', [
        ticketId,
      ])
    ).rows[0] ?? null
  );
}

/** Nova ronda de classificação (idempotente por `seq`). */
async function enqueueRound(client: Queryable, row: RoutingRow, delaySeconds = 0) {
  const seq = Number(row.job_seq) + 1;
  const jobId = randomUUID();
  await client.query(
    `INSERT INTO ticket_routing_jobs(id,ticket_id,project_id,seq,status,available_at)
     VALUES($1,$2,$3,$4,'queued',TIMESTAMPADD(SECOND,$5,NOW(3)))`,
    [jobId, row.ticket_id, row.project_id, seq, delaySeconds],
  );
  await client.query(
    "UPDATE ticket_routing SET job_seq=$2,status='classifying',version=version+1,updated_at=NOW(3) WHERE ticket_id=$1",
    [row.ticket_id, seq],
  );
  return jobId;
}

/**
 * Fixa os candidatos na criação do ticket e enfileira a primeira classificação. Até à escolha
 * definitiva o ticket não tem execução: nenhum efeito dos fluxos candidatos é executado.
 */
export async function beginRouting(
  client: Queryable,
  ticket: TicketLock,
  plan: Extract<FlowSelectionPlan<PublishedFlow>, { kind: 'classify' }>,
  context: { agentInstructions?: string },
) {
  const candidates = plan.candidates.map((flow, index) => pin(flow, `C${index + 1}`));
  const fallback = plan.fallback ? pin(plan.fallback, 'F') : null;
  const policyHash = createHash('sha256')
    .update(JSON.stringify({ candidates, fallback }))
    .digest('hex');
  const inserted = await client.query(
    `INSERT IGNORE INTO ticket_routing(ticket_id,project_id,status,policy_hash,candidates,fallback,start_context)
     VALUES($1,$2,'classifying',$3,$4,$5,$6)`,
    [
      ticket.id,
      ticket.project_id,
      policyHash,
      JSON.stringify(candidates),
      fallback ? JSON.stringify(fallback) : null,
      JSON.stringify(context),
    ],
  );
  if (!inserted.rowCount) return false;
  const row = (await lockRouting(client, ticket.id))!;
  await routingEvent(client, row, 'started', {
    policyHash,
    candidates: candidates.map(({ key, flowId, versionId, versionNumber, name }) => ({
      key,
      flowId,
      versionId,
      versionNumber,
      name,
    })),
    fallback: fallback
      ? { flowId: fallback.flowId, versionId: fallback.versionId, name: fallback.name }
      : null,
  });
  const jobId = await enqueueRound(client, row);
  await routingEvent(client, row, 'job_queued', { seq: 1 }, null, jobId);
  return true;
}

/**
 * Resposta pública do AUTOR do ticket a uma pergunta de encaminhamento pendente. Só a primeira
 * resposta a cada pergunta retoma a classificação (mensagens/webhooks repetidos não duplicam).
 */
export async function acceptRoutingReply(
  client: Queryable,
  actor: User,
  ticket: TicketLock,
  comment: { id: string } | undefined,
) {
  if (!comment) return false;
  const row = await lockRouting(client, ticket.id);
  if (!row || row.status !== 'awaiting_reply' || !row.question_id) return false;
  if (actor.id !== ticket.created_by) return false;
  const inserted = await client.query(
    `INSERT IGNORE INTO ticket_routing_replies(question_id,ticket_id,comment_id,actor_id)
     VALUES($1,$2,$3,$4)`,
    [row.question_id, ticket.id, comment.id, actor.id],
  );
  if (!inserted.rowCount) return false;
  if (ticket.status === 'awaiting_information') {
    await recordTicketMove(client, {
      ticketId: ticket.id,
      projectId: ticket.project_id,
      from: ticket.status,
      to: 'new',
      version: ticket.version,
      actorId: actor.id,
      action: 'ticket.routing_reply',
    });
  }
  await client.query(
    'UPDATE ticket_routing SET question_id=NULL,question_text=NULL,reply_due_at=NULL WHERE ticket_id=$1',
    [ticket.id],
  );
  await routingEvent(
    client,
    row,
    'reply_received',
    { questionId: row.question_id, commentId: comment.id },
    actor.id,
  );
  const jobId = await enqueueRound(client, row);
  await routingEvent(client, row, 'job_queued', { seq: Number(row.job_seq) + 1 }, null, jobId);
  return true;
}

type Resolution = 'classified' | 'fallback' | 'manual';

/**
 * Decisões e recuperação do encaminhamento. A escolha definitiva associa o fluxo e a versão
 * fixados uma única vez; depois disso nada (regras, novas mensagens) muda o fluxo do ticket.
 */
export class TicketRouter {
  constructor(
    private readonly db: Database,
    private readonly engine: FlowEngine,
  ) {}

  /** Vista para a equipa (o cliente vê apenas a pergunta pública na conversa). */
  async view(actor: User, ticketId: string): Promise<TicketRoutingView | null> {
    return this.db.transaction(async (client) => {
      const member = await requireMember(client, actor);
      const ticket = await findTicket(client, member, ticketId);
      if (member.role === 'client') return null;
      const row = (
        await client.query<RoutingRow>('SELECT * FROM ticket_routing WHERE ticket_id=$1', [
          ticketId,
        ])
      ).rows[0];
      if (!row) return null;
      const access = await projectPermissionContext(client, member, ticket.project_id);
      const canRoute =
        (access.isAdmin || access.permissions.includes('flows.activate')) &&
        ['classifying', 'awaiting_reply', 'pending_manual'].includes(row.status);
      const job = (
        await client.query<{ status: string; attempt: number; error_code: string | null }>(
          'SELECT status,attempt,error_code FROM ticket_routing_jobs WHERE ticket_id=$1 ORDER BY seq DESC LIMIT 1',
          [ticketId],
        )
      ).rows[0];
      const events = (
        await client.query<{
          kind: string;
          actor: string | null;
          details: unknown;
          created_at: Date;
        }>(
          `SELECT e.kind,u.display_name AS actor,e.details,e.created_at FROM ticket_routing_events e
             LEFT JOIN users u ON u.id=e.actor_id WHERE e.ticket_id=$1 ORDER BY e.id DESC LIMIT 50`,
          [ticketId],
        )
      ).rows;
      const routedBy = row.routed_by
        ? ((
            await client.query<{ display_name: string }>(
              'SELECT display_name FROM users WHERE id=$1',
              [row.routed_by],
            )
          ).rows[0]?.display_name ?? null)
        : null;
      const candidates = routingCandidates(row);
      const fallback = routingFallback(row);
      const all = [...candidates, ...(fallback ? [fallback] : [])];
      const chosen = all.find((item) => item.versionId === row.chosen_version_id);
      return {
        status: row.status,
        policyHash: row.policy_hash,
        candidates: all.map((item) => ({
          key: item.key,
          flowId: item.flowId,
          versionId: item.versionId,
          versionNumber: item.versionNumber,
          name: item.name,
          priority: item.priority,
          instructions: item.policy?.instructions ?? '',
          fallback: item.key === 'F',
        })),
        questionsAsked: Number(row.questions_asked),
        pendingQuestion:
          row.status === 'awaiting_reply' && row.question_text && row.question_at
            ? {
                text: row.question_text,
                askedAt: row.question_at.toISOString(),
                replyDueAt: row.reply_due_at?.toISOString() ?? null,
              }
            : null,
        lastDecision: jsonValue<RoutingDecision>(row.last_decision),
        resolution: row.resolution,
        reason: row.reason,
        chosen: chosen
          ? {
              flowId: chosen.flowId,
              versionId: chosen.versionId,
              name: chosen.name,
              versionNumber: chosen.versionNumber,
            }
          : null,
        routedAt: row.routed_at?.toISOString() ?? null,
        routedBy,
        job: job
          ? { status: job.status, attempt: Number(job.attempt), errorCode: job.error_code }
          : null,
        canRoute,
        events: events.map((event) => ({
          kind: event.kind,
          actor: event.actor,
          details: jsonValue<Record<string, unknown>>(event.details) ?? {},
          createdAt: event.created_at.toISOString(),
        })),
      };
    });
  }

  /**
   * Escolha manual pela equipa com permissão de ativar fluxos, sempre entre os candidatos fixados
   * (ou o fallback) do ticket: nunca um fluxo/versão fora desse conjunto.
   */
  async routeManually(actor: User, ticketId: string, raw: unknown) {
    const input = parseInput(manualRouteInputSchema, raw);
    return this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      const found = await findTicket(client, member, ticketId, true);
      if (member.role === 'client')
        throw new DomainError('FORBIDDEN', 'Sem permissão para encaminhar este pedido.', 403);
      await requireProjectPermission(client, member, found.project_id, 'flows.activate', true);
      const ticket = (await lockFlowTicket(client, ticketId))!;
      const row = await lockRouting(client, ticketId);
      if (!row)
        throw new DomainError('ROUTING_NOT_FOUND', 'Este pedido não está em encaminhamento.', 404);
      if (!['classifying', 'awaiting_reply', 'pending_manual'].includes(row.status))
        throw new DomainError('ROUTING_CLOSED', 'O encaminhamento deste pedido já terminou.', 409);
      if (['resolved', 'cancelled'].includes(ticket.status))
        throw new DomainError('ROUTING_CLOSED', 'Este pedido já está fechado.', 409);
      const fallback = routingFallback(row);
      const target = [...routingCandidates(row), ...(fallback ? [fallback] : [])].find(
        (item) => item.versionId === input.versionId,
      );
      if (!target)
        throw new DomainError(
          'ROUTING_CANDIDATE_INVALID',
          'Escolha um dos fluxos candidatos deste pedido.',
          400,
        );
      const routed = await this.finalize(client, ticket, row, target, {
        resolution: 'manual',
        reason: input.reason,
        actorId: member.id,
      });
      if (!routed)
        throw new DomainError(
          'ROUTING_DEPENDENCY_UNAVAILABLE',
          'A versão escolhida já não pode ser executada.',
          409,
        );
      return { applied: true };
    });
  }

  /** Perguntas sem resposta dentro do prazo: não há escolha arbitrária (fallback configurado ou pendente). */
  async expireOverdue(limit = 20) {
    const due = await this.db.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM ticket_routing WHERE status='awaiting_reply' AND reply_due_at<=NOW(3)
        ORDER BY reply_due_at LIMIT ${Math.max(1, Math.min(limit, 100))}`,
    );
    let expired = 0;
    for (const { ticket_id } of due.rows)
      await this.db.transaction(async (client) => {
        const ticket = await lockFlowTicket(client, ticket_id);
        if (!ticket || (await ticketWorkPaused(client, ticket.project_id))) return;
        const row = await lockRouting(client, ticket_id);
        if (!row || row.status !== 'awaiting_reply' || !row.reply_due_at) return;
        if (row.reply_due_at.getTime() > Date.now()) return;
        if (['resolved', 'cancelled'].includes(ticket.status))
          return this.cancel(client, row, 'ticket_closed');
        await routingEvent(client, row, 'reply_timeout', { questionId: row.question_id });
        await this.unresolved(client, ticket, row, 'reply_timeout');
        expired += 1;
      });
    return expired;
  }

  /**
   * Aplica uma decisão validada da ronda atual (ticket, routing e job já bloqueados pelo chamador).
   */
  async applyDecision(
    client: Queryable,
    ticket: TicketLock,
    row: RoutingRow,
    decision: RoutingDecision,
    jobId: string,
  ) {
    await client.query(
      'UPDATE ticket_routing SET last_decision=$2,failures=0,updated_at=NOW(3) WHERE ticket_id=$1',
      [row.ticket_id, JSON.stringify(decision)],
    );
    await routingEvent(client, row, 'decision', { ...decision }, null, jobId);
    if (decision.decision === 'choose') {
      const target = routingCandidates(row).find((item) => item.key === decision.candidate);
      if (target) {
        const routed = await this.finalize(client, ticket, row, target, {
          resolution: 'classified',
          reason: decision.reason,
          actorId: null,
          jobId,
        });
        if (routed) return;
      }
      return this.unresolved(client, ticket, row, 'dependency_unavailable');
    }
    if (decision.decision === 'clarify' && decision.question) {
      if (Number(row.questions_asked) >= ROUTING_MAX_QUESTIONS)
        return this.unresolved(client, ticket, row, 'questions_exhausted');
      return this.ask(client, ticket, row, decision.question, jobId);
    }
    const fallback = routingFallback(row);
    if (decision.decision === 'none' && fallback) {
      const routed = await this.finalize(client, ticket, row, fallback, {
        resolution: 'fallback',
        reason: decision.reason,
        actorId: null,
        jobId,
      });
      if (routed) return;
    }
    return this.unresolved(client, ticket, row, 'no_candidate');
  }

  /**
   * Falha da ronda atual (resposta inválida, Copilot indisponível): nova tentativa com espera ou,
   * esgotadas as tentativas/sem Copilot configurado, encaminhamento não resolvido.
   */
  async failRound(
    client: Queryable,
    ticket: TicketLock,
    row: RoutingRow,
    code: string,
    jobId: string,
  ) {
    const failures = Number(row.failures) + 1;
    await client.query(
      'UPDATE ticket_routing SET failures=$2,updated_at=NOW(3) WHERE ticket_id=$1',
      [row.ticket_id, failures],
    );
    await routingEvent(client, row, 'classifier_failed', { code, failures }, null, jobId);
    if (code === 'copilot_not_configured' || failures >= ROUTING_MAX_FAILURES)
      return this.unresolved(client, ticket, row, 'classifier_unavailable');
    const next = await enqueueRound(client, row, ROUTING_RETRY_SECONDS);
    await routingEvent(
      client,
      row,
      'job_queued',
      { seq: Number(row.job_seq) + 1, retry: true },
      null,
      next,
    );
  }

  /** Ticket fechado durante o encaminhamento: termina sem associar fluxo. */
  async cancel(client: Queryable, row: RoutingRow, reason: string) {
    await client.query(
      "UPDATE ticket_routing SET status='cancelled',reason=$2,question_id=NULL,reply_due_at=NULL,version=version+1,updated_at=NOW(3) WHERE ticket_id=$1",
      [row.ticket_id, reason],
    );
    await client.query(
      "UPDATE ticket_routing_jobs SET status='cancelled',finished_at=NOW(3) WHERE ticket_id=$1 AND status='queued'",
      [row.ticket_id],
    );
    await routingEvent(client, row, 'cancelled', { reason });
  }

  private async ask(
    client: Queryable,
    ticket: TicketLock,
    row: RoutingRow,
    question: string,
    jobId: string,
  ) {
    const author = (await teamRequester(client, ticket.project_id)) ?? ticket.created_by;
    await appendAutomatedComment(client, {
      ticketId: ticket.id,
      projectId: ticket.project_id,
      authorId: author,
      visibility: 'public',
      body: question,
      authorKind: 'agent',
    });
    const questionId = randomUUID();
    await client.query(
      `UPDATE ticket_routing SET status='awaiting_reply',question_id=$2,question_text=$3,question_at=NOW(3),
         reply_due_at=TIMESTAMPADD(HOUR,$4,NOW(3)),questions_asked=questions_asked+1,
         version=version+1,updated_at=NOW(3)
       WHERE ticket_id=$1`,
      [row.ticket_id, questionId, question, ROUTING_REPLY_HOURS],
    );
    if (ticket.status === 'new' || ticket.status === 'investigating') {
      await recordTicketMove(client, {
        ticketId: ticket.id,
        projectId: ticket.project_id,
        from: ticket.status,
        to: 'awaiting_information',
        version: ticket.version,
        actorId: null,
        action: 'ticket.routing_question',
      });
    }
    await routingEvent(client, row, 'question_asked', { questionId, question }, null, jobId);
  }

  /** Sem escolha definitiva: fallback se o projeto o configurou para estes casos; senão, pendente. */
  private async unresolved(client: Queryable, ticket: TicketLock, row: RoutingRow, reason: string) {
    const fallback = routingFallback(row);
    if (fallback?.policy?.fallbackOnUnresolved) {
      const routed = await this.finalize(client, ticket, row, fallback, {
        resolution: 'fallback',
        reason,
        actorId: null,
      });
      if (routed) return;
    }
    await client.query(
      `UPDATE ticket_routing SET status='pending_manual',reason=$2,question_id=NULL,question_text=NULL,
         reply_due_at=NULL,version=version+1,updated_at=NOW(3)
       WHERE ticket_id=$1`,
      [row.ticket_id, reason],
    );
    await client.query(
      "UPDATE ticket_routing_jobs SET status='cancelled',finished_at=NOW(3) WHERE ticket_id=$1 AND status='queued'",
      [row.ticket_id],
    );
    if (ticket.status === 'awaiting_information')
      await recordTicketMove(client, {
        ticketId: ticket.id,
        projectId: ticket.project_id,
        from: ticket.status,
        to: 'new',
        version: ticket.version,
        actorId: null,
        action: 'ticket.routing_pending',
      });
    await routingEvent(client, row, 'pending_manual', { reason });
  }

  /** Associação definitiva (uma única vez) ao fluxo e versão fixados, com o manifesto dessa versão. */
  private async finalize(
    client: Queryable,
    ticket: TicketLock,
    row: RoutingRow,
    target: PinnedCandidate,
    info: { resolution: Resolution; reason: string; actorId: string | null; jobId?: string },
  ) {
    const flow = await pinnedFlow(client, ticket.project_id, target.flowId, target.versionId);
    if (!flow) {
      await routingEvent(client, row, 'dependency_unavailable', {
        flowId: target.flowId,
        versionId: target.versionId,
      });
      return false;
    }
    let current = ticket;
    if (current.status === 'awaiting_information') {
      await recordTicketMove(client, {
        ticketId: current.id,
        projectId: current.project_id,
        from: current.status,
        to: 'new',
        version: current.version,
        actorId: info.actorId,
        action: 'ticket.routing_routed',
      });
      current = { ...current, status: 'new', version: current.version + 1 };
    }
    const context = jsonValue<{ agentInstructions?: string }>(row.start_context) ?? {};
    await this.engine.startWith(client, current, flow, context);
    await client.query(
      `UPDATE ticket_routing SET status='routed',chosen_flow_id=$2,chosen_version_id=$3,resolution=$4,
         reason=$5,routed_by=$6,routed_at=NOW(3),question_id=NULL,question_text=NULL,reply_due_at=NULL,
         version=version+1,updated_at=NOW(3)
       WHERE ticket_id=$1`,
      [
        row.ticket_id,
        target.flowId,
        target.versionId,
        info.resolution,
        info.reason.slice(0, 600),
        info.actorId,
      ],
    );
    await client.query(
      "UPDATE ticket_routing_jobs SET status='cancelled',finished_at=NOW(3) WHERE ticket_id=$1 AND status='queued'",
      [row.ticket_id],
    );
    await routingEvent(
      client,
      row,
      'routed',
      {
        key: target.key,
        flowId: target.flowId,
        versionId: target.versionId,
        versionNumber: target.versionNumber,
        name: target.name,
        manifestHash: target.manifestHash,
        resolution: info.resolution,
      },
      info.actorId,
      info.jobId ?? null,
    );
    return true;
  }
}
