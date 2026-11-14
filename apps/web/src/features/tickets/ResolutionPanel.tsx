import { useState } from 'react';
import { preExecutionStatuses, type TicketDetail } from '@zeroops/contracts';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { MarkdownContent } from '../../components/MarkdownContent';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';

export function ResolutionPanel({
  detail,
  onChanged,
}: {
  detail: TicketDetail;
  onChanged: (message: string) => void;
}) {
  const { session, request } = useSession();
  const { t } = useIdentityLocale();
  const mutation = useMutation();
  const [body, setBody] = useState('');
  const [notes, setNotes] = useState('');
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  if (!session) return null;
  const canPropose =
    ['technical', 'admin'].includes(session.user.role) &&
    preExecutionStatuses.includes(detail.ticket.status);
  const canDecide =
    detail.ticket.status === 'awaiting_confirmation' &&
    detail.resolution?.status === 'pending' &&
    session.user.role === 'client' &&
    session.user.id === detail.resolution.clientId;
  if (!canPropose && !detail.resolution) return null;
  return (
    <section className="panel detail-section">
      <div className="panel-heading">
        <h2>{t('Resolução sem alteração de código', 'Resolution without code changes')}</h2>
      </div>
      <div className="panel-padding stack">
        <p>
          {t(
            'Uma resposta humana é publicada e o cliente atribuído confirma a resolução. Este percurso não executa código nem passa por QA ou release.',
            'A human response is published and the assigned client confirms resolution. This path does not execute code or require QA or release.',
          )}
        </p>
        {mutation.error && <Notice>{mutation.error}</Notice>}
        {detail.resolution && (
          <div className="stack">
            <strong>{detail.resolution.authorName}</strong>
            <MarkdownContent>{detail.resolution.body}</MarkdownContent>
            <p>
              {t('Estado', 'Status')}:{' '}
              {detail.resolution.status === 'pending'
                ? t('Aguarda confirmação', 'Awaiting confirmation')
                : detail.resolution.status === 'accepted'
                  ? t('Confirmada pelo cliente', 'Confirmed by client')
                  : t('Rejeitada pelo cliente', 'Rejected by client')}
            </p>
            {detail.resolution.notes && (
              <MarkdownContent>{detail.resolution.notes}</MarkdownContent>
            )}
          </div>
        )}
        {canDecide && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void mutation.run(async () => {
                await request(
                  `/tickets/${encodeURIComponent(detail.ticket.id)}/resolutions/decision`,
                  {
                    method: 'POST',
                    body: {
                      expectedVersion: detail.ticket.version,
                      artifactHash: detail.resolution?.hash,
                      decision,
                      notes,
                    },
                  },
                );
                onChanged(t('Decisão de resolução registada.', 'Resolution decision recorded.'));
              });
            }}
          >
            <label>
              {t('Decisão', 'Decision')}
              <select
                value={decision}
                onChange={(event) =>
                  setDecision(event.target.value === 'reject' ? 'reject' : 'approve')
                }
              >
                <option value="approve">{t('Confirmar resolução', 'Confirm resolution')}</option>
                <option value="reject">{t('Ainda não está resolvido', 'Not resolved yet')}</option>
              </select>
            </label>
            <label>
              {t('Notas / motivo de rejeição', 'Notes / rejection reason')}
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                required={decision === 'reject'}
                minLength={decision === 'reject' ? 3 : undefined}
                maxLength={5000}
              />
            </label>
            <button className="button button-primary" disabled={mutation.busy}>
              {t('Registar decisão', 'Record decision')}
            </button>
          </form>
        )}
        {canPropose && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void mutation.run(async () => {
                await request(`/tickets/${encodeURIComponent(detail.ticket.id)}/resolutions`, {
                  method: 'POST',
                  body: { expectedVersion: detail.ticket.version, body },
                });
                setBody('');
                onChanged(
                  t(
                    'Resposta publicada. O cliente atribuído tem de confirmar a resolução.',
                    'Response published. The assigned client must confirm resolution.',
                  ),
                );
              });
            }}
          >
            <MarkdownEditor
              name="resolution"
              label={t('Resposta pública de resolução', 'Public resolution response')}
              value={body}
              onChange={setBody}
              required
              minLength={10}
              maxLength={20000}
            />
            <button className="button button-secondary" disabled={mutation.busy}>
              {t('Propor resolução sem código', 'Propose resolution without code')}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
