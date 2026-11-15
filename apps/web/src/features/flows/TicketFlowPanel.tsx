import { useEffect, useMemo, useRef, useState } from 'react';
import {
  portLabel,
  resultLabel,
  type FlowAssistantRequestView,
  type FlowDecisionOption,
  type FlowStepOutput,
  type FlowStepView,
  type TicketFlowView,
} from '@zeroops/contracts';
import { MarkdownContent } from '../../components/MarkdownContent';
import { Notice } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectSession as useSession } from '../../lib/project-admin';
import { assistantErrorLabels } from './FlowAssistantPanel';
import { FlowCanvas, type CanvasMarks } from './FlowCanvas';
import { IncidentStepBlock, TicketIncidentPanel } from './IncidentViews';
import { executionStatusLabels, newIdempotencyKey, stepStatusLabels } from './flow-labels';

const format = (value: string, locale: string) =>
  new Date(value).toLocaleString(locale === 'en' ? 'en-GB' : 'pt-PT');

/** Marcas do percurso: feito, etapa atual e destinos possíveis. */
function ticketMarks(flow: TicketFlowView): CanvasMarks {
  const nodes: CanvasMarks['nodes'] = {};
  const edges: CanvasMarks['edges'] = {};
  const counts: Record<string, number> = {};
  for (const step of flow.steps) {
    nodes[step.nodeId] = 'done';
    counts[step.nodeId] = Math.max(counts[step.nodeId] ?? 0, step.attempt);
    if (step.port) edges[`${step.nodeId}:${step.port}`] = 'done';
  }
  for (const path of flow.paths) {
    if (nodes[path.target] !== 'done') nodes[path.target] = 'possible';
    edges[`${flow.execution.currentNodeId}:${path.port}`] = 'possible';
  }
  if (
    flow.execution.currentNodeId &&
    ['running', 'waiting', 'failed'].includes(flow.execution.status)
  )
    nodes[flow.execution.currentNodeId] = 'current';
  for (const [id, count] of Object.entries(counts)) if (count < 2) delete counts[id];
  return { nodes, edges, counts };
}

