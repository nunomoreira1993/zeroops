import { useState, type FormEvent } from 'react';
import { commentRevisionInputSchema, type Comment, type Ticket } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';

export function CommentCorrectionForm({
  ticket,
  comment,
  onChanged,
  onCancel,
}: {
  ticket: Ticket;
  comment: Comment;
  onChanged: (message: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(comment.body);
  const { request } = useSession();
  const mutation = useMutation();
  const { t } = useIdentityLocale();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutation.run(async () => {
      const input = commentRevisionInputSchema.safeParse({
        expectedVersion: comment.version,
        body: data.get('body'),
      });
      if (!input.success)
        throw new Error(
          t(
            'Escreva uma mensagem válida antes de guardar.',
            'Write a valid message before saving.',
          ),
        );
      await request(
        `/tickets/${encodeURIComponent(ticket.id)}/comments/${encodeURIComponent(comment.id)}/revisions`,
        { method: 'POST', body: input.data },
      );
      onChanged(
        t(
          'Mensagem revista. A versão anterior ficou preservada no histórico.',
          'Message revised. The previous version was kept in the history.',
        ),
      );
    });
  };
  return (
    <form className="stack" onSubmit={submit}>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <fieldset disabled={mutation.busy} className="stack">
        <legend className="sr-only">{t('Corrigir a mensagem', 'Correct the message')}</legend>
        <MarkdownEditor
          label={t('Corrigir mensagem', 'Correct message')}
          name="body"
          value={body}
          onChange={setBody}
          required
          maxLength={20000}
          rows={4}
        />
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            {t('Cancelar', 'Cancel')}
          </button>
          <button className="button button-primary" type="submit" disabled={mutation.busy}>
            {mutation.busy ? t('A guardar…', 'Saving…') : t('Guardar correção', 'Save correction')}
            <Icon name="check" size={16} />
          </button>
        </div>
      </fieldset>
    </form>
  );
}
