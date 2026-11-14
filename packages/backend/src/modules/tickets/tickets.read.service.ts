import type { Ticket, User } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { requireMember } from '../identity/membership.js';
import { findTicket, projectMembership, readTicketAssignments } from './tickets.queries.js';
import {
  toComment,
  toEvent,
  toTicket,
  toTicketCommentRevision,
  toTicketRevision,
  type CommentRow,
  type EventRow,
  type TicketCommentRevisionRow,
  type TicketRevisionRow,
  type TicketRow,
} from './tickets.rows.js';

/** Consultas e projeções de tickets, sujeitas sempre à pertença ativa do ator. */
export class TicketsReadService {
  constructor(private readonly db: Database) {}

  /** Lista tickets visíveis ao membro autenticado no projeto atual. */
  async list(actor: User): Promise<Ticket[]> {
    await requireMember(this.db, actor);
    const result = await this.db.query<TicketRow & { creator_name: string }>(
      `SELECT t.*, creator.display_name AS creator_name FROM tickets t ${projectMembership}
       JOIN users creator ON creator.id = t.created_by
       WHERE t.project_id = $2 ORDER BY t.created_at DESC, t.id`,
      [actor.id, actor.projectId],
    );
    return result.rows.map((row) => ({ ...toTicket(row), creatorName: row.creator_name }));
  }

  /** Obtém um ticket, aplicando a verificação de pertença/projeto. */
  async get(actor: User, id: string): Promise<Ticket> {
    return toTicket(await findTicket(this.db, actor, id));
  }

  /**
   * Obtém o ticket e o respetivo histórico numa transação, ocultando comentários internos a clientes.
   */
  async detail(actor: User, id: string) {
    return this.db.transaction(async (client) => {
      const ticket = toTicket(await findTicket(client, actor, id));
      const creator = await client.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id=$1',
        [ticket.createdBy],
      );
      const creatorName = creator.rows[0]?.display_name;
      if (!creatorName) throw new DomainError('TICKET_NOT_FOUND', 'Pedido não encontrado.', 404);
      const comments = await client.query<CommentRow>(
        `SELECT c.*, author.display_name AS author_name, author.avatar_version AS author_avatar_version,
           author_member.role AS author_role,author_member.organization AS author_organization
         FROM ticket_comments c JOIN tickets t ON t.id = c.ticket_id
         ${projectMembership} JOIN users author ON author.id = c.author_id
         LEFT JOIN project_memberships author_member ON author_member.user_id=author.id AND author_member.project_id=t.project_id
         WHERE t.project_id = $2 AND t.id = $3
           AND (member.role <> 'client' OR c.visibility = 'public')
         ORDER BY c.created_at, c.id`,
        [actor.id, actor.projectId, id],
      );
      const commentRevisions = await client.query<TicketCommentRevisionRow>(
        `SELECT r.*, editor.display_name AS editor_name
         FROM ticket_comment_revisions r
         JOIN ticket_comments c ON c.id=r.comment_id
         JOIN tickets t ON t.id=c.ticket_id
         ${projectMembership}
         JOIN users editor ON editor.id=r.editor_id
         WHERE t.project_id=$2 AND t.id=$3
           AND (member.role <> 'client' OR c.visibility = 'public')
         ORDER BY r.comment_id, r.version`,
        [actor.id, actor.projectId, id],
      );
      const events = await client.query<EventRow>(
        `SELECT e.* FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
         ${projectMembership} WHERE t.project_id = $2 AND t.id = $3
         ORDER BY e.created_at, e.sequence`,
        [actor.id, actor.projectId, id],
      );
      const revisions = await client.query<TicketRevisionRow>(
        `SELECT r.*, author.display_name AS actor_name
         FROM ticket_revisions r
         JOIN tickets t ON t.id = r.ticket_id
         ${projectMembership}
         JOIN users author ON author.id = r.actor_id
         WHERE t.project_id = $2 AND t.id = $3
         ORDER BY r.ticket_version, r.created_at`,
        [actor.id, actor.projectId, id],
      );
      return {
        ticket,
        creatorName,
        comments: comments.rows.map(toComment),
        commentRevisions: commentRevisions.rows.map(toTicketCommentRevision),
        events: events.rows.map(toEvent),
        revisions: revisions.rows.map(toTicketRevision),
        assignments: await readTicketAssignments(client, id, actor.projectId),
      };
    });
  }
}
