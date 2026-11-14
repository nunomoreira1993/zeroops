import type {
  Comment,
  Ticket,
  TicketEvent,
  TicketRevision,
  TicketRevisionSnapshot,
  TicketCommentRevision,
} from '../../../../contracts/src/index.js';

export interface TicketRow {
  id: string;
  key: string;
  project_id: string;
  created_by: string;
  title: string;
  description: string;
  category: Ticket['category'];
  environment: Ticket['environment'];
  priority: Ticket['priority'];
  status: Ticket['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
export interface CommentRow {
  id: string;
  author_id: string;
  author_name: string;
  visibility: Comment['visibility'];
  body: string;
  automated: boolean;
  author_kind: 'agent' | 'system' | null;
  author_role: Comment['authorRole'];
  author_organization: Comment['authorOrganization'];
  /** Presentes só nas consultas que os selecionam (ex.: detalhe do ticket). */
  author_avatar_version?: number | null;
  agent_run_id?: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
export interface TicketCommentRevisionRow {
  id: string;
  comment_id: string;
  version: number;
  editor_name: string;
  before_body: string | null;
  after_body: string;
  created_at: Date;
}
export interface EventRow {
  id: string;
  ticket_id: string;
  from_status: TicketEvent['fromStatus'];
  to_status: TicketEvent['toStatus'];
  created_at: Date;
}
export interface TicketRevisionRow {
  id: string;
  ticket_version: number;
  actor_name: string;
  before_data: TicketRevisionSnapshot | null;
  after_data: TicketRevisionSnapshot;
  created_at: Date;
}

/** Converte a linha persistida no contrato público de ticket sem expor colunas internas. */
export function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    key: row.key,
    projectId: row.project_id,
    createdBy: row.created_by,
    title: row.title,
    description: row.description,
    category: row.category,
    environment: row.environment,
    priority: row.priority,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Converte comentário incluindo visibilidade e autoria derivada do estado atual. */
export function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    visibility: row.visibility,
    body: row.body,
    automated: row.automated,
    authorKind: row.automated ? (row.author_kind ?? 'system') : 'human',
    authorRole: row.author_role,
    authorOrganization: row.author_organization,
    ...(row.author_avatar_version !== undefined && {
      authorAvatarVersion: row.author_avatar_version,
    }),
    ...(row.agent_run_id && { agentRunId: row.agent_run_id }),
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Converte evento persistido para o contrato público do histórico. */
export function toEvent(row: EventRow): TicketEvent {
  return {
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    createdAt: row.created_at.toISOString(),
  };
}

/** Converte revisão do ticket preservando os snapshots anterior e posterior. */
export function toTicketRevision(row: TicketRevisionRow): TicketRevision {
  return {
    id: row.id,
    ticketVersion: row.ticket_version,
    actorName: row.actor_name,
    before: row.before_data,
    after: row.after_data,
    createdAt: row.created_at.toISOString(),
  };
}

/** Converte revisão de comentário para o contrato público sem remover versões históricas. */
export function toTicketCommentRevision(row: TicketCommentRevisionRow): TicketCommentRevision {
  return {
    id: row.id,
    commentId: row.comment_id,
    version: row.version,
    editorName: row.editor_name,
    before: row.before_body,
    after: row.after_body,
    createdAt: row.created_at.toISOString(),
  };
}
