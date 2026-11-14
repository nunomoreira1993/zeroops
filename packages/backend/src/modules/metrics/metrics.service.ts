import type { Metrics, User } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { requireMember } from '../identity/membership.js';
import { projectMembership } from '../tickets/tickets.queries.js';
import type { EventRow, TicketRow } from '../tickets/tickets.rows.js';
import { measureTicket } from './ticket-timing.js';

function mean(samples: number[]): number | null {
  return samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null;
}

/** Calcula métricas de tickets e tempos do projeto ativo sem presumir metas de SLA. */
export class MetricsService {
  constructor(private readonly db: Database) {}

  /** Calcula tempos e contagens, excluindo notas internas e respostas automáticas. */
  async summary(actor: User): Promise<Metrics> {
    return this.db.transaction(async (client) => {
      await requireMember(client, actor);
      const parameters = [actor.id, actor.projectId];
      const ticketResult = await client.query<TicketRow>(
        `SELECT t.* FROM tickets t ${projectMembership}
         WHERE t.project_id = $2 ORDER BY t.created_at DESC, t.id`,
        parameters,
      );
      const eventResult = await client.query<EventRow>(
        `SELECT e.* FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
         ${projectMembership} WHERE t.project_id = $2
         ORDER BY e.created_at, e.sequence`,
        parameters,
      );
      const responses = await client.query<{ ticket_id: string; responded_at: Date }>(
        `SELECT c.ticket_id, min(c.created_at) AS responded_at
         FROM ticket_comments c JOIN tickets t ON t.id = c.ticket_id
         ${projectMembership} JOIN project_memberships author ON author.user_id = c.author_id AND author.project_id=t.project_id
         WHERE t.project_id = $2 AND c.visibility = 'public' AND NOT c.automated
           AND c.author_id <> t.created_by
           AND author.role IN ('technical', 'qa', 'release', 'admin')
           AND c.created_at >= t.created_at
           AND COALESCE((SELECT e.to_status FROM ticket_events e
             WHERE e.ticket_id = t.id AND e.created_at <= c.created_at
             ORDER BY e.created_at DESC, e.sequence DESC LIMIT 1), 'new') NOT IN ('resolved', 'cancelled')
         GROUP BY c.ticket_id`,
        parameters,
      );
      const clock = await client.query<{ current_time: Date }>('SELECT NOW(3) AS "current_time"');
      const now = clock.rows[0]!.current_time;
      const events = new Map<string, EventRow[]>();
      for (const event of eventResult.rows) {
        const history = events.get(event.ticket_id) ?? [];
        history.push(event);
        events.set(event.ticket_id, history);
      }
      const firstResponses = new Map(
        responses.rows.map((row) => [row.ticket_id, row.responded_at]),
      );
      const responseSamples: number[] = [];
      const resolutionSamples: number[] = [];
      const tickets = ticketResult.rows.map((ticket) => {
        const timing = measureTicket(
          ticket,
          events.get(ticket.id) ?? [],
          firstResponses.get(ticket.id) ?? null,
          now,
        );
        if (timing.firstResponseMs !== null) responseSamples.push(timing.firstResponseMs);
        if (timing.resolutionMs !== null) resolutionSamples.push(timing.resolutionMs);
        return {
          id: ticket.id,
          key: ticket.key,
          elapsedMs: timing.elapsedMs,
          waitingMs: timing.waitingMs,
          activeStateMs: timing.activeStateMs,
          firstResponseMs: timing.firstResponseMs,
        };
      });
      return {
        total: tickets.length,
        open: ticketResult.rows.filter(
          (ticket) => ticket.status !== 'resolved' && ticket.status !== 'cancelled',
        ).length,
        resolved: ticketResult.rows.filter((ticket) => ticket.status === 'resolved').length,
        firstResponseMeanMs: mean(responseSamples),
        firstResponseCount: responseSamples.length,
        resolutionMeanMs: mean(resolutionSamples),
        resolutionCount: resolutionSamples.length,
        tickets,
      };
    });
  }
}
