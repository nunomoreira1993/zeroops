import type { TicketStatus } from '../../../../contracts/src/index.js';
import type { EventRow, TicketRow } from '../tickets/tickets.rows.js';

const waitingStates = new Set<TicketStatus>([
  'awaiting_information',
  'awaiting_client',
  'awaiting_technical',
  'awaiting_confirmation',
  'awaiting_release',
]);
const closedStates = new Set<TicketStatus>(['resolved', 'cancelled']);

export interface TicketTiming {
  elapsedMs: number;
  waitingMs: number;
  activeStateMs: number;
  firstResponseMs: number | null;
  resolutionMs: number | null;
}

/**
 * Closed intervals do not accrue time. Reopening resumes the original timeline
 * without losing earlier work or counting time the ticket spent resolved.
 * First response remains wall-clock time from creation to the first eligible reply.
 */
export function measureTicket(
  ticket: Pick<TicketRow, 'created_at' | 'updated_at' | 'status'>,
  events: EventRow[],
  firstResponse: Date | null,
  now: Date,
): TicketTiming {
  const created = ticket.created_at.getTime();
  const current = Math.max(created, now.getTime());
  const history = events.filter(
    (event) => event.created_at.getTime() >= created && event.created_at.getTime() <= current,
  );
  const finalEvent = history.at(-1);
  const closedAt =
    finalEvent && finalEvent.to_status === ticket.status
      ? finalEvent.created_at.getTime()
      : ticket.updated_at.getTime();
  const end = closedStates.has(ticket.status)
    ? Math.min(current, Math.max(created, closedAt))
    : current;
  let previous = created;
  let state: TicketStatus = 'new';
  let elapsedMs = 0;
  let waitingMs = 0;
  let lastEvent: EventRow | undefined;

  const accumulate = (until: number) => {
    const duration = Math.max(0, until - previous);
    if (!closedStates.has(state)) {
      elapsedMs += duration;
      if (waitingStates.has(state)) waitingMs += duration;
    }
    previous = until;
  };
  for (const event of history) {
    const at = event.created_at.getTime();
    if (at < created || at > end) continue;
    accumulate(Math.max(previous, at));
    state = event.to_status;
    lastEvent = event;
  }
  accumulate(end);

  // An open/reopened ticket is not a completed resolution sample.
  const resolved = ticket.status === 'resolved' && lastEvent?.to_status === 'resolved';
  const responseAt = firstResponse?.getTime();
  const responseEnd =
    closedStates.has(ticket.status) && lastEvent && lastEvent.to_status === ticket.status
      ? lastEvent.created_at.getTime()
      : end;
  return {
    elapsedMs,
    waitingMs,
    activeStateMs: elapsedMs - waitingMs,
    firstResponseMs:
      responseAt !== undefined && responseAt >= created && responseAt <= responseEnd
        ? responseAt - created
        : null,
    resolutionMs: resolved ? elapsedMs : null,
  };
}
