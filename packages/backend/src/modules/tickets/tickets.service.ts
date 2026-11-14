import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createTicketSchema,
  commentRevisionInputSchema,
  healthAlertKeySchema,
  type Comment,
  type CreateTicket,
  type Ticket,
  ticketAssignmentsInputSchema,
  type TicketAssignments,
  type TicketAssignmentsInput,
  type TicketRevisionSnapshot,
  updateTicketSchema,
  type UpdateTicket,
  type User,
  type TicketOrigin,
  preExecutionStatuses,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { parseInput } from '../identity/identity.validation.js';
import { requireMember } from '../identity/membership.js';
import { findTicket, readTicketAssignments } from './tickets.queries.js';
import { TicketsReadService } from './tickets.read.service.js';
import { toComment, toTicket, type CommentRow, type TicketRow } from './tickets.rows.js';
import { appendHumanComment } from './ticket-comments.js';
import { invalidateTicketDependencies } from './ticket-dependencies.js';
import type { Queryable } from '../identity/membership.js';
import {
  healthOccurrenceSuppressed,
  ticketWorkPaused,
  type HealthOccurrence,
} from './ticket-purge-health.js';

const commentSchema = z.strictObject({
  body: z.string().trim().min(1).max(20000),
  visibility: z.enum(['public', 'internal']),
});
export type CommentInput = z.infer<typeof commentSchema>;

const assignmentFields = [
  ['client', 'clientUserId', 'client'],
  ['technical', 'technicalUserId', 'technical'],
  ['qa', 'qaUserId', 'qa'],
  ['release', 'releaseUserId', 'release'],
] as const;

/**
 * Reação a uma mensagem pública já gravada, na mesma transação (ex.: retomar a investigação do
 * agente quando o cliente responde). Injetada pela composição para manter `tickets` sem
 * dependências de módulos superiores.
 */
export type PublicCommentHook = (client: Queryable, actor: User, ticketId: string) => Promise<void>;

export interface CreatedTicket {
  id: string;
  projectId: string;
  createdBy: string;
  creatorRole: User['role'];
  version: number;
}
export interface CreateTicketOptions {
  healthOccurrence?: HealthOccurrence;
  /** Instruções específicas para a investigação automática (ex.: incidentes da Saúde). */
  agentInstructions?: string;
  /** Origem do pedido (regras de seleção do fluxo); por omissão deriva do papel do autor. */
  origin?: TicketOrigin;
  /** Tipo de alerta da Saúde que abriu o ticket (escolhe o fluxo associado a esse alerta). */
  alertKey?: string;
}
/** Reação à criação do ticket, na mesma transação (ex.: investigação automática do Copilot). */
export type TicketCreatedHook = (
  client: Queryable,
  ticket: CreatedTicket,
  options: CreateTicketOptions,
) => Promise<void>;

/** Casos de uso de tickets, conversa e atribuições limitados à pertença ativa do ator. */
export class TicketsService {
  private readonly reads: TicketsReadService;

  constructor(
    private readonly db: Database,
    private readonly publicCommentHooks: readonly PublicCommentHook[] = [],
    private readonly createdHooks: readonly TicketCreatedHook[] = [],
  ) {
    this.reads = new TicketsReadService(db);
  }

  /** Lista tickets visíveis ao membro autenticado no projeto atual. */
  async list(actor: User): Promise<Ticket[]> {
    return this.reads.list(actor);
  }

  /** Obtém um ticket, aplicando a verificação de pertença/projeto. */
  async get(actor: User, id: string): Promise<Ticket> {
    return this.reads.get(actor, id);
  }

  /**
   * Obtém o ticket e o respetivo histórico numa transação, ocultando comentários internos a clientes.
   */
  async detail(actor: User, id: string) {
    return this.reads.detail(actor, id);
  }

