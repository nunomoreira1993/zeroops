import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AgentQuestion, AgentRun } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { MarkdownContent } from '../../components/MarkdownContent';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { buildTimeline, type TimelineItem } from './agent-run-timeline';
import { AgentRunSteps } from './AgentRunSteps';
import { QuotaBadge, UsageBadge } from './AgentUsage';
import { useAgentRunEvents } from './useAgentRunEvents';
import '../../styles/agent-run-steps.css';

/**
 * Conversa ao vivo com o Copilot durante um run: texto em streaming, passos técnicos recolhidos
 * (ferramentas, MCP e permissões), consumo por turno, perguntas do agente (incluindo aprovação de
 * plano) e mensagens de seguimento da equipa.
 */
export function AgentRunLive({
  ticketId,
  run,
  composer = true,
}: {
  ticketId: string;
  run: AgentRun;
  /** Falso quando as mensagens de seguimento seguem pelo compositor do chat da equipa. */
  composer?: boolean;
}) {
  const { t } = useIdentityLocale();
  const running = run.status === 'running';
  const active = running || run.status === 'queued';
  const { events, error, live } = useAgentRunEvents(ticketId, run.id, active);
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const end = useRef<HTMLLIElement>(null);
  const pending = running ? (events.length ? timeline.pendingQuestion : run.pendingQuestion) : null;
  const usage = timeline.usage ?? run.usage;
  const quota = timeline.quota ?? run.quota;

  useEffect(() => {
    if (active) end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, events.length]);

  if (!events.length && !active) return null;
  return (
    <section
      className="agent-live"
      aria-label={t('Conversa com o Copilot', 'Conversation with Copilot')}
    >
      <div className="agent-live-heading">
        <h3>{t('Conversa', 'Conversation')}</h3>
        {active && (
          <span className={`agent-live-badge${live ? ' agent-live-on' : ''}`}>
            {live ? t('Ao vivo', 'Live') : t('A atualizar', 'Updating')}
          </span>
        )}
        {(usage || quota) && (
          <span className="agent-usage-summary">
            {usage && <UsageBadge usage={usage} label={t('Investigação', 'Investigation')} />}
            {quota && <QuotaBadge quota={quota} />}
          </span>
        )}
      </div>
      {error && <Notice tone="warning">{error}</Notice>}
      {timeline.servers.length > 0 && (
        <ul className="agent-mcp-servers" aria-label={t('Servidores MCP', 'MCP servers')}>
          {timeline.servers.map((server) => (
            <li key={server.name} className={`agent-mcp-${server.status}`} title={server.error}>
              <Icon name="code" size={12} />
              {server.name} · {server.status}
            </li>
          ))}
        </ul>
      )}
      <ol className="agent-live-timeline">
        {timeline.items.map((item) => (
          <TimelineEntry key={item.key} item={item} />
        ))}
        {active && !events.length && (
          <li className="agent-live-status">
            {t('A aguardar o executor…', 'Waiting for the runner…')}
          </li>
        )}
        <li ref={end} aria-hidden="true" />
      </ol>
      {pending && <QuestionForm ticketId={ticketId} runId={run.id} question={pending} />}
      {composer && running && !run.cancelRequested && (
        <MessageForm ticketId={ticketId} runId={run.id} />
      )}
    </section>
  );
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  const { t } = useIdentityLocale();
  switch (item.kind) {
    case 'status':
      return <li className="agent-live-status">{item.text}</li>;
    case 'assistant':
      return (
        <li className="agent-live-assistant">
          <MarkdownContent>{item.text}</MarkdownContent>
          {item.streaming && <span className="agent-live-cursor" aria-hidden="true" />}
        </li>
      );
    case 'steps':
      return <AgentRunSteps steps={item.steps} />;
    case 'tool':
    case 'permission':
      return <AgentRunSteps steps={[item]} />;
    case 'usage':
      return (
        <li className="agent-live-usage">
          <UsageBadge usage={item.usage} />
        </li>
      );
    case 'question':
      return (
        <li className="agent-live-question">
          <strong>
            {item.question.kind === 'plan'
              ? t('Plano para aprovação', 'Plan for approval')
              : t('Pergunta do Copilot', 'Question from Copilot')}
          </strong>
          <MarkdownContent>{item.question.question}</MarkdownContent>
          {item.answer !== null && (
            <p className="agent-live-answer">
              {item.author}: {item.answer}
            </p>
          )}
        </li>
      );
    case 'user':
      return (
        <li className="agent-live-user">
          <strong>{item.author}</strong>
          <p>{item.text}</p>
        </li>
      );
    case 'error':
      return (
        <li className="agent-live-error">
          <Icon name="warning" size={14} /> {item.text}
        </li>
      );
  }
}

