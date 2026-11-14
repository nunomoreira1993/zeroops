import type { Ticket, TicketParticipant } from '@zeroops/contracts';
import { Loading, Notice, ResourceError } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { ticketLabels } from './labels';

export function TicketParticipantsPanel({
  ticket,
  participants,
  onChanged,
}: {
  ticket: Ticket;
  participants: TicketParticipant[];
  onChanged: (message: string) => void;
}) {
  const { session, request } = useSession();
  const { locale, t } = useIdentityLocale();
  const roleLabels = ticketLabels(locale).role;
  const canManage = !!session && ['technical', 'admin'].includes(session.user.role);
  const candidates = useResource<TicketParticipant[]>(
    canManage ? `/tickets/${encodeURIComponent(ticket.id)}/participants/candidates` : null,
  );
  const mutation = useMutation();
  const change = (userId: string, action: 'add' | 'remove') =>
    void mutation.run(async () => {
      await request(`/tickets/${encodeURIComponent(ticket.id)}/participants`, {
        method: 'POST',
        body: { expectedVersion: ticket.version, userId, action },
      });
      onChanged(t('Participantes atualizados.', 'Participants updated.'));
    });
  return (
    <section className="panel detail-side-panel">
      <h2>{t('Participantes', 'Participants')}</h2>
      <p className="muted">
        {t(
          'Participar determina as notificações, não restringe os pedidos públicos do projeto.',
          'Participation controls notifications, not access to public project tickets.',
        )}
      </p>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <ul className="content-list">
        {participants.map((person) => (
          <li key={person.userId}>
            <strong>{person.displayName}</strong>
            <p className="muted">
              {roleLabels[person.role]} ·{' '}
              {person.organization === 'deloitte'
                ? 'Deloitte'
                : person.organization === 'client'
                  ? t('Cliente', 'Client')
                  : t('Organização por confirmar', 'Organization unconfirmed')}
            </p>
            {canManage && !person.required && (
              <button
                className="text-button"
                disabled={mutation.busy}
                onClick={() => change(person.userId, 'remove')}
              >
                {t('Remover participante', 'Remove participant')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {canManage &&
        (candidates.loading ? (
          <Loading />
        ) : candidates.error ? (
          <ResourceError error={candidates.error} retry={candidates.reload} />
        ) : (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              change(String(new FormData(event.currentTarget).get('userId') ?? ''), 'add');
            }}
          >
            <label>
              {t('Adicionar participante', 'Add participant')}
              <select name="userId" required defaultValue="" disabled={mutation.busy}>
                <option value="" disabled>
                  {t('Selecionar membro', 'Select member')}
                </option>
                {(candidates.data ?? [])
                  .filter(
                    (person) => !participants.some((existing) => existing.userId === person.userId),
                  )
                  .map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <button className="button button-secondary" disabled={mutation.busy}>
              {t('Adicionar', 'Add')}
            </button>
          </form>
        ))}
    </section>
  );
}
