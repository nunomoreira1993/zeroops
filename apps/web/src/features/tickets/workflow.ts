import type { TicketAssignments, TicketStatus, Role } from '@zeroops/contracts';
import type { Locale } from '../../lib/identity';

export const decisionRoles: Partial<Record<TicketStatus, keyof TicketAssignments>> = {
  awaiting_client: 'client',
  awaiting_technical: 'technical',
  awaiting_qa: 'qa',
  awaiting_release: 'release',
};

export function canPublishProposal(role: Role, status: TicketStatus): boolean {
  return (
    ['technical', 'admin'].includes(role) &&
    [
      'new',
      'investigating',
      'awaiting_client',
      'awaiting_technical',
      'awaiting_confirmation',
      'blocked',
    ].includes(status)
  );
}

export interface TransitionOption {
  action: 'investigate' | 'request_information' | 'resume' | 'cancel' | 'reopen';
  label: string;
}

export function availableTransitions(
  role: Role,
  status: TicketStatus,
  locale: Locale = 'pt-PT',
): TransitionOption[] {
  const t = (pt: string, en: string) => (locale === 'en' ? en : pt);
  const options: TransitionOption[] = [];
  const staff = role === 'technical' || role === 'admin';
  if (staff && ['new', 'blocked'].includes(status))
    options.push({ action: 'investigate', label: t('Iniciar análise', 'Start analysis') });
  if (staff && ['new', 'investigating'].includes(status))
    options.push({
      action: 'request_information',
      label: t('Pedir informação', 'Request information'),
    });
  if (status === 'awaiting_information')
    options.push({ action: 'resume', label: t('Retomar análise', 'Resume analysis') });
  if (['resolved', 'cancelled'].includes(status))
    options.push({ action: 'reopen', label: t('Reabrir pedido', 'Reopen ticket') });
  if (
    staff &&
    [
      'new',
      'investigating',
      'awaiting_information',
      'awaiting_client',
      'awaiting_technical',
      'awaiting_confirmation',
      'blocked',
    ].includes(status)
  )
    options.push({ action: 'cancel', label: t('Cancelar pedido', 'Cancel ticket') });
  return options;
}
