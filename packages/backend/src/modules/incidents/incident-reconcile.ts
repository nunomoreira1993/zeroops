import { releaseLocksOf } from '../../database/resource-locks.js';
import type { Queryable } from '../identity/membership.js';
import { appendAutomatedComment } from '../tickets/ticket-comments.js';

interface UncertainRow {
  id: string;
  ticket_id: string;
  project_id: string;
  created_by: string;
  request_status: string;
  error_code: string | null;
  error_message: string | null;
}

/**
 * Reconcilia intervenções com resultado desconhecido quando o relay entrega, mais tarde, o
 * resultado do pedido que já tinha recolhido. Nunca repete a intervenção: só regista o desfecho
 * real e liberta a reserva do recurso. Devolve quantas intervenções foram reconciliadas.
 */
export async function reconcileUncertainInterventions(db: Queryable, limit = 50): Promise<number> {
  const rows = (
    await db.query<UncertainRow>(
      `SELECT i.id,i.ticket_id,i.project_id,t.created_by,r.status AS request_status,
              r.error_code,r.error_message
         FROM incident_interventions i
         JOIN connector_relay_requests r ON r.id=i.relay_request_id
         JOIN tickets t ON t.id=i.ticket_id
        WHERE i.status='uncertain' AND r.status IN ('done','failed')
          AND (r.error_code IS NULL OR r.error_code<>'UNCERTAIN')
        ORDER BY i.created_at LIMIT ${Math.max(1, Math.min(limit, 500))}`,
    )
  ).rows;
  let reconciled = 0;
  for (const row of rows) {
    const succeeded = row.request_status === 'done';
    const text = succeeded
      ? 'Reconciliada: o relay confirmou mais tarde que a intervenção foi executada.'
      : `Reconciliada: o relay confirmou mais tarde que a intervenção falhou${row.error_code ? ` (${row.error_code})` : ''}: ${row.error_message ?? 'sem detalhe'}.`;
    const update = await db.query(
      `UPDATE incident_interventions SET status=$2,result_text=$3,finished_at=NOW(3)
        WHERE id=$1 AND status='uncertain'`,
      [row.id, succeeded ? 'succeeded' : 'failed', text.slice(0, 2000)],
    );
    if (!update.rowCount) continue;
    reconciled += 1;
    const others = (
      await db.query<{ id: string }>(
        "SELECT id FROM incident_interventions WHERE ticket_id=$1 AND status='uncertain' LIMIT 1",
        [row.ticket_id],
      )
    ).rows[0];
    if (!others) await releaseLocksOf(db, { kind: 'intervention', id: row.ticket_id });
    await appendAutomatedComment(db, {
      ticketId: row.ticket_id,
      projectId: row.project_id,
      authorId: row.created_by,
      visibility: 'internal',
      body: `${text} A validação da recuperação continua a cargo do fluxo/equipa.`,
      authorKind: 'system',
    });
  }
  return reconciled;
}
