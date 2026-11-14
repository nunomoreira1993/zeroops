import { useState, type FormEvent } from 'react';
import { transitionSchema, type Ticket } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { availableTransitions } from './workflow';

export function TransitionPanel({
  ticket,
  onChanged,
}: {
  ticket: Ticket;
  onChanged: (message: string) => void;
}) {
  const { session, request } = useSession();
  const { locale, t } = useIdentityLocale();
  const options = session ? availableTransitions(session.user.role, ticket.status, locale) : [];
  const [action, setAction] = useState<string>(options[0]?.action ?? '');
  const mutation = useMutation();
  if (!options.length) return null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutation.run(async () => {
      const result = transitionSchema.safeParse({
        expectedVersion: ticket.version,
        action,
        notes: data.get('notes'),
      });
      if (!result.success)
        throw new Error(
          t(
            'Selecione uma ação e escreva uma nota com pelo menos 3 caracteres.',
            'Select an action and write a note of at least 3 characters.',
          ),
        );
      await request(`/tickets/${encodeURIComponent(ticket.id)}/transitions`, {
        method: 'POST',
        body: result.data,
      });
      onChanged(
        t(
          'Estado atualizado. A nota foi adicionada à conversa pública do pedido.',
          'Status updated. The note was added to the public ticket conversation.',
        ),
      );
    });
  };
  return (
    <section className="panel detail-side-panel">
      <h2>{t('Próximo passo', 'Next step')}</h2>
      <p className="muted">
        {t('Ações disponíveis no estado atual.', 'Actions available in the current status.')}
      </p>
      {mutation.error && (
        <Notice>
          {mutation.error}{' '}
          {t(
            'Atualize o pedido se a versão tiver mudado.',
            'Refresh the ticket if the version has changed.',
          )}
        </Notice>
      )}
      <form onSubmit={submit} className="stack">
        <fieldset disabled={mutation.busy} className="stack">
          <legend className="sr-only">
            {t('Alterar estado do pedido', 'Change ticket status')}
          </legend>
          <label>
            {t('Ação', 'Action')}
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              {options.map((option) => (
                <option key={option.action} value={option.action}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {action === 'cancel' && (
            <Notice tone="warning">
              {t(
                'Esta ação cancela o pedido. Não inicia nenhuma implementação ou publicação.',
                'This action cancels the ticket. It does not start any implementation or deployment.',
              )}
            </Notice>
          )}
          <label>
            {t('Nota pública', 'Public note')}
            <textarea
              name="notes"
              required
              minLength={3}
              maxLength={5000}
              rows={3}
              placeholder={t(
                'Explique o motivo desta ação…',
                'Explain the reason for this action…',
              )}
            />
          </label>
          <button
            type="submit"
            className={`button ${action === 'cancel' ? 'button-danger' : 'button-secondary'}`}
            disabled={mutation.busy}
          >
            {mutation.busy ? t('A atualizar…', 'Updating…') : t('Confirmar ação', 'Confirm action')}
            <Icon name="arrow" size={16} />
          </button>
        </fieldset>
      </form>
    </section>
  );
}
