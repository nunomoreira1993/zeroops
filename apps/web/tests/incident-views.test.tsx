import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TicketIncidentView } from '@zeroops/contracts';
import { TicketIncidentPanel } from '../src/features/flows/IncidentViews';
import { IdentityLocaleProvider } from '../src/lib/identity';

const incident: TicketIncidentView = {
  environment: 'production',
  state: 'recovered',
  resource: {
    kind: 'database',
    engine: 'mysql',
    host: 'db01',
    unit: 'mariadb.service',
    environment: 'production',
    managed: true,
  },
  alertComponent: 'site pizzahut (web01)',
  causeComponent: 'MySQL em db01',
  causeConfirmed: true,
  demoScenario: 'mysql',
  openedAt: '2031-03-01T08:00:00.000Z',
  recoveredAt: '2031-03-01T08:05:00.000Z',
  interventions: [
    {
      id: 'i1',
      ticketId: 't1',
      stepId: 'intervir',
      action: 'service_restart',
      target: 'mariadb.service',
      parameter: null,
      previousValue: null,
      newValue: null,
      rollback: null,
      decision: 'auto',
      decisionReason: 'Regra: reinício automático em produção.',
      status: 'simulated',
      result: 'Serviço ativo.',
      actor: 'agent',
      createdAt: '2031-03-01T08:02:00.000Z',
      finishedAt: '2031-03-01T08:03:00.000Z',
    },
  ],
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'pt-PT';
});
afterEach(cleanup);

describe('TicketIncidentPanel', () => {
  it('destaca a causa num componente diferente do alerta e lista as intervenções', () => {
    const { container } = render(
      <IdentityLocaleProvider>
        <TicketIncidentPanel incident={incident} />
      </IdentityLocaleProvider>,
    );
    expect(screen.getByTestId('ticket-incident')).toBeTruthy();
    expect(container.querySelector('.incident-component.is-different')?.textContent).toContain(
      'MySQL em db01',
    );
    expect(screen.getByText(/diferente do componente do alerta/)).toBeTruthy();
    expect(container.querySelectorAll('.incident-interventions tbody tr')).toHaveLength(1);
    expect(container.querySelector('.incident-interventions')?.textContent).toContain(
      'mariadb.service',
    );
  });

  it('não marca diferença quando a causa ainda está por apurar', () => {
    const { container } = render(
      <IdentityLocaleProvider>
        <TicketIncidentPanel
          incident={{ ...incident, causeComponent: null, causeConfirmed: false, interventions: [] }}
        />
      </IdentityLocaleProvider>,
    );
    expect(container.querySelector('.is-different')).toBeNull();
    expect(screen.getByText('Por apurar')).toBeTruthy();
    expect(screen.getByText('Nenhuma intervenção registada.')).toBeTruthy();
  });
});
