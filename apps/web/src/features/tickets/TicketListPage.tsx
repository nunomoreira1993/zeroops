import { useMemo, useState } from 'react';
import { statuses, type Ticket, type TicketStatus } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { EmptyState, Loading, PageHeader, ResourceError } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { ticketLabels } from './labels';
import { TicketTable } from './TicketTable';

export function TicketListPage() {
  const resource = useResource<Ticket[]>('/tickets');
  const { locale, t } = useIdentityLocale();
  const labels = ticketLabels(locale);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [priority, setPriority] = useState('');
  const filtered = useMemo(
    () =>
      resource.data
        ?.filter(
          (ticket) =>
            (!status || ticket.status === status) &&
            (!priority || ticket.priority === priority) &&
            `${ticket.key} ${ticket.title} ${ticket.description}`
              .toLocaleLowerCase('pt-PT')
              .includes(query.trim().toLocaleLowerCase('pt-PT')),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? [],
    [resource.data, status, priority, query],
  );
  const filteredAny = Boolean(query || status || priority);
  return (
    <>
      <PageHeader
        title={t('Pedidos', 'Tickets')}
        description={t(
          'Pedidos de manutenção do projeto, com conversa e decisões.',
          'Project maintenance tickets, with conversation and decisions.',
        )}
        action={
          <a className="button button-primary" href="#tickets/new">
            <Icon name="plus" size={19} />
            {t('Novo pedido', 'New ticket')}
          </a>
        }
      />
      <section className="panel">
        <div className="ticket-toolbar">
          <label className="search-field">
            <span className="sr-only">{t('Pesquisar pedidos', 'Search tickets')}</span>
            <Icon name="search" size={19} />
            <input
              type="search"
              placeholder={t(
                'Pesquisar por referência ou assunto…',
                'Search by reference or subject…',
              )}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="filter-field">
            <span className="sr-only">{t('Filtrar por estado', 'Filter by status')}</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as TicketStatus | '')}
            >
              <option value="">{t('Todos os estados', 'All statuses')}</option>
              {statuses.map((value) => (
                <option key={value} value={value}>
                  {labels.status[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span className="sr-only">{t('Filtrar por prioridade', 'Filter by priority')}</span>
            <select value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="">{t('Todas as prioridades', 'All priorities')}</option>
              {Object.entries(labels.priority).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {resource.loading && <Loading label={t('A carregar pedidos…', 'Loading tickets…')} />}
        {resource.error && (
          <div className="panel-padding">
            <ResourceError error={resource.error} retry={resource.reload} />
          </div>
        )}
        {resource.data && (
          <>
            <div className="results-caption">
              <span role="status">
                {filtered.length}{' '}
                {filtered.length === 1 ? t('pedido', 'ticket') : t('pedidos', 'tickets')}
                {filteredAny ? ` ${t('de', 'of')} ${resource.data.length}` : ''}
              </span>
              {filteredAny && (
                <button
                  className="text-button"
                  onClick={() => {
                    setQuery('');
                    setStatus('');
                    setPriority('');
                  }}
                >
                  {t('Limpar filtros', 'Clear filters')}
                </button>
              )}
            </div>
            {filtered.length ? (
              <TicketTable tickets={filtered} />
            ) : (
              <EmptyState
                title={
                  filteredAny
                    ? t('Nenhum pedido encontrado.', 'No tickets found.')
                    : t('Ainda não há pedidos.', 'There are no tickets yet.')
                }
                icon={filteredAny ? 'search' : 'ticket'}
                action={
                  !filteredAny && (
                    <a className="button button-secondary" href="#tickets/new">
                      {t('Criar um pedido', 'Create a ticket')}
                    </a>
                  )
                }
              >
                {filteredAny
                  ? t(
                      'Experimente outro termo de pesquisa ou altere os filtros.',
                      'Try another search term or change the filters.',
                    )
                  : t(
                      'Quando surgir uma questão ou oportunidade de melhoria, comece por aqui.',
                      'When a question or improvement opportunity comes up, start here.',
                    )}
              </EmptyState>
            )}
          </>
        )}
      </section>
    </>
  );
}
