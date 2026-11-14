import { randomUUID } from 'node:crypto';
import type { TicketStatus, User } from '../../../../contracts/src/index.js';
import type { Queryable } from '../identity/membership.js';
import { recordTicketMove } from '../tickets/ticket-move.js';
import { appendAutomatedComment } from '../tickets/ticket-comments.js';

/** Runs automáticos seguidos (retomados pelo cliente) antes de exigir intervenção da equipa. */
export const MAX_CLIENT_REPLY_RUNS = 3;

export const CLIENT_REPLY_INSTRUCTIONS =
  'O cliente respondeu às perguntas enviadas. Lê a resposta na conversa e continua a investigação.';

interface RunForClient {
  id: string;
  ticket_id: string;
  project_id: string;
  requested_by: string;
}

/** Texto da mensagem pública: neutro, sem detalhes técnicos nem referência ao agente. */
export function clientQuestionsMessage(questions: string[]) {
  const list = questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
  return `Olá,\n\nPara continuarmos a analisar o seu pedido, precisamos de mais alguma informação:\n\n${list}\n\nObrigado.`;
}

function insertComment(
  client: Queryable,
  run: RunForClient,
  visibility: 'public' | 'internal',
  body: string,
) {
  return appendAutomatedComment(client, {
    ticketId: run.ticket_id,
    projectId: run.project_id,
    authorId: run.requested_by,
    visibility,
    body,
    authorKind: 'agent',
  });
}

/**
 * Envia ao cliente as perguntas do agente, se o projeto o permitir, e passa o ticket a
 * «aguarda informação». Devolve o id da mensagem pública ou null se não foi enviada.
 */
export async function publishClientQuestions(
  client: Queryable,
  run: RunForClient,
  questions: string[],
): Promise<string | null> {
  if (!questions.length) return null;
  const project = (
    await client.query<{ auto: boolean }>(
      'SELECT agent_auto_client_questions AS auto FROM projects WHERE id=$1',
      [run.project_id],
    )
  ).rows[0];
  if (!project?.auto) return null;
  const ticket = (
    await client.query<{ status: TicketStatus; version: number }>(
      'SELECT status,version FROM tickets WHERE id=$1 FOR UPDATE',
      [run.ticket_id],
    )
  ).rows[0];
  if (!ticket || !['new', 'investigating', 'awaiting_information'].includes(ticket.status))
    return null;
  const messageId = await insertComment(client, run, 'public', clientQuestionsMessage(questions));
  if (ticket.status !== 'awaiting_information')
    await recordTicketMove(client, {
      ticketId: run.ticket_id,
      projectId: run.project_id,
      from: ticket.status,
      to: 'awaiting_information',
      version: ticket.version,
      actorId: null,
      action: 'agent.client_questions_sent',
    });
  return messageId;
}

/**
 * Quando o cliente responde a perguntas do agente, retoma a investigação: o ticket volta a
 * «em investigação» e é criado um novo run. Limitado a MAX_CLIENT_REPLY_RUNS seguidos.
 */
export async function resumeAfterClientReply(client: Queryable, actor: User, ticketId: string) {
  if (actor.role !== 'client') return;
  const ticket = (
    await client.query<{
      status: TicketStatus;
      version: number;
      project_id: string;
    }>('SELECT status,version,project_id FROM tickets WHERE id=$1 FOR UPDATE', [ticketId])
  ).rows[0];
  if (ticket?.status !== 'awaiting_information') return;
  const recent = await client.query<{
    id: string;
    status: string;
    run_trigger: 'manual' | 'client_reply';
    client_message_id: string | null;
    requested_by: string;
  }>(
    `SELECT id,status,run_trigger,client_message_id,requested_by FROM agent_runs
     WHERE ticket_id=$1 ORDER BY created_at DESC LIMIT ${MAX_CLIENT_REPLY_RUNS + 1} FOR UPDATE`,
    [ticketId],
  );
  const last = recent.rows[0];
  if (!last?.client_message_id || ['queued', 'running'].includes(last.status)) return;
  const run: RunForClient = {
    id: last.id,
    ticket_id: ticketId,
    project_id: ticket.project_id,
    requested_by: last.requested_by,
  };
  const automatic = recent.rows.slice(0, MAX_CLIENT_REPLY_RUNS);
  if (
    automatic.length === MAX_CLIENT_REPLY_RUNS &&
    automatic.every((row) => row.run_trigger === 'client_reply')
  ) {
    await insertComment(
      client,
      run,
      'internal',
      `**Revisão necessária:** o cliente respondeu, mas já houve ${MAX_CLIENT_REPLY_RUNS} investigações automáticas seguidas. Reveja a conversa e peça uma nova investigação se fizer sentido.`,
    );
    return;
  }
  await recordTicketMove(client, {
    ticketId,
    projectId: ticket.project_id,
    from: ticket.status,
    to: 'investigating',
    version: ticket.version,
    actorId: actor.id,
    action: 'agent.client_replied',
  });
  const runId = randomUUID();
  await client.query(
    `INSERT INTO agent_runs(id,ticket_id,project_id,requested_by,instructions,ticket_version,run_trigger)
     VALUES($1,$2,$3,$4,$5,$6,'client_reply')`,
    [
      runId,
      ticketId,
      ticket.project_id,
      last.requested_by,
      CLIENT_REPLY_INSTRUCTIONS,
      ticket.version + 1,
    ],
  );
  await client.query(
    'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), actor.id, ticketId, 'agent.run_requested', { runId, trigger: 'client_reply' }],
  );
}
