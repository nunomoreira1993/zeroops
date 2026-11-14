import { useState } from 'react';
import type {
  HealthAlertHistoryEntry,
  HealthCheckView,
  HealthHistory,
  HealthNotificationView,
} from '@zeroops/contracts';
import { Loading, ResourceError } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { healthHref } from './HealthTabs';
import { formatDate, formatDuration, healthLabels } from './health-labels';

const periods = [7, 30, 90] as const;

function DeliveryState({ item }: { item: HealthNotificationView }) {
  const { locale } = useIdentityLocale();
  const { deliveryError: deliveryErrorLabels, deliveryState: deliveryStateLabels } =
    healthLabels(locale);
  const error = item.errorCode ? (deliveryErrorLabels[item.errorCode] ?? item.errorCode) : null;
  return (
    <span className={`health-delivery health-delivery-${item.state}`} title={error ?? undefined}>
      {deliveryStateLabels[item.state]}
      {error ? ` · ${error}` : ''}
    </span>
  );
}

function Recipients({ list }: { list: string[] }) {
  const { t } = useIdentityLocale();
  return list.length ? (
    <span className="health-recipients">{list.join(', ')}</span>
  ) : (
    <span className="health-muted">{t('sem destinatários', 'no recipients')}</span>
  );
}

type TimelineItem =
  | { type: 'event'; at: string; event: HealthAlertHistoryEntry['events'][number] }
  | { type: 'notification'; at: string; notification: HealthNotificationView };

