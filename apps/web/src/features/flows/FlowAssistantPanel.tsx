import { useEffect, useState } from 'react';
import type { FlowAssistantRequestView } from '@zeroops/contracts';
import { MarkdownContent } from '../../components/MarkdownContent';
import { Notice } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectSession } from '../../lib/project-admin';

export const assistantErrorLabels: Record<string, { pt: string; en: string }> = {
  copilot_not_configured: {
    pt: 'A integração Copilot do projeto não está configurada.',
    en: 'The project Copilot integration is not configured.',
  },
  agent_failed: { pt: 'O Copilot não conseguiu responder.', en: 'Copilot could not answer.' },
  invalid_response: {
    pt: 'A resposta do Copilot não era uma alteração válida.',
    en: 'The Copilot answer was not a valid change.',
  },
  interrupted: {
    pt: 'Pedido interrompido por um reinício.',
    en: 'Request interrupted by a restart.',
  },
  context_unavailable: {
    pt: 'O fluxo ou o ticket já não está disponível.',
    en: 'The flow or ticket is no longer available.',
  },
};

/**
 * Assistente do fluxo: o pedido em português é transformado pelo Copilot em operações parciais
 * sobre o rascunho. A proposta é pré-visualizada no desenho e só muda o rascunho quando aceite.
 */
export function FlowAssistantPanel({
  basePath,
  draftVersion,
  dirty,
  copilotReady,
  previewId,
  onPreview,
  onResolved,
}: {
  basePath: string;
  draftVersion: number;
  dirty: boolean;
  copilotReady: boolean;
  previewId: string | null;
  onPreview: (request: FlowAssistantRequestView | null) => void;
  onResolved: () => void;
}) {
  const { t } = useIdentityLocale();
  const { request } = useProjectSession();
  const [refresh, setRefresh] = useState(0);
  const history = useResource<FlowAssistantRequestView[]>(`${basePath}/assistant`, refresh);
  const [message, setMessage] = useState('');
  const mutation = useMutation();
  const items = history.data ?? [];
  const pending = items.some((item) => item.status === 'queued' || item.status === 'running');
  useEffect(() => setRefresh(pending ? 2500 : 0), [pending]);

  // A proposta pendente mais recente aparece automaticamente no desenho.
  const latest = items.find(
    (item) =>
      item.status === 'succeeded' &&
      item.resolution === 'pending' &&
      (item.response?.operations.length ?? 0) > 0,
  );
  useEffect(() => {
    if (!history.data) return;
    if (latest && latest.id !== previewId) onPreview(latest);
    if (!latest && previewId) onPreview(null);
  }, [latest?.id]);

  const resolve = (item: FlowAssistantRequestView, resolution: 'accepted' | 'discarded') =>
    mutation.run(async () => {
      await request(`${basePath}/assistant/${item.id}/resolution`, {
        method: 'POST',
        body:
          resolution === 'accepted'
            ? { resolution, expectedDraftVersion: draftVersion }
            : { resolution },
      });
      onPreview(null);
      history.reload();
      onResolved();
    });

  return (
    <aside
      className="panel flow-assistant stack"
      aria-label={t('Assistente do fluxo', 'Flow assistant')}
    >
      <div>
        <h3>{t('Assistente', 'Assistant')}</h3>
        <p className="muted">
          {t(
            'Descreva a alteração em português, p. ex. «Antes de desenvolver, pede aprovação ao responsável técnico». A proposta aparece no desenho para aceitar ou descartar.',
            'Describe the change, e.g. «Before development, ask the technical lead for approval». The proposal is shown on the diagram to accept or discard.',
          )}
        </p>
      </div>
      {!copilotReady && (
        <Notice tone="warning">
          {t(
            'Configure e verifique a integração Copilot do projeto (Parâmetros e integrações) para usar o assistente.',
            'Configure and verify the project Copilot integration (Parameters and integrations) to use the assistant.',
          )}
        </Notice>
      )}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const text = message.trim();
          if (text.length < 2) return;
          void mutation.run(async () => {
            await request(`${basePath}/assistant`, { method: 'POST', body: { message: text } });
            setMessage('');
            history.reload();
          });
        }}
      >
        <label>
          {t('Pedido', 'Request')}
          <textarea
            rows={3}
            maxLength={2000}
            value={message}
            disabled={!copilotReady || pending}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        {dirty && (
          <p className="muted">
            {t(
              'Grave o rascunho antes de pedir: o assistente trabalha sobre a versão gravada.',
              'Save the draft first: the assistant works on the saved version.',
            )}
          </p>
        )}
        <button
          className="button button-primary align-start"
          disabled={!copilotReady || pending || dirty || mutation.busy || message.trim().length < 2}
        >
          {pending
            ? t('O Copilot está a responder…', 'Copilot is answering…')
            : t('Enviar', 'Send')}
        </button>
      </form>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <ol className="flow-assistant-history">
        {items.map((item) => (
          <li key={item.id} className={item.id === previewId ? 'is-previewing' : undefined}>
            <p className="flow-assistant-user">
              <strong>{item.requestedBy}</strong>: {item.message}
            </p>
            {(item.status === 'queued' || item.status === 'running') && (
              <p className="muted">
                {t('A aguardar resposta do Copilot…', 'Waiting for Copilot…')}
              </p>
            )}
            {item.status === 'failed' && (
              <Notice tone="warning">
                {(item.errorCode && assistantErrorLabels[item.errorCode]
                  ? t(
                      assistantErrorLabels[item.errorCode]!.pt,
                      assistantErrorLabels[item.errorCode]!.en,
                    )
                  : null) ?? t('Pedido falhou.', 'Request failed.')}
              </Notice>
            )}
            {item.response && (
              <div className="flow-assistant-answer">
                {item.response.reply && <MarkdownContent>{item.response.reply}</MarkdownContent>}
                {item.response.question && (
                  <p className="flow-assistant-question">
                    <strong>{t('Pergunta', 'Question')}:</strong> {item.response.question}
                  </p>
                )}
                {item.response.operations.length > 0 && (
                  <p className="muted">
                    {item.response.operations.length}{' '}
                    {t('alteração(ões) proposta(s)', 'proposed change(s)')} ·{' '}
                    {item.resolution === 'accepted'
                      ? t('aceite', 'accepted')
                      : item.resolution === 'discarded'
                        ? t('descartada', 'discarded')
                        : t('pendente', 'pending')}
                  </p>
                )}
                {item.resolution === 'pending' && item.response.operations.length > 0 && (
                  <div className="flow-config-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => onPreview(item.id === previewId ? null : item)}
                    >
                      {item.id === previewId
                        ? t('Esconder do desenho', 'Hide from diagram')
                        : t('Ver no desenho', 'Show on diagram')}
                    </button>
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={mutation.busy || dirty}
                      onClick={() => void resolve(item, 'accepted')}
                    >
                      {t('Aceitar', 'Accept')}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={mutation.busy}
                      onClick={() => void resolve(item, 'discarded')}
                    >
                      {t('Descartar', 'Discard')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}
