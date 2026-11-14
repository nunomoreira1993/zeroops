import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TicketStatus } from '../../../../contracts/src/index.js';
import type { EventRow } from '../tickets/tickets.rows.js';
import { measureTicket } from './ticket-timing.js';

const base = Date.parse('2026-01-01T00:00:00Z');
const at = (seconds: number) => new Date(base + seconds * 1000);
const event = (seconds: number, to: TicketStatus, from: TicketStatus | null = null): EventRow => ({
  id: randomUUID(),
  ticket_id: randomUUID(),
  from_status: from,
  to_status: to,
  created_at: at(seconds),
});

describe('ticket timing', () => {
  it('accounts for each waiting interval and freezes resolution rather than using the current status duration', () => {
    const history = [
      event(0, 'new'),
      event(10, 'awaiting_information'),
      event(20, 'investigating'),
      event(30, 'awaiting_client'),
      event(40, 'awaiting_technical'),
      event(60, 'awaiting_release'),
      event(70, 'deploying'),
      event(90, 'resolved'),
    ];
    const ticket = { created_at: at(0), updated_at: at(90), status: 'resolved' as const };
    expect(measureTicket(ticket, history, at(15), at(1000))).toEqual({
      elapsedMs: 90000,
      waitingMs: 50000,
      activeStateMs: 40000,
      firstResponseMs: 15000,
      resolutionMs: 90000,
    });
    expect(measureTicket(ticket, history, at(95), at(2000)).firstResponseMs).toBeNull();
  });

  it('preserves earlier cycles while excluding time closed after resolution and cancellation', () => {
    const history = [
      event(0, 'new'),
      event(10, 'resolved'),
      event(100, 'investigating', 'resolved'),
      event(110, 'awaiting_client'),
      event(120, 'cancelled'),
      event(200, 'investigating', 'cancelled'),
    ];
    const reopened = { created_at: at(0), updated_at: at(200), status: 'investigating' as const };
    expect(measureTicket(reopened, history, null, at(220))).toEqual({
      elapsedMs: 50000,
      waitingMs: 10000,
      activeStateMs: 40000,
      firstResponseMs: null,
      resolutionMs: null,
    });
    expect(
      measureTicket(
        { ...reopened, updated_at: at(230), status: 'resolved' },
        [...history, event(230, 'resolved')],
        null,
        at(1000),
      ).resolutionMs,
    ).toBe(60000);
  });

  it('counts true zero-duration resolutions, but does not invent samples from status alone', () => {
    const ticket = { created_at: at(0), updated_at: at(0), status: 'resolved' as const };
    expect(
      measureTicket(ticket, [event(0, 'new'), event(0, 'resolved')], at(0), at(100)),
    ).toMatchObject({
      elapsedMs: 0,
      resolutionMs: 0,
      firstResponseMs: 0,
    });
    expect(measureTicket(ticket, [], null, at(100)).resolutionMs).toBeNull();
  });

  it('uses the recorded closure rather than a stale or subsequently edited ticket timestamp', () => {
    const events = [event(0, 'new'), event(10, 'resolved')];
    for (const updated_at of [at(5), at(100)]) {
      const ticket = { created_at: at(0), updated_at, status: 'resolved' as const };
      expect(measureTicket(ticket, events, at(12), at(1000))).toMatchObject({
        elapsedMs: 10000,
        resolutionMs: 10000,
        firstResponseMs: null,
      });
    }
  });
});
