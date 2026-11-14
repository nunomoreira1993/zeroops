import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthSettingsSchema, type HealthOverview } from '@zeroops/contracts';
import { HealthAlertingTab } from '../src/features/health/HealthAlertingTab';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../src/lib/session', () => ({
  useSession: () => ({ request, user: { projectId: 'test-project' } }),
}));

vi.mock('../src/lib/project-admin', () => ({
  useProjectAdmin: () => null,
  useProjectSession: () => ({ request, session: { user: { projectId: 'test-project' } } }),
}));

const overview: HealthOverview = {
  settings: healthSettingsSchema.parse({ enabled: true }),
  configured: true,
  canManage: true,
  agentTokenConfigured: false,
  lastCycleAt: null,
  lastReportAt: null,
  lastAgentSampleAt: null,
  checks: [
    {
      id: 'scheduled-jobs',
      group: 'Verificações internas',
      title: 'Falha de processos automáticos ou tarefas agendadas',
      description: 'Idade da última execução de cada cron reportado.',
      criticality: 'critica',
      channels: ['painel', 'email', 'sms'],
      source: 'host_agent',
      siteStatus: 'analysis',
      status: 'ok',
      value: null,
      unit: null,
      summary: '',
      checkedAt: null,
      statusSince: null,
    },
  ],
  alerts: [],
  members: [],
  alertRulesSync: { state: 'disabled', syncedAt: null, message: null },
  suspension: { active: {}, history: [] },
};

describe('HealthAlertingTab', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    request.mockReset();
    request.mockImplementation((path: string) => {
      if (path.endsWith('/alert-links') || path.endsWith('/flows')) return Promise.resolve([]);
      return Promise.resolve(overview);
    });
  });

  it('keeps flow actions in the grouped Checks table and exposes threshold editing in its header', async () => {
    render(<HealthAlertingTab overview={overview} onSaved={vi.fn()} />);
    const checksHeading = screen.getByRole('heading', { name: 'Checks' });
    expect(screen.queryByRole('heading', { name: 'Alert rules and flows' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Verificações internas' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Fluxo' })).toBeTruthy();
    const createFlow = await screen.findByRole('button', { name: 'Criar fluxo próprio' });
    await waitFor(() => expect((createFlow as HTMLButtonElement).disabled).toBe(false));
    expect(
      checksHeading.compareDocumentPosition(createFlow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Editar alarmística' }));

    expect(
      screen.getByLabelText('Duração de DTQ de clientes (login) lento em minutos'),
    ).toBeTruthy();
    expect((createFlow as HTMLButtonElement).disabled).toBe(false);
  });

  it('saves edited rules without changing the rest of the health settings', async () => {
    const onSaved = vi.fn();
    render(<HealthAlertingTab overview={overview} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar alarmística' }));
    fireEvent.change(screen.getByLabelText('Duração de DTQ de clientes (login) lento em minutos'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gravar regras' }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/monitoring/settings', {
        method: 'POST',
        body: {
          ...overview.settings,
          alertRules: { DtqClientesLento: { forMinutes: 20 } },
        },
      }),
    );
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('discards unsaved rule edits when cancelling', () => {
    render(<HealthAlertingTab overview={overview} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar alarmística' }));
    fireEvent.change(screen.getByLabelText('Duração de DTQ de clientes (login) lento em minutos'), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(screen.queryByRole('button', { name: 'Gravar regras' })).toBeNull();
    expect(request).not.toHaveBeenCalledWith(
      '/monitoring/settings',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps rule editing unavailable to non-administrators', () => {
    render(<HealthAlertingTab overview={{ ...overview, canManage: false }} onSaved={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Editar alarmística' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Criar fluxo próprio' })).toBeNull();
  });

  it('shows a save error without reporting success', async () => {
    request.mockImplementation((path: string) => {
      if (path.endsWith('/alert-links') || path.endsWith('/flows')) return Promise.resolve([]);
      return Promise.reject(new Error('Não foi possível gravar.'));
    });
    const onSaved = vi.fn();
    render(<HealthAlertingTab overview={overview} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar alarmística' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gravar regras' }));

    expect(await screen.findByText('Não foi possível gravar.')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