/** Informação produzida por uma etapa (análise, diff, testes, comentários, relatório…). */
export function StepOutputView({ step }: { step: FlowStepView }) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const output: FlowStepOutput = step.output;
  const visibility = (value: 'internal' | 'public' | undefined) =>
    value === 'public' ? (
      <span className="flow-chip flow-chip-public">{t('para o cliente', 'to the client')}</span>
    ) : (
      <span className="flow-chip flow-chip-internal">{t('interno', 'internal')}</span>
    );
  const empty = !Object.values(output).some((value) =>
    Array.isArray(value) ? value.length : Boolean(value),
  );
  return (
    <div className="flow-output stack">
      {output.feedback && (
        <div className="flow-output-block">
          <h5>
            {t('Comentários recebidos', 'Feedback received')} {visibility('internal')}
          </h5>
          <p>{output.feedback}</p>
        </div>
      )}
      {output.summary && (
        <div className="flow-output-block">
          <h5>
            {step.op === 'copilot_task'
              ? t('Resultado do Copilot', 'Copilot result')
              : t('Resumo', 'Summary')}{' '}
            {visibility('internal')}
          </h5>
          <MarkdownContent>{output.summary}</MarkdownContent>
        </div>
      )}
      {output.evidence && output.evidence.length > 0 && (
        <div className="flow-output-block">
          <h5>
            {t('Evidência', 'Evidence')} {visibility('internal')}
          </h5>
          <ul className="content-list">
            {output.evidence.map((item, index) => (
              <li key={index}>
                <strong>{item.source}</strong>: {item.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {output.proposedTests && output.proposedTests.length > 0 && (
        <div className="flow-output-block">
          <h5>
            {t('Testes propostos', 'Proposed tests')} {visibility('internal')}
          </h5>
          <ul className="content-list">
            {output.proposedTests.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {output.patch && (
        <details className="flow-output-block">
          <summary>
            {t('Proposta de correção (diff)', 'Fix proposal (diff)')} {visibility('internal')}
          </summary>
          <pre className="flow-patch">{output.patch}</pre>
        </details>
      )}
      {output.replyDraft && (
        <div className="flow-output-block">
          <h5>
            {t('Resposta proposta', 'Proposed reply')} {visibility('internal')}
          </h5>
          <MarkdownContent>{output.replyDraft}</MarkdownContent>
        </div>
      )}
      {output.comment && (
        <div className="flow-output-block">
          <h5>
            {t('Comentário da decisão', 'Decision comment')} {visibility(output.commentVisibility)}
          </h5>
          <MarkdownContent>{output.comment}</MarkdownContent>
        </div>
      )}
      {output.clientMessage && (
        <div className="flow-output-block">
          <h5>
            {t('Mensagem enviada', 'Message sent')} {visibility('public')}
          </h5>
          <MarkdownContent>{output.clientMessage}</MarkdownContent>
        </div>
      )}
      {output.note && (
        <div className="flow-output-block">
          <h5>
            {t('Nota', 'Note')} {visibility('internal')}
          </h5>
          <MarkdownContent>{output.note}</MarkdownContent>
        </div>
      )}
      {output.reason && <p>{output.reason}</p>}
      {output.incident && <IncidentStepBlock incident={output.incident} lang={lang} />}
      {output.external && <p className="flow-external">{output.external}</p>}
      {output.errorCode && (
        <p className="muted">
          {t('Código', 'Code')}: {output.errorCode}
        </p>
      )}
      {empty && <p className="muted">{t('Sem informação produzida.', 'No output produced.')}</p>}
    </div>
  );
}

/** Secção «Fluxo» do ticket: percurso, etapa atual, caminhos possíveis e assistente do ticket. */
export function TicketFlowSection({
  ticketId,
  flow,
  onChanged,
}: {
  ticketId: string;
  flow: TicketFlowView | null;
  onChanged: () => void;
}) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const [selected, setSelected] = useState<string | null>(null);
  const marks = useMemo(() => (flow ? ticketMarks(flow) : {}), [flow]);
  if (!flow)
    return (
      <section className="panel detail-section">
        <div className="panel-padding">
          <p className="muted">
            {t(
              'Este pedido ainda não entrou num fluxo de resolução.',
              'This ticket has not entered a resolution flow yet.',
            )}
          </p>
        </div>
      </section>
    );
  const nodeId = selected ?? flow.execution.currentNodeId;
  const nodeSteps = flow.steps.filter((step) => step.nodeId === nodeId);
  const definitionNode = flow.definition.nodes.find((node) => node.id === nodeId);
  return (
    <>
      <section className="panel detail-section flow-ticket">
        <div className="panel-heading">
          <div>
            <h2>
              {flow.execution.flow.name}{' '}
              <span className="flow-chip">
                v{flow.execution.version.number}
                {flow.execution.version.latestNumber > flow.execution.version.number &&
                  ` · ${t(`última v${flow.execution.version.latestNumber}`, `latest v${flow.execution.version.latestNumber}`)}`}
              </span>
            </h2>
            <p>
              {executionStatusLabels[flow.execution.status]?.[lang]} ·{' '}
              {t('Iniciado em', 'Started on')} {format(flow.execution.startedAt, locale)}
              {flow.execution.version.latestNumber > flow.execution.version.number &&
                ` · ${t('este pedido mantém a versão com que entrou', 'this ticket keeps the version it started with')}`}
            </p>
          </div>
        </div>
        <div className="panel-padding stack">
          <FlowCanvas
            definition={flow.definition}
            marks={marks}
            selected={nodeId}
            onSelect={setSelected}
            height={420}
          />
          <p className="muted flow-legend">
            <span className="flow-legend-done">{t('percurso feito', 'path taken')}</span>
            <span className="flow-legend-current">{t('etapa atual', 'current step')}</span>
            <span className="flow-legend-possible">
              {t('caminhos possíveis', 'possible paths')}
            </span>
          </p>
          {flow.paths.length > 0 && (
            <div>
              <h4>{t('A partir daqui', 'From here')}</h4>
              <ul className="content-list">
                {flow.paths.map((path) => (
                  <li key={path.port}>
                    {portLabel(
                      flow.definition.nodes.find(
                        (node) => node.id === flow.execution.currentNodeId,
                      ),
                      path.port,
                      lang,
                    )}{' '}
                    → {path.targetLabel}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flow-step-detail">
            <h4>
              {definitionNode?.label ?? nodeId}{' '}
              {nodeSteps.length > 1 && (
                <span className="muted">
                  ({nodeSteps.length} {t('tentativas', 'attempts')})
                </span>
              )}
            </h4>
            {nodeSteps.length === 0 && (
              <p className="muted">{t('Etapa ainda não percorrida.', 'Step not reached yet.')}</p>
            )}
            {nodeSteps.map((step) => (
              <article key={step.id} className="flow-attempt">
                <header>
                  <strong>
                    {t('Tentativa', 'Attempt')} {step.attempt}
                  </strong>{' '}
                  · {stepStatusLabels[step.status]?.[lang]}
                  {step.port && (
                    <>
                      {' '}
                      · {t('resultado', 'outcome')}: {portLabel(definitionNode, step.port, lang)}
                      {step.output.result && step.output.result !== step.port && (
                        <> ({resultLabel(step.output.result, lang)})</>
                      )}
                    </>
                  )}
                  {step.actor && (
                    <>
                      {' '}
                      · {t('por', 'by')} {step.actor.displayName}
                    </>
                  )}
                  {!step.actor && step.op === 'copilot_task' && <> · Copilot</>}
                  {' · '}
                  {format(step.finishedAt ?? step.startedAt, locale)}
                </header>
                <StepOutputView step={step} />
              </article>
            ))}
          </div>
        </div>
      </section>
      {flow.incident && <TicketIncidentPanel incident={flow.incident} />}
      <section className="panel detail-section">
        <div className="panel-heading">
          <h2>{t('Percurso', 'Path')}</h2>
        </div>
        <ol className="event-list flow-path-list">
          {flow.steps.map((step) => (
            <li key={step.id}>
              <span className={`event-dot flow-dot-${step.status}`} aria-hidden="true" />
              <div>
                <p>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setSelected(step.nodeId)}
                  >
                    {step.label}
                  </button>
                  {step.attempt > 1 && ` (${step.attempt})`}
                  {step.port && (
                    <strong>
                      {' '}
                      →{' '}
                      {portLabel(
                        flow.definition.nodes.find((node) => node.id === step.nodeId),
                        step.port,
                        lang,
                      )}
                    </strong>
                  )}
                  <span className="muted">
                    {' · '}
                    {step.actor?.displayName ??
                      (step.op === 'copilot_task'
                        ? 'Copilot'
                        : (step.assignee?.label ?? t('Sistema', 'System')))}
                  </span>
                </p>
                <time dateTime={step.startedAt}>{format(step.startedAt, locale)}</time>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {flow.canUseAssistant && <TicketAssistant ticketId={ticketId} onChanged={onChanged} />}
    </>
  );
}

/** Quem tem a próxima ação e, se for o utilizador atual, as decisões disponíveis. */
export function FlowNextActionPanel({
  ticketId,
  flow,
  onChanged,
}: {
  ticketId: string;
  flow: TicketFlowView | null;
  onChanged: (flow: TicketFlowView | null, message: string) => void;
}) {
  const { t } = useIdentityLocale();
  const { session, request } = useSession();
  const [comment, setComment] = useState('');
  const [option, setOption] = useState<FlowDecisionOption | null>(null);
  const mutation = useMutation();
  // A mesma intenção (etapa) reutiliza a chave: um duplo clique produz um único avanço.
  const keys = useRef(new Map<string, string>());
  const next = flow?.next ?? null;
  useEffect(() => {
    setOption(null);
    setComment('');
  }, [next?.stepId]);
  if (!flow) return null;
  const isClient = session?.user.role === 'client';
  const decide = (choice: FlowDecisionOption) =>
    mutation.run(async () => {
      if (!next) return;
      const intent = `${next.stepId}:${choice.port}`;
      const key = keys.current.get(intent) ?? newIdempotencyKey();
      keys.current.set(intent, key);
      const result = await request<{ flow: TicketFlowView | null }>(
        `/tickets/${ticketId}/flow/decisions`,
        {
          method: 'POST',
          body: {
            stepId: next.stepId,
            port: choice.port,
            ...(comment.trim() ? { comment: comment.trim() } : {}),
            ...(next.review?.headSha ? { artifactSha: next.review.headSha } : {}),
            idempotencyKey: key,
          },
        },
      );
      onChanged(
        result.flow,
        t(`Decisão registada: ${choice.label}.`, `Decision recorded: ${choice.label}.`),
      );
    });
  return (
    <section
      className="panel detail-side-panel flow-next"
      aria-label={t('Próxima ação', 'Next action')}
    >
      <h2>{t('Próxima ação', 'Next action')}</h2>
      {!next ? (
        <p className="muted">
          {flow.execution.status === 'completed'
            ? t('Fluxo concluído.', 'Flow completed.')
            : flow.execution.status === 'failed'
              ? t(
                  'Fluxo interrompido: a equipa tem de rever.',
                  'Flow stopped: the team must review.',
                )
              : t('Sem ação pendente.', 'No pending action.')}
        </p>
      ) : (
        <div className="stack">
          <p>
            <strong>{next.label}</strong>
            <br />
            {next.waitingFor === 'copilot'
              ? t('O Copilot está a trabalhar.', 'Copilot is working.')
              : next.waitingFor === 'system'
                ? t('À espera do sistema.', 'Waiting for the system.')
                : `${t('Com', 'With')}: ${next.assignee?.label ?? t('equipa', 'team')}`}
          </p>
          {next.review && (
            <p className="muted">
              {next.review.headSha
                ? `${t('Review do commit', 'Review of commit')} ${next.review.headSha.slice(0, 12)}${next.review.testsPassed ? '' : ` · ${t('testes falhados: só pode rejeitar', 'tests failed: reject only')}`}`
                : t('Ainda não existe um commit para rever.', 'No commit to review yet.')}
            </p>
          )}
          {next.canAct && next.options.length > 0 && (
            <>
              <div className="flow-decisions">
                {next.options.map((choice) => (
                  <button
                    key={choice.port}
                    type="button"
                    className={`button ${option?.port === choice.port ? 'button-primary' : 'button-secondary'}`}
                    disabled={mutation.busy}
                    onClick={() => {
                      if (choice.requiresComment && !comment.trim()) {
                        setOption(choice);
                        return;
                      }
                      void decide(choice);
                    }}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
              <label>
                {t('Comentário', 'Comment')}
                {option?.requiresComment && ' *'}
                <textarea
                  rows={3}
                  maxLength={8000}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </label>
              <p className="muted">
                {isClient
                  ? t(
                      'O comentário fica visível para a equipa.',
                      'The comment is visible to the team.',
                    )
                  : t(
                      'Comentário interno, exceto nas opções marcadas para o cliente.',
                      'Internal comment, except for options marked for the client.',
                    )}
              </p>
              {option?.requiresComment && (
                <Notice tone="warning">
                  {t(
                    `«${option.label}» exige um comentário (p. ex. o motivo).`,
                    `«${option.label}» requires a comment (e.g. the reason).`,
                  )}
                </Notice>
              )}
            </>
          )}
          {!next.canAct && next.options.length > 0 && (
            <p className="muted">
              {t('Opções desta etapa', 'Options at this step')}:{' '}
              {next.options.map((item) => item.label).join(' · ')}
            </p>
          )}
          {mutation.error && <Notice>{mutation.error}</Notice>}
        </div>
      )}
    </section>
  );
}

/** Assistente do ticket: explica o estado com base no histórico e propõe transições permitidas. */
function TicketAssistant({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const { t } = useIdentityLocale();
  const { request } = useSession();
  const [refresh, setRefresh] = useState(0);
  const history = useResource<FlowAssistantRequestView[]>(
    `/tickets/${ticketId}/flow/assistant`,
    refresh,
  );
  const [message, setMessage] = useState('');
  const mutation = useMutation();
  const keys = useRef(new Map<string, string>());
  const items = history.data ?? [];
  const pending = items.some((item) => item.status === 'queued' || item.status === 'running');
  useEffect(() => setRefresh(pending ? 2500 : 0), [pending]);
  return (
    <section className="panel detail-section flow-assistant">
      <div className="panel-heading">
        <div>
          <h2>{t('Assistente do pedido', 'Ticket assistant')}</h2>
          <p>
            {t(
              'Pergunte, p. ex., «Porque está parado e o que falta para avançar?» ou peça «Devolve ao desenvolvimento com este comentário». As ações afetam só este pedido; o processo muda-se no editor de fluxos.',
              'Ask e.g. «Why is it stuck and what is missing?» or «Send it back to development with this comment». Actions only affect this ticket; the process is changed in the flow editor.',
            )}
          </p>
        </div>
      </div>
      <div className="panel-padding stack">
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const text = message.trim();
            if (text.length < 2) return;
            void mutation.run(async () => {
              await request(`/tickets/${ticketId}/flow/assistant`, {
                method: 'POST',
                body: { message: text },
              });
              setMessage('');
              history.reload();
            });
          }}
        >
          <textarea
            aria-label={t('Pergunta ao assistente', 'Question to the assistant')}
            rows={2}
            maxLength={2000}
            value={message}
            disabled={pending}
            onChange={(event) => setMessage(event.target.value)}
          />
          <button
            className="button button-primary align-start"
            disabled={pending || mutation.busy || message.trim().length < 2}
          >
            {pending
              ? t('O Copilot está a responder…', 'Copilot is answering…')
              : t('Perguntar', 'Ask')}
          </button>
        </form>
        {mutation.error && <Notice>{mutation.error}</Notice>}
        <ol className="flow-assistant-history">
          {items.map((item) => (
            <li key={item.id}>
              <p className="flow-assistant-user">
                <strong>{item.requestedBy}</strong>: {item.message}
              </p>
              {item.status === 'failed' && (
                <Notice tone="warning">
                  {item.errorCode && assistantErrorLabels[item.errorCode]
                    ? t(
                        assistantErrorLabels[item.errorCode]!.pt,
                        assistantErrorLabels[item.errorCode]!.en,
                      )
                    : t('Pedido falhou.', 'Request failed.')}
                </Notice>
              )}
              {(item.status === 'queued' || item.status === 'running') && (
                <p className="muted">
                  {t('A aguardar resposta do Copilot…', 'Waiting for Copilot…')}
                </p>
              )}
              {item.response && (
                <div className="flow-assistant-answer">
                  {item.response.reply && <MarkdownContent>{item.response.reply}</MarkdownContent>}
                  {item.response.question && (
                    <p className="flow-assistant-question">
                      <strong>{t('Pergunta', 'Question')}:</strong> {item.response.question}
                    </p>
                  )}
                  {item.response.transition && item.resolution === 'pending' && (
                    <div className="stack">
                      <p>
                        {t('Ação proposta', 'Proposed action')}:{' '}
                        <strong>{item.response.transition.port}</strong>
                        {item.response.transition.comment && (
                          <> — «{item.response.transition.comment}»</>
                        )}
                      </p>
                      <button
                        type="button"
                        className="button button-primary align-start"
                        disabled={mutation.busy}
                        onClick={() =>
                          void mutation.run(async () => {
                            const key = keys.current.get(item.id) ?? newIdempotencyKey();
                            keys.current.set(item.id, key);
                            await request(`/tickets/${ticketId}/flow/assistant/${item.id}/apply`, {
                              method: 'POST',
                              body: { idempotencyKey: key },
                            });
                            history.reload();
                            onChanged();
                          })
                        }
                      >
                        {t('Aplicar neste pedido', 'Apply to this ticket')}
                      </button>
                    </div>
                  )}
                  {item.response.transition && item.resolution === 'accepted' && (
                    <p className="muted">{t('Ação aplicada.', 'Action applied.')}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
