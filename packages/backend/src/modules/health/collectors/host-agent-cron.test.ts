import { describe, expect, it } from 'vitest';
import {
  healthAgentSampleSchema,
  healthSettingsSchema,
  type HealthCronSample,
} from '../../../../../contracts/src/index.js';
import { HostAgentCollector } from './host-agent.collector.js';

const settings = healthSettingsSchema.parse({});
const context = (now: Date) => ({ projectId: 'p', settings, now, previous: () => undefined });

function scheduledCron(
  overrides: Partial<Extract<HealthCronSample, { id: string }>> = {},
): Extract<HealthCronSample, { id: string }> {
  return {
    id: 'ph-root-http-001',
    name: 'Pizza Hut daily report',
    schedule: '0 8 * * *',
    timeZone: 'Europe/Lisbon',
    graceMinutes: 30,
    activatedAt: '2026-11-09T10:00:00Z',
    lastAttemptAt: null,
    lastExitCode: null,
    lastHttpStatus: null,
    lastHttpCurlExitCode: null,
    lastHttpCompletedAt: null,
    lastHttpCompletedStatus: null,
    lastFailureAt: null,
    lastFailureCode: null,
    inProgress: false,
    ...overrides,
  };
}

async function collectCron(cron: ReturnType<typeof scheduledCron>, now: Date) {
  const collector = new HostAgentCollector({
    latest: async () => [{ receivedAt: now, sample: { host: 'web1', crons: [cron] } }],
    latestBefore: async () => null,
  });
  return (await collector.collect(context(now))).find((item) => item.checkId === 'scheduled-jobs')!;
}

describe('scheduled cron heartbeats', () => {
  it('accepts both the legacy age sample and the scheduled-task contract', () => {
    expect(
      healthAgentSampleSchema.safeParse({
        host: 'web1',
        crons: [{ name: 'legacy', lastRunAgeMinutes: 31 }],
      }).success,
    ).toBe(true);
    expect(healthAgentSampleSchema.safeParse({ host: 'web1', crons: [scheduledCron()] }).success).toBe(
      true,
    );
  });

  it('keeps first execution pending until its daily deadline, then warns', async () => {
    const pending = await collectCron(scheduledCron(), new Date('2026-11-10T08:29:59Z'));
    expect(pending.status).toBe('unknown');
    expect(pending.summary).toContain('pendente até 2026-11-10T08:30:00.000Z');

    const late = await collectCron(scheduledCron(), new Date('2026-11-10T08:31:00Z'));
    expect(late.status).toBe('warning');
    expect(late.summary).toContain('prazo 2026-11-10T08:00:00.000Z');
  });

  it('does not report a scheduled task late during its configured pause', async () => {
    const result = await collectCron(
      scheduledCron({
        name: 'Pizza Hut windowed task',
        schedule: '*/10 0-5,11-23 * * *',
        activatedAt: '2026-11-09T00:00:00Z',
        lastAttemptAt: '2026-11-10T05:50:30Z',
        lastExitCode: 0,
        lastHttpStatus: 200,
        lastHttpCurlExitCode: 0,
        lastHttpCompletedAt: '2026-11-10T05:50:30Z',
        lastHttpCompletedStatus: 200,
      }),
      new Date('2026-11-10T09:00:00Z'),
    );

    expect(result.status).toBe('ok');
    expect(result.summary).toContain('próximo prazo 2026-11-10T11:00:00.000Z');
  });

  it('records an HTTP failure without renewing the prior HTTP completion', async () => {
    const result = await collectCron(
      scheduledCron({
        schedule: '* * * * *',
        lastAttemptAt: '2026-11-10T08:05:00Z',
        lastExitCode: 0,
        lastHttpStatus: 500,
        lastHttpCurlExitCode: 0,
        lastHttpCompletedAt: '2026-11-10T08:00:00Z',
        lastHttpCompletedStatus: 200,
        lastFailureAt: '2026-11-10T08:05:00Z',
        lastFailureCode: 'http:500',
      }),
      new Date('2026-11-10T08:06:00Z'),
    );

    expect(result.status).toBe('warning');
    expect(result.summary).toContain('última tentativa falhou (http:500)');
    expect(result.summary).toContain('conclusão HTTP 200');
    expect(result.summary).toContain('sucesso funcional não verificado');
  });

  it('continues to apply the global threshold to legacy payloads', async () => {
    const collector = new HostAgentCollector({
      latest: async () => [
        {
          receivedAt: new Date('2026-11-10T08:00:00Z'),
          sample: { host: 'web1', crons: [{ name: 'legacy', lastRunAgeMinutes: 31 }] },
        },
      ],
      latestBefore: async () => null,
    });

    const result = (await collector.collect(context(new Date('2026-11-10T08:01:00Z')))).find(
      (item) => item.checkId === 'scheduled-jobs',
    );
    expect(result?.status).toBe('warning');
    expect(result?.summary).toContain('limite legado 30');
  });
});
