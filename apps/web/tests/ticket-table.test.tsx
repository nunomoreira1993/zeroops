import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ticket } from '@zeroops/contracts';
import { TicketTable } from '../src/features/tickets/TicketTable';
import { IdentityLocaleProvider, LocalePicker } from '../src/lib/identity';

const ticket: Ticket = {
  id: '22222222-2222-4222-8222-222222222222',
  key: 'ZO-100',
  projectId: '11111111-1111-4111-8111-111111111111',
  createdBy: '33333333-3333-4333-8333-333333333333',
  creatorName: 'Ana Silva',
  title: 'Synthetic maintenance request',
  description: 'A synthetic request for creation metadata checks.',
  category: 'question',
  environment: 'quality',
  priority: 'medium',
  status: 'new',
  version: 0,
  createdAt: '2026-11-01T12:15:00.000Z',
  updatedAt: '2026-11-11T15:30:00.000Z',
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'pt-PT';
});
afterEach(cleanup);

describe('TicketTable creation metadata', () => {
  it.each([false, true])(
    'shows the actual creation date and creator with compact=%s',
    (compact) => {
      const { container } = render(
        <IdentityLocaleProvider>
          <TicketTable tickets={[ticket]} compact={compact} />
        </IdentityLocaleProvider>,
      );
      const created = container.querySelector(`time[datetime="${ticket.createdAt}"]`);
      expect(created?.textContent).toContain('2026');
      expect(screen.getByText(/por Ana Silva/)).toBeTruthy();
      expect(screen.queryByText(ticket.createdBy)).toBeNull();
      expect(container.querySelector(`time[datetime="${ticket.updatedAt}"]`)).not.toBeNull();
    },
  );

  it('localizes creation labels and clearly identifies missing creator information in older responses', () => {
    const legacyTicket = { ...ticket };
    delete legacyTicket.creatorName;
    render(
      <IdentityLocaleProvider>
        <LocalePicker />
        <TicketTable tickets={[legacyTicket]} compact />
      </IdentityLocaleProvider>,
    );
    fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    expect(screen.getByText(/Created on.*by Creator unavailable/)).toBeTruthy();
    expect(screen.queryByText(ticket.createdBy)).toBeNull();
  });
});