  /** Cria ticket, primeira revisão, evento e notificação numa única transação. */
  async create(
    actor: User,
    input: CreateTicket,
    options: CreateTicketOptions = {},
  ): Promise<Ticket> {
    const data = parseInput(createTicketSchema, input);
    return this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      if (await ticketWorkPaused(client, member.projectId))
        throw new DomainError('TICKET_WORK_PAUSED', 'Tickets temporariamente em manutenção.', 409);
      if (
        options.healthOccurrence &&
        (await healthOccurrenceSuppressed(client, member.projectId, options.healthOccurrence))
      )
        throw new DomainError('HEALTH_TICKET_SUPPRESSED', 'Ocorrência tratada pela limpeza.', 409);
      const ticketId = randomUUID();
      await client.query(
        `INSERT INTO tickets (id, project_id, created_by, title, description, category, environment, priority, origin, alert_key)
         VALUES ($1,$3,$2,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ticketId,
          member.id,
          member.projectId,
          data.title,
          data.description,
          data.category,
          data.environment,
          data.priority,
          options.origin ?? (member.role === 'client' ? 'portal_client' : 'portal_team'),
          options.alertKey ? healthAlertKeySchema.parse(options.alertKey) : null,
        ],
      );
      const inserted = await client.query<TicketRow>('SELECT * FROM tickets WHERE id=$1', [
        ticketId,
      ]);
      const row = inserted.rows[0];
      if (!row) throw new DomainError('FORBIDDEN', 'Sem acesso a este projeto.', 403);
      const snapshot: TicketRevisionSnapshot = {
        title: row.title,
        description: row.description,
        category: row.category,
        environment: row.environment,
        priority: row.priority,
      };
      await client.query(
        `INSERT INTO ticket_revisions
         (id,ticket_id,ticket_version,actor_id,after_data)
         VALUES($1,$2,$3,$4,$5)`,
        [randomUUID(), row.id, row.version, member.id, JSON.stringify(snapshot)],
      );
      if (member.role === 'client') {
        await client.query(
          `INSERT INTO ticket_assignments(ticket_id,project_id,stage,user_id,assigned_by)
           VALUES($1,$2,'client',$3,$3)`,
          [row.id, member.projectId, member.id],
        );
      }
      await client.query(
        `INSERT INTO ticket_events (id, ticket_id, from_status, to_status)
         VALUES ($1, $2, NULL, 'new')`,
        [randomUUID(), row.id],
      );
      await client.query(
        `INSERT INTO notification_outbox (id, topic, payload)
         VALUES ($1, 'ticket.created', $2)`,
        [
          randomUUID(),
          JSON.stringify({
            ticketId: row.id,
            projectId: member.projectId,
            actorId: member.id,
            key: row.key,
          }),
        ],
      );
      for (const hook of this.createdHooks)
        await hook(
          client,
          {
            id: row.id,
            projectId: member.projectId,
            createdBy: member.id,
            creatorRole: member.role,
            version: row.version,
          },
          options,
        );
      return toTicket(row);
    });
  }

  /** Revê o conteúdo sob controlo de versão e invalida decisões/trabalho dependentes da versão anterior. */
  async update(actor: User, id: string, input: UpdateTicket): Promise<Ticket> {
    const data = parseInput(updateTicketSchema, input);
    return this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      const current = await findTicket(client, member, id, true);
      if (current.version !== data.expectedVersion)
        throw new DomainError('STALE_VERSION', 'O pedido mudou. Recarregue a página.');

      const ownerCanEdit = current.created_by === member.id && current.status === 'new';
      const teamCanEdit =
        ['technical', 'admin'].includes(member.role) &&
        preExecutionStatuses.includes(current.status);
      if (!ownerCanEdit && !teamCanEdit) {
        throw new DomainError(
          'FORBIDDEN',
          'Só o autor antes da análise ou a equipa técnica numa etapa editável pode rever o pedido.',
          403,
        );
      }
      if (data.environment === 'development' && current.environment !== 'development') {
        throw new DomainError(
          'INVALID_INPUT',
          'Não é possível alterar um pedido para o ambiente Desenvolvimento.',
          400,
        );
      }

      const before: TicketRevisionSnapshot = {
        title: current.title,
        description: current.description,
        category: current.category,
        environment: current.environment,
        priority: current.priority,
      };
      const after: TicketRevisionSnapshot = {
        title: data.title,
        description: data.description,
        category: data.category,
        environment: data.environment,
        priority: data.priority,
      };
      if (JSON.stringify(before) === JSON.stringify(after)) return toTicket(current);
      await invalidateTicketDependencies(client, member, id, current.version + 1, 'content');

      const nextStatus = [
        'awaiting_information',
        'awaiting_client',
        'awaiting_technical',
        'awaiting_confirmation',
        'blocked',
      ].includes(current.status)
        ? 'investigating'
        : current.status;
      await client.query(
        `UPDATE tickets
         SET title=$2,description=$3,category=$4,environment=$5,priority=$6,
             status=$7,version=version+1,updated_at=NOW(3)
         WHERE id=$1`,
        [
          current.id,
          after.title,
          after.description,
          after.category,
          after.environment,
          after.priority,
          nextStatus,
        ],
      );
      const updated = await client.query<TicketRow>('SELECT * FROM tickets WHERE id=$1', [
        current.id,
      ]);
      const row = updated.rows[0];
      if (!row) throw new DomainError('TICKET_NOT_FOUND', 'Pedido não encontrado.', 404);
      await client.query(
        `INSERT INTO ticket_revisions
         (id,ticket_id,ticket_version,actor_id,before_data,after_data)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          row.id,
          row.version,
          member.id,
          JSON.stringify(before),
          JSON.stringify(after),
        ],
      );
      if (current.status !== row.status) {
        await client.query(
          `INSERT INTO ticket_events(id,ticket_id,from_status,to_status) VALUES($1,$2,$3,$4)`,
          [randomUUID(), row.id, current.status, row.status],
        );
      }
      await client.query(
        `INSERT INTO audit_events(id,actor_id,ticket_id,action,details)
         VALUES($1,$2,$3,'ticket.content_revised',$4)`,
        [
          randomUUID(),
          member.id,
          row.id,
          JSON.stringify({
            previousVersion: current.version,
            version: row.version,
            previousStatus: current.status,
            status: row.status,
          }),
        ],
      );
      return toTicket(row);
    });
  }

  /** Atribui responsáveis distintos e ativos às etapas, exigindo papel correspondente e versão atual. */
  async assign(actor: User, id: string, input: TicketAssignmentsInput): Promise<TicketAssignments> {
    const data = parseInput(ticketAssignmentsInputSchema, input);
    return this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      if (member.role !== 'admin')
        throw new DomainError(
          'FORBIDDEN',
          'Só um administrador do projeto pode atribuir responsáveis.',
          403,
        );
      const current = await findTicket(client, member, id, true);
      if (current.version !== data.expectedVersion)
        throw new DomainError('STALE_VERSION', 'O pedido mudou. Recarregue a página.');
      if (!preExecutionStatuses.includes(current.status)) {
        throw new DomainError(
          'INVALID_STATE',
          'Não é possível alterar responsáveis durante execução, QA, release ou deploy.',
        );
      }

      const selected = assignmentFields.map(([stage, field, role]) => ({
        stage,
        role,
        userId: data[field],
      }));
      const userIds = selected.flatMap(({ userId }) => (userId ? [userId] : []));
      if (new Set(userIds).size !== userIds.length)
        throw new DomainError(
          'INVALID_ASSIGNMENT',
          'Cada etapa deve ter uma pessoa diferente.',
          400,
        );
      const eligible = userIds.length
        ? await client.query<{ id: string; role: string }>(
            `SELECT u.id, m.role
             FROM users u
             JOIN project_memberships m ON m.user_id=u.id AND m.project_id=$1
             JOIN projects p ON p.id=m.project_id
             WHERE u.id IN ($2) AND NOT u.disabled AND NOT m.disabled AND NOT p.archived`,
            [member.projectId, userIds],
          )
        : { rows: [] as { id: string; role: string }[] };
      for (const assignment of selected) {
        if (!assignment.userId) continue;
        const person = eligible.rows.find((row) => row.id === assignment.userId);
        if (!person || person.role !== assignment.role)
          throw new DomainError(
            'INVALID_ASSIGNMENT',
            `O responsável da etapa ${assignment.stage} tem de ser um membro ativo com o perfil correspondente.`,
            400,
          );
      }

      const previous = await readTicketAssignments(client, id, member.projectId);
      const changes = selected
        .filter(({ stage, userId }) => previous[stage]?.userId !== userId)
        .map(({ stage, userId }) => ({
          stage,
          previousUserId: previous[stage]?.userId ?? null,
          userId,
        }));
      const changedStages = changes.map(({ stage }) => stage);
      if (!changedStages.length) return previous;
      await invalidateTicketDependencies(client, member, id, current.version + 1, 'assignments');
      await client.query('DELETE FROM ticket_assignments WHERE ticket_id=$1', [id]);
      for (const assignment of selected) {
        if (!assignment.userId) continue;
        await client.query(
          `INSERT INTO ticket_assignments(ticket_id,project_id,stage,user_id,assigned_by)
           VALUES($1,$2,$3,$4,$5)`,
          [id, member.projectId, assignment.stage, assignment.userId, member.id],
        );
      }
      const nextStatus = [
        'awaiting_information',
        'awaiting_client',
        'awaiting_technical',
        'awaiting_confirmation',
        'blocked',
      ].includes(current.status)
        ? 'investigating'
        : current.status;
      await client.query(
        'UPDATE tickets SET status=$2,version=version+1,updated_at=NOW(3) WHERE id=$1',
        [id, nextStatus],
      );
      const updated = await client.query<TicketRow>('SELECT * FROM tickets WHERE id=$1', [id]);
      const row = updated.rows[0];
      if (!row) throw new DomainError('TICKET_NOT_FOUND', 'Pedido não encontrado.', 404);
      if (current.status !== row.status) {
        await client.query(
          `INSERT INTO ticket_events(id,ticket_id,from_status,to_status) VALUES($1,$2,$3,$4)`,
          [randomUUID(), id, current.status, row.status],
        );
      }
      await client.query(
        `INSERT INTO audit_events(id,actor_id,ticket_id,action,details)
         VALUES($1,$2,$3,'ticket.assignments_changed',$4)`,
        [
          randomUUID(),
          member.id,
          id,
          JSON.stringify({ changedStages, changes, version: row.version }),
        ],
      );
      return readTicketAssignments(client, id, member.projectId);
    });
  }

  /** Regista uma resposta ou nota interna, aplicando as permissões e visibilidade do projeto. */
  async comment(actor: User, id: string, input: CommentInput): Promise<Comment> {
    const data = parseInput(commentSchema, input);
    return this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      await findTicket(client, member, id, true);
      const comment = await appendHumanComment(client, member, id, data.body, data.visibility);
      if (data.visibility === 'public')
        for (const hook of this.publicCommentHooks) await hook(client, member, id);
      return comment;
    });
  }

  /** Revê uma mensagem sem apagar versões anteriores e bloqueia alterações durante execução ou release. */
  async reviseComment(
    actor: User,
    ticketId: string,
    commentId: string,
    raw: unknown,
  ): Promise<Comment> {
    const input = parseInput(commentRevisionInputSchema, raw);
    return this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      const ticket = await findTicket(client, member, ticketId, true);
      if (!preExecutionStatuses.includes(ticket.status))
        throw new DomainError(
          'INVALID_STATE',
          'Não é possível rever mensagens durante execução, QA, release ou deploy.',
        );
      const locked = await client.query<
        Omit<CommentRow, 'author_name' | 'author_role' | 'author_organization'>
      >('SELECT * FROM ticket_comments WHERE id=$1 AND ticket_id=$2 FOR UPDATE', [
        commentId,
        ticketId,
      ]);
      const comment = locked.rows[0];
      const author = comment
        ? await client.query<
            Pick<CommentRow, 'author_name' | 'author_role' | 'author_organization'>
          >(
            `SELECT author.display_name AS author_name,
               m.role AS author_role,m.organization AS author_organization
             FROM users author
             LEFT JOIN project_memberships m ON m.user_id=author.id AND m.project_id=$2
             WHERE author.id=$1`,
            [comment.author_id, member.projectId],
          )
        : null;
      const authorRow = author?.rows[0];
      const current: CommentRow | undefined =
        comment && authorRow ? { ...comment, ...authorRow } : undefined;
      if (!current) throw new DomainError('COMMENT_NOT_FOUND', 'Mensagem não encontrada.', 404);
      if (current.automated || current.author_id !== member.id)
        throw new DomainError('FORBIDDEN', 'Só o autor pode corrigir uma mensagem humana.', 403);
      if (current.version !== input.expectedVersion)
        throw new DomainError('STALE_VERSION', 'A mensagem mudou. Recarregue a conversa.');
      if (current.body === input.body) return toComment(current);
      await invalidateTicketDependencies(
        client,
        member,
        ticketId,
        ticket.version + 1,
        'comment_correction',
      );

      await client.query(
        'UPDATE ticket_comments SET body=$2,version=version+1,updated_at=NOW(3) WHERE id=$1',
        [commentId, input.body],
      );
      const updated = await client.query<
        Omit<CommentRow, 'author_name' | 'author_role' | 'author_organization'>
      >('SELECT * FROM ticket_comments WHERE id=$1', [commentId]);
      const revised = updated.rows[0];
      if (!revised) throw new DomainError('COMMENT_NOT_FOUND', 'Mensagem não encontrada.', 404);
      const row: CommentRow = {
        ...revised,
        author_name: member.displayName,
        author_role: member.role,
        author_organization: member.organization ?? null,
      };
      await client.query(
        `INSERT INTO ticket_comment_revisions
         (id,comment_id,version,editor_id,before_body,after_body)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), commentId, row.version, member.id, current.body, row.body],
      );
      const nextStatus = [
        'awaiting_information',
        'awaiting_client',
        'awaiting_technical',
        'awaiting_confirmation',
        'blocked',
      ].includes(ticket.status)
        ? 'investigating'
        : ticket.status;
      await client.query(
        'UPDATE tickets SET status=$2,version=version+1,updated_at=NOW(3) WHERE id=$1',
        [ticketId, nextStatus],
      );
      if (ticket.status !== nextStatus) {
        await client.query(
          `INSERT INTO ticket_events(id,ticket_id,from_status,to_status) VALUES($1,$2,$3,$4)`,
          [randomUUID(), ticketId, ticket.status, nextStatus],
        );
      }
      await client.query(
        `INSERT INTO audit_events(id,actor_id,ticket_id,action,details)
         VALUES($1,$2,$3,'ticket.comment_revised',$4)`,
        [
          randomUUID(),
          member.id,
          ticketId,
          JSON.stringify({
            commentId,
            previousVersion: current.version,
            version: row.version,
            visibility: current.visibility,
          }),
        ],
      );
      return toComment(row);
    });
  }
}
