import { useState, type FormEvent } from 'react';
import { ticketEnvironmentSchema, updateTicketSchema, type Ticket } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { ticketLabels } from './labels';
import { useSession } from '../../lib/session';

export function TicketEditForm({
  ticket,
  onChanged,
  onCancel,
}: {
  ticket: Ticket;
  onChanged: (message: string) => void;
  onCancel: () => void;
}) {
  const [description, setDescription] = useState(ticket.description);
  const { request } = useSession();
  const mutation = useMutation();
  const { locale, t } = useIdentityLocale();
  const labels = ticketLabels(locale);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutation.run(async () => {
      const values = updateTicketSchema.safeParse({
        ...Object.fromEntries(data),
        expectedVersion: ticket.version,
      });
      if (!values.success)
        throw new Error(
          t(
            'Reveja o assunto e a descrição antes de guardar as alterações.',
            'Check the subject and description before saving the changes.',
          ),
        );
      await request<Ticket>(`/tickets/${encodeURIComponent(ticket.id)}/revisions`, {
        method: 'POST',
        body: values.data,
      });
      onChanged(
        t(
          'Pedido atualizado. A revisão ficou registada no histórico.',
          'Ticket updated. The revision was recorded in the history.',
        ),
      );
    });
  };
  const environments = ticketEnvironmentSchema.options.filter(
    (environment) => environment !== 'development' || ticket.environment === 'development',
  );
  return (
    <form className="stack" onSubmit={submit}>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <fieldset disabled={mutation.busy} className="stack">
        <legend className="sr-only">
          {t('Rever informação do pedido', 'Review ticket information')}
        </legend>
        <label>
          {t('Assunto', 'Subject')}
          <input name="title" defaultValue={ticket.title} required minLength={5} maxLength={180} />
        </label>
        <div className="form-row">
          <label>
            {t('Tipo de pedido', 'Ticket type')}
            <select name="category" defaultValue={ticket.category}>
              {Object.entries(labels.category).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Ambiente', 'Environment')}
            <select name="environment" defaultValue={ticket.environment}>
              {environments.map((value) => (
                <option key={value} value={value}>
                  {labels.environment[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {t('Prioridade', 'Priority')}
          <select name="priority" defaultValue={ticket.priority}>
            {Object.entries(labels.priority).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <MarkdownEditor
          label={t('Descrição', 'Description')}
          name="description"
          value={description}
          onChange={setDescription}
          minLength={10}
          maxLength={20000}
          rows={8}
        />
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            {t('Cancelar', 'Cancel')}
          </button>
          <button className="button button-primary" type="submit" disabled={mutation.busy}>
            {mutation.busy ? t('A guardar…', 'Saving…') : t('Guardar revisão', 'Save revision')}
            <Icon name="check" size={17} />
          </button>
        </div>
      </fieldset>
    </form>
  );
}
