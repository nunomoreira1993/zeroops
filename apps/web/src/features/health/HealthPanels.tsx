import {
  healthCheckGroups,
  type HealthAlertView,
  type HealthCheckGroup,
  type HealthCheckView,
  type HealthMember,
} from '@zeroops/contracts';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { Notice } from '../../components/ui';
import { healthHref } from './HealthTabs';
import { criticalityOrder, formatDate, healthLabels } from './health-labels';
import {
  HealthCheckFlowAction,
  HealthCheckFlowControls,
  useHealthAlertFlows,
} from './HealthAlertFlows';

const emailStateLabels = {
  'pt-PT': {
    pending: 'em fila',
    sent: 'aceite pelo SMTP',
    failed: 'falhou',
    blocked: 'bloqueado',
  },
  en: {
    pending: 'queued',
    sent: 'accepted by SMTP',
    failed: 'failed',
    blocked: 'blocked',
  },
} as const;

export function HealthSummary({ checks }: { checks: HealthCheckView[] }) {
  const { locale, t } = useIdentityLocale();
  const { criticality: criticalityLabels } = healthLabels(locale);
  return (
    <div className="health-summary">
      {criticalityOrder.map((criticality) => {
        const group = checks.filter((check) => check.criticality === criticality);
        const failing = group.filter(
          (check) => check.status === 'warning' || check.status === 'critical',
        );
        const unknown = group.filter((check) => check.status === 'unknown').length;
        return (
          <article key={criticality} className={`panel health-card health-${criticality}`}>
            <span className="health-card-label">{criticalityLabels[criticality]}</span>
            <strong>
              {failing.length} / {group.length}
            </strong>
            <span>
              {failing.length ? t('em alerta', 'alerting') : t('sem alertas', 'no alerts')}
              {unknown ? ` · ${unknown} ${t('sem dados', 'no data')}` : ''}
            </span>
          </article>
        );
      })}
    </div>
  );
}

const groupLabels: Record<HealthCheckGroup, string> = {
  Servidores: 'Servers',
  'Serviços (MySQL, Redis)': 'Services (MySQL, Redis)',
  'Disponibilidade do site': 'Site availability',
  'IBM i (DB2 e filas DTQ)': 'IBM i (DB2 and DTQ queues)',
  'Verificações internas': 'Internal checks',
  Pagamentos: 'Payments',
  'Logs/Aplicação': 'Logs/Application',
  Relatórios: 'Reports',
};

