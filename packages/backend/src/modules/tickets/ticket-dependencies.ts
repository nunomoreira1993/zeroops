import { randomUUID } from 'node:crypto';
import type { User } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import type { Queryable } from '../identity/membership.js';

/** Invalida propostas, aprovações, execuções e resoluções dependentes de uma nova versão do ticket. */
export async function invalidateTicketDependencies(
  db: Queryable,
  actor: User,
  ticketId: string,
  ticketVersion: number,
  reason:
    | 'content'
    | 'assignments'
    | 'comment_correction'
    | 'proposal'
    | 'resolution'
    | 'cancel'
    | 'reopen',
) {
  const active = await db.query(
    `SELECT 1 FROM DUAL WHERE
       EXISTS (SELECT 1 FROM execution_runs WHERE ticket_id=$1 AND status='running')
       OR EXISTS (SELECT 1 FROM deployment_runs WHERE ticket_id=$1 AND status IN ('running','uncertain'))`,
    [ticketId],
  );
  if (active.rowCount)
    throw new DomainError(
      'RECONCILIATION_REQUIRED',
      'Existe uma operação ativa ou incerta. Reconcilie-a antes de alterar o pedido.',
    );
  await db.query(
    'UPDATE proposals SET invalidated_at=NOW(3) WHERE ticket_id=$1 AND invalidated_at IS NULL',
    [ticketId],
  );
  await db.query(
    'UPDATE approvals SET invalidated_at=NOW(3) WHERE ticket_id=$1 AND invalidated_at IS NULL',
    [ticketId],
  );
  await db.query(
    `UPDATE execution_runs SET invalidated_at=NOW(3),
       error_code=CASE WHEN status='pending' THEN 'material_change' ELSE error_code END,
       status=CASE WHEN status='pending' THEN 'blocked' ELSE status END
     WHERE ticket_id=$1 AND invalidated_at IS NULL`,
    [ticketId],
  );
  await db.query(
    `UPDATE deployment_runs SET invalidated_at=NOW(3),
       error_code=CASE WHEN status='pending' THEN 'material_change' ELSE error_code END,
       status=CASE WHEN status='pending' THEN 'blocked' ELSE status END
     WHERE ticket_id=$1 AND invalidated_at IS NULL`,
    [ticketId],
  );
  await db.query(
    'UPDATE ticket_resolutions SET invalidated_at=NOW(3) WHERE ticket_id=$1 AND invalidated_at IS NULL',
    [ticketId],
  );
  await db.query(
    `INSERT INTO ticket_dependency_invalidations(id,ticket_id,ticket_version,actor_id,reason)
     VALUES($1,$2,$3,$4,$5)`,
    [randomUUID(), ticketId, ticketVersion, actor.id, reason],
  );
}
