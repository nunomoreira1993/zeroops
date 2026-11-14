import type { ReactNode } from 'react';
import type { TicketStatus } from '@zeroops/contracts';
import { ticketLabels } from '../lib/format';
import { useIdentityLocale } from '../lib/identity';
import { Icon, type IconName } from './Icon';

export function Notice({
  children,
  tone = 'error',
}: {
  children: ReactNode;
  tone?: 'error' | 'warning' | 'success' | 'info';
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon
        name={tone === 'success' ? 'check' : tone === 'info' ? 'shield' : 'warning'}
        size={18}
      />
      <div>{children}</div>
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useIdentityLocale();
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? t('A carregar…', 'Loading…')}</span>
    </div>
  );
}

export function ResourceError({ error, retry }: { error: string; retry: () => void }) {
  const { t } = useIdentityLocale();
  return (
    <div className="stack">
      <Notice>{error}</Notice>
      <button className="kt-btn kt-btn-outline align-start" onClick={retry}>
        <Icon name="refresh" size={16} /> {t('Tentar novamente', 'Try again')}
      </button>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  icon = 'ticket',
  action,
}: {
  title: string;
  children: ReactNode;
  icon?: IconName;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function StatusBadge({ status }: { status: TicketStatus }) {
  const { locale } = useIdentityLocale();
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {ticketLabels(locale).status[status]}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1 tabIndex={-1} id="page-title">
          {title}
        </h1>
        <p className="page-description">{description}</p>
      </div>
      {action}
    </header>
  );
}
