import type { CreateTicket, Role, TicketEnvironment, TicketStatus } from '@zeroops/contracts';
import type { Locale } from './identity';

export const statusLabels: Record<TicketStatus, string> = {
  new: 'Novo',
  investigating: 'Em análise',
  awaiting_information: 'Aguarda informação',
  awaiting_client: 'Aprovação do cliente',
  awaiting_technical: 'Aprovação técnica',
  awaiting_confirmation: 'Confirmação de resolução',
  implementing: 'Em implementação',
  awaiting_qa: 'Validação de QA',
  awaiting_release: 'Aprovação de release',
  deploying: 'Em publicação',
  resolved: 'Resolvido',
  blocked: 'Bloqueado',
  cancelled: 'Cancelado',
};
export const priorityLabels: Record<CreateTicket['priority'], string> = {
  low: 'Baixa',
  medium: 'Normal',
  high: 'Alta',
  critical: 'Crítica',
};
export const categoryLabels: Record<CreateTicket['category'], string> = {
  incident: 'Incidente',
  bug: 'Erro',
  improvement: 'Melhoria',
  question: 'Esclarecimento',
};
export const environmentLabels: Record<TicketEnvironment, string> = {
  development: 'Desenvolvimento',
  quality: 'Qualidade',
  production: 'Produção',
};
export const roleLabels: Record<Role, string> = {
  client: 'Cliente',
  technical: 'Equipa técnica',
  qa: 'Qualidade',
  release: 'Gestor de release',
  admin: 'Administrador',
};
const englishLabels = {
  status: {
    new: 'New',
    investigating: 'Investigating',
    awaiting_information: 'Awaiting information',
    awaiting_client: 'Client approval',
    awaiting_technical: 'Technical approval',
    awaiting_confirmation: 'Resolution confirmation',
    implementing: 'Implementing',
    awaiting_qa: 'QA validation',
    awaiting_release: 'Release approval',
    deploying: 'Deploying',
    resolved: 'Resolved',
    blocked: 'Blocked',
    cancelled: 'Cancelled',
  } satisfies Record<TicketStatus, string>,
  priority: { low: 'Low', medium: 'Normal', high: 'High', critical: 'Critical' },
  category: { incident: 'Incident', bug: 'Bug', improvement: 'Improvement', question: 'Question' },
  environment: { development: 'Development', quality: 'Quality', production: 'Production' },
  role: {
    client: 'Client',
    technical: 'Technical team',
    qa: 'Quality',
    release: 'Release manager',
    admin: 'Administrator',
  },
};

export function ticketLabels(locale: Locale = 'pt-PT') {
  return locale === 'en'
    ? englishLabels
    : {
        status: statusLabels,
        priority: priorityLabels,
        category: categoryLabels,
        environment: environmentLabels,
        role: roleLabels,
      };
}

export const intlLocale = (locale: Locale = 'pt-PT') => (locale === 'en' ? 'en-GB' : 'pt-PT');
export const shortDate = (value: string, locale: Locale = 'pt-PT') =>
  new Intl.DateTimeFormat(intlLocale(locale), { day: '2-digit', month: 'short' }).format(
    new Date(value),
  );
export const dateTime = (value: string, locale: Locale = 'pt-PT') =>
  new Intl.DateTimeFormat(intlLocale(locale), {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
export const number = (value: number, locale: Locale = 'pt-PT') =>
  new Intl.NumberFormat(intlLocale(locale)).format(value);
export function duration(value: number | null): string {
  if (value === null) return '—';
  const minutes = Math.max(0, Math.floor(value / 60_000));
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}
export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1))
    .join('')
    .toUpperCase();
