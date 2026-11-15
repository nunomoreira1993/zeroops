import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationsMetrics } from '@zeroops/contracts';
import { OperationsMetricsPage } from '../src/features/projects/OperationsMetricsPage';
import { IdentityLocaleProvider } from '../src/lib/identity';
import { SessionProvider } from '../src/lib/session';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const user = {
  id: 'tech',
  projectId: 'project',
  displayName: 'Técnico',
  email: 'tech@example.test',
  role: 'technical',
  instanceAdmin: false,
  locale: 'pt-PT',
};

const metrics = (days: number): OperationsMetrics => ({
  projectId: 'project',
  windowDays: days,
  generatedAt: '2030-01-01T00:00:00Z',
  queues: [
    {
      kind: 'agent_run',
      pending: 1,
      running: 0,
      oldestPendingSeconds: 30,
      meanWaitSeconds: null,
      started: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    },
  ],
  steps: [],
  leases: [{ eventType: 'lease_lost', total: 2 }],
  human: {
    waitingSteps: 0,
    oldestWaitingSeconds: null,
    decisions: 0,
    meanDecisionSeconds: null,
    agentQuestions: 0,
    answersPending: 0,
    answersConsumed: 0,
  },
  copilot: {
    runsWithUsage: 1,
    modelCalls: 2,
    inputTokens: 150,
    outputTokens: 15,
    aiCredits: null,
    callsWithoutReportedCredits: 2,
    models: ['gpt-x'],
    quota: null,
  },
  tools: [],
  deliveries: [],
  interventions: [],
  uncertain: { deliveries: 1, interventions: 0 },
  health: {
    incidents: 0,
    open: 0,
    recovered: 0,
    meanRecoverySeconds: null,
    recurrences: 0,
    validationsConfirmed: 1,
    validationsNotConfirmed: 2,
    validationsUnknownTelemetry: 1,
  },
  correlation: [
    {
      at: '2030-01-01T00:00:00Z',
      kind: 'job_lease',
      detail: 'lease_lost',
      projectId: 'project',
      ticketId: 't1',
      ticketKey: 'ZO-7',
      flowVersionId: null,
      executionId: null,
      stepId: null,
      jobId: 'job-1',
      attempt: 2,
      externalOperation: null,
    },
  ],
});

describe('Operação (P11)', () => {
  it('mostra valores ausentes como não registados e muda a janela pedida', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/api/session') return Response.json({ user, csrfToken: 'csrf' });
      const match = /^\/api\/projects\/project\/operations\/metrics\?days=(\d+)$/.exec(String(url));
      if (match) return Response.json(metrics(Number(match[1])));
      return Response.json({}, { status: 404 });
    });
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <OperationsMetricsPage projectId="project" />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    await screen.findByText('Filas e trabalhos');
    const text = () => document.body.textContent ?? '';
    expect(text()).toContain('AI credits: não registado');
    expect(text()).toContain('2 chamadas sem créditos reportados');
    expect(text()).toContain('lease_lost 2');
    expect(text()).toContain('ZO-7');
    expect(text()).not.toContain('AI credits: 0');
    expect(text()).toMatch(/1 confirmadas,\s*2 sem confirmação \(\s*1 sem telemetria\s*\)/);

    fireEvent.change(screen.getByLabelText('Janela'), { target: { value: '7' } });
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => String(url).endsWith('/operations/metrics?days=7')),
      ).toBe(true),
    );
  });
});
