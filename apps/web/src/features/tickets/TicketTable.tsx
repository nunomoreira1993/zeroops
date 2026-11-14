import type { Ticket } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/ui';
import { useIdentityLocale } from '../../lib/identity';
import { formatDateTime, formatShortDate, ticketLabels } from './labels';

export function TicketTable({
  tickets,
  compact = false,
}: {
  tickets: Ticket[];
  compact?: boolean;
}) {
  const { locale, t } = useIdentityLocale();
  const labels = ticketLabels(locale);
  return (
    <div className="table-scroll">
      <table className={`ticket-table ${compact ? 'table-compact' : ''}`}>
        <caption className="sr-only">
          {t(
            'Pedidos de manutenção, data de criação, criador, estado, prioridade e última atualização',
            'Maintenance tickets, creation date, creator, status, priority and last update',
          )}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('Pedido', 'Ticket')}</th>
            <th scope="col">{t('Estado', 'Status')}</th>
            <th scope="col">{t('Prioridade', 'Priority')}</th>
            {!compact && <th scope="col">{t('Ambiente', 'Environment')}</th>}
            <th scope="col">{t('Atualizado', 'Updated')}</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr key={ticket.id}>
              <td className="ticket-title-cell">
                <a href={`#tickets/${encodeURIComponent(ticket.id)}`}>
                  <span className="ticket-key">{ticket.key}</span>
                  <strong>{ticket.title}</strong>
                </a>
                <span className="ticket-category">{labels.category[ticket.category]}</span>
                <span className="ticket-created">
                  {t('Criado em', 'Created on')}{' '}
                  <time dateTime={ticket.createdAt}>
                    {formatDateTime(ticket.createdAt, locale)}
                  </time>
                  {' · '}
                  {t('por', 'by')}{' '}
                  {ticket.creatorName ?? t('Criador indisponível', 'Creator unavailable')}
                </span>
              </td>
              <td>
                <StatusBadge status={ticket.status} />
              </td>
              <td>
                <span className={`priority priority-${ticket.priority}`}>
                  <span className="priority-bars" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  {labels.priority[ticket.priority]}
                </span>
              </td>
              {!compact && (
                <td className="environment-cell">{labels.environment[ticket.environment]}</td>
              )}
              <td className="ticket-date">
                <time dateTime={ticket.updatedAt}>{formatShortDate(ticket.updatedAt, locale)}</time>
                <a
                  href={`#tickets/${encodeURIComponent(ticket.id)}`}
                  className="row-arrow"
                  aria-label={`${t('Abrir', 'Open')} ${ticket.key}`}
                >
                  <Icon name="chevron" size={17} />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
