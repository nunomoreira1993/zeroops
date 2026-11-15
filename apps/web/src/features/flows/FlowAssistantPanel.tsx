import { useEffect, useState } from 'react';
import type {
  FlowAssistantRequestView,
  FlowAuthoringEventView,
  FlowAuthoringMode,
  FlowAuthoringStateView,
} from '@zeroops/contracts';
import { MarkdownContent } from '../../components/MarkdownContent';
import { CapabilityDevelopmentPanel } from './CapabilityDevelopmentPanel';
import { Notice } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectPermission, useProjectSession } from '../../lib/project-admin';

export const assistantErrorLabels: Record<string, { pt: string; en: string }> = {
  authorization_revoked: {
    pt: 'A permissão do autor foi revogada ou o seu acesso ao projeto deixou de estar ativo.',
    en: 'The author permission was revoked or project access is no longer active.',
  },
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
  cancelled: { pt: 'Pedido cancelado.', en: 'Request cancelled.' },
};

const DRAFT_KEY = 'zeroops.flow-authoring.message:';

function readDraft(key: string) {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Sem armazenamento local o rascunho da mensagem só vive na página.
  }
}

/** Texto curto e público de um evento de construção (sem raciocínio do modelo nem segredos). */
export function authoringEventText(
  event: FlowAuthoringEventView,
  t: (pt: string, en: string) => string,
): string | null {
  const payload = event.payload;
  const summary = typeof payload.summary === 'string' && payload.summary ? payload.summary : '';
  const list = (key: string) => (Array.isArray(payload[key]) ? (payload[key] as string[]) : []);
  const changes = [
    list('added').length
      ? t(`+${list('added').length} etapa(s)`, `+${list('added').length} step(s)`)
      : '',
    list('changed').length
      ? t(`${list('changed').length} alterada(s)`, `${list('changed').length} changed`)
      : '',
    list('removed').length
      ? t(`−${list('removed').length} removida(s)`, `−${list('removed').length} removed`)
      : '',
  ]
    .filter(Boolean)
    .join(', ');
  const detail = [summary, changes].filter(Boolean).join(' · ');
  switch (event.type) {
    case 'turn_queued':
      return t('Pedido na fila.', 'Request queued.');
    case 'turn_started':
      return t('O Copilot começou a trabalhar.', 'Copilot started working.');
    case 'draft_read':
      return t('Leu o rascunho atual.', 'Read the current draft.');
    case 'operation_applied':
      return `${t('Aplicado', 'Applied')}: ${detail || t('alteração', 'change')}`;
    case 'operation_proposed':
      return `${t('Proposto', 'Proposed')}: ${detail || t('alteração', 'change')}`;
    case 'operation_rejected':
      return `${t('Rejeitado (rascunho intacto)', 'Rejected (draft intact)')}: ${String(payload.error ?? '')}`;
    case 'operation_conflict':
      return t(
        `Conflito: o rascunho mudou (rev. ${String(payload.currentRevision ?? '?')}). O Copilot vai reler antes de continuar.`,
        `Conflict: the draft changed (rev. ${String(payload.currentRevision ?? '?')}). Copilot will re-read before continuing.`,
      );
    case 'capability_missing':
      return `${t('Capacidade em falta', 'Missing capability')}: ${String(payload.capability ?? '')}`;
    case 'capability_development':
      return `${t('Desenvolvimento de capacidade', 'Capability development')}: ${String(payload.title ?? '')} (${String(payload.state ?? '')})`;
    case 'capability_linked':
      return `${t('Capacidade associada ao rascunho (fluxo por ativar)', 'Capability linked to draft (flow not activated)')}: ${String(payload.title ?? '')}`;
    case 'turn_completed':
      return t('Turno concluído.', 'Turn completed.');
    case 'turn_failed':
      return t('Turno falhou.', 'Turn failed.');
    case 'turn_cancelled':
      return t('Turno cancelado.', 'Turn cancelled.');
    case 'proposal_accepted':
      return t('Proposta aceite.', 'Proposal accepted.');
    case 'proposal_discarded':
      return t('Proposta descartada.', 'Proposal discarded.');
    case 'operation_undone':
      return t('Alteração desfeita (nova revisão).', 'Change undone (new revision).');
    default:
      return null;
  }
}