function useRunInput(ticketId: string, runId: string) {
  const { request } = useSession();
  const mutation = useMutation();
  const send = (
    body: { kind: 'answer'; questionId: string; text: string } | { kind: 'message'; text: string },
    onSent?: () => void,
  ) =>
    mutation.run(async () => {
      await request(`/tickets/${ticketId}/agent-runs/${encodeURIComponent(runId)}/inputs`, {
        method: 'POST',
        body,
      });
      onSent?.();
    });
  return { send, busy: mutation.busy, error: mutation.error };
}

function QuestionForm({
  ticketId,
  runId,
  question,
}: {
  ticketId: string;
  runId: string;
  question: AgentQuestion;
}) {
  const { t } = useIdentityLocale();
  const input = useRunInput(ticketId, runId);
  const [text, setText] = useState('');
  const answer = (value: string) =>
    void input.send({ kind: 'answer', questionId: question.questionId, text: value });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (text.trim()) answer(text.trim());
  };
  return (
    <form className="agent-live-form agent-live-ask" onSubmit={submit}>
      <fieldset disabled={input.busy}>
        <legend>
          {question.kind === 'plan'
            ? t('O Copilot aguarda a aprovação do plano', 'Copilot is waiting for plan approval')
            : t('O Copilot aguarda a sua resposta', 'Copilot is waiting for your answer')}
        </legend>
        {input.error && <Notice>{input.error}</Notice>}
        {question.choices.length > 0 && (
          <div className="agent-live-choices">
            {question.choices.map((choice) => (
              <button
                key={choice}
                type="button"
                className="button button-secondary"
                onClick={() => answer(choice)}
              >
                {choice}
              </button>
            ))}
          </div>
        )}
        {question.allowFreeform && (
          <>
            <label>
              {question.kind === 'plan'
                ? t('Alterações ao plano', 'Plan changes')
                : t('Resposta', 'Answer')}
              <textarea
                rows={2}
                maxLength={4000}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            <button className="button button-primary" type="submit" disabled={!text.trim()}>
              <Icon name="message" size={16} />
              {t('Responder', 'Reply')}
            </button>
          </>
        )}
      </fieldset>
    </form>
  );
}

function MessageForm({ ticketId, runId }: { ticketId: string; runId: string }) {
  const { t } = useIdentityLocale();
  const input = useRunInput(ticketId, runId);
  const [text, setText] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    void input.send({ kind: 'message', text: value }, () => setText(''));
  };
  return (
    <form className="agent-live-form" onSubmit={submit}>
      <fieldset disabled={input.busy}>
        <legend className="sr-only">{t('Mensagem para o Copilot', 'Message to Copilot')}</legend>
        {input.error && <Notice>{input.error}</Notice>}
        <label>
          {t('Mensagem para o Copilot', 'Message to Copilot')}
          <textarea
            rows={2}
            maxLength={4000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t(
              'Ex.: verifique também os pagamentos desta encomenda no Shift4.',
              'E.g.: also check the payments for this order in Shift4.',
            )}
          />
        </label>
        <button className="button button-secondary" type="submit" disabled={!text.trim()}>
          <Icon name="arrow" size={16} />
          {t('Enviar', 'Send')}
        </button>
      </fieldset>
    </form>
  );
}
