import { useState } from 'react';
import type { TicketRoutingStatus, TicketRoutingView } from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectSession as useSession } from '../../lib/project-admin';

const statusLabels: Record<TicketRoutingStatus, { pt: string; en: string }> = {
  classifying: { pt: 'A classificar', en: 'Classifying' },
  awaiting_reply: { pt: 'À espera do autor', en: 'Waiting for the author' },
  pending_manual: { pt: 'Escolha manual pendente', en: 'Manual choice pending' },
  routed: { pt: 'Encaminhado', en: 'Routed' },
  cancelled: { pt: 'Cancelado', en: 'Cancelled' },
};

const resolutionLabels: Record<string, { pt: string; en: string }> = {
  classified: { pt: 'classificado pelo Copilot', en: 'classified by Copilot' },
  fallback: { pt: 'fallback', en: 'fallback' },
  manual: { pt: 'escolha manual', en: 'manual choice' },
};

const format = (value: string, locale: string) =>
  new Date(value).toLocaleString(locale === 'en' ? 'en-GB' : 'pt-PT');

/**
 * Encaminhamento semântico do pedido (só equipa): estado, candidatos fixados na criação, pergunta
 * pendente, decisão do classificador, escolha final e escolha manual entre os candidatos fixados.
 */
export function TicketRoutingPanel({
  ticketId,
  routing,
  onChanged,
}: {
  ticketId: string;
  routing: TicketRoutingView;
  onChanged: () => void;
}) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const { request } = useSession();
  const mutation = useMutation();
  const [versionId, setVersionId] = useState('');
  const [reason, setReason] = useState('');
  const open = ['classifying', 'awaiting_reply', 'pending_manual'].includes(routing.status);
  const name = (key: string | null) =>
    routing.candidates.find((candidate) => candidate.key === key)?.name ?? key ?? '—';
  return (
    <section className="panel detail-section flow-routing">
      <div className="panel-heading">
        <div>
          <h2>{t('Encaminhamento', 'Routing')}</h2>
          <p>
            {statusLabels[routing.status][lang]}
            {routing.job &&
              open &&
              ` · ${t('classificação', 'classification')}: ${routing.job.status}${routing.job.errorCode ? ` (${routing.job.errorCode})` : ''}`}
          </p>
        </div>
        <span className="flow-chip flow-chip-internal">{t('interno', 'internal')}</span>
      </div>
      <div className="panel-padding stack">
        {routing.chosen && (
          <p>
            <strong>{t('Fluxo escolhido', 'Chosen flow')}:</strong> {routing.chosen.name} v
            {routing.chosen.versionNumber}
            {routing.resolution &&
              ` · ${resolutionLabels[routing.resolution]?.[lang] ?? routing.resolution}`}
            {routing.routedAt && ` · ${format(routing.routedAt, locale)}`}
          </p>
        )}
        {!routing.chosen && routing.reason && (
          <p className="muted">
            {t('Motivo', 'Reason')}: {routing.reason}
          </p>
        )}
        {routing.pendingQuestion && (
          <div className="flow-output-block">
            <h5>
              {t('Pergunta ao autor', 'Question to the author')}{' '}
              <span className="flow-chip flow-chip-public">
                {t('para o cliente', 'to the client')}
              </span>
            </h5>
            <p>{routing.pendingQuestion.text}</p>
            <p className="muted">
              {t('Enviada em', 'Sent on')} {format(routing.pendingQuestion.askedAt, locale)}
              {routing.pendingQuestion.replyDueAt &&
                ` · ${t('prazo', 'due')} ${format(routing.pendingQuestion.replyDueAt, locale)}`}
            </p>
          </div>
        )}
        {routing.lastDecision && (
          <div className="flow-output-block">
            <h5>{t('Última decisão do classificador', 'Last classifier decision')}</h5>
            <p>
              {routing.lastDecision.decision === 'choose'
                ? `${t('Escolheu', 'Chose')} ${name(routing.lastDecision.candidate)}`
                : routing.lastDecision.decision === 'clarify'
                  ? t('Pediu esclarecimento', 'Asked for clarification')
                  : t('Nenhum candidato aplicável', 'No applicable candidate')}
              {' — '}
              {routing.lastDecision.reason}
            </p>
            {routing.lastDecision.alternatives.length > 0 && (
              <p className="muted">
                {t('Alternativas', 'Alternatives')}:{' '}
                {routing.lastDecision.alternatives.map(name).join(', ')}
              </p>
            )}
          </div>
        )}
        <div className="flow-output-block">
          <h5>
            {t('Candidatos fixados na criação', 'Candidates pinned at creation')}{' '}
            <span className="muted">#{routing.policyHash.slice(0, 12)}</span>
          </h5>
          <ul className="flow-routing-candidates">
            {routing.candidates.map((candidate) => (
              <li key={candidate.key}>
                <strong>
                  {candidate.name} v{candidate.versionNumber}
                </strong>
                {candidate.fallback && ` · ${t('fallback', 'fallback')}`}
                {candidate.instructions && (
                  <span className="muted"> — {candidate.instructions}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
        {open && routing.canRoute && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void mutation.run(async () => {
                await request(`/tickets/${ticketId}/flow/routing/manual`, {
                  method: 'POST',
                  body: { versionId, reason },
                });
                setReason('');
                onChanged();
              });
            }}
          >
            <h5>{t('Escolher manualmente', 'Choose manually')}</h5>
            <label>
              {t('Fluxo', 'Flow')}
              <select
                value={versionId}
                required
                onChange={(event) => setVersionId(event.target.value)}
              >
                <option value="">—</option>
                {routing.candidates.map((candidate) => (
                  <option key={candidate.key} value={candidate.versionId}>
                    {candidate.name} v{candidate.versionNumber}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('Motivo', 'Reason')}
              <input
                value={reason}
                required
                minLength={3}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            {mutation.error && <Notice>{mutation.error}</Notice>}
            <button
              className="button button-primary align-start"
              disabled={mutation.busy || !versionId}
            >
              {t('Encaminhar', 'Route')}
            </button>
          </form>
        )}
        {routing.events.length > 0 && (
          <details>
            <summary>{t('Histórico do encaminhamento', 'Routing history')}</summary>
            <ul className="flow-routing-events">
              {routing.events.map((item, index) => (
                <li key={`${item.createdAt}-${index}`}>
                  {format(item.createdAt, locale)} · {item.kind}
                  {item.actor ? ` · ${item.actor}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
