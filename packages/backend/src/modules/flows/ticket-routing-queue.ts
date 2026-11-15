import { parseRoutingDecision, RoutingReplyError } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import type { Queryable } from '../identity/membership.js';
import { ticketWorkPaused } from '../tickets/ticket-purge-health.js';
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
} from '../agents/job-leases.js';
import type { ClaimedAssistantRequest } from './flow-assistant.js';
import { buildRoutingPrompt, type RoutingPromptInput } from './routing-prompt.js';
import { lockFlowTicket, type TicketLock } from './flow-engine.js';
import {
  jsonValue,
  lockRouting,
  routingCandidates,
  routingEvent,
  type RoutingRow,
  type TicketRouter,
} from './ticket-routing.js';

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

interface JobRow {
  id: string;
  ticket_id: string;
  project_id: string;
  seq: number;
  status: string;
  attempt: number;
  worker_id: string | null;
  lease_epoch: number;
}

const closed = (ticket: TicketLock) => ['resolved', 'cancelled'].includes(ticket.status);

/** Prompt do classificador para a ronda atual (pedido, candidatos fixados e conversa). */
async function routingPrompt(client: Queryable, row: RoutingRow) {
  const ticket = (
    await client.query<RoutingPromptInput['ticket']>(
      'SELECT `key`,title,description,category,environment,priority,origin FROM tickets WHERE id=$1',
      [row.ticket_id],
    )
  ).rows[0];
  if (!ticket) throw new Error('Ticket indisponível.');
  const questions = (
    await client.query<{ details: unknown; created_at: Date }>(
      "SELECT details,created_at FROM ticket_routing_events WHERE ticket_id=$1 AND kind='question_asked' ORDER BY id",
      [row.ticket_id],
    )
  ).rows.map((event) => jsonValue<{ questionId: string; question: string }>(event.details));
  const replies = new Map(
    (
      await client.query<{ question_id: string; body: string }>(
        `SELECT r.question_id,c.body FROM ticket_routing_replies r JOIN ticket_comments c ON c.id=r.comment_id
          WHERE r.ticket_id=$1`,
        [row.ticket_id],
      )
    ).rows.map((reply) => [reply.question_id, reply.body]),
  );
  return buildRoutingPrompt({
    ticket,
    candidates: routingCandidates(row),
    conversation: questions
      .filter((item): item is { questionId: string; question: string } => Boolean(item))
      .map((item) => ({ question: item.question, reply: replies.get(item.questionId) ?? null })),
    questionsAsked: Number(row.questions_asked),
  });
}

/**
 * Fila das rondas de classificação. Segue o modelo de leases do P03: claim atómico, heartbeat,
 * fencing por época e recuperação; só a ronda atual do ticket pode aplicar uma decisão.
 */
export class TicketRoutingQueue {
  constructor(
    private readonly db: Database,
    private readonly router: TicketRouter,
  ) {}

  /** Reclama atomicamente a próxima ronda de classificação disponível, com lease e época novos. */
  async claimNext(worker: WorkerIdentity = LOCAL_WORKER): Promise<ClaimedAssistantRequest | null> {
    validateWorker(worker);
    return this.db.transaction(async (client) => {
      const job = (
        await client.query<JobRow>(
          `SELECT * FROM ticket_routing_jobs WHERE status='queued' AND available_at<=NOW(3)
              AND NOT EXISTS(SELECT 1 FROM ticket_purge_maintenance p WHERE p.project_id=ticket_routing_jobs.project_id AND p.lease_until>NOW(3))
            ORDER BY available_at,created_at LIMIT 1 FOR UPDATE`,
        )
      ).rows[0];
      if (!job) return null;
      if (await ticketWorkPaused(client, job.project_id)) return null;
      const row = (
        await client.query<RoutingRow>('SELECT * FROM ticket_routing WHERE ticket_id=$1', [
          job.ticket_id,
        ])
      ).rows[0];
      if (!row || row.status !== 'classifying' || Number(row.job_seq) !== Number(job.seq)) {
        await client.query(
          "UPDATE ticket_routing_jobs SET status='cancelled',finished_at=NOW(3) WHERE id=$1 AND status='queued'",
          [job.id],
        );
        return null;
      }
      const claimed = await client.query(
        `UPDATE ticket_routing_jobs SET status='running', started_at=COALESCE(started_at,NOW(3)),
           worker_id=$2, lease_epoch=lease_epoch+1, attempt=attempt+1,
           lease_until=TIMESTAMPADD(SECOND,$3,NOW(3)), heartbeat_at=NOW(3)
         WHERE id=$1 AND status='queued'`,
        [job.id, worker.workerId, worker.leaseSeconds],
      );
      if (!claimed.rowCount) return null;
      const owned = (
        await client.query<{ lease_epoch: number; attempt: number }>(
          'SELECT lease_epoch,attempt FROM ticket_routing_jobs WHERE id=$1',
          [job.id],
        )
      ).rows[0]!;
      const lease: JobLease = {
        jobId: job.id,
        workerId: worker.workerId,
        epoch: Number(owned.lease_epoch),
        leaseSeconds: worker.leaseSeconds,
      };
      await this.event(client, job, lease, Number(owned.attempt), 'claimed');
      try {
        return {
          id: job.id,
          projectId: job.project_id,
          scope: 'routing',
          prompt: await routingPrompt(client, row),
          lease,
        };
      } catch {
        await client.query(
          "UPDATE ticket_routing_jobs SET status='failed',error_code='context_unavailable',finished_at=NOW(3),lease_until=NULL WHERE id=$1",
          [job.id],
        );
        return null;
      }
    });
  }

