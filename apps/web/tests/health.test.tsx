import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertRuleCatalog, healthSettingsSchema, type HealthOverview } from '@zeroops/contracts';
import { HealthPage } from '../src/features/health/HealthPage';
import { HealthAlertRules, localizedAlertRule } from '../src/features/health/HealthAlertRules';
import { HealthSettingsForm } from '../src/features/health/HealthSettingsForm';
import { HealthQuietWindows } from '../src/features/health/HealthQuietWindows';
import { Loading, ResourceError, StatusBadge } from '../src/components/ui';
import { IdentityLocaleProvider, LocalePicker } from '../src/lib/identity';
import { dateTime, number, shortDate, statusLabels, ticketLabels } from '../src/lib/format';
import {
  formatDateTime,
  formatShortDate,
  ticketLabels as legacyTicketLabels,
} from '../src/features/tickets/labels';
import { fromRoutingDraft, toRoutingDraft } from '../src/features/health/HealthRecipientLists';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/session', () => ({
  useSession: () => ({ request }),
}));

const overview: HealthOverview = {
  settings: healthSettingsSchema.parse({ enabled: true }),
  configured: true,
  canManage: true,
  agentTokenConfigured: false,
  lastCycleAt: null,
  lastReportAt: null,
  lastAgentSampleAt: null,
  checks: [],
  alerts: [],
  members: [],
  alertRulesSync: { state: 'disabled', syncedAt: null, message: null },
  suspension: { active: {}, history: [] },
};

