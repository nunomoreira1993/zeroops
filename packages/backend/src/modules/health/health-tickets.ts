import type { CreateTicket, User } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import type { CreateTicketOptions, TicketsService } from '../tickets/tickets.service.js';
import { DomainError } from '../../errors.js';

type ActorRow = {
  id: string;
  project_id: string;
  email: string;
  display_name: string;
  role: User['role'];
  instance_admin: number | boolean;
};

/** Abertura e anotação dos tickets de incidente da Saúde (alertas externos críticos). */
export interface HealthTicketGateway {
  open(
    projectId: string,
    input: CreateTicket,
    options?: CreateTicketOptions,
  ): Promise<{ id: string; key: string } | null>;
  comment(projectId: string, ticketId: string, body: string): Promise<void>;
  /** Muda o título (ex.: a causa provável do incidente mudou); ignora se já não for editável. */
  retitle(projectId: string, ticketId: string, title: string): Promise<void>;
  /** Estado atual do ticket (null se não existir no projeto). */
  status(projectId: string, ticketId: string): Promise<string | null>;
}

/** Estados em que o ticket do alerta já está fechado: um novo disparo abre outro ticket. */
export const closedTicketStatuses = new Set(['resolved', 'cancelled']);

/**
 * Cria tickets em nome de quem configurou a Saúde (`health_settings.updated_by`) ou, na falta,
 * de um administrador (ou técnico) ativo do projeto. Usa o mesmo serviço e validações da UI.
 */
export class HealthTickets implements HealthTicketGateway {
  constructor(
    private readonly db: Database,
    private readonly tickets: TicketsService,
  ) {}

  /** Abre um ticket em nome do ator de sistema do projeto; devolve null se não houver ator. */
  async open(projectId: string, input: CreateTicket, options: CreateTicketOptions = {}) {
    const actor = await this.actor(projectId);
    if (!actor) return null;
    try {
      const ticket = await this.tickets.create(actor, input, options);
      return { id: ticket.id, key: ticket.key };
    } catch (error) {
      if (
        error instanceof DomainError &&
        ['HEALTH_TICKET_SUPPRESSED', 'TICKET_WORK_PAUSED'].includes(error.code)
      )
        return null;
      throw error;
    }
  }

  /** Acrescenta um comentário interno ao ticket do alerta. */
  async comment(projectId: string, ticketId: string, body: string) {
    const actor = await this.actor(projectId);
    if (actor) await this.tickets.comment(actor, ticketId, { body, visibility: 'internal' });
  }

  /** Atualiza o título do incidente (ex.: nova causa provável); ignora tickets já em trabalho. */
  async retitle(projectId: string, ticketId: string, title: string) {
    const actor = await this.actor(projectId);
    if (!actor) return;
    const ticket = await this.tickets.get(actor, ticketId);
    if (ticket.title === title) return;
    try {
      await this.tickets.update(actor, ticketId, {
        title,
        description: ticket.description,
        category: ticket.category,
        environment: ticket.environment,
        priority: ticket.priority,
        expectedVersion: ticket.version,
      });
    } catch {
      // Ticket já em trabalho (não editável) ou alterado entretanto: mantém o título.
    }
  }

  /** Estado atual do ticket no projeto (null se não existir). */
  async status(projectId: string, ticketId: string) {
    const found = await this.db.query<{ status: string }>(
      'SELECT status FROM tickets WHERE project_id=$1 AND id=$2',
      [projectId, ticketId],
    );
    return found.rows[0]?.status ?? null;
  }

  private async actor(projectId: string): Promise<User | null> {
    const found = await this.db.query<ActorRow>(
      `SELECT u.id,m.project_id,u.email,u.display_name,m.role,u.instance_admin
         FROM project_memberships m
         JOIN users u ON u.id=m.user_id
         LEFT JOIN health_settings s ON s.project_id=m.project_id AND s.updated_by=u.id
        WHERE m.project_id=$1 AND NOT u.disabled AND NOT m.disabled AND m.role IN ('admin','technical')
        ORDER BY s.updated_by IS NULL, m.role<>'admin', u.email
        LIMIT 1`,
      [projectId],
    );
    const row = found.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      instanceAdmin: Boolean(row.instance_admin),
    };
  }
}
