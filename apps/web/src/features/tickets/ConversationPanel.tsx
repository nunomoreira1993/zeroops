import { useState } from 'react';
import type { AgentRun, TicketDetail } from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { MarkdownContent } from '../../components/MarkdownContent';
import { Notice } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { type AgentRunsResource } from './AgentRunPanel';
import { CommentComposer } from './CommentComposer';
import { ConversationThread } from './ConversationThread';
import { activeRun } from './team-chat';
import { TeamChat } from './TeamChat';
import { TeamComposer, useLatest, useModelCatalog } from './TeamComposer';

type Channel = 'client' | 'team';

/**
 * Conversa do pedido em dois canais: o cliente só vê as mensagens públicas (respostas finais e
 * perguntas); a equipa tem ainda o canal interno com o trabalho do Copilot e as notas internas.
 */
export function ConversationPanel({
  detail,
  onChanged,
  channel,
  onChannelChange,
}: {
  detail: TicketDetail;
  onChanged: (message: string) => void;
  channel: Channel;
  onChannelChange: (channel: Channel) => void;
}) {
  const { session } = useSession();
  const { t } = useIdentityLocale();
  const team = !!session && session.user.role !== 'client';
  const runs = useResource<AgentRun[]>(
    team ? `/tickets/${encodeURIComponent(detail.ticket.id)}/agent-runs` : null,
    5000,
  );
  const setChannel = onChannelChange;
  const [clientDraft, setClientDraft] = useState('');
  const [teamDraft, setTeamDraft] = useState('');
  const runList = useLatest(runs.data, detail.ticket.id) ?? [];
  const catalog = useModelCatalog(team ? detail.ticket.id : null);
  if (!session) return null;

  const publicCount = detail.comments.filter((c) => c.visibility === 'public').length + 1;
  const internalCount = detail.comments.filter((c) => c.visibility === 'internal').length;
  const reviewDraft = (text: string) => {
    setClientDraft(text);
    setChannel('client');
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.comment-form-public textarea')?.focus(),
    );
  };

  if (!team) {
    return (
      <section className="panel detail-section conversation-panel" id="conversation">
        <div className="panel-heading">
          <div>
            <h2>{t('Conversa do pedido', 'Ticket conversation')}</h2>
            <p>
              {t(
                'Mensagens com a equipa de suporte · atualização automática a cada 10 segundos.',
                'Messages with the support team · refreshed automatically every 10 seconds.',
              )}
            </p>
          </div>
          <span className="count-pill">{publicCount}</span>
        </div>
        <ConversationThread
          detail={detail}
          user={session.user}
          onChanged={onChanged}
          channel="public"
        />
        <CommentComposer
          ticketId={detail.ticket.id}
          visibility="public"
          draft={clientDraft}
          onDraftChange={setClientDraft}
          label={t('Adicionar mensagem', 'Add message')}
          placeholder={t(
            'Partilhe contexto ou responda à equipa…',
            'Share context or reply to the team…',
          )}
          hint={t(
            'Visível a todos os participantes do pedido.',
            'Visible to all ticket participants.',
          )}
          submitLabel={t('Enviar mensagem', 'Send message')}
          onChanged={onChanged}
        />
      </section>
    );
  }

  return (
    <section className="panel detail-section conversation-panel" id="conversation">
      <div className="panel-heading">
        <div>
          <h2>{t('Conversa do pedido', 'Ticket conversation')}</h2>
          <p>
            {t(
              'O cliente só vê o separador Cliente. O trabalho do Copilot e as notas internas ficam na equipa.',
              'The client only sees the Client tab. Copilot work and internal notes stay with the team.',
            )}
          </p>
        </div>
      </div>
      <nav
        className="section-nav conversation-channels"
        aria-label={t('Canais da conversa', 'Conversation channels')}
      >
        <button onClick={() => setChannel('client')} aria-pressed={channel === 'client'}>
          <Icon name="message" size={15} />
          {t('Cliente', 'Client')} <span>{publicCount}</span>
        </button>
        <button onClick={() => setChannel('team')} aria-pressed={channel === 'team'}>
          <Icon name="pulse" size={15} />
          {t('Equipa · Copilot', 'Team · Copilot')} <span>{internalCount}</span>
        </button>
      </nav>
      <div hidden={channel !== 'client'} className="conversation-channel">
        <ConversationThread
          detail={detail}
          user={session.user}
          onChanged={onChanged}
          channel="public"
        />
        <ProposedReply detail={detail} runs={runs} onReview={reviewDraft} />
        <CommentComposer
          ticketId={detail.ticket.id}
          visibility="public"
          draft={clientDraft}
          onDraftChange={setClientDraft}
          label={t('Resposta ao cliente', 'Reply to client')}
          placeholder={t(
            'Escreva a resposta final ao cliente…',
            'Write the final reply to the client…',
          )}
          hint={t(
            'Visível ao cliente. Reveja antes de enviar.',
            'Visible to the client. Review before sending.',
          )}
          submitLabel={t('Enviar ao cliente', 'Send to client')}
          onChanged={onChanged}
        />
      </div>
      <div hidden={channel !== 'team'} className="conversation-channel team-channel">
        <TeamChat
          ticketId={detail.ticket.id}
          comments={detail.comments}
          runs={runList}
          models={catalog?.models}
          user={session.user}
          visible={channel === 'team'}
          onUseDraft={reviewDraft}
        />
        {runs.error && <Notice>{runs.error}</Notice>}
        <TeamComposer
          ticketId={detail.ticket.id}
          closed={['resolved', 'cancelled'].includes(detail.ticket.status)}
          active={activeRun(runList)}
          catalog={catalog}
          draft={teamDraft}
          onDraftChange={setTeamDraft}
          onChanged={onChanged}
          onRunsChanged={runs.reload}
        />
      </div>
    </section>
  );
}

/** Cartão com a resposta final proposta pelo último run, ainda por rever e enviar. */
function ProposedReply({
  detail,
  runs,
  onReview,
}: {
  detail: TicketDetail;
  runs: AgentRunsResource;
  onReview: (text: string) => void;
}) {
  const { t } = useIdentityLocale();
  const latest = runs.data?.[0];
  if (!latest || latest.status !== 'succeeded' || !latest.replyDraft) return null;
  const since = Date.parse(latest.finishedAt ?? latest.createdAt);
  const answered = detail.comments.some(
    (c) =>
      c.visibility === 'public' &&
      c.authorKind === 'human' &&
      c.authorRole !== 'client' &&
      Date.parse(c.createdAt) > since,
  );
  if (answered) return null;
  const draft = latest.replyDraft;
  return (
    <aside
      className="proposed-reply"
      aria-label={t('Resposta proposta pelo Copilot', 'Reply proposed by Copilot')}
    >
      <header>
        <Icon name="pulse" size={16} />
        <strong>{t('Resposta proposta pelo Copilot', 'Reply proposed by Copilot')}</strong>
        <span className="tiny-badge badge-amber">
          {t('Por rever · o cliente ainda não vê', 'To review · not yet visible to the client')}
        </span>
      </header>
      <MarkdownContent>{draft}</MarkdownContent>
      <button className="button button-secondary" onClick={() => onReview(draft)}>
        <Icon name="message" size={16} />
        {t('Rever e editar', 'Review and edit')}
      </button>
    </aside>
  );
}