  /** Renova o lease se a tentativa ainda for a atual; indica perda de posse ou cancelamento. */
  async heartbeat(lease: JobLease): Promise<HeartbeatState> {
    const renewed = await this.db.query(
      `UPDATE ticket_routing_jobs SET lease_until=TIMESTAMPADD(SECOND,$4,NOW(3)), heartbeat_at=NOW(3)
       WHERE ${OWNED_BY()}`,
      [lease.jobId, lease.workerId, lease.epoch, lease.leaseSeconds],
    );
    if (renewed.rowCount) return { owned: true, cancelRequested: false };
    await this.rejectStale(this.db, lease, 'lease_lost');
    return { owned: false, cancelRequested: true };
  }

  /** Valida e aplica a decisão, apenas pela tentativa com o lease atual e na ronda atual. */
  async complete(lease: JobLease, text: string): Promise<FencedOutcome> {
    return this.owned(lease, 'succeeded', async (client, ticket, row, job) => {
      await client.query(
        "UPDATE ticket_routing_jobs SET status='succeeded',reply=$2,finished_at=NOW(3),lease_until=NULL WHERE id=$1",
        [job.id, JSON.stringify({ text: clip(text, 8000) })],
      );
      await this.event(client, job, lease, Number(job.attempt), 'completed');
      if (!row) return;
      let decision;
      try {
        const candidates = routingCandidates(row);
        decision = parseRoutingDecision(
          text,
          candidates.map((item) => item.key),
          candidates.map((item) => item.name),
        );
      } catch (error) {
        if (!(error instanceof RoutingReplyError)) throw error;
        await routingEvent(client, row, 'invalid_reply', { message: error.message }, null, job.id);
        return this.router.failRound(client, ticket, row, 'invalid_response', job.id);
      }
      await this.router.applyDecision(client, ticket, row, decision, job.id);
    });
  }

  /** Regista a falha da tentativa atual (retry diferido ou escolha manual); tentativas antigas são rejeitadas. */
  async fail(lease: JobLease, code: string): Promise<FencedOutcome> {
    return this.owned(lease, 'failed', async (client, ticket, row, job) => {
      await client.query(
        "UPDATE ticket_routing_jobs SET status='failed',error_code=$2,finished_at=NOW(3),lease_until=NULL WHERE id=$1",
        [job.id, clip(code, 100)],
      );
      await this.event(client, job, lease, Number(job.attempt), 'failed', { code });
      if (row) await this.router.failRound(client, ticket, row, code, job.id);
    });
  }

