import type { FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/ui';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';

/** Compositor de mensagens com a visibilidade fixa pelo canal (cliente ou equipa). */
export function CommentComposer({
  ticketId,
  visibility,
  draft,
  onDraftChange,
  label,
  placeholder,
  hint,
  submitLabel,
  onChanged,
}: {
  ticketId: string;
  visibility: 'public' | 'internal';
  draft: string;
  onDraftChange: (value: string) => void;
  label: string;
  placeholder: string;
  hint: string;
  submitLabel: string;
  onChanged: (message: string) => void;
}) {
  const { request } = useSession();
  const mutation = useMutation();
  const { t } = useIdentityLocale();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void mutation.run(async () => {
      const body = draft.trim();
      if (!body)
        throw new Error(
          t('Escreva uma mensagem antes de enviar.', 'Write a message before sending.'),
        );
      await request(`/tickets/${encodeURIComponent(ticketId)}/comments`, {
        method: 'POST',
        body: { body, visibility },
      });
      onDraftChange('');
      onChanged(
        visibility === 'public'
          ? t('Mensagem enviada ao cliente.', 'Message sent to the client.')
          : t('Nota interna adicionada.', 'Internal note added.'),
      );
    });
  };
  return (
    <form className={`comment-form comment-form-${visibility}`} onSubmit={submit}>
      <fieldset disabled={mutation.busy} className="stack">
        <legend className="sr-only">{label}</legend>
        {mutation.error && <Notice>{mutation.error}</Notice>}
        <MarkdownEditor
          label={label}
          name="body"
          value={draft}
          onChange={onDraftChange}
          rows={4}
          required
          maxLength={20000}
          placeholder={placeholder}
        />
        <div className="comment-actions">
          <span className="field-hint">{hint}</span>
          <button className="button button-primary" type="submit" disabled={mutation.busy}>
            {mutation.busy ? t('A enviar…', 'Sending…') : submitLabel}
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </fieldset>
    </form>
  );
}
