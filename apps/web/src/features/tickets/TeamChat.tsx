import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { type AgentModelOption, type AgentRun, type Comment, type User } from '@zeroops/contracts';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { MarkdownContent } from '../../components/MarkdownContent';
import { Notice } from '../../components/ui';
import { useIdentityLocale } from '../../lib/identity';
import { AgentRunDetails, failureText, statusText, triggerText } from './AgentRunPanel';
import { AgentRunLive } from './AgentRunLive';
import { UsageBadge } from './AgentUsage';
import { formatDateTime } from './labels';
import { buildTeamThread, type TeamChatItem } from './team-chat';
import { runRoutingName } from './TeamComposer';

/** Entradas mostradas de cada vez; as anteriores carregam ao fazer scroll para cima. */
export const TEAM_CHAT_PAGE = 20;
const NEAR_EDGE = 80;

/**
 * Chat da equipa com o Copilot: abre na última mensagem, carrega as anteriores com scroll para
 * cima e mostra o trabalho técnico de cada resposta só quando se pede («Ver interações»).
 */
export function TeamChat({
  ticketId,
  comments,
  runs,
  models,
  user,
  visible,
  onUseDraft,
}: {
  ticketId: string;
  comments: Comment[];
  runs: AgentRun[];
  models: AgentModelOption[] | undefined;
  user: User;
  /** O canal está à vista (o scroll para o fim só funciona com o contentor visível). */
  visible: boolean;
  onUseDraft: (draft: string) => void;
}) {
  const { t } = useIdentityLocale();
  const items = useMemo(() => buildTeamThread(comments, runs), [comments, runs]);
  const [count, setCount] = useState(TEAM_CHAT_PAGE);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const restore = useRef<number | null>(null);
  const shown = items.slice(-count);
  const hidden = items.length - shown.length;
  const last = items[items.length - 1];
  const lastSignature = last ? `${last.key}:${last.kind === 'run' ? last.run.status : ''}` : '';

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (restore.current !== null) {
      node.scrollTop += node.scrollHeight - restore.current;
      restore.current = null;
    } else if (visible && stick.current) node.scrollTop = node.scrollHeight;
  }, [visible, count, items.length, lastSignature]);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_EDGE;
    if (node.scrollTop < NEAR_EDGE && hidden > 0 && restore.current === null) {
      restore.current = node.scrollHeight;
      setCount((value) => value + TEAM_CHAT_PAGE);
    }
  };

  return (
    <div className="team-chat" ref={scroller} onScroll={onScroll}>
      {hidden > 0 ? (
        <button
          type="button"
          className="team-chat-more text-button"
          onClick={() => {
            restore.current = scroller.current?.scrollHeight ?? null;
            setCount((value) => value + TEAM_CHAT_PAGE);
          }}
        >
          {t('Mensagens anteriores', 'Earlier messages')} ({hidden})
        </button>
      ) : (
        <p className="team-chat-start muted">
          {t(
            'Início da conversa da equipa. O cliente não vê este canal.',
            'Start of the team conversation. The client cannot see this channel.',
          )}
        </p>
      )}
      {items.length === 0 && (
        <p className="team-chat-empty muted">
          {t(
            'Ainda não há mensagens. Pergunte ao Copilot ou deixe uma nota à equipa.',
            'No messages yet. Ask Copilot or leave a note for the team.',
          )}
        </p>
      )}
      <ol className="team-chat-list" aria-label={t('Conversa da equipa', 'Team conversation')}>
        {shown.map((item) => (
          <ChatItem
            key={item.key}
            item={item}
            ticketId={ticketId}
            models={models}
            user={user}
            onUseDraft={onUseDraft}
          />
        ))}
      </ol>
    </div>
  );
}

function ChatItem({
  item,
  ticketId,
  models,
  user,
  onUseDraft,
}: {
  item: TeamChatItem;
  ticketId: string;
  models: AgentModelOption[] | undefined;
  user: User;
  onUseDraft: (draft: string) => void;
}) {
  const { t } = useIdentityLocale();
  switch (item.kind) {
    case 'system':
      return (
        <Bubble
          avatar={<Avatar name={t('Sistema', 'System')} kind="system" />}
          author={t('Sistema', 'System')}
          at={item.at}
          system
        >
          <MarkdownContent>{item.comment.body}</MarkdownContent>
        </Bubble>
      );
    case 'note':
      return (
        <Bubble
          mine={item.comment.authorId === user.id}
          avatar={
            <Avatar
              name={item.comment.authorName}
              userId={item.comment.authorId}
              avatarVersion={item.comment.authorAvatarVersion ?? null}
            />
          }
          author={item.comment.authorName}
          at={item.at}
        >
          <MarkdownContent>{item.comment.body}</MarkdownContent>
        </Bubble>
      );
    case 'agent':
      return (
        <Bubble
          avatar={<Avatar name="Copilot" kind="copilot" />}
          author="Copilot"
          at={item.at}
          agent
        >
          <MarkdownContent>{item.comment.body}</MarkdownContent>
        </Bubble>
      );
    case 'run':
      return (
        <RunItems
          run={item.run}
          reply={item.reply}
          ticketId={ticketId}
          models={models}
          user={user}
          onUseDraft={onUseDraft}
        />
      );
  }
}

