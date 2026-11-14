import { z } from 'zod';
import type { TicketAssignments, User } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import { validateActor, type Queryable } from '../identity/membership.js';
import type { TicketRow } from './tickets.rows.js';

export const projectMembership = `
  JOIN project_memberships member ON member.user_id=$1 AND member.project_id=t.project_id AND NOT member.disabled
  JOIN users identity_member ON identity_member.id=member.user_id AND NOT identity_member.disabled
  JOIN projects project ON project.id=t.project_id AND NOT project.archived
`;

interface TicketAssignmentRow {
  stage: keyof TicketAssignments;
  user_id: string;
  display_name: string;
}

/** Carrega responsáveis por etapa para compor a vista ou devolver atribuições após atualização. */
export async function readTicketAssignments(
  db: Queryable,
  ticketId: string,
  projectId: string,
): Promise<TicketAssignments> {
  const result = await db.query<TicketAssignmentRow>(
    `SELECT a.stage, a.user_id, u.display_name
     FROM ticket_assignments a
     JOIN users u ON u.id = a.user_id
     WHERE a.ticket_id=$1 AND a.project_id=$2`,
    [ticketId, projectId],
  );
  const assignments: TicketAssignments = {
    client: null,
    technical: null,
    qa: null,
    release: null,
  };
  for (const row of result.rows)
    assignments[row.stage] = { userId: row.user_id, displayName: row.display_name };
  return assignments;
}

/** Valida UUID do ticket antes de o usar em consultas ou locks de BD. */
export function validateTicketId(id: string): void {
  if (!z.uuid().safeParse(id).success) {
    throw new DomainError('INVALID_INPUT', 'Identificador de pedido inválido.', 400);
  }
}

/** Obtém ticket visível ao ator/projeto e, opcionalmente, bloqueia apenas a linha do ticket. */
export async function findTicket(
  db: Queryable,
  actor: User,
  id: string,
  lock = false,
): Promise<TicketRow> {
  validateActor(actor);
  validateTicketId(id);
  if (lock) {
    // Só a linha do pedido fica bloqueada; pertença e projeto mantêm o lock partilhado de requireMember.
    const locked = await db.query<TicketRow>(
      'SELECT t.* FROM tickets t WHERE t.project_id = $1 AND t.id = $2 FOR UPDATE',
      [actor.projectId, id],
    );
    const row = locked.rows[0];
    const visible =
      row &&
      (
        await db.query(
          `SELECT t.id FROM tickets t ${projectMembership}
           WHERE t.project_id = $2 AND t.id = $3`,
          [actor.id, actor.projectId, id],
        )
      ).rowCount;
    if (!row || !visible) throw new DomainError('TICKET_NOT_FOUND', 'Pedido não encontrado.', 404);
    return row;
  }
  const result = await db.query<TicketRow>(
    `SELECT t.* FROM tickets t ${projectMembership}
     WHERE t.project_id = $2 AND t.id = $3`,
    [actor.id, actor.projectId, id],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError('TICKET_NOT_FOUND', 'Pedido não encontrado.', 404);
  return row;
}
