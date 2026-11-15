import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  emptyUsage,
  quotaSnapshot,
  UsageAccumulator,
  type AgentQuestion,
  type AgentQuota,
  type AgentRunEvent,
  type AgentRunEventPayload,
  type AgentRunInput,
  type AgentUsage,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { requireMember, type Queryable } from '../identity/membership.js';
import { findTicket, validateTicketId } from '../tickets/tickets.queries.js';
import { OWNED_BY, type JobLease } from './job-leases.js';

export type { AgentRunEvent, AgentRunEventPayload, AgentRunInput };

/** Entrada da equipa entregue ao executor. */
export interface ClaimedInput {
  kind: 'answer' | 'message';
  questionId: string | null;
  text: string;
}

const inputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('answer'),
    questionId: z.string().trim().min(1).max(100),
    text: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({ kind: z.literal('message'), text: z.string().trim().min(1).max(4000) }),
]);

const PAGE_LIMIT = 500;

interface EventRow {
  id: number | string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

function toEvent(row: EventRow): AgentRunEvent {
  return {
    ...(row.payload as AgentRunEventPayload),
    type: row.type as AgentRunEventPayload['type'],
    id: Number(row.id),
    createdAt: row.created_at.toISOString(),
  } as AgentRunEvent;
}

/**
 * Perguntas por responder, por run: a última pergunta de cada run sem evento `answer` correspondente.
 * Só se aplica a runs em execução (um run terminado já não espera respostas).
 */
export async function pendingQuestions(
  db: Queryable,
  runIds: string[],
): Promise<Map<string, AgentQuestion>> {
  const pending = new Map<string, AgentQuestion>();
  if (!runIds.length) return pending;
  const placeholders = runIds.map((_, index) => `$${index + 1}`).join(',');
  const result = await db.query<EventRow & { run_id: string }>(
    `SELECT e.id,e.run_id,e.type,e.payload,e.created_at FROM agent_run_events e
     JOIN agent_runs r ON r.id=e.run_id AND r.status='running'
     WHERE e.run_id IN (${placeholders}) AND e.type IN ('question','answer') ORDER BY e.id`,
    runIds,
  );
  for (const row of result.rows) {
    const event = toEvent(row);
    if (event.type === 'question')
      pending.set(row.run_id, {
        questionId: event.questionId,
        kind: event.kind,
        question: event.question,
        choices: event.choices,
        allowFreeform: event.allowFreeform,
      });
    else if (event.type === 'answer' && pending.get(row.run_id)?.questionId === event.questionId)
      pending.delete(row.run_id);
  }
  return pending;
}

/**
 * Reconstrói consumo reportado por recibos únicos; os eventos originais ficam intactos.
 * A quota é apenas um snapshot da conta e nunca é usada para atribuir custo a este run.
 */
export async function runUsage(
  db: Queryable,
  runIds: string[],
): Promise<Map<string, { usage: AgentUsage | null; quota: AgentQuota | null }>> {
  const byRun = new Map<string, { usage: AgentUsage | null; quota: AgentQuota | null }>();
  if (!runIds.length) return byRun;
  const placeholders = runIds.map((_, index) => `$${index + 1}`).join(',');
  const result = await db.query<EventRow & { run_id: string }>(
    `SELECT id,run_id,type,payload,created_at FROM agent_run_events
     WHERE run_id IN (${placeholders}) AND type IN ('usage','quota','user.message') ORDER BY id`,
    runIds,
  );
  const accumulators = new Map<string, UsageAccumulator>();
  for (const row of result.rows) {
    const entry = byRun.get(row.run_id) ?? { usage: null, quota: null };
    const accumulator = accumulators.get(row.run_id) ?? new UsageAccumulator();
    accumulators.set(row.run_id, accumulator);
    const event = toEvent(row);
    if (event.type === 'quota') {
      entry.quota = quotaSnapshot(event);
    } else if (event.type === 'user.message') {
      accumulator.userRequest();
    } else if (event.type === 'usage') {
      entry.usage ??= emptyUsage();
      accumulator.add(event, entry.usage);
    }
    byRun.set(row.run_id, entry);
  }
  return byRun;
}

/**
 * Conversa ao vivo de um run: o executor publica eventos e consome as entradas; a equipa lê os
 * eventos (por polling ou SSE) e responde às perguntas ou envia mensagens de seguimento.
 */
export class AgentRunEventsService {
  constructor(private readonly db: Database) {}

  /**
   * Publica eventos do executor por ordem. Os payloads devem já vir limitados e sem segredos. Com
   * `lease`, só a tentativa que detém a posse escreve (devolve `false` a uma tentativa antiga).
   */
  async append(runId: string, events: AgentRunEventPayload[], lease?: JobLease) {
    if (!events.length) return true;
    if (lease && !(await this.owns(runId, lease))) return false;
    const values: unknown[] = [];
    const rows = events.map((event, index) => {
      const { type, ...payload } = event;
      values.push(runId, type, JSON.stringify(payload));
      const base = index * 3;
      return `($${base + 1},$${base + 2},$${base + 3})`;
    });
    await this.db.query(
      `INSERT INTO agent_run_events(run_id,type,payload) VALUES ${rows.join(',')}`,
      values,
    );
    const observedModels = events
      .filter((event) => event.type === 'usage' && 'model' in event)
      .map((event) => ('model' in event && typeof event.model === 'string' ? event.model : null))
      .filter((model): model is string => Boolean(model))
      .slice(-16);
    if (observedModels.length)
      await this.db.query(
        "UPDATE agent_runs SET effective_model=$2 WHERE id=$1 AND status='running'",
        [runId, observedModels.at(-1)!.slice(0, 100)],
      );
    return true;
  }