export function HealthChecksTable({
  checks,
  canManage,
}: {
  checks: HealthCheckView[];
  canManage: boolean;
}) {
  const { locale, t } = useIdentityLocale();
  const flows = useHealthAlertFlows(canManage);
  const {
    criticality: criticalityLabels,
    channel: channelLabels,
    source: sourceLabels,
    status: statusLabels,
  } = healthLabels(locale);
  const sorted = [...checks].sort(
    (a, b) => criticalityOrder.indexOf(a.criticality) - criticalityOrder.indexOf(b.criticality),
  );
  const groups = healthCheckGroups
    .map((group) => ({ group, checks: sorted.filter((check) => check.group === group) }))
    .filter(({ checks: groupChecks }) => groupChecks.length > 0);
  return (
    <div className="health-check-groups">
      {(flows.error || flows.mutation.error) && (
        <Notice tone="error">{flows.error ?? flows.mutation.error}</Notice>
      )}
      {groups.map(({ group, checks: groupChecks }) => (
        <section className="health-check-group" key={group}>
          <h3>{locale === 'en' ? groupLabels[group] : group}</h3>
          <div className="health-table-wrap">
            <table className={`health-table${canManage ? ' health-table-with-flows' : ''}`}>
              <thead>
                <tr>
                  <th>{t('Alarmística', 'Alert')}</th>
                  <th>{t('Criticidade', 'Criticality')}</th>
                  <th>{t('Canais', 'Channels')}</th>
                  <th>{t('Estado', 'Status')}</th>
                  <th>{t('Detalhe', 'Detail')}</th>
                  <th>{t('Verificado', 'Checked')}</th>
                  {canManage && <th>{t('Fluxo', 'Flow')}</th>}
                  {canManage && <th>{t('Ações', 'Actions')}</th>}
                  <th>
                    <span className="sr-only">{t('Histórico', 'History')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {groupChecks.map((check) => (
                  <tr key={check.id}>
                    <td>
                      <strong>{check.title}</strong>
                      <span className="health-muted">
                        {sourceLabels[check.source] ?? check.source}
                      </span>
                    </td>
                    <td>
                      <span className={`health-pill health-${check.criticality}`}>
                        {criticalityLabels[check.criticality]}
                      </span>
                    </td>
                    <td>
                      {check.channels
                        .map((channel) => channelLabels[channel] ?? channel)
                        .join(', ')}
                    </td>
                    <td>
                      <span className={`health-status health-status-${check.status}`}>
                        {statusLabels[check.status]}
                      </span>
                    </td>
                    <td className="health-detail">{check.summary || check.description}</td>
                    <td>{formatDate(check.checkedAt, locale)}</td>
                    {canManage && (
                      <>
                        <td>
                          <HealthCheckFlowControls check={check} state={flows} />
                        </td>
                        <td>
                          <HealthCheckFlowAction check={check} state={flows} />
                        </td>
                      </>
                    )}
                    <td>
                      <a
                        className="health-link"
                        href={healthHref('historico', check.id)}
                        aria-label={t(`Histórico de ${check.title}`, `History of ${check.title}`)}
                      >
                        {t('Histórico', 'History')}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

export function HealthAlerts({
  alerts,
  members,
  onChange,
}: {
  alerts: HealthAlertView[];
  members: HealthMember[];
  onChange: () => void;
}) {
  const { request } = useSession();
  const { locale, t } = useIdentityLocale();
  const { criticality: criticalityLabels } = healthLabels(locale);
  const mutation = useMutation();
  const act = (path: string, body?: unknown) =>
    void mutation.run(async () => {
      await request(path, { method: 'POST', body });
      onChange();
    });
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{t('Alertas ativos', 'Active alerts')}</h2>
        <a className="health-link" href={healthHref('historico')}>
          {t('Ver todo o histórico', 'View full history')}
        </a>
      </div>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {alerts.length === 0 ? (
        <p className="health-muted">{t('Sem alertas ativos.', 'No active alerts.')}</p>
      ) : (
        <ul className="health-alerts">
          {alerts.map((alert) => (
            <li key={alert.id} className={`health-alert health-alert-${alert.state}`}>
              <div>
                <span className={`health-pill health-${alert.criticality}`}>
                  {criticalityLabels[alert.criticality]}
                </span>
                <strong>{alert.title}</strong>
                <p>{alert.summary}</p>
                <span className="health-muted">
                  {t('Aberto', 'Opened')} {formatDate(alert.openedAt, locale)} · {alert.notifyCount}{' '}
                  {t('notificação(ões)', 'notification(s)')}
                  {alert.acknowledgedAt &&
                    ` · ${t('receção confirmada', 'acknowledged')} ${formatDate(alert.acknowledgedAt, locale)}`}
                  {alert.resolvedAt &&
                    ` · ${t('resolvido', 'resolved')} ${formatDate(alert.resolvedAt, locale)}`}
                  {alert.emailState &&
                    ` · ${t('e-mail', 'email')} ${emailStateLabels[locale][alert.emailState]}${alert.emailErrorCode ? ` (${alert.emailErrorCode})` : ''}`}
                </span>
                <a className="health-link" href={healthHref('historico', alert.checkId)}>
                  {t('Ver histórico e avisos enviados', 'View history and sent notices')}
                </a>
              </div>
              {alert.state !== 'resolved' && (
                <div className="health-alert-actions">
                  {alert.state === 'open' && (
                    <button
                      className="button button-primary"
                      disabled={mutation.busy}
                      onClick={() => act(`/monitoring/alerts/${alert.id}/ack`)}
                    >
                      {t('Confirmar receção', 'Acknowledge')}
                    </button>
                  )}
                  <label>
                    <span className="sr-only">{t('Atribuir', 'Assign')}</span>
                    <select
                      aria-label={t('Atribuir alerta', 'Assign alert')}
                      value={alert.assignedTo ?? ''}
                      disabled={mutation.busy}
                      onChange={(event) =>
                        act(`/monitoring/alerts/${alert.id}/assign`, {
                          userId: event.target.value || null,
                        })
                      }
                    >
                      <option value="">{t('Sem responsável', 'Unassigned')}</option>
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
