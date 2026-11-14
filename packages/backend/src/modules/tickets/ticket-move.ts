import { randomUUID } from 'node:crypto';
import type { TicketStatus } from '../../../../contracts/src/index.js';
import type { Queryable } from '../identity/membership.js';

export interface TicketMove {
  ticketId: string;
  projectId: string;
  from: TicketStatus;
  to: TicketStatus;
  /** Versão do ticket antes da transição (passa a `version + 1`). */
  version: number;
  /** Ator auditado; null em transições automáticas do sistema. */
  actorId: string | null;
  action: string;
}

/** Muda o estado do ticket com evento, auditoria e notificação, dentro da transação do chamador. */
export async function recordTicketMove(client: Queryable, move: TicketMove) {
  await client.query(
    'UPDATE tickets SET status=$2,version=version+1,updated_at=NOW(3) WHERE id=$1',
    [move.ticketId, move.to],
  );
  await client.query(
    'INSERT INTO ticket_events(id,ticket_id,from_status,to_status) VALUES($1,$2,$3,$4)',
    [randomUUID(), move.ticketId, move.from, move.to],
  );
  await client.query(
    'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,$2,$3,$4,$5)',
    [
      randomUUID(),
      move.actorId,
      move.ticketId,
      move.action,
      JSON.stringify({ from: move.from, to: move.to, version: move.version + 1 }),
    ],
  );
  await client.query('INSERT INTO notification_outbox(id,topic,payload) VALUES($1,$2,$3)', [
    randomUUID(),
    'ticket.changed',
    JSON.stringify({
      ticketId: move.ticketId,
      projectId: move.projectId,
      actorId: move.actorId,
      status: move.to,
    }),
  ]);
}
