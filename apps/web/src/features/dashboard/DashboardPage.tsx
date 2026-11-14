import type { Metrics, Ticket } from '@zeroops/contracts';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, Loading, PageHeader, ResourceError, StatusBadge } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { duration, number } from '../../lib/format';
import { useIdentityLocale } from '../../lib/identity';
import { TicketTable } from '../tickets/TicketTable';

function MetricCard({
  label,
  value,
  detail,
  icon,
  accent = false,
}: {
  label: string;
  value: string;
  detail: string;
  icon: IconName;
  accent?: boolean;
}) {
  return (
    <article className={`metric-card ${accent ? 'metric-accent' : ''}`}>
      <div className="metric-label">
        {label}
        <span className="metric-icon">
          <Icon name={icon} size={19} />
        </span>
      </div>
      <strong className="metric-value">{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

export function DashboardPage() {
  const { locale, t } = useIdentityLocale();
  const count = (value: number) =>
    locale === 'en' ? value.toLocaleString('en-GB') : number(value);
  const metrics = useResource<Metrics>('/metrics');
  const tickets = useResource<Ticket[]>('/tickets');
  const waiting = tickets.data?.filter((ticket) =>
    ['awaiting_client', 'awaiting_technical', 'awaiting_qa', 'awaiting_release'].includes(
      ticket.status,
    ),
  );
  const recent = tickets.data
    ? [...tickets.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
    : [];
  return (
    <>
      <PageHeader
        title={t('Visão geral', 'Overview')}
        description={t(
          'Pedidos, aprovações e tempos de resposta do projeto.',
          'Project requests, approvals and response times.',
        )}
        action={
          <a href="#tickets/new" className="kt-btn kt-btn-primary">
            <Icon name="plus" size={16} />
            {t('Novo pedido', 'New request')}
          </a>
        }
      />
      {metrics.loading && <Loading label={t('A carregar indicadores…', 'Loading indicators…')} />}
      {metrics.error && <ResourceError error={metrics.error} retry={metrics.reload} />}
      {metrics.data && (
        <section
          className="metrics-grid"
          aria-label={t('Indicadores do workspace', 'Workspace indicators')}
        >
          <MetricCard
            label={t('Pedidos em aberto', 'Open requests')}
            value={count(metrics.data.open)}
            detail={t(
              `${count(metrics.data.total)} pedidos no total`,
              `${count(metrics.data.total)} requests in total`,
            )}
            icon="ticket"
            accent
          />
          <MetricCard
            label={t('Pedidos resolvidos', 'Resolved requests')}
            value={count(metrics.data.resolved)}
            detail={t('Com ciclo de manutenção concluído', 'With the maintenance cycle completed')}
            icon="check"
          />
          <MetricCard
            label={t('Primeira resposta', 'First response')}
            value={duration(metrics.data.firstResponseMeanMs)}
            detail={
              metrics.data.firstResponseCount
                ? t(
                    `Média · ${count(metrics.data.firstResponseCount)} pedidos com resposta`,
                    `Average · ${count(metrics.data.firstResponseCount)} requests with a response`,
                  )
                : t('Ainda sem respostas medidas', 'No responses measured yet')
            }
            icon="message"
          />
          <MetricCard
            label={t('Tempo de resolução', 'Resolution time')}
            value={duration(metrics.data.resolutionMeanMs)}
            detail={
              metrics.data.resolutionCount
                ? t(
                    `Média · ${count(metrics.data.resolutionCount)} resoluções medidas`,
                    `Average · ${count(metrics.data.resolutionCount)} resolutions measured`,
                  )
                : t('Ainda sem resoluções medidas', 'No resolutions measured yet')
            }
            icon="clock"
          />
        </section>
      )}

      <div className="dashboard-columns">
        <section className="kt-card recent-panel">
          <div className="kt-card-header">
            <div>
              <h2 className="kt-card-title">{t('Atividade recente', 'Recent activity')}</h2>
              <p className="card-subtitle">
                {t('Pedidos atualizados mais recentemente', 'Most recently updated requests')}
              </p>
            </div>
            <a href="#tickets" className="subtle-link">
              {t('Ver todos', 'View all')} <Icon name="arrow" size={16} />
            </a>
          </div>
          {tickets.loading && <Loading label={t('A carregar pedidos…', 'Loading requests…')} />}
          {tickets.error && (
            <div className="kt-card-content">
              <ResourceError error={tickets.error} retry={tickets.reload} />
            </div>
          )}
          {tickets.data &&
            (recent.length ? (
              <TicketTable tickets={recent} compact />
            ) : (
              <EmptyState
                title={t('Ainda não existem pedidos', 'There are no requests yet')}
                action={
                  <a className="kt-btn kt-btn-outline" href="#tickets/new">
                    <Icon name="plus" size={16} />
                    {t('Criar o primeiro pedido', 'Create the first request')}
                  </a>
                }
              >
                {t(
                  'Reporte um incidente, proponha uma melhoria ou esclareça uma dúvida.',
                  'Report an incident, propose an improvement or ask a question.',
                )}
              </EmptyState>
            ))}
        </section>
        <section className="kt-card approvals-panel">
          <div className="kt-card-header">
            <h2 className="kt-card-title">{t('À espera de aprovação', 'Awaiting approval')}</h2>
            <span className="kt-badge kt-badge-outline kt-badge-secondary">
              {waiting ? waiting.length : '—'}
            </span>
          </div>
          {tickets.loading && <Loading />}
          {tickets.error && (
            <p className="kt-card-content muted">
              {t('Não foi possível consultar as aprovações.', 'Could not load the approvals.')}
            </p>
          )}
          {waiting &&
            (waiting.length ? (
              <ul className="approval-list">
                {waiting.slice(0, 4).map((ticket) => (
                  <li key={ticket.id}>
                    <a href={`#tickets/${encodeURIComponent(ticket.id)}`}>
                      <span className="ticket-key">{ticket.key}</span>
                      <strong>{ticket.title}</strong>
                      <StatusBadge status={ticket.status} />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="shield" title={t('Sem decisões pendentes', 'No pending decisions')}>
                {t(
                  'Os pedidos que precisarem de aprovação aparecem aqui.',
                  'Requests that need approval appear here.',
                )}
              </EmptyState>
            ))}
        </section>
      </div>

      <section className="kt-card process-panel">
        <div className="kt-card-header">
          <div>
            <h2 className="kt-card-title">{t('Fluxo de aprovação', 'Approval flow')}</h2>
            <p className="card-subtitle">
              {t(
                'Cada pedido passa por estas decisões até à publicação',
                'Each request goes through these decisions until publication',
              )}
            </p>
          </div>
        </div>
        <ol className="kt-card-content process-stages">
          {[
            ['1', t('Cliente', 'Client'), t('Aprova a proposta', 'Approves the proposal')],
            ['2', t('Técnica', 'Technical'), t('Valida a execução', 'Validates the work')],
            ['3', 'QA', t('Verifica a qualidade', 'Checks the quality')],
            ['4', 'Release', t('Autoriza a publicação', 'Authorises publication')],
            [
              '5',
              t('Publicação', 'Publication'),
              t(
                'Automática, quando a infraestrutura o permite',
                'Automatic, when the infrastructure allows it',
              ),
            ],
          ].map(([step, title, description]) => (
            <li key={step}>
              <span className="process-number">{step}</span>
              <div>
                <strong>{title}</strong>
                <span>{description}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {metrics.data && metrics.data.tickets.length > 0 && (
        <section className="kt-card duration-panel">
          <div className="kt-card-header">
            <div>
              <h2 className="kt-card-title">{t('Tempos por pedido', 'Times per request')}</h2>
              <p className="card-subtitle">
                {t(
                  'Tempo decorrido, em espera e no estado atual (tempo de calendário)',
                  'Elapsed time, waiting time and time in the current status (calendar time)',
                )}
              </p>
            </div>
          </div>
          <div className="kt-card-table table-scroll">
            <table className="kt-table duration-table">
              <caption className="sr-only">{t('Tempos por pedido', 'Times per request')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('Pedido', 'Request')}</th>
                  <th scope="col">{t('Tempo decorrido', 'Elapsed time')}</th>
                  <th scope="col">{t('Em espera', 'Waiting')}</th>
                  <th scope="col">{t('No estado atual', 'In current status')}</th>
                  <th scope="col">{t('Primeira resposta', 'First response')}</th>
                </tr>
              </thead>
              <tbody>
                {metrics.data.tickets.map((ticket) => (
                  <tr key={ticket.id}>
                    <td>
                      <a href={`#tickets/${encodeURIComponent(ticket.id)}`} className="subtle-link">
                        {ticket.key}
                      </a>
                    </td>
                    <td>{duration(ticket.elapsedMs)}</td>
                    <td>{duration(ticket.waitingMs)}</td>
                    <td>{duration(ticket.activeStateMs)}</td>
                    <td>{duration(ticket.firstResponseMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
