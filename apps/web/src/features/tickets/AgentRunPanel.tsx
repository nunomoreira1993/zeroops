import type { AgentRun, AgentRunStatus } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { MarkdownContent } from '../../components/MarkdownContent';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';

export const statusText: Record<AgentRunStatus, [string, string]> = {
  queued: ['Em fila', 'Queued'],
  running: ['A investigar', 'Investigating'],
  succeeded: ['Concluída', 'Completed'],
  failed: ['Falhou', 'Failed'],
  cancelled: ['Cancelada', 'Cancelled'],
};

export const failureText: Record<string, [string, string]> = {
  fusion_unavailable: [
    'Fusion indisponível ou recusado; escolha outro modelo.',
    'Fusion unavailable or rejected; choose another model.',
  ],
  copilot_not_configured: [
    'A integração Copilot não está verificada para este projeto. Configure o token em Integrações e clique em Testar ligação.',
    'The Copilot integration is not verified for this project. Configure the token in Integrations and click Test connection.',
  ],
  executor_interrupted: [
    'O executor foi reiniciado durante a investigação. Peça uma nova investigação.',
    'The runner was restarted during the investigation. Request a new investigation.',
  ],
  lease_expired: [
    'O executor deixou de responder e a investigação esgotou as tentativas. Peça uma nova investigação.',
    'The runner stopped responding and the investigation ran out of attempts. Request a new investigation.',
  ],
  cancelled: ['A investigação foi cancelada.', 'The investigation was cancelled.'],
  agent_failed: [
    'O agente não conseguiu concluir a investigação. Consulte os logs do executor.',
    'The agent could not complete the investigation. Check the runner logs.',
  ],
};

export const triggerText: Record<AgentRun['trigger'], [string, string]> = {
  manual: ['Pedido pela equipa', 'Requested by the team'],
  client_reply: ['Resposta do cliente', 'Client reply'],
  auto: ['Investigação automática', 'Automatic investigation'],
  incident_review: ['Análise pós-incidente', 'Post-incident review'],
  flow: ['Etapa do fluxo', 'Flow step'],
};

export type AgentRunsResource = ReturnType<typeof useResource<AgentRun[]>>;

/**
 * Detalhe técnico de um run (mostrado em «Ver interações»): evidências, consultas a conectores,
 * perguntas ao cliente e resposta proposta.
 */
export function AgentRunDetails({
  run,
  onUseDraft,
}: {
  run: AgentRun;
  onUseDraft: (draft: string) => void;
}) {
  const { t } = useIdentityLocale();
  return (
    <div className="agent-run-details">
      {(run.agentProfile ||
        run.repositoryResources?.length ||
        run.effectiveTools?.length ||
        run.effectiveModel) && (
        <section>
          <h3>{t('Contexto de execução', 'Execution context')}</h3>
          {run.agentProfile && (
            <p>
              {t('Agente ZeroOps', 'ZeroOps agent')}: {run.agentProfile.name} · v
              {run.agentProfile.version}
            </p>
          )}
          {run.model && (
            <p>
              {t('Modelo pedido', 'Requested model')}: {run.model}
            </p>
          )}
          {run.effectiveModel && (
            <p>
              {t('Modelo efetivo', 'Effective model')}: {run.effectiveModel}
            </p>
          )}
          {run.repositorySnapshotHash && (
            <p>
              {t(
                'Hash do snapshot de conteúdos (não é revisão SVN)',
                'Content snapshot hash (not an SVN revision)',
              )}
              : sha256:{run.repositorySnapshotHash}
            </p>
          )}
          {run.allowedTools && (
            <p>
              {t('Ferramentas permitidas', 'Permitted tools')}:{' '}
              {run.allowedTools.join(', ') || t('nenhuma', 'none')}
            </p>
          )}
          {run.effectiveTools && (
            <p>
              {t('Ferramentas efetivas', 'Effective tools')}: {run.effectiveTools.join(', ')}
            </p>
          )}
          {run.repositoryResources && run.repositoryResources.length > 0 && (
            <ul className="content-list">
              {run.repositoryResources.map((resource) => (
                <li key={`${resource.path}:${resource.sha256 ?? 'unavailable'}`}>
                  <code>{resource.path}</code> ·{' '}
                  {resource.required ? t('obrigatório', 'mandatory') : t('selecionado', 'selected')}{' '}
                  · {resource.status}
                  {resource.selectionReason
                    ? ` · ${
                        resource.selectionReason === 'global_instruction'
                          ? t('instrução global', 'global instruction')
                          : resource.selectionReason === 'relevance'
                            ? t('relevante para o pedido', 'relevant to request')
                            : t('selecionado no flow', 'selected by flow')
                      }`
                    : ''}
                  {resource.sha256 ? ` · sha256:${resource.sha256}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {run.evidence.length > 0 && (
        <section>
          <h3>{t('Evidências', 'Evidence')}</h3>
          <ul className="content-list">
            {run.evidence.map((item, index) => (
              <li key={index}>
                <strong>{item.source}</strong> · {item.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.toolCalls.length > 0 && (
        <section>
          <h3>
            {t('Consultas a conectores', 'Connector queries')} ({run.toolCalls.length})
          </h3>
          <ol className="agent-tool-calls">
            {run.toolCalls.map((call, index) => (
              <li key={index} className={`agent-tool-${call.outcome}`}>
                <span>
                  <span
                    className={`agent-env-badge${call.environment === 'production' ? ' is-production' : ''}`}
                  >
                    {call.environment === 'production' ? t('PRODUÇÃO', 'PRODUCTION') : 'QA'}
                  </span>
                  {call.tool} · {call.outcome}
                  {call.rowCount !== null && ` · ${call.rowCount} ${t('linhas', 'rows')}`} ·{' '}
                  {call.durationMs} ms
                  {call.errorCode && ` · ${call.errorCode}`}
                </span>
                <pre>{call.request}</pre>
              </li>
            ))}
          </ol>
        </section>
      )}
      {run.clientQuestions.length > 0 && (
        <section>
          <h3>
            {t('Perguntas ao cliente', 'Questions to the client')}{' '}
            <span className="tiny-badge">
              {run.clientMessageId
                ? t('Enviadas automaticamente', 'Sent automatically')
                : t('Por enviar', 'Not sent yet')}
            </span>
          </h3>
          <ol className="content-list">
            {run.clientQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ol>
        </section>
      )}
      {run.replyDraft && (
        <section>
          <h3>{t('Resposta proposta ao cliente', 'Proposed reply to the client')}</h3>
          <MarkdownContent>{run.replyDraft}</MarkdownContent>
          <button
            className="button button-secondary"
            onClick={() => onUseDraft(run.replyDraft ?? '')}
          >
            <Icon name="message" size={16} />
            {t('Rever e enviar ao cliente', 'Review and send to the client')}
          </button>
        </section>
      )}
    </div>
  );
}