describe('HealthPage', () => {
  beforeAll(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
  });

  beforeEach(() => {
    request.mockImplementation(async (path: string) => {
      if (path === '/monitoring') return overview;
      return { state: 'blocked', errorCode: 'smtp_not_configured' };
    });
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
  });

  it('does not claim the report was sent when SMTP blocks delivery', async () => {
    render(<HealthPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar relatório' }));
    expect(
      await screen.findByText(
        'O relatório não foi enviado. Verifique a integração SMTP e os destinatários.',
      ),
    ).toBeTruthy();
  });

  it('suspends an environment with a reason and offers to resume it', async () => {
    const suspended: HealthOverview = {
      ...overview,
      suspension: {
        active: {
          production: {
            id: 's1',
            environment: 'production',
            reason: 'Manutenção web01',
            suspendedBy: 'Nuno',
            suspendedAt: '2026-05-13T10:00:00.000Z',
            resumedBy: null,
            resumedAt: null,
            cancelledRuns: 1,
          },
        },
        history: [],
      },
    };
    let current = overview;
    request.mockImplementation(async (path: string) => {
      if (path === '/monitoring') return current;
      if (path === '/monitoring/suspend') current = suspended;
      return current.suspension;
    });
    render(<HealthPage />);
    const env = await screen.findByTestId('health-suspension-production');
    fireEvent.click(within(env).getByRole('button', { name: 'Suspender' }));
    const submit = screen.getByRole('button', { name: 'Suspender agora' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Manutenção web01' } });
    fireEvent.click(submit);
    expect(await screen.findByText('Saúde suspensa em Produção.')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/monitoring/suspend', {
      method: 'POST',
      body: { environment: 'production', reason: 'Manutenção web01' },
    });
    expect(
      await within(screen.getByTestId('health-suspension-production')).findByRole('button', {
        name: 'Retomar',
      }),
    ).toBeTruthy();
  });

  it('round-trips distribution lists and drops empty routes', () => {
    const settings = healthSettingsSchema.parse({
      enabled: true,
      lists: [{ id: 'tec', name: 'Técnica', emails: ['a@x.pt', 'b@x.pt'] }],
      defaults: { critica: ['tec'] },
      routes: { 'redis-down': ['tec'] },
    });
    const draft = toRoutingDraft(settings);
    expect(draft.lists[0]?.emailsText).toBe('a@x.pt, b@x.pt');
    const saved = fromRoutingDraft({
      ...draft,
      lists: [{ id: 'tec', name: 'Técnica', emailsText: 'a@x.pt; c@x.pt\nd@x.pt' }],
      routes: { 'redis-down': ['tec'], 'disk-free': [] },
    });
    expect(saved.lists[0]?.emails).toEqual(['a@x.pt', 'c@x.pt', 'd@x.pt']);
    expect(saved.routes).toEqual({ 'redis-down': ['tec'] });
    expect(healthSettingsSchema.safeParse({ ...settings, ...saved }).success).toBe(true);
  });

  it('confirms report delivery only after the SMTP accepts it', async () => {
    request.mockImplementation(async (path: string) =>
      path === '/monitoring' ? overview : { state: 'sent', errorCode: null },
    );
    render(<HealthPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar relatório' }));
    expect(await screen.findByText('O servidor SMTP aceitou o relatório.')).toBeTruthy();
  });

  it('stores only alert rule changes that differ from the catalog', () => {
    const onChange = vi.fn();
    const sync = { state: 'ok', syncedAt: null, message: null } as const;
    const { rerender } = render(
      <HealthAlertRules overrides={{}} sync={sync} onChange={onChange} />,
    );
    const field = screen.getByLabelText('Duração de DTQ de clientes (login) lento em minutos');
    fireEvent.change(field, { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ DtqClientesLento: { forMinutes: 20 } });

    rerender(
      <HealthAlertRules
        overrides={{ DtqClientesLento: { forMinutes: 20 } }}
        sync={sync}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Duração de DTQ de clientes (login) lento em minutos'), {
      target: { value: '15' },
    });
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('switches shared UI labels without translating caller content', () => {
    const retry = vi.fn();
    render(
      <IdentityLocaleProvider>
        <LocalePicker />
        <StatusBadge status="investigating" />
        <Loading />
        <Loading label="API user content" />
        <ResourceError error="Original API error" retry={retry} />
      </IdentityLocaleProvider>,
    );
    expect(screen.getByText('Em análise')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    expect(screen.getByText('Investigating')).toBeTruthy();
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.getByText('API user content')).toBeTruthy();
    expect(screen.getByText('Original API error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('shares ticket labels and keeps Portuguese formatter defaults', () => {
    const value = '2026-11-11T09:30:00Z';
    expect(legacyTicketLabels).toBe(ticketLabels);
    expect(ticketLabels().status).toBe(statusLabels);
    expect(ticketLabels('en').environment.production).toBe('Production');
    expect(ticketLabels('en').role.technical).toBe('Technical team');
    expect(formatDateTime).toBe(dateTime);
    expect(formatShortDate).toBe(shortDate);
    expect(dateTime(value)).toBe(dateTime(value, 'pt-PT'));
    expect(shortDate(value)).toBe(shortDate(value, 'pt-PT'));
    expect(shortDate(value, 'en')).toBe(
      new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(value)),
    );
    expect(number(1234.5, 'en')).toBe('1,234.5');
    expect(number(1234.5)).toBe(new Intl.NumberFormat('pt-PT').format(1234.5));
  });

  it('localizes every catalog rule title, description and threshold without mutating contracts', () => {
    for (const rule of alertRuleCatalog) {
      expect(localizedAlertRule(rule, 'pt-PT')).toBe(rule);
      const english = localizedAlertRule(rule, 'en');
      expect(english.title).not.toBe(rule.title);
      expect(english.description).not.toBe(rule.description);
      if (rule.threshold) expect(english.threshold?.label).not.toBe(rule.threshold.label);
    }
  });

  it('switches settings tabs and labels live', () => {
    render(
      <IdentityLocaleProvider>
        <LocalePicker />
        <HealthSettingsForm overview={overview} onSaved={vi.fn()} />
      </IdentityLocaleProvider>,
    );
    fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByLabelText('Data collected from')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Alert rules' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Limits' }));
    expect(screen.getByLabelText('Minimum free disk (%)')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Server agent' }));
    expect(screen.getByRole('button', { name: 'Generate agent token' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeTruthy();
  });

  it('localizes downtime targets and defaults but preserves existing user names', () => {
    const onChange = vi.fn();
    render(
      <IdentityLocaleProvider>
        <LocalePicker />
        <HealthQuietWindows
          windows={[
            {
              name: 'Nome do utilizador',
              start: '01:00',
              end: '07:00',
              timezone: 'Europe/Lisbon',
              days: [1],
              checks: [],
            },
          ]}
          checks={[]}
          onChange={onChange}
        />
      </IdentityLocaleProvider>,
    );
    fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    expect(screen.getByLabelText('Name').getAttribute('value')).toBe('Nome do utilizador');
    expect(screen.getByLabelText('Mon')).toBeTruthy();
    expect(screen.getByLabelText('Network share nearly full')).toBeTruthy();
    expect(screen.getByLabelText('DTQ users probe (Production)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add downtime' }));
    expect(onChange.mock.lastCall?.[0][1].name).toBe('Planned downtime');
    expect(onChange.mock.lastCall?.[0][0].name).toBe('Nome do utilizador');
  });
});
