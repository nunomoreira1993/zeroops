import { randomUUID } from 'node:crypto';
import { Database } from '../../database/database.js';
import { ticketWorkPaused } from '../../database/ticket-maintenance.js';

export type OutboxDeliveryStatus = 'sent' | 'blocked' | 'failed' | 'uncertain';

export interface OutboxHandler {
  /** Entrega um evento e devolve o estado final; nunca deve marcar como enviado sem transporte. */
  deliver(
    id: string,
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: OutboxDeliveryStatus; errorCode?: string }>;
}

/**
 * Reclama entradas numa transação curta, entrega fora da transação e grava o resultado.
 * Uma reclamação abandonada passa a incerta e nunca é repetida automaticamente.
 */
export async function dispatchOutbox(db: Database, handler: OutboxHandler, batchSize = 20) {
  const claimed = await db.transaction(async (client) => {
    await client.query(
      `UPDATE notification_delivery_state SET state='uncertain',lease_id=NULL,finished_at=NOW(3),
         error_code='delivery_interrupted'
       WHERE state='processing' AND claimed_at < DATE_SUB(NOW(3), INTERVAL 10 MINUTE)`,
    );
    const result = await client.query<{
      id: string;
      topic: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT o.id,o.topic,o.payload FROM notification_outbox o
       LEFT JOIN notification_delivery_state d ON d.outbox_id=o.id
       WHERE o.status='pending' AND (d.state IS NULL OR d.state='pending')
       AND NOT EXISTS(SELECT 1 FROM ticket_purge_maintenance p
         WHERE p.project_id=JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.projectId'))
           AND JSON_EXTRACT(o.payload,'$.ticketId') IS NOT NULL AND p.lease_until>NOW(3))
       ORDER BY o.created_at LIMIT $1 FOR UPDATE`,
      [batchSize],
    );
    const rows = [];
    for (const item of result.rows) {
      if (
        typeof item.payload.ticketId === 'string' &&
        typeof item.payload.projectId === 'string' &&
        (await ticketWorkPaused(client, item.payload.projectId))
      )
        continue;
      rows.push({ ...item, leaseId: randomUUID() });
    }
    for (const item of rows)
      await client.query(
        `INSERT INTO notification_delivery_state(outbox_id,state,attempts,lease_id,claimed_at)
         VALUES($1,'processing',1,$2,NOW(3))
         ON DUPLICATE KEY UPDATE state='processing',attempts=attempts+1,lease_id=VALUES(lease_id),
           claimed_at=VALUES(claimed_at),finished_at=NULL,error_code=NULL`,
        [item.id, item.leaseId],
      );
    return rows;
  });

  for (const item of claimed) {
    let outcome: { status: OutboxDeliveryStatus; errorCode?: string };
    try {
      outcome = await handler.deliver(item.id, item.topic, item.payload);
    } catch (error) {
      outcome = {
        status: 'uncertain',
        errorCode: error instanceof Error ? error.name.slice(0, 100) : 'delivery_uncertain',
      };
    }
    await db.transaction(async (client) => {
      const state = await client.query(
        `UPDATE notification_delivery_state SET state=$3,lease_id=NULL,finished_at=NOW(3),
           error_code=$4 WHERE outbox_id=$1 AND lease_id=$2 AND state='processing'`,
        [item.id, item.leaseId, outcome.status, outcome.errorCode ?? null],
      );
      if (!state.rowCount || outcome.status === 'uncertain') return;
      await client.query(
        `UPDATE notification_outbox SET status=$2,error_code=$3 WHERE id=$1 AND status='pending'`,
        [item.id, outcome.status, outcome.errorCode ?? null],
      );
    });
  }
  return claimed.length;
}
