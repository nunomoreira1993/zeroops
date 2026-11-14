import { useEffect, useState } from 'react';
import { preExecutionStatuses, type TicketDetail, type TicketFlowView } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { MarkdownContent } from '../../components/MarkdownContent';
import {
  EmptyState,
  Loading,
  Notice,
  PageHeader,
  ResourceError,
  StatusBadge,
} from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { FlowNextActionPanel, TicketFlowSection } from '../flows/TicketFlowPanel';
import { ConversationPanel } from './ConversationPanel';
import { DecisionPanel } from './DecisionPanel';
import { ProposalPanel } from './ProposalPanel';
import { ResolutionPanel } from './ResolutionPanel';
import { TicketAssignmentsPanel } from './TicketAssignmentsPanel';
import { TicketEditForm } from './TicketEditForm';
import { TicketParticipantsPanel } from './TicketParticipantsPanel';
import { TransitionPanel } from './TransitionPanel';
import { formatDateTime, ticketLabels } from './labels';

export function TicketDetailPage({ id }: { id: string }) {
  const resource = useResource<TicketDetail>(`/tickets/${id}`, 10000);
  const flowResource = useResource<{ flow?: TicketFlowView | null }>(`/tickets/${id}/flow`, 10000);
  const [flowOverride, setFlowOverride] = useState<{ value: TicketFlowView | null } | null>(null);
  const flow = flowOverride ? flowOverride.value : (flowResource.data?.flow ?? null);
  useEffect(() => {
    if (flowResource.data) setFlowOverride(null);
  }, [flowResource.data]);
  const flowChanged = () => {
    resource.reload();
    flowResource.reload();
  };
  // Pedidos anteriores aos fluxos (sem execução) mantêm os painéis de decisão originais.
  const legacy = !flow && !flowResource.loading && flowOverride === null;
  const { session } = useSession();
  const { locale, t } = useIdentityLocale();
  const {
    category: categoryLabels,
    environment: environmentLabels,
    priority: priorityLabels,
    status: statusLabels,
  } = ticketLabels(locale);
  const dateTime = (value: string) => formatDateTime(value, locale);
  const [section, setSection] = useState<'overview' | 'conversation' | 'flow' | 'history'>(
    'conversation',
  );
  const [channel, setChannel] = useState<'client' | 'team'>('client');
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const changed = (confirmation: string) => {
    setMessage(confirmation);
    resource.reload();
  };
  const detail = resource.data;
  const ticket = detail?.ticket;
  const editable =
    !!session &&
    !!ticket &&
    ((session.user.id === ticket.createdBy && ticket.status === 'new') ||
      (['technical', 'admin'].includes(session.user.role) &&
        preExecutionStatuses.includes(ticket.status)));
  return (
    <>
      <a href="#tickets" className="back-link">
        ← {t('Todos os pedidos', 'All tickets')}
      </a>
      {message && <Notice tone="success">{message}</Notice>}
      {resource.loading && <Loading label={t('A carregar o pedido…', 'Loading ticket…')} />}
      {resource.error && <ResourceError error={resource.error} retry={resource.reload} />}
      {detail && ticket && (
        <>
          <PageHeader
            title={ticket.title}
            description={`${ticket.key} · ${categoryLabels[ticket.category]} · ${t('Criado em', 'Created on')} ${dateTime(ticket.createdAt)}`}
            action={
              <button
                className="button button-secondary"
                onClick={() => {
                  setMessage(null);
                  resource.reload();
                }}
              >
                <Icon name="refresh" size={17} />
                {t('Atualizar', 'Refresh')}
              </button>
            }
          />
          <div className="ticket-summary">
            <StatusBadge status={ticket.status} />
            <span className={`priority priority-${ticket.priority}`}>
              {priorityLabels[ticket.priority]}
            </span>
            <span>{environmentLabels[ticket.environment]}</span>
            <span>
              {t('Versão', 'Version')} {ticket.version}
            </span>
          </div>
          {detail.blockers.length > 0 && (
            <details className="ticket-blockers">
              <summary>
                {t('Integrações pendentes', 'Pending integrations')} · {detail.blockers.length}{' '}
                {t('bloqueios', 'blockers')}
              </summary>
              <Notice tone="warning">
                <strong>{t('Este pedido tem bloqueios', 'This ticket has blockers')}</strong>
                <ul className="notice-list">
                  {detail.blockers.map((blocker, index) => (
                    <li key={index}>{blocker}</li>
                  ))}
                </ul>
                <a href="#integrations">
                  {t('Consultar estado das integrações', 'Check integration status')}
                </a>
              </Notice>
            </details>
          )}
          <div className="detail-layout">
            <div className="detail-main">
              <nav className="section-nav" aria-label={t('Secções do pedido', 'Ticket sections')}>
                <button
                  onClick={() => setSection('conversation')}
                  aria-pressed={section === 'conversation'}
                >
                  {t('Conversa', 'Conversation')} <span>{detail.comments.length + 1}</span>
                </button>
                <button
                  onClick={() => setSection('overview')}
                  aria-pressed={section === 'overview'}
                >
                  {t('Contexto e proposta', 'Context and proposal')}
                </button>
                <button onClick={() => setSection('flow')} aria-pressed={section === 'flow'}>
                  {t('Fluxo', 'Flow')}
                  {flow?.next && <span>{flow.next.label}</span>}
                </button>
                <button onClick={() => setSection('history')} aria-pressed={section === 'history'}>
                  {t('Histórico', 'History')}{' '}
                  <span>{detail.events.length + detail.revisions.length}</span>
                </button>
              </nav>
              {section === 'overview' && (
                <>
                  <section className="panel detail-section">
                    <div className="panel-heading">
                      <h2>{t('Contexto do pedido', 'Ticket context')}</h2>
                      {editable &&
                        (editing ? (
                          <button
                            className="button button-secondary"
                            onClick={() => setEditing(false)}
                          >
                            {t('Cancelar edição', 'Cancel editing')}
                          </button>
                        ) : (
                          <button
                            className="button button-secondary"
                            onClick={() => setEditing(true)}
                          >
                            {t('Editar pedido', 'Edit ticket')}
                          </button>
                        ))}
                    </div>
                    <div className="panel-padding">
                      {editing ? (
                        <TicketEditForm
                          ticket={ticket}
                          onChanged={(confirmation) => {
                            setEditing(false);
                            changed(confirmation);
                          }}
                          onCancel={() => setEditing(false)}
                        />
                      ) : (
                        <MarkdownContent>{ticket.description}</MarkdownContent>
                      )}
                    </div>
                  </section>
                  {legacy && <ProposalPanel detail={detail} onChanged={changed} />}
                  {legacy && <ResolutionPanel detail={detail} onChanged={changed} />}
                </>
              )}
              {section === 'flow' && (
                <TicketFlowSection ticketId={ticket.id} flow={flow} onChanged={flowChanged} />
              )}
              {section === 'conversation' && (
                <>
                  <ConversationPanel
                    detail={detail}
                    onChanged={changed}
                    channel={channel}
                    onChannelChange={setChannel}
                  />
                  {legacy && ticket.status === 'awaiting_confirmation' && (
                    <ResolutionPanel detail={detail} onChanged={changed} />
                  )}
                </>
              )}
              {section === 'history' && (
                <section className="panel detail-section">
                  <div className="panel-heading">
                    <div>
                      <h2>{t('Histórico do pedido', 'Ticket history')}</h2>
                      <p>
                        {t(
                          'Alterações de estado e revisões de conteúdo registadas pelo serviço.',
                          'Status changes and content revisions recorded by the service.',
                        )}
                      </p>
                    </div>
                    <Icon name="clock" size={21} />
                  </div>
                  {detail.events.length ? (
                    <ol className="event-list">
                      {[...detail.events]
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .map((event) => (
                          <li key={event.id}>
                            <span className="event-dot" aria-hidden="true" />
                            <div>
                              <p>
                                {event.fromStatus ? (
                                  <>
                                    <span>{statusLabels[event.fromStatus]}</span>
                                    <Icon name="arrow" size={14} />
                                  </>
                                ) : (
                                  <span>{t('Pedido criado', 'Ticket created')}</span>
                                )}
                                <strong>{statusLabels[event.toStatus]}</strong>
                              </p>
                              <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>
                            </div>
                          </li>
                        ))}
                    </ol>
                  ) : (
                    <EmptyState
                      icon="clock"
                      title={t('Sem eventos registados.', 'No events recorded.')}
                    >
                      {t(
                        'As alterações de estado serão apresentadas aqui.',
                        'Status changes will be shown here.',
                      )}
                    </EmptyState>
                  )}
                  <div className="panel-padding">
                    {detail.invalidations.length > 0 && (
                      <div className="stack">
                        <h3>
                          {t('Aprovações e trabalho invalidados', 'Invalidated approvals and work')}
                        </h3>
                        <ul className="content-list">
                          {detail.invalidations.map((item) => (
                            <li key={item.id}>
                              {t('Versão', 'Version')} {item.ticketVersion} · {item.actorName} ·{' '}
                              {item.reason} · {dateTime(item.createdAt)}
                            </li>
                          ))}
                        </ul>
                        <p className="muted">
                          {t(
                            'Os registos anteriores são preservados, mas não autorizam a versão atual.',
                            'Previous records are preserved, but do not authorize the current version.',
                          )}
                        </p>
                      </div>
                    )}
                    <h3>{t('Revisões de conteúdo', 'Content revisions')}</h3>
                    {detail.revisions.length ? (
                      <ol className="event-list">
                        {detail.revisions.map((revision) => {
                          const fields = (
                            [
                              ['title', t('Assunto', 'Subject')],
                              ['description', t('Descrição', 'Description')],
                              ['category', t('Tipo de pedido', 'Ticket type')],
                              ['environment', t('Ambiente', 'Environment')],
                              ['priority', t('Prioridade', 'Priority')],
                            ] as const
                          ).filter(
                            ([field]) =>
                              revision.before && revision.before[field] !== revision.after[field],
                          );
                          return (
                            <li key={revision.id}>
                              <span className="event-dot" aria-hidden="true" />
                              <div>
                                <p>
                                  <strong>
                                    {revision.before
                                      ? t('Conteúdo revisto', 'Revised content')
                                      : t('Conteúdo inicial', 'Initial content')}
                                  </strong>
                                  <span>
                                    {' '}
                                    · {revision.actorName} · {t('versão', 'version')}{' '}
                                    {revision.ticketVersion}
                                  </span>
                                </p>
                                <time dateTime={revision.createdAt}>
                                  {dateTime(revision.createdAt)}
                                </time>
                                {fields.length > 0 && (
                                  <details>
                                    <summary>
                                      {t('Ver campos alterados', 'View changed fields')} (
                                      {fields.length})
                                    </summary>
                                    <dl className="metadata-list">
                                      {fields.map(([field, label]) => (
                                        <div key={field}>
                                          <dt>{label}</dt>
                                          <dd>
                                            <pre>{revision.before?.[field]}</pre>
                                            <pre>{revision.after[field]}</pre>
                                          </dd>
                                        </div>
                                      ))}
                                    </dl>
                                  </details>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    ) : (
                      <p className="muted">
                        {t(
                          'Sem revisões de conteúdo registadas.',
                          'No content revisions recorded.',
                        )}
                      </p>
                    )}
                  </div>
                </section>
              )}
            </div>
            <aside className="detail-sidebar">
              <FlowNextActionPanel
                ticketId={ticket.id}
                flow={flow}
                onChanged={(value, confirmation) => {
                  setFlowOverride({ value });
                  setMessage(confirmation);
                  flowChanged();
                }}
              />
              <TicketParticipantsPanel
                ticket={ticket}
                participants={detail.participants}
                onChanged={changed}
              />
              <TicketAssignmentsPanel
                key={`assignments-${ticket.version}`}
                ticket={ticket}
                assignments={detail.assignments}
                onChanged={changed}
              />
              {legacy && (
                <DecisionPanel
                  key={`decision-${ticket.version}`}
                  detail={detail}
                  onChanged={changed}
                />
              )}
              {legacy && (
                <TransitionPanel
                  key={`transition-${ticket.version}`}
                  ticket={ticket}
                  onChanged={changed}
                />
              )}
              <section className="panel detail-side-panel">
                <h2>{t('Detalhes', 'Details')}</h2>
                <dl className="metadata-list">
                  <div>
                    <dt>{t('Referência', 'Reference')}</dt>
                    <dd>{ticket.key}</dd>
                  </div>
                  <div>
                    <dt>{t('Tipo', 'Type')}</dt>
                    <dd>{categoryLabels[ticket.category]}</dd>
                  </div>
                  <div>
                    <dt>{t('Ambiente', 'Environment')}</dt>
                    <dd>{environmentLabels[ticket.environment]}</dd>
                  </div>
                  <div>
                    <dt>{t('Prioridade', 'Priority')}</dt>
                    <dd>{priorityLabels[ticket.priority]}</dd>
                  </div>
                  <div>
                    <dt>{t('Última atualização', 'Last update')}</dt>
                    <dd>{dateTime(ticket.updatedAt)}</dd>
                  </div>
                </dl>
              </section>
              <p className="detail-security-note">
                <Icon name="shield" size={17} />
                {t(
                  'Todas as decisões são validadas pelo serviço e associadas à versão do pedido.',
                  'All decisions are validated by the service and linked to the ticket version.',
                )}
              </p>
            </aside>
          </div>
        </>
      )}
    </>
  );
}