function Bubble({
  avatar,
  author,
  at,
  mine = false,
  agent = false,
  system = false,
  badge,
  footer,
  children,
}: {
  avatar: ReactNode;
  author: string;
  at: string;
  mine?: boolean;
  agent?: boolean;
  system?: boolean;
  badge?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { locale } = useIdentityLocale();
  return (
    <li
      className={`team-chat-message${mine ? ' is-mine' : ''}${agent ? ' is-agent' : ''}${system ? ' is-system' : ''}`}
    >
      {avatar}
      <article>
        <header>
          <strong>{author}</strong>
          {badge}
          <time dateTime={at}>{formatDateTime(at, locale)}</time>
        </header>
        {children}
        {footer && <footer>{footer}</footer>}
      </article>
    </li>
  );
}

/** Pedido ao Copilot (quem pediu, instruções e modelo) seguido da resposta do Copilot. */
function RunItems({
  run,
  reply,
  ticketId,
  models,
  user,
  onUseDraft,
}: {
  run: AgentRun;
  reply: Comment | null;
  ticketId: string;
  models: AgentModelOption[] | undefined;
  user: User;
  onUseDraft: (draft: string) => void;
}) {
  const { t, locale } = useIdentityLocale();
  const [open, setOpen] = useState(false);
  const active = run.status === 'queued' || run.status === 'running';
  const failure = run.errorCode ? failureText[run.errorCode] : undefined;
  const routing = runRoutingName(run, models, t);
  const body = reply?.body ?? run.summary;
  const manual = run.trigger === 'manual';
  return (
    <>
      {manual ? (
        <Bubble
          mine={run.requestedBy.id === user.id}
          avatar={
            <Avatar
              name={run.requestedBy.displayName}
              userId={run.requestedBy.id}
              avatarVersion={run.requestedBy.avatarVersion ?? null}
            />
          }
          author={run.requestedBy.displayName}
          at={run.createdAt}
        >
          <p className="preserve-lines">
            {run.instructions ?? t('Investigar este pedido.', 'Investigate this ticket.')}
          </p>
        </Bubble>
      ) : (
        <li className="team-chat-system">
          <Icon name="bot" size={13} />
          <span>{t(...triggerText[run.trigger])}</span>
          <time dateTime={run.createdAt}>{formatDateTime(run.createdAt, locale)}</time>
        </li>
      )}
      <Bubble
        agent
        avatar={<Avatar name="Copilot" kind="copilot" />}
        author="Copilot"
        at={run.finishedAt ?? run.startedAt ?? run.createdAt}
        badge={
          <span className={`tiny-badge agent-run-badge-${run.status}`}>
            {active && <span className="spinner" aria-hidden="true" />}
            {t(...statusText[run.status])}
          </span>
        }
        footer={
          <>
            <span
              className="team-chat-chip"
              title={t('Encaminhamento selecionado', 'Selected routing')}
            >
              <Icon name="bot" size={12} /> {routing}
            </span>
            {run.usage ? (
              <UsageBadge usage={run.usage} models={models} />
            ) : (
              <span className="muted">{t('Custo indisponível', 'Cost unavailable')}</span>
            )}
            {!active && (
              <button
                type="button"
                className="text-button team-chat-toggle"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
              >
                <Icon name="code" size={13} />
                {open
                  ? t('Esconder interações', 'Hide interactions')
                  : `${t('Ver interações', 'View interactions')} (${run.toolCalls.length})`}
              </button>
            )}
          </>
        }
      >
        {active && run.progress && <p className="muted">{run.progress}…</p>}
        {active && run.cancelRequested && (
          <p className="muted">{t('Cancelamento pedido.', 'Cancellation requested.')}</p>
        )}
        {active && <AgentRunLive ticketId={ticketId} run={run} composer={false} />}
        {!active && body && <MarkdownContent>{body}</MarkdownContent>}
        {run.status === 'failed' && run.errorCode && (
          <Notice tone="warning">
            {failure ? t(...failure) : `${t('Erro', 'Error')}: ${run.errorCode}`}
          </Notice>
        )}
        {run.status === 'cancelled' && !body && (
          <p className="muted">
            {t('A investigação foi cancelada.', 'The investigation was cancelled.')}
          </p>
        )}
        {!active && run.replyDraft && !open && (
          <button
            type="button"
            className="button button-secondary team-chat-draft"
            onClick={() => onUseDraft(run.replyDraft ?? '')}
          >
            <Icon name="message" size={15} />
            {t('Rever resposta ao cliente', 'Review client reply')}
          </button>
        )}
        {open && (
          <div className="team-chat-interactions">
            <AgentRunLive ticketId={ticketId} run={run} composer={false} />
            <AgentRunDetails run={run} onUseDraft={onUseDraft} />
          </div>
        )}
      </Bubble>
    </>
  );
}