  private async owns(runId: string, lease: JobLease) {
    if (lease.jobId !== runId) return false;
    const owned = await this.db.query(`SELECT id FROM agent_runs WHERE ${OWNED_BY()}`, [
      lease.jobId,
      lease.workerId,
      lease.epoch,
    ]);
    return Boolean(owned.rowCount);
  }

  /** Eventos posteriores a `afterId`, apenas para a equipa do projeto do ticket. */
  async listSince(
    actor: User,
    ticketId: string,
    runId: string,
    afterId = 0,
  ): Promise<{ events: AgentRunEvent[]; status: string }> {
    const run = await this.authorize(this.db, actor, ticketId, runId);
    const result = await this.db.query<EventRow>(
      `SELECT id,type,payload,created_at FROM agent_run_events
       WHERE run_id=$1 AND id>$2 ORDER BY id LIMIT ${PAGE_LIMIT}`,
      [runId, Math.max(0, Math.trunc(afterId) || 0)],
    );
    return { events: result.rows.map(toEvent), status: run.status };
  }

  /** Regista uma resposta ou mensagem da equipa para o executor consumir. */
  async submitInput(actor: User, ticketId: string, runId: string, raw: unknown) {
    const input = inputSchema.parse(raw);
    return this.db.transaction(async (client) => {
      const run = await this.authorize(client, actor, ticketId, runId, true);
      if (run.status !== 'running' || run.cancel_requested)
        throw new DomainError('AGENT_RUN_NOT_RUNNING', 'A execução já não está ativa.', 409);
      if (input.kind === 'answer') {
        const pending = (await pendingQuestions(client, [runId])).get(runId);
        if (pending?.questionId !== input.questionId)
          throw new DomainError('AGENT_QUESTION_NOT_PENDING', 'A pergunta já não está ativa.', 409);
      }
      const id = randomUUID();
      await client.query(
        'INSERT INTO agent_run_inputs(id,run_id,kind,question_id,body,author_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          runId,
          input.kind,
          input.kind === 'answer' ? input.questionId : null,
          input.text,
          run.memberId,
        ],
      );
      const event: AgentRunEventPayload =
        input.kind === 'answer'
          ? {
              type: 'answer',
              questionId: input.questionId,
              answer: input.text,
              author: actor.displayName,
            }
          : { type: 'user.message', text: input.text, author: actor.displayName };
      const { type, ...payload } = event;
      await client.query('INSERT INTO agent_run_events(run_id,type,payload) VALUES($1,$2,$3)', [
        runId,
        type,
        JSON.stringify(payload),
      ]);
      await client.query(
        'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,$2,$3,$4,$5)',
        [
          randomUUID(),
          run.memberId,
          run.ticket_id,
          `agent.run_${input.kind}`,
          JSON.stringify({ runId, inputId: id }),
        ],
      );
      return { id };
    });
  }

  /** Entrega ao executor as entradas ainda não consumidas e marca-as como consumidas. */
  async claimInputs(runId: string, lease?: JobLease): Promise<ClaimedInput[]> {
    if (lease && !(await this.owns(runId, lease))) return [];
    return this.db.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        kind: 'answer' | 'message';
        question_id: string | null;
        body: string;
      }>(
        'SELECT id,kind,question_id,body FROM agent_run_inputs WHERE run_id=$1 AND consumed_at IS NULL ORDER BY created_at,id FOR UPDATE',
        [runId],
      );
      if (!result.rowCount) return [];
      const ids = result.rows.map((row) => row.id);
      await client.query(
        `UPDATE agent_run_inputs SET consumed_at=NOW(3) WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`,
        ids,
      );
      return result.rows.map((row) => ({
        kind: row.kind,
        questionId: row.question_id,
        text: row.body,
      }));
    });
  }

  private async authorize(
    db: Queryable,
    actor: User,
    ticketId: string,
    runId: string,
    lock = false,
  ) {
    validateTicketId(runId);
    const member = await requireMember(db, actor, lock);
    if (member.role === 'client')
      throw new DomainError('FORBIDDEN', 'A investigação do agente é reservada à equipa.', 403);
    const ticket = await findTicket(db, actor, ticketId);
    const run = (
      await db.query<{ ticket_id: string; status: string; cancel_requested: boolean }>(
        `SELECT ticket_id,status,cancel_requested FROM agent_runs WHERE id=$1 AND ticket_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [runId, ticket.id],
      )
    ).rows[0];
    if (!run) throw new DomainError('AGENT_RUN_NOT_FOUND', 'Execução não encontrada.', 404);
    return { ...run, memberId: member.id };
  }
}
