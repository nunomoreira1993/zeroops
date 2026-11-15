import {
  incidentResourceKinds,
  interventionActionLabels,
  type FlowStepOutput,
  type IncidentInterventionView,
  type InterventionAction,
  type TicketIncidentView,
} from '@zeroops/contracts';
import { useIdentityLocale } from '../../lib/identity';
import { TechLogo } from './tech-logos';

type IncidentOutput = NonNullable<FlowStepOutput['incident']>;
type Lang = 'pt' | 'en';

const decisionLabels: Record<string, { pt: string; en: string }> = {
  auto: { pt: 'execução automática', en: 'automatic' },
  approval: { pt: 'precisa de aprovação', en: 'needs approval' },
  forbidden: { pt: 'proibida', en: 'forbidden' },
};

const statusLabels: Record<string, { pt: string; en: string }> = {
  pending: { pt: 'pendente', en: 'pending' },
  running: { pt: 'a executar', en: 'running' },
  succeeded: { pt: 'concluída', en: 'succeeded' },
  failed: { pt: 'falhou', en: 'failed' },
  refused: { pt: 'recusada', en: 'refused' },
  cancelled: { pt: 'cancelada', en: 'cancelled' },
  simulated: { pt: 'simulada', en: 'simulated' },
  uncertain: {
    pt: 'resultado incerto — a reconciliar, sem repetir',
    en: 'uncertain — reconciling, not retried',
  },
};

const criterionLabels: Record<string, { pt: string; en: string }> = {
  alerts_resolved: { pt: 'alertas resolvidos', en: 'alerts resolved' },
  disk_free: { pt: 'espaço livre em disco', en: 'free disk space' },
  memory_pressure: { pt: 'pressão de memória', en: 'memory pressure' },
  cpu_load: { pt: 'carga de CPU', en: 'CPU load' },
  database_query: { pt: 'query de verificação na BD', en: 'database check query' },
  service_active: { pt: 'serviço ativo', en: 'service active' },
  http_check: { pt: 'verificação HTTP', en: 'HTTP check' },
};

const actionLabel = (action: string | null | undefined, lang: Lang) =>
  action ? (interventionActionLabels[action as InterventionAction]?.[lang] ?? action) : '—';

function resourceIcon(kind: string | undefined, engine: string | null | undefined) {
  if (engine) return engine;
  return kind ? (incidentResourceKinds[kind]?.icon ?? 'server') : 'server';
}