/** Cronologia de um alarme: eventos (abertura, receção, atribuição…) e cada envio por canal. */
export function HealthAlertTimeline({ alert }: { alert: HealthAlertHistoryEntry }) {
  const { locale, t } = useIdentityLocale();
  const {
    alertEvent: alertEventLabels,
    channel: channelLabels,
    notificationKind: notificationKindLabels,
  } = healthLabels(locale);
  const items: TimelineItem[] = [
    ...alert.events.map((event) => ({ type: 'event' as const, at: event.at, event })),
    ...alert.notifications.map((notification) => ({
      type: 'notification' as const,
      at: notification.createdAt,
      notification,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (!items.length)
    return <p className="health-muted">{t('Sem eventos registados.', 'No recorded events.')}</p>;
  return (
    <ol className="health-timeline">
      {items.map((item, index) =>
        item.type === 'event' ? (
          <li key={`e-${index}`} className={`health-timeline-item health-event-${item.event.kind}`}>
            <time dateTime={item.at}>{formatDate(item.at, locale)}</time>
            <div>
              <strong>{alertEventLabels[item.event.kind]}</strong>
              {item.event.kind === 'assigned' &&
                item.event.detail &&
                `${t(' a ', ' to ')}${item.event.detail}`}
              {item.event.actorName && (
                <span className="health-muted">
                  {t('por', 'by')} {item.event.actorName}
                </span>
              )}
              {item.event.kind === 'ticket' && item.event.detail ? (
                <a className="health-muted" href={`#tickets/${item.event.detail}`}>
                  {t('Abrir ticket', 'Open ticket')}
                </a>
              ) : (
                item.event.detail &&
                item.event.kind !== 'assigned' &&
                item.event.kind !== 'unassigned' && (
                  <span className="health-muted">{item.event.detail}</span>
                )
              )}
            </div>
          </li>
        ) : (
          <li
            key={`n-${item.notification.id}`}
            className="health-timeline-item health-timeline-notification"
          >
            <time dateTime={item.at}>{formatDate(item.at, locale)}</time>
            <div>
              <strong>
                {notificationKindLabels[item.notification.kind]} {t('por', 'via')}{' '}
                {channelLabels[item.notification.channel] ?? item.notification.channel}
              </strong>{' '}
              <DeliveryState item={item.notification} />
              <span className="health-muted">
                {item.notification.recipients.length
                  ? `${t('Para', 'To')}: ${item.notification.recipients.join(', ')}`
                  : t('Sem destinatários', 'No recipients')}
                {item.notification.sentAt &&
                  ` · ${t('aceite pelo SMTP', 'accepted by SMTP')} ${formatDate(item.notification.sentAt, locale)}`}
                {item.notification.attempts > 1 &&
                  ` · ${item.notification.attempts} ${t('tentativas', 'attempts')}`}
              </span>
            </div>
          </li>
        ),
      )}
    </ol>
  );
}

function AlertHistoryItem({
  alert,
  defaultOpen,
}: {
  alert: HealthAlertHistoryEntry;
  defaultOpen: boolean;
}) {
  const { locale, t } = useIdentityLocale();
  const { criticality: criticalityLabels, alertState: alertStateLabels } = healthLabels(locale);
  const sent = alert.notifications.filter((item) => item.state === 'sent').length;
  return (
    <li>
      <details className={`health-history-item health-alert-${alert.state}`} open={defaultOpen}>
        <summary>
          <span className={`health-pill health-${alert.criticality}`}>
            {criticalityLabels[alert.criticality]}
          </span>
          <span className="health-history-title">
            <strong>{alert.title}</strong>
            <span className="health-muted">{alert.summary}</span>
          </span>
          <span className="health-history-meta">
            <span className={`health-state health-state-${alert.state}`}>
              {alertStateLabels[alert.state]}
            </span>
            <span className="health-muted">
              {formatDate(alert.openedAt, locale)} ·{' '}
              {formatDuration(alert.openedAt, alert.resolvedAt, locale)}
            </span>
            <span className="health-muted">
              {sent}/{alert.notifications.length} {t('avisos enviados', 'notices sent')}
            </span>
          </span>
        </summary>
        <dl className="health-history-facts">
          <div>
            <dt>{t('Origem', 'Source')}</dt>
            <dd>{alert.source === 'prometheus' ? 'Prometheus (Alertmanager)' : 'ZeroOps'}</dd>
          </div>
          <div>
            <dt>{t('Receção', 'Acknowledgement')}</dt>
            <dd>
              {alert.acknowledgedAt
                ? `${alert.acknowledgedName ?? '—'}, ${formatDate(alert.acknowledgedAt, locale)}`
                : t('Por confirmar', 'Pending')}
            </dd>
          </div>
          <div>
            <dt>{t('Responsável', 'Assignee')}</dt>
            <dd>{alert.assignedName ?? t('Sem responsável', 'Unassigned')}</dd>
          </div>
          <div>
            <dt>{t('Resolvido', 'Resolved')}</dt>
            <dd>
              {alert.resolvedAt
                ? formatDate(alert.resolvedAt, locale)
                : t('Ainda ativo', 'Still active')}
            </dd>
          </div>
        </dl>
        <HealthAlertTimeline alert={alert} />
      </details>
    </li>
  );
}

function useHistory(days: number, check: string | null) {
  const query = new URLSearchParams({ days: String(days) });
  if (check) query.set('check', check);
  return useResource<HealthHistory>(`/monitoring/history?${query.toString()}`, 60000);
}

function PeriodSelect({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  const { t } = useIdentityLocale();
  return (
    <label>
      {t('Período', 'Period')}
      <select value={days} onChange={(event) => onChange(Number(event.target.value))}>
        {periods.map((value) => (
          <option key={value} value={value}>
            {t(`Últimos ${value} dias`, `Last ${value} days`)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Tab Histórico: alarmes do período (filtráveis por verificação) com a respetiva cronologia. */
export function HealthHistoryPanel({
  checks,
  check,
}: {
  checks: HealthCheckView[];
  check: string | null;
}) {
  const { t } = useIdentityLocale();
  const [days, setDays] = useState(30);
  const [state, setState] = useState<'all' | 'active' | 'resolved'>('all');
  const history = useHistory(days, check);
  const alerts = (history.data?.alerts ?? []).filter((alert) =>
    state === 'all'
      ? true
      : state === 'resolved'
        ? alert.state === 'resolved'
        : alert.state !== 'resolved',
  );
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{t('Histórico de alarmes', 'Alarm history')}</h2>
      </div>
      <div className="health-filters">
        <label>
          {t('Alarmística', 'Alert')}
          <select
            value={check ?? ''}
            onChange={(event) => {
              window.location.hash = healthHref('historico', event.target.value || null);
            }}
          >
            <option value="">{t('Todas (inclui Prometheus)', 'All (includes Prometheus)')}</option>
            {checks.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <PeriodSelect days={days} onChange={setDays} />
        <label>
          {t('Estado', 'Status')}
          <select value={state} onChange={(event) => setState(event.target.value as typeof state)}>
            <option value="all">{t('Todos', 'All')}</option>
            <option value="active">{t('Ativos', 'Active')}</option>
            <option value="resolved">{t('Resolvidos', 'Resolved')}</option>
          </select>
        </label>
      </div>
      {history.error && <ResourceError error={history.error} retry={history.reload} />}
      {!history.data && !history.error && (
        <Loading label={t('A carregar o histórico…', 'Loading history…')} />
      )}
      {history.data &&
        (alerts.length === 0 ? (
          <p className="health-muted">
            {t('Sem alarmes neste período.', 'No alarms in this period.')}
          </p>
        ) : (
          <ul className="health-history">
            {alerts.map((alert, index) => (
              <AlertHistoryItem
                key={alert.id}
                alert={alert}
                defaultOpen={Boolean(check) && index === 0}
              />
            ))}
          </ul>
        ))}
    </section>
  );
}

/** Tab Notificações: registo de todos os envios (alertas, resoluções e relatórios). */
export function HealthNotificationLog() {
  const { locale, t } = useIdentityLocale();
  const {
    channel: channelLabels,
    deliveryState: deliveryStateLabels,
    notificationKind: notificationKindLabels,
  } = healthLabels(locale);
  const [days, setDays] = useState(7);
  const [state, setState] = useState<'all' | HealthNotificationView['state']>('all');
  const history = useHistory(days, null);
  const titles = new Map((history.data?.alerts ?? []).map((alert) => [alert.id, alert.title]));
  const rows = (history.data?.notifications ?? []).filter(
    (item) => state === 'all' || item.state === state,
  );
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{t('Notificações enviadas', 'Sent notifications')}</h2>
      </div>
      <div className="health-filters">
        <PeriodSelect days={days} onChange={setDays} />
        <label>
          {t('Estado', 'Status')}
          <select value={state} onChange={(event) => setState(event.target.value as typeof state)}>
            <option value="all">{t('Todos', 'All')}</option>
            {Object.entries(deliveryStateLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {history.error && <ResourceError error={history.error} retry={history.reload} />}
      {!history.data && !history.error && (
        <Loading label={t('A carregar as notificações…', 'Loading notifications…')} />
      )}
      {history.data &&
        (rows.length === 0 ? (
          <p className="health-muted">
            {t('Sem notificações neste período.', 'No notifications in this period.')}
          </p>
        ) : (
          <div className="health-table-wrap">
            <table className="health-table health-notification-log">
              <thead>
                <tr>
                  <th>{t('Quando', 'When')}</th>
                  <th>{t('Tipo', 'Type')}</th>
                  <th>{t('Alarme / assunto', 'Alarm / subject')}</th>
                  <th>{t('Canal', 'Channel')}</th>
                  <th>{t('Destinatários', 'Recipients')}</th>
                  <th>{t('Estado', 'Status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDate(item.createdAt, locale)}</td>
                    <td>{notificationKindLabels[item.kind]}</td>
                    <td>
                      <strong>{(item.alertId && titles.get(item.alertId)) ?? item.subject}</strong>
                      {item.alertId && titles.has(item.alertId) && (
                        <span className="health-muted">{item.subject}</span>
                      )}
                    </td>
                    <td>{channelLabels[item.channel] ?? item.channel}</td>
                    <td className="health-detail">
                      <Recipients list={item.recipients} />
                    </td>
                    <td>
                      <DeliveryState item={item} />
                      {item.sentAt && (
                        <span className="health-muted">{formatDate(item.sentAt, locale)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
