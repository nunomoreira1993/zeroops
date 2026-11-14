import { describe, expect, it } from 'vitest';
import { nextCronOccurrenceAfter } from './cron-schedule.js';

describe('cron schedule deadlines', () => {
  it('uses the next local run after activation for daily schedules', () => {
    expect(
      nextCronOccurrenceAfter('0 8 * * *', 'Europe/Lisbon', new Date('2026-11-09T10:00:00Z')),
    ).toEqual(new Date('2026-11-10T08:00:00Z'));
  });

  it('does not expect a task during a configured hourly pause', () => {
    expect(
      nextCronOccurrenceAfter(
        '*/10 0-5,11-23 * * *',
        'Europe/Lisbon',
        new Date('2026-11-10T05:50:30Z'),
      ),
    ).toEqual(new Date('2026-11-10T11:00:00Z'));
  });

  it('skips nonexistent local times during the spring DST transition', () => {
    expect(
      nextCronOccurrenceAfter('30 1 * * *', 'Europe/Lisbon', new Date('2026-03-28T01:30:00Z')),
    ).toEqual(new Date('2026-03-30T00:30:00Z'));
  });

  it('handles both real occurrences of a repeated local time during autumn DST', () => {
    expect(
      nextCronOccurrenceAfter('30 1 * * *', 'Europe/Lisbon', new Date('2026-10-25T00:30:30Z')),
    ).toEqual(new Date('2026-10-25T01:30:00Z'));
  });
});
