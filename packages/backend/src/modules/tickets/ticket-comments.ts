import { randomUUID } from 'node:crypto';
import type { Comment, User } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import type { Queryable } from '../identity/membership.js';
import { toComment, type CommentRow } from './tickets.rows.js';

/** Comentário automático (agente ou sistema), com revisão inicial e outbox, na transação atual. */
export async function appendAutomatedComment(
  db: Queryable,
  input: {
    ticketId: string;
    projectId: string;
    authorId: string;
    visibility: 'public' | 'internal';
    body: string;
    authorKind: 'agent' | 'system';
  },
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO ticket_comments(id,ticket_id,author_id,visibility,body,automated,author_kind)
     VALUES($1,$2,$3,$4,$5,1,$6)`,
    [id, input.ticketId, input.authorId, input.visibility, input.body, input.authorKind],
  );
  await db.query(
    'INSERT INTO ticket_comment_revisions(id,comment_id,version,editor_id,after_body) VALUES($1,$2,0,$3,$4)',
    [randomUUID(), id, input.authorId, input.body],
  );
  await db.query(
    "INSERT INTO notification_outbox(id,topic,payload) VALUES($1,'ticket.comment_created',$2)",
    [
      randomUUID(),
      JSON.stringify({
        ticketId: input.ticketId,
        projectId: input.projectId,
        actorId: input.authorId,
        commentId: id,
        visibility: input.visibility,
      }),
    ],
  );
  return id;
}

/** Grava comentário humano e evento/outbox correspondentes dentro da transação do ticket. */
export async function appendHumanComment(
  db: Queryable,
  actor: User,
  ticketId: string,
  body: string,
  visibility: 'public' | 'internal',
): Promise<Comment> {
  if (actor.role === 'client' && visibility === 'internal')
    throw new DomainError('FORBIDDEN', 'Clientes apenas podem publicar comentários públicos.', 403);
  const id = randomUUID();
  await db.query(
    `INSERT INTO ticket_comments(id,ticket_id,author_id,visibility,body,automated)
     VALUES($1,$2,$3,$4,$5,false)`,
    [id, ticketId, actor.id, visibility, body],
  );
  const result = await db.query<
    Omit<CommentRow, 'author_name' | 'author_role' | 'author_organization'>
  >('SELECT * FROM ticket_comments WHERE id=$1', [id]);
  const inserted = result.rows[0];
  if (!inserted)
    throw new DomainError('COMMENT_NOT_CREATED', 'Não foi possível guardar a mensagem.', 500);
  const row: CommentRow = {
    ...inserted,
    author_name: actor.displayName,
    author_role: actor.role,
    author_organization: actor.organization ?? null,
  };
  await db.query(
    'INSERT INTO ticket_comment_revisions(id,comment_id,version,editor_id,after_body) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), row.id, row.version, actor.id, row.body],
  );
  await db.query(
    "INSERT INTO notification_outbox(id,topic,payload) VALUES($1,'ticket.comment_created',$2)",
    [
      randomUUID(),
      JSON.stringify({
        ticketId,
        projectId: actor.projectId,
        actorId: actor.id,
        commentId: row.id,
        visibility,
      }),
    ],
  );
  return toComment(row);
}
