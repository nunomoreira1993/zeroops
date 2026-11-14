import { describe, expect, it } from 'vitest';
import { nextTicketStatus } from './ticket-transition.js';

describe('ticket transition policy', () => {
  it.each([
    ['new', 'technical', 'investigate', 'investigating'],
    ['blocked', 'admin', 'investigate', 'investigating'],
    ['new', 'technical', 'request_information', 'awaiting_information'],
    ['investigating', 'admin', 'request_information', 'awaiting_information'],
    ['awaiting_information', 'client', 'resume', 'investigating'],
    ['awaiting_information', 'technical', 'resume', 'investigating'],
    ['resolved', 'client', 'reopen', 'new'],
    ['cancelled', 'qa', 'reopen', 'new'],
    ['investigating', 'technical', 'cancel', 'cancelled'],
    ['blocked', 'admin', 'cancel', 'cancelled'],
  ] as const)('allows %s/%s/%s to %s', (status, role, action, expected) => {
    expect(nextTicketStatus(status, role, action)).toBe(expected);
  });

  it.each([
    ['new', 'client', 'investigate'],
    ['resolved', 'technical', 'request_information'],
    ['investigating', 'client', 'resume'],
    ['new', 'technical', 'reopen'],
    ['implementing', 'technical', 'cancel'],
    ['blocked', 'qa', 'cancel'],
  ] as const)('rejects %s/%s/%s', (status, role, action) => {
    expect(() => nextTicketStatus(status, role, action)).toThrow();
  });
});