/** Decisão, intervenção e validação registadas numa etapa do incidente. */
export function IncidentStepBlock({ incident, lang }: { incident: IncidentOutput; lang: Lang }) {
  const { t } = useIdentityLocale();
  const rows: [string, React.ReactNode][] = [];
  if (incident.resource)
    rows.push([
      t('Recurso', 'Resource'),
      <span className="incident-resource">
        <TechLogo id={resourceIcon(incident.resource.kind, incident.resource.engine)} size={14} />
        {incidentResourceKinds[incident.resource.kind]?.label[lang] ?? incident.resource.kind}
        {incident.resource.host && ` · ${incident.resource.host}`}
        {incident.resource.unit && ` · ${incident.resource.unit}`}
        {!incident.resource.managed && ` · ${t('não gerido', 'not managed')}`}
      </span>,
    ]);
  if (incident.alertComponent) rows.push([t('Alerta em', 'Alert from'), incident.alertComponent]);
  if (incident.causeComponent)
    rows.push([
      t('Causa em', 'Cause in'),
      `${incident.causeComponent}${incident.causeConfirmed ? '' : ` (${t('por confirmar', 'unconfirmed')})`}`,
    ]);
  if (incident.decision)
    rows.push([
      t('Decisão', 'Decision'),
      `${decisionLabels[incident.decision]?.[lang] ?? incident.decision}${incident.decisionReason ? ` — ${incident.decisionReason}` : ''}`,
    ]);
  if (incident.action)
    rows.push([
      t('Ação', 'Action'),
      `${actionLabel(incident.action, lang)}${incident.target ? ` · ${incident.target}` : ''}`,
    ]);
  if (incident.parameter)
    rows.push([
      t('Alteração', 'Change'),
      `${incident.parameter}: ${incident.previousValue ?? '?'} → ${incident.newValue ?? '?'}`,
    ]);
  if (incident.rollback)
    rows.push([t('Como repor', 'How to roll back'), <code>{incident.rollback}</code>]);
  if (incident.criterion)
    rows.push([
      t('Critério de recuperação', 'Recovery criterion'),
      `${criterionLabels[incident.criterion]?.[lang] ?? incident.criterion}${incident.attempts ? ` · ${incident.attempts} ${t('tentativa(s)', 'attempt(s)')}` : ''}`,
    ]);
  if (incident.recipients && incident.recipients.length > 0)
    rows.push([t('Destinatários', 'Recipients'), incident.recipients.join(', ')]);
  if (rows.length === 0 && !incident.measurements?.length) return null;
  return (
    <div className="flow-output-block incident-step">
      <h5>
        {t('Incidente', 'Incident')}{' '}
        <span className="flow-chip flow-chip-internal">{t('interno', 'internal')}</span>
        {incident.simulated && (
          <span className="flow-chip">{t('demonstração (simulado)', 'demo (simulated)')}</span>
        )}
      </h5>
      <dl className="incident-facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {incident.measurements && incident.measurements.length > 0 && (
        <details>
          <summary>
            {t('Medições', 'Measurements')} ({incident.measurements.length})
          </summary>
          <ul className="content-list incident-measurements">
            {incident.measurements.map((item, index) => (
              <li
                key={index}
                className={item.unknown ? 'is-unknown' : item.ok ? 'is-ok' : 'is-fail'}
              >
                <time dateTime={item.at}>{new Date(item.at).toLocaleTimeString()}</time>{' '}
                {item.unknown ? `? ${t('desconhecido', 'unknown')}:` : item.ok ? '✓' : '✗'}{' '}
                {item.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function InterventionRow({ item, lang }: { item: IncidentInterventionView; lang: Lang }) {
  const { t } = useIdentityLocale();
  return (
    <tr>
      <td>{new Date(item.createdAt).toLocaleString(lang === 'en' ? 'en-GB' : 'pt-PT')}</td>
      <td>
        {actionLabel(item.action, lang)}
        <div className="muted">{item.target}</div>
      </td>
      <td>
        {item.parameter
          ? `${item.parameter}: ${item.previousValue ?? '?'} → ${item.newValue ?? '?'}`
          : '—'}
        {item.rollback && (
          <div className="muted">
            {t('Repor', 'Roll back')}: <code>{item.rollback}</code>
          </div>
        )}
      </td>
      <td>
        {decisionLabels[item.decision]?.[lang] ?? item.decision}
        <div className="muted">{item.decisionReason}</div>
      </td>
      <td>
        <span className={`incident-status incident-status-${item.status}`}>
          {statusLabels[item.status]?.[lang] ?? item.status}
        </span>
        {item.result && <div className="muted">{item.result}</div>}
      </td>
      <td>{item.actor === 'human' ? t('Pessoa', 'Person') : 'Copilot'}</td>
    </tr>
  );
}

/** Painel do incidente no ticket: recurso, componente do alerta vs. causa e intervenções. */
export function TicketIncidentPanel({ incident }: { incident: TicketIncidentView }) {
  const { locale, t } = useIdentityLocale();
  const lang: Lang = locale === 'en' ? 'en' : 'pt';
  const resource = incident.resource;
  const differentCause =
    incident.causeComponent && incident.alertComponent
      ? incident.causeComponent !== incident.alertComponent
      : false;
  return (
    <section className="panel detail-section incident-panel" data-testid="ticket-incident">
      <div className="panel-heading">
        <div>
          <h2>
            {t('Incidente', 'Incident')}{' '}
            <span className="flow-chip">
              {incident.environment === 'production'
                ? t('Produção', 'Production')
                : t('Qualidade', 'Quality')}
            </span>
            {incident.demoScenario && (
              <span className="flow-chip">
                {t('demonstração', 'demo')}: {incident.demoScenario}
              </span>
            )}
          </h2>
          <p>
            {t('Aberto em', 'Opened on')}{' '}
            {new Date(incident.openedAt).toLocaleString(lang === 'en' ? 'en-GB' : 'pt-PT')}
            {incident.recoveredAt &&
              ` · ${t('recuperado em', 'recovered on')} ${new Date(incident.recoveredAt).toLocaleString(lang === 'en' ? 'en-GB' : 'pt-PT')}`}
          </p>
        </div>
      </div>
      <div className="panel-padding stack">
        <div className="incident-components">
          <div className="incident-component">
            <span className="muted">{t('Recurso afetado', 'Affected resource')}</span>
            <strong className="incident-resource">
              <TechLogo id={resourceIcon(resource?.kind, resource?.engine)} size={18} />
              {resource
                ? (incidentResourceKinds[resource.kind]?.label[lang] ?? resource.kind)
                : t('Por identificar', 'Unknown')}
            </strong>
            {resource && (
              <span className="muted">
                {[resource.host, resource.unit].filter(Boolean).join(' · ') || '—'}
                {!resource.managed &&
                  ` · ${t('não gerido (só diagnóstico)', 'not managed (diagnosis only)')}`}
              </span>
            )}
          </div>
          <div className="incident-component">
            <span className="muted">{t('Componente do alerta', 'Alerting component')}</span>
            <strong>{incident.alertComponent ?? '—'}</strong>
          </div>
          <div className={`incident-component${differentCause ? ' is-different' : ''}`}>
            <span className="muted">{t('Componente da causa', 'Root-cause component')}</span>
            <strong>{incident.causeComponent ?? t('Por apurar', 'Under investigation')}</strong>
            <span className="muted">
              {incident.causeComponent
                ? incident.causeConfirmed
                  ? t('causa confirmada', 'cause confirmed')
                  : t('hipótese por confirmar', 'hypothesis to confirm')
                : ''}
              {differentCause &&
                ` · ${t('diferente do componente do alerta', 'differs from the alerting component')}`}
            </span>
          </div>
        </div>
        <div>
          <h4>{t('Intervenções', 'Interventions')}</h4>
          {incident.interventions.length === 0 ? (
            <p className="muted">
              {t('Nenhuma intervenção registada.', 'No interventions recorded.')}
            </p>
          ) : (
            <div className="table-scroll">
              <table className="identity-table incident-interventions">
                <thead>
                  <tr>
                    <th>{t('Quando', 'When')}</th>
                    <th>{t('Ação', 'Action')}</th>
                    <th>{t('Antes → depois', 'Before → after')}</th>
                    <th>{t('Decisão', 'Decision')}</th>
                    <th>{t('Resultado', 'Result')}</th>
                    <th>{t('Por', 'By')}</th>
                  </tr>
                </thead>
                <tbody>
                  {incident.interventions.map((item) => (
                    <InterventionRow key={item.id} item={item} lang={lang} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