  /** Devolve a ronda à fila sem consumir tentativa (paragem ordenada do executor). */
  async release(lease: JobLease, reason = 'shutdown'): Promise<FencedOutcome> {
    return this.db.transaction(async (client) => {
      const job = (
        await client.query<JobRow>(
          `SELECT * FROM ticket_routing_jobs WHERE ${OWNED_BY()} FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!job) return this.rejectStale(client, lease, 'stale_attempt_rejected');
      await client.query(
        `UPDATE ticket_routing_jobs SET status='queued', worker_id=NULL, lease_until=NULL,
           heartbeat_at=NULL, attempt=GREATEST(attempt-1,0) WHERE id=$1`,
        [job.id],
      );
      await this.event(client, job, lease, Number(job.attempt), 'released', { reason });
      return 'accepted';
    });
  }

  /**
   * Rondas `running` com lease expirado voltam à fila uma vez; depois falham e contam como falha
   * transitória do classificador. Rondas vivas de outros executores ficam intactas.
   */
  async recoverExpired(maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    const outcome = { requeued: 0, failed: 0 };
    const expired = await this.db.query<{ id: string; ticket_id: string }>(
      "SELECT id,ticket_id FROM ticket_routing_jobs WHERE status='running' AND (lease_until IS NULL OR lease_until<=NOW(3)) LIMIT 50",
    );
    for (const { id, ticket_id } of expired.rows)
      await this.db.transaction(async (client) => {
        const ticket = await lockFlowTicket(client, ticket_id);
        const row = await lockRouting(client, ticket_id);
        const job = (
          await client.query<JobRow>(
            `SELECT * FROM ticket_routing_jobs WHERE id=$1 AND status='running'
               AND (lease_until IS NULL OR lease_until<=NOW(3)) FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!job || !ticket) return;
        const lease: JobLease = {
          jobId: id,
          workerId: job.worker_id ?? '',
          epoch: Number(job.lease_epoch),
          leaseSeconds: 0,
        };
        if (Number(job.attempt) < maxAttempts) {
          await client.query(
            "UPDATE ticket_routing_jobs SET status='queued', worker_id=NULL, lease_until=NULL, heartbeat_at=NULL WHERE id=$1",
            [id],
          );
          await this.event(client, job, lease, Number(job.attempt), 'lease_expired_requeued');
          outcome.requeued += 1;
          return;
        }
        await client.query(
          "UPDATE ticket_routing_jobs SET status='failed',error_code='interrupted',finished_at=NOW(3),lease_until=NULL WHERE id=$1",
          [id],
        );
        await this.event(client, job, lease, Number(job.attempt), 'lease_expired_failed');
        if (row && this.current(ticket, row, job))
          await this.router.failRound(client, ticket, row, 'interrupted', id);
        outcome.failed += 1;
      });
    return outcome;
  }

  private current(ticket: TicketLock, row: RoutingRow, job: JobRow) {
    return (
      !closed(ticket) && row.status === 'classifying' && Number(row.job_seq) === Number(job.seq)
    );
  }

  /**
   * Bloqueia ticket → routing → ronda (ordem fixa) e exige a posse atual. Uma ronda antiga ou de
   * um ticket já fechado termina sem efeitos sobre o encaminhamento.
   */
  private async owned(
    lease: JobLease,
    terminal: 'succeeded' | 'failed',
    apply: (
      client: Queryable,
      ticket: TicketLock,
      row: RoutingRow | null,
      job: JobRow,
    ) => Promise<void>,
  ): Promise<FencedOutcome> {
    return this.db.transaction(async (client) => {
      const peek = (
        await client.query<{ ticket_id: string }>(
          'SELECT ticket_id FROM ticket_routing_jobs WHERE id=$1',
          [lease.jobId],
        )
      ).rows[0];
      if (!peek) return 'stale';
      const ticket = await lockFlowTicket(client, peek.ticket_id);
      const row = await lockRouting(client, peek.ticket_id);
      const job = (
        await client.query<JobRow>(
          `SELECT * FROM ticket_routing_jobs WHERE ${OWNED_BY()} FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!job || !ticket)
        return this.rejectStale(client, lease, 'stale_attempt_rejected', terminal);
      if (row && closed(ticket) && ['classifying', 'awaiting_reply'].includes(row.status))
        await this.router.cancel(client, row, 'ticket_closed');
      const current = row && this.current(ticket, row, job) ? row : null;
      if (row && !current)
        await routingEvent(
          client,
          row,
          'stale_result_ignored',
          { seq: Number(job.seq) },
          null,
          job.id,
        );
      await apply(client, ticket, current, job);
      return 'accepted';
    });
  }

  private async rejectStale(
    client: Queryable,
    lease: JobLease,
    type: JobEventType,
    terminal?: string,
  ): Promise<FencedOutcome> {
    const row = (
      await client.query<JobRow>('SELECT * FROM ticket_routing_jobs WHERE id=$1', [lease.jobId])
    ).rows[0];
    if (!row) return 'stale';
    if (
      terminal &&
      row.status === terminal &&
      row.worker_id === lease.workerId &&
      Number(row.lease_epoch) === lease.epoch
    )
      return 'duplicate';
    await this.event(client, row, lease, Number(row.attempt), type, {
      currentEpoch: Number(row.lease_epoch),
      currentStatus: row.status,
    });
    return 'stale';
  }

  private async event(
    client: Queryable,
    job: JobRow,
    lease: JobLease,
    attempt: number,
    type: JobEventType,
    details?: Record<string, unknown>,
  ) {
    await recordJobEvent(client, {
      kind: 'ticket_routing',
      jobId: job.id,
      projectId: job.project_id,
      ticketId: job.ticket_id,
      attempt,
      epoch: lease.epoch,
      workerId: lease.workerId || null,
      type,
      details,
    });
  }
}
