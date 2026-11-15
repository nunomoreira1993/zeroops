import { useState } from 'react';
import type { OperationsMetrics } from '@zeroops/contracts';
import { Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';

const seconds = (value: number | null, unknown: string) =>
  value === null
    ? unknown
    : value < 120
      ? `${value.toFixed(1)} s`
      : value < 7200
        ? `${(value / 60).toFixed(1)} min`
        : `${(value / 3600).toFixed(1)} h`;

/**
 * P11 — métricas operacionais internas do projeto (só equipa): filas, etapas, leases, intervenção
 * humana, uso/quota reportados pelo Copilot, ferramentas, entregas, Health e correlação.
 */
export function OperationsMetricsPage({ projectId }: { projectId: string }) {
  const { t } = useIdentityLocale();
  const [days, setDays] = useState(30);
  const resource = useResource<OperationsMetrics>(
    `/projects/${encodeURIComponent(projectId)}/operations/metrics?days=${days}`,
  );
  const none = t('não registado', 'not recorded');
  const data = resource.data;
  return (
    <div className="stack">
      <PageHeader
        title={t('Operação', 'Operations')}
        description={t(
          'Valores registados pelo ZeroOps na janela escolhida. «Não registado» significa ausência de dados, não zero.',
          'Values recorded by ZeroOps in the selected window. «Not recorded» means no data, not zero.',
        )}
        action={
          <label>
            {t('Janela', 'Window')}{' '}
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {[1, 7, 30, 90].map((value) => (
                <option key={value} value={value}>
                  {value} {t('dias', 'days')}
                </option>
              ))}
            </select>
          </label>
        }
      />
      {resource.loading && !data ? (
        <Loading />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : data ? (
        <>
          <section className="panel stack" aria-label={t('Filas', 'Queues')}>
            <h2>{t('Filas e trabalhos', 'Queues and jobs')}</h2>
            <table className="identity-table">
              <thead>
                <tr>
                  <th>{t('Tipo', 'Kind')}</th>
                  <th>{t('Pendentes', 'Pending')}</th>
                  <th>{t('Em curso', 'Running')}</th>
                  <th>{t('Mais antigo', 'Oldest')}</th>
                  <th>{t('Espera média', 'Mean wait')}</th>
                  <th>{t('Concluídos', 'Succeeded')}</th>
                  <th>{t('Falhados', 'Failed')}</th>
                </tr>
              </thead>
              <tbody>
                {data.queues.map((queue) => (
                  <tr key={queue.kind}>
                    <td>{queue.kind}</td>
                    <td>{queue.pending}</td>
                    <td>{queue.running}</td>
                    <td>{seconds(queue.oldestPendingSeconds, '—')}</td>
                    <td>{seconds(queue.meanWaitSeconds, none)}</td>
                    <td>{queue.succeeded}</td>
                    <td>{queue.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              {t('Eventos de lease:', 'Lease events:')}{' '}
              {data.leases.length
                ? data.leases.map((item) => `${item.eventType} ${item.total}`).join(' · ')
                : none}
            </p>
          </section>

          <section className="panel stack" aria-label={t('Etapas', 'Steps')}>
            <h2>{t('Etapas dos fluxos', 'Flow steps')}</h2>
            {data.steps.length ? (
              <table className="identity-table">
                <thead>
                  <tr>
                    <th>{t('Fluxo', 'Flow')}</th>
                    <th>{t('Etapa', 'Step')}</th>
                    <th>{t('Concluídas', 'Completed')}</th>
                    <th>{t('Falhadas', 'Failed')}</th>
                    <th>{t('Em espera', 'Waiting')}</th>
                    <th>{t('Repetições', 'Retries')}</th>
                    <th>{t('Duração média', 'Mean duration')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.steps.map((step) => (
                    <tr key={`${step.flowName}:${step.versionNumber}:${step.nodeId}`}>
                      <td>
                        {step.flowName} v{step.versionNumber}
                      </td>
                      <td>{step.nodeId}</td>
                      <td>{step.completed}</td>
                      <td>{step.failed}</td>
                      <td>{step.waiting + step.active}</td>
                      <td>{step.retries}</td>
                      <td>{seconds(step.meanDurationSeconds, none)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Notice tone="info">{none}</Notice>
            )}
            <p className="muted">
              {t('Intervenção humana', 'Human intervention')}: {data.human.waitingSteps}{' '}
              {t('em espera (mais antiga', 'waiting (oldest')}{' '}
              {seconds(data.human.oldestWaitingSeconds, '—')}) · {data.human.decisions}{' '}
              {t('decisões, média', 'decisions, mean')}{' '}
              {seconds(data.human.meanDecisionSeconds, none)} · {data.human.agentQuestions}{' '}
              {t('perguntas do agente', 'agent questions')}, {data.human.answersPending}{' '}
              {t('respostas por consumir', 'answers pending')}
            </p>
          </section>

          <section className="panel stack" aria-label="Copilot">
            <h2>{t('Copilot (valores reportados)', 'Copilot (reported values)')}</h2>
            <p>
              {data.copilot.modelCalls} {t('chamadas em', 'calls in')} {data.copilot.runsWithUsage}{' '}
              {t('execuções', 'runs')} · {data.copilot.inputTokens} / {data.copilot.outputTokens}{' '}
              tokens (in/out) · AI credits:{' '}
              {data.copilot.aiCredits === null ? none : data.copilot.aiCredits}
              {data.copilot.callsWithoutReportedCredits > 0 &&
                ` (${data.copilot.callsWithoutReportedCredits} ${t('chamadas sem créditos reportados', 'calls without reported credits')})`}
            </p>
            <p className="muted">
              {t('Modelos', 'Models')}: {data.copilot.models.join(', ') || none} ·{' '}
              {t('Quota', 'Quota')}:{' '}
              {data.copilot.quota
                ? data.copilot.quota.unlimited
                  ? t('ilimitada', 'unlimited')
                  : `${data.copilot.quota.used}/${data.copilot.quota.entitlement} (${data.copilot.quota.remainingPercentage}% ${t('restante', 'left')})`
                : none}
            </p>
            {data.tools.length > 0 && (
              <p className="muted">
                {t('Ferramentas', 'Tools')}:{' '}
                {data.tools
                  .map(
                    (tool) =>
                      `${tool.tool} ok ${tool.ok} / ${t('rejeitadas', 'rejected')} ${tool.rejected} / ${t('erros', 'errors')} ${tool.error}`,
                  )
                  .join(' · ')}
              </p>
            )}
          </section>

          <section
            className="panel stack"
            aria-label={t('Entrega e Health', 'Delivery and Health')}
          >
            <h2>{t('Entregas, intervenções e Health', 'Deliveries, interventions and Health')}</h2>
            {(data.uncertain.deliveries > 0 || data.uncertain.interventions > 0) && (
              <Notice tone="warning">
                {t(
                  `Operações com resultado incerto por reconciliar: ${data.uncertain.deliveries} entregas, ${data.uncertain.interventions} intervenções.`,
                  `Uncertain operations to reconcile: ${data.uncertain.deliveries} deliveries, ${data.uncertain.interventions} interventions.`,
                )}
              </Notice>
            )}
            <p>
              {t('Entregas', 'Deliveries')}:{' '}
              {data.deliveries.map((item) => `${item.state} ${item.total}`).join(' · ') || none}
            </p>
            <p>
              {t('Intervenções', 'Interventions')}:{' '}
              {data.interventions.map((item) => `${item.status} ${item.total}`).join(' · ') || none}
            </p>
            <p>
              Health: {data.health.incidents} {t('incidentes', 'incidents')},{' '}
              {data.health.recovered} {t('com alertas recuperados', 'with recovered alerts')} (
              {t('média', 'mean')} {seconds(data.health.meanRecoverySeconds, none)}),{' '}
              {data.health.recurrences} {t('reincidências em 7 dias', 'recurrences within 7 days')}
            </p>
            <p>
              {t('Validação da recuperação', 'Recovery validation')}:{' '}
              {data.health.validationsConfirmed} {t('confirmadas', 'confirmed')},{' '}
              {data.health.validationsNotConfirmed} {t('sem confirmação', 'not confirmed')} (
              {data.health.validationsUnknownTelemetry} {t('sem telemetria', 'without telemetry')})
            </p>
          </section>

          <section className="panel stack" aria-label={t('Correlação', 'Correlation')}>
            <h2>{t('Falhas e operações incertas', 'Failures and uncertain operations')}</h2>
            {data.correlation.length ? (
              <table className="identity-table">
                <thead>
                  <tr>
                    <th>{t('Quando', 'When')}</th>
                    <th>{t('Tipo', 'Kind')}</th>
                    <th>Ticket</th>
                    <th>{t('Detalhe', 'Detail')}</th>
                    <th>{t('Execução / etapa / job', 'Execution / step / job')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.correlation.map((item, index) => (
                    <tr key={`${item.kind}:${item.jobId ?? ''}:${item.at}:${index}`}>
                      <td>{new Date(item.at).toLocaleString()}</td>
                      <td>{item.kind}</td>
                      <td>
                        {item.ticketId ? (
                          <a href={`#tickets/${encodeURIComponent(item.ticketId)}`}>
                            {item.ticketKey ?? item.ticketId}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{item.detail}</td>
                      <td>
                        <code>
                          {[
                            item.executionId?.slice(0, 8),
                            item.stepId?.slice(0, 8),
                            item.jobId?.slice(0, 8),
                            item.attempt === null ? null : `#${item.attempt}`,
                            item.externalOperation,
                          ]
                            .filter(Boolean)
                            .join(' / ') || '—'}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Notice tone="info">
                {t('Sem falhas registadas na janela.', 'No failures recorded in the window.')}
              </Notice>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
