import { useState } from 'react';
import type {
  DeliveryRunView,
  DevelopmentWorkspaceView,
  TicketDevelopmentView,
} from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : '—');

/**
 * Desenvolvimento do ticket (P08, só equipa): workspace isolado, base/head, diff completo obtido do
 * Git, testes executados (com o commit testado), publicação/PR, revisores e decisões.
 */
export function TicketDevelopmentPanel({ ticketId }: { ticketId: string }) {
  const { t } = useIdentityLocale();
  const resource = useResource<TicketDevelopmentView>(
    `/tickets/${encodeURIComponent(ticketId)}/development`,
    10000,
  );
  if (resource.error || !resource.data?.workspaces.length) return null;
  return (
    <section className="panel detail-section" aria-label={t('Desenvolvimento', 'Development')}>
      <div className="panel-heading">
        <h2>{t('Desenvolvimento e review', 'Development and review')}</h2>
      </div>
      <div className="panel-padding stack">
        {resource.data.workspaces.map((workspace) => (
          <WorkspaceView key={workspace.id} workspace={workspace} />
        ))}
      </div>
    </section>
  );
}

function WorkspaceView({ workspace }: { workspace: DevelopmentWorkspaceView }) {
  const { t } = useIdentityLocale();
  const [showDiff, setShowDiff] = useState(false);
  const revision = workspace.revisions.at(-1) ?? null;
  const finalTests = workspace.tests.filter(
    (test) => test.phase === 'final' && test.testedSha === workspace.headSha,
  );
  return (
    <article className="development-workspace stack">
      <header className="development-header">
        <h3>
          {workspace.repository.name} · <code>{workspace.branch}</code>
        </h3>
        <span className={`status-badge development-state-${workspace.state}`}>
          {workspace.state}
        </span>
      </header>
      <dl className="development-facts">
        <dt>{t('Base', 'Base')}</dt>
        <dd>
          <code>{workspace.baseBranch}</code> @ <code>{short(workspace.baseSha)}</code>
        </dd>
        <dt>Head</dt>
        <dd>
          <code>{short(workspace.headSha)}</code>
        </dd>
        <dt>{t('Trabalho', 'Job')}</dt>
        <dd>
          {workspace.currentRunId ? (
            <>
              {t('em curso', 'running')} · <code>{short(workspace.currentRunId)}</code> ·{' '}
              {t('tentativa', 'attempt')} {workspace.ownerEpoch}
            </>
          ) : (
            t('sem trabalho em curso', 'no running job')
          )}
        </dd>
        {workspace.retentionUntil && (
          <>
            <dt>{t('Retenção', 'Retention')}</dt>
            <dd>{new Date(workspace.retentionUntil).toLocaleString()}</dd>
          </>
        )}
      </dl>
      {revision && (
        <div>
          <h4>
            {t('Ficheiros alterados', 'Changed files')} ({revision.files.length})
          </h4>
          <ul className="development-files">
            {revision.files.map((file) => (
              <li key={`${file.status}:${file.path}`}>
                <span className={`development-file-${file.status}`}>{file.status}</span>{' '}
                <code>
                  {file.previousPath ? `${file.previousPath} → ` : ''}
                  {file.path}
                </code>
              </li>
            ))}
          </ul>
          {workspace.diff && (
            <>
              <button type="button" className="link-button" onClick={() => setShowDiff(!showDiff)}>
                {showDiff
                  ? t('Esconder diff', 'Hide diff')
                  : t('Ver diff completo', 'Show full diff')}
              </button>
              {showDiff && <pre className="flow-patch">{workspace.diff}</pre>}
              {workspace.diffTruncated && (
                <Notice tone="warning">
                  {t('Diff truncado na apresentação.', 'Diff truncated for display.')}
                </Notice>
              )}
            </>
          )}
        </div>
      )}
      <div>
        <h4>{t('Testes executados', 'Executed tests')}</h4>
        {workspace.tests.length === 0 ? (
          <p className="muted">{t('Nenhum teste executado.', 'No tests executed.')}</p>
        ) : (
          <ul className="development-tests">
            {workspace.tests.map((test) => (
              <li key={test.id}>
                <span className={test.exitCode === 0 ? 'development-pass' : 'development-fail'}>
                  {test.exitCode === 0
                    ? t('passou', 'passed')
                    : test.timedOut
                      ? t('tempo esgotado', 'timed out')
                      : `${t('falhou', 'failed')} (exit ${test.exitCode ?? '?'})`}
                </span>{' '}
                <strong>{test.name}</strong> ·{' '}
                {test.phase === 'final' ? t('final', 'final') : t('agente', 'agent')} ·{' '}
                <code>{test.command}</code> ·{' '}
                {test.testedSha
                  ? `commit ${short(test.testedSha)}`
                  : `${t('árvore', 'tree')} ${short(test.workingTreeHash)}`}{' '}
                · {test.durationMs} ms
                <details>
                  <summary>{t('Log', 'Log')}</summary>
                  <pre className="flow-patch">{test.log}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
        {workspace.headSha && finalTests.length === 0 && (
          <Notice tone="warning">
            {t(
              'O head atual não tem testes finais registados.',
              'The current head has no recorded final tests.',
            )}
          </Notice>
        )}
      </div>
      <div>
        <h4>{t('Publicação', 'Publication')}</h4>
        {workspace.publish === 'none' ? (
          <p className="muted">{t('Esta etapa não publica.', 'This step does not publish.')}</p>
        ) : workspace.publications.length === 0 ? (
          <p className="muted">{t('Ainda não publicado.', 'Not published yet.')}</p>
        ) : (
          <ul className="content-list">
            {workspace.publications.map((publication) => (
              <li key={publication.id}>
                {publication.kind === 'pull_request' ? 'PR' : 'Branch'} · {publication.provider} ·{' '}
                <strong>{publication.state}</strong>
                {publication.number !== null && ` #${publication.number}`}
                {publication.url && (
                  <>
                    {' · '}
                    <a href={publication.url} target="_blank" rel="noreferrer">
                      {publication.url}
                    </a>
                  </>
                )}
                {publication.headSha && (
                  <>
                    {' · '}
                    <code>{short(publication.headSha)}</code>
                  </>
                )}
                {publication.lastError && <span className="muted"> · {publication.lastError}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <DeliveriesView pipeline={workspace.pipeline} />
      <div>
        <h4>{t('Review', 'Review')}</h4>
        {workspace.review && (
          <p>
            {t('Regra', 'Rule')}: <strong>{workspace.review.rule}</strong> ·{' '}
            {t('aprovações', 'approvals')} {workspace.review.approvals}/{workspace.review.required}{' '}
            · {t('revisores', 'reviewers')}:{' '}
            {workspace.review.reviewers.map((reviewer) => reviewer.displayName).join(', ') || '—'}
            {!workspace.review.canDecide && (
              <span className="muted">
                {' '}
                · {t('não é revisor desta etapa', 'you are not a reviewer of this step')}
              </span>
            )}
          </p>
        )}
        {workspace.reviews.length === 0 ? (
          <p className="muted">{t('Sem decisões.', 'No decisions.')}</p>
        ) : (
          <ul className="content-list">
            {workspace.reviews.map((decision) => (
              <li
                key={decision.id}
                className={decision.invalidatedAt ? 'development-invalidated' : ''}
              >
                <strong>{decision.actor.displayName}</strong> · {decision.port} · commit{' '}
                <code>{short(decision.headSha)}</code>
                {decision.override && ` · ${t('override de administrador', 'admin override')}`}
                {decision.comment && <> · «{decision.comment}»</>}
                {decision.invalidatedAt && (
                  <span className="muted">
                    {' '}
                    · {t('invalidada', 'invalidated')}: {decision.invalidationReason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

const deliveryStateLabels: Record<DeliveryRunView['state'], { pt: string; en: string }> = {
  queued: { pt: 'na fila', en: 'queued' },
  integrating: { pt: 'a integrar', en: 'integrating' },
  starting: { pt: 'a iniciar a pipeline', en: 'starting pipeline' },
  publishing: { pt: 'pipeline em curso', en: 'pipeline running' },
  uncertain: { pt: 'resultado incerto (a reconciliar)', en: 'uncertain (reconciling)' },
  published: { pt: 'publicado', en: 'published' },
  failed: { pt: 'falhou', en: 'failed' },
  conflict: { pt: 'conflito: volta ao desenvolvimento', en: 'conflict: back to development' },
  rework: { pt: 'alterado após review', en: 'changed after review' },
  blocked: { pt: 'bloqueado por gate', en: 'blocked by gate' },
  cancelled: { pt: 'cancelado', en: 'cancelled' },
};

/** Entregas por pipeline (P09): candidato, gates, fila, integração, pipeline, checks e eventos. */
function DeliveriesView({ pipeline }: { pipeline: DevelopmentWorkspaceView['pipeline'] }) {
  const { t, locale } = useIdentityLocale();
  const lang = locale === 'en' ? 'en' : 'pt';
  return (
    <div>
      <h4>{t('Entrega por pipeline', 'Pipeline delivery')}</h4>
      {!pipeline.available && <p className="muted">{pipeline.reason}</p>}
      {pipeline.available && pipeline.deliveries.length === 0 && (
        <p className="muted">
          {t(
            'Ainda sem entrega: a etapa de entrega só arranca depois dos reviews configurados.',
            'No delivery yet: the delivery step only starts after the configured reviews.',
          )}
        </p>
      )}
      {pipeline.deliveries.map((delivery) => (
        <article key={delivery.id} className="development-delivery stack">
          <header className="development-header">
            <strong>
              {delivery.pipeline.name} · {delivery.pipeline.environment} →{' '}
              <code>{delivery.pipeline.targetBranch}</code>
            </strong>
            <span className={`status-badge delivery-state-${delivery.state}`}>
              {deliveryStateLabels[delivery.state]?.[lang] ?? delivery.state}
            </span>
          </header>
          {delivery.reason && <p className="muted">{delivery.reason}</p>}
          <dl className="development-facts">
            <dt>{t('Candidato', 'Candidate')}</dt>
            <dd>
              <code>{short(delivery.candidate.baseSha)}</code> →{' '}
              <code>{short(delivery.candidate.headSha)}</code>
            </dd>
            {delivery.queuePosition !== null && (
              <>
                <dt>{t('Fila', 'Queue')}</dt>
                <dd>
                  {t('posição', 'position')} {delivery.queuePosition}
                </dd>
              </>
            )}
            <dt>{t('Integrado', 'Integrated')}</dt>
            <dd>
              <code>{short(delivery.integratedSha)}</code>
              {delivery.revalidated &&
                ` · ${t('revalidado sobre a base atual', 'revalidated on the current base')}`}
            </dd>
            <dt>{t('Artefacto', 'Artifact')}</dt>
            <dd>
              <code>{delivery.artifactDigest ? delivery.artifactDigest.slice(0, 19) : '—'}</code>
            </dd>
            <dt>Pipeline</dt>
            <dd>
              {delivery.pipelineStatus ?? '—'}
              {delivery.externalId && (
                <>
                  {' · '}
                  <code>{delivery.externalId}</code>
                </>
              )}
              {delivery.externalUrl && (
                <>
                  {' · '}
                  <a href={delivery.externalUrl} target="_blank" rel="noreferrer">
                    {delivery.externalUrl}
                  </a>
                </>
              )}
              {` · ${delivery.attempts} ${t('tentativa(s)', 'attempt(s)')}`}
            </dd>
            <dt>{t('Aprovações', 'Approvals')}</dt>
            <dd>{delivery.approvals.map((approval) => approval.displayName).join(', ') || '—'}</dd>
          </dl>
          {delivery.checks.length > 0 && (
            <ul className="content-list">
              {delivery.checks.map((check) => (
                <li key={check.name}>
                  {check.name} · <strong>{check.status}</strong>
                </li>
              ))}
            </ul>
          )}
          {delivery.events.length > 0 && (
            <details>
              <summary>
                {t('Eventos', 'Events')} ({delivery.events.length})
              </summary>
              <ul className="content-list">
                {delivery.events.map((event) => (
                  <li key={event.id}>
                    {new Date(event.receivedAt).toLocaleString(lang === 'en' ? 'en-GB' : 'pt-PT')} ·{' '}
                    {event.source} #{event.sequence} · {event.status} · <em>{event.outcome}</em>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </article>
      ))}
    </div>
  );
}