/**
 * Chat de construção do fluxo (P06). O Copilot altera o rascunho com ferramentas tipadas,
 * validadas e autorizadas no backend: no modo assistido as alterações ficam propostas até aceitar;
 * no automático entram no rascunho à medida que o agente trabalha. Ativar continua a ser explícito.
 */
export function FlowAssistantPanel({
  basePath,
  flowId,
  draftVersion,
  dirty,
  copilotReady,
  previewId,
  authoring,
  events,
  live,
  eventCursor,
  onPreview,
  onResolved,
}: {
  basePath: string;
  flowId: string;
  draftVersion: number;
  dirty: boolean;
  copilotReady: boolean;
  previewId: string | null;
  authoring: FlowAuthoringStateView | null;
  events: FlowAuthoringEventView[];
  live: boolean;
  /** Último evento recebido: atualiza o histórico sem esperar pelo polling. */
  eventCursor: number;
  onPreview: (request: FlowAssistantRequestView | null) => void;
  onResolved: () => void;
}) {
  const { t } = useIdentityLocale();
  const { request } = useProjectSession();
  const canEdit = useProjectPermission('flows.edit');
  const [refresh, setRefresh] = useState(0);
  const history = useResource<FlowAssistantRequestView[]>(`${basePath}/assistant`, refresh);
  const draftKey = `${DRAFT_KEY}${basePath}`;
  const [message, setMessage] = useState(() => readDraft(draftKey));
  const [mode, setMode] = useState<FlowAuthoringMode>(authoring?.session?.mode ?? 'assisted');
  const mutation = useMutation();
  const items = history.data ?? [];
  const running = items.find((item) => item.status === 'queued' || item.status === 'running');
  const pending = Boolean(running);
  useEffect(() => setRefresh(pending ? 5000 : 0), [pending]);
  useEffect(() => {
    if (eventCursor) history.reload();
  }, [eventCursor]);
  useEffect(() => {
    if (authoring?.session?.mode) setMode(authoring.session.mode);
  }, [authoring?.session?.mode]);
  useEffect(() => writeDraft(draftKey, message), [draftKey, message]);

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

  const changeMode = (next: FlowAuthoringMode) =>
    mutation.run(async () => {
      setMode(next);
      await request(`${basePath}/authoring/mode`, { method: 'POST', body: { mode: next } });
      onResolved();
    });

  const cancel = (item: FlowAssistantRequestView) =>
    mutation.run(async () => {
      await request(`${basePath}/assistant/${item.id}/cancel`, { method: 'POST', body: {} });
      history.reload();
      onResolved();
    });

  const undo = (operationId: string) =>
    mutation.run(async () => {
      await request(`${basePath}/authoring/operations/${operationId}/undo`, {
        method: 'POST',
        body: { expectedDraftVersion: draftVersion },
      });
      onResolved();
    });

  const progressFor = (requestId: string) =>
    events
      .filter((event) => event.requestId === requestId)
      .map((event) => ({ id: event.id, type: event.type, text: authoringEventText(event, t) }))
      .filter((line): line is { id: number; type: FlowAuthoringEventView['type']; text: string } =>
        Boolean(line.text),
      );

  const applied = (authoring?.operations ?? []).filter(
    (operation) => operation.status === 'applied' && operation.source !== 'undo',
  );
  const capabilities = authoring?.capabilities ?? [];

  return (
    <aside
      className="panel flow-assistant stack"
      aria-label={t('Assistente do fluxo', 'Flow assistant')}
    >
      <div>
        <h3>
          {t('Construir com o Copilot', 'Build with Copilot')}{' '}
          <span
            className={`flow-chip ${live ? 'flow-chip-active' : 'flow-chip-internal'}`}
            title={t('Ligação aos eventos em tempo real', 'Real-time event connection')}
          >
            {live ? t('em direto', 'live') : t('a sincronizar', 'syncing')}
          </span>
        </h3>
        <p className="muted">
          {t(
            'Descreva o fluxo ou a alteração, p. ex. «Antes de desenvolver, pede aprovação ao responsável técnico». As etapas e ligações aparecem no desenho enquanto o Copilot trabalha. Ativar continua a ser uma ação sua.',
            'Describe the flow or change, e.g. «Before development, ask the technical lead for approval». Steps and links appear on the diagram while Copilot works. Activating remains your action.',
          )}
        </p>
      </div>
      <fieldset className="flow-fieldset" disabled={!canEdit || mutation.busy}>
        <legend>{t('Modo', 'Mode')}</legend>
        <div className="flow-checks">
          <label className="checkbox-row">
            <input
              type="radio"
              name="flow-authoring-mode"
              checked={mode === 'assisted'}
              onChange={() => void changeMode('assisted')}
            />
            {t('Assistido (pré-visualizar e aceitar)', 'Assisted (preview and accept)')}
          </label>
          <label className="checkbox-row">
            <input
              type="radio"
              name="flow-authoring-mode"
              checked={mode === 'auto'}
              onChange={() => void changeMode('auto')}
            />
            {t('Construção automática no rascunho', 'Automatic build in the draft')}
          </label>
        </div>
      </fieldset>
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
            await request(`${basePath}/assistant`, {
              method: 'POST',
              body: { message: text, mode },
            });
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
            disabled={!canEdit || !copilotReady}
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
          disabled={
            !canEdit ||
            !copilotReady ||
            pending ||
            dirty ||
            mutation.busy ||
            message.trim().length < 2
          }
        >
          {pending ? t('O Copilot está a trabalhar…', 'Copilot is working…') : t('Enviar', 'Send')}
        </button>
      </form>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <CapabilityDevelopmentPanel
        flowId={flowId}
        draftVersion={draftVersion}
        requests={capabilities}
        onChanged={onResolved}
      />
      <ol className="flow-assistant-history">
        {items.map((item) => {
          const progress = progressFor(item.id);
          const active = item.status === 'queued' || item.status === 'running';
          return (
            <li key={item.id} className={item.id === previewId ? 'is-previewing' : undefined}>
              <p className="flow-assistant-user">
                <strong>{item.requestedBy}</strong>: {item.message}
                {item.authoringMode && (
                  <span className="flow-chip">
                    {' '}
                    {item.authoringMode === 'auto'
                      ? t('automático', 'automatic')
                      : t('assistido', 'assisted')}
                  </span>
                )}
              </p>
              {progress.length > 0 && (
                <ul className="flow-authoring-progress" aria-label={t('Progresso', 'Progress')}>
                  {progress.map((line) => (
                    <li key={line.id} className={`flow-authoring-${line.type}`}>
                      {line.text}
                    </li>
                  ))}
                </ul>
              )}
              {active && (
                <div className="flow-config-actions">
                  <p className="muted">{t('A aguardar o Copilot…', 'Waiting for Copilot…')}</p>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={!canEdit || mutation.busy}
                    onClick={() => void cancel(item)}
                  >
                    {t('Cancelar', 'Cancel')}
                  </button>
                </div>
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
                        disabled={!canEdit || mutation.busy || dirty}
                        onClick={() => void resolve(item, 'accepted')}
                      >
                        {t('Aceitar', 'Accept')}
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={!canEdit || mutation.busy}
                        onClick={() => void resolve(item, 'discarded')}
                      >
                        {t('Descartar', 'Discard')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {applied.length > 0 && (
        <section aria-label={t('Alterações aplicadas', 'Applied changes')}>
          <h4>{t('Alterações aplicadas ao rascunho', 'Changes applied to the draft')}</h4>
          <ul className="flow-authoring-operations">
            {applied.slice(0, 15).map((operation) => (
              <li key={operation.id}>
                <span>
                  {t(
                    `rev. ${operation.resultRevision ?? '?'}`,
                    `rev. ${operation.resultRevision ?? '?'}`,
                  )}{' '}
                  ·{' '}
                  {operation.summary ||
                    (operation.kind === 'routing' ? t('regras', 'rules') : t('etapas', 'steps'))}
                  {operation.source === 'accept' &&
                    ` · ${t('proposta aceite', 'accepted proposal')}`}
                  {operation.undoneBy && ` · ${t('desfeita', 'undone')}`}
                </span>
                {!operation.undoneBy && (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={!canEdit || mutation.busy || dirty || !operation.undoable}
                    title={
                      operation.undoable
                        ? undefined
                        : t(
                            'O rascunho mudou depois desta alteração: desfaça primeiro as mais recentes.',
                            'The draft changed after this change: undo the most recent ones first.',
                          )
                    }
                    onClick={() => void undo(operation.id)}
                  >
                    {t('Desfazer', 'Undo')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
