import { useState } from 'react';
import { preExecutionStatuses, type TicketDetail, type User } from '@zeroops/contracts';
import { Avatar } from '../../components/Avatar';
import { MarkdownContent } from '../../components/MarkdownContent';
import { useIdentityLocale } from '../../lib/identity';
import { formatDateTime, ticketLabels } from './labels';
import { CommentCorrectionForm } from './CommentCorrectionForm';

export function ConversationThread({
  detail,
  user,
  onChanged,
  channel,
}: {
  detail: TicketDetail;
  user: User;
  onChanged: (message: string) => void;
  /** Só as mensagens deste canal; o pedido original aparece no canal do cliente. */
  channel?: 'public' | 'internal';
}) {
  const { locale, t } = useIdentityLocale();
  const roleLabels = ticketLabels(locale).role;
  const dateTime = (value: string) => formatDateTime(value, locale);
  const author = detail.creatorName;
  const [editingId, setEditingId] = useState<string | null>(null);
  const canEditComments = preExecutionStatuses.includes(detail.ticket.status);
  const creator = detail.participants.find((person) => person.userId === detail.ticket.createdBy);
  const isClient = user.role === 'client';
  const comments = detail.comments.filter(
    (comment) =>
      (!isClient || comment.visibility === 'public') &&
      (!channel || comment.visibility === channel),
  );
  return (
    <ol className="chat-thread" aria-label={t('Mensagens do pedido', 'Ticket messages')}>
      {channel !== 'internal' && (
        <li className="chat-message chat-original">
          <Avatar name={author} userId={detail.ticket.createdBy} />
          <article>
            <header>
              <strong>{author}</strong>
              <span className="tiny-badge">{t('Pedido original', 'Original request')}</span>
              {creator && (
                <span className="tiny-badge">
                  {roleLabels[creator.role]} ·{' '}
                  {creator.organization === 'deloitte'
                    ? 'Deloitte'
                    : creator.organization === 'client'
                      ? t('Cliente', 'Client')
                      : t('Organização por confirmar', 'Organization unconfirmed')}
                </span>
              )}
              <time dateTime={detail.ticket.createdAt}>{dateTime(detail.ticket.createdAt)}</time>
            </header>
            <MarkdownContent>{detail.ticket.description}</MarkdownContent>
          </article>
        </li>
      )}
      {comments.length === 0 && channel === 'internal' && (
        <li className="chat-empty muted">
          {t(
            'Ainda não há notas internas. As conclusões do Copilot e as notas da equipa aparecem aqui.',
            'No internal notes yet. Copilot conclusions and team notes appear here.',
          )}
        </li>
      )}
      {comments.map((comment) => {
        const revisions = detail.commentRevisions.filter(
          (revision) => revision.commentId === comment.id && revision.version > 0,
        );
        const fromAgent = comment.authorKind === 'agent';
        const fromSystem = comment.authorKind === 'system';
        // O cliente vê as mensagens automáticas como vindas da equipa de suporte.
        const authorName =
          (fromAgent || fromSystem) && isClient
            ? t('Equipa de suporte', 'Support team')
            : fromSystem
              ? 'ZeroOps'
              : comment.authorName;
        return (
          <li
            key={comment.id}
            className={`chat-message ${comment.visibility === 'internal' ? 'chat-internal' : ''} ${comment.automated ? 'chat-automated' : ''}`}
          >
            <Avatar
              name={authorName}
              userId={comment.authorKind === 'human' ? comment.authorId : null}
              avatarVersion={comment.authorAvatarVersion ?? null}
              kind={comment.automated && !isClient ? (fromAgent ? 'copilot' : 'system') : 'person'}
            />
            <article>
              <header>
                <strong>{authorName}</strong>
                {!((fromAgent || fromSystem) && isClient) && (
                  <span className={`tiny-badge${fromAgent ? ' badge-agent' : ''}`}>
                    {fromAgent
                      ? t('Automática · Copilot', 'Automated · Copilot')
                      : comment.authorKind === 'system'
                        ? t('Sistema', 'System')
                        : comment.authorRole
                          ? roleLabels[comment.authorRole]
                          : t('Participante humano', 'Human participant')}
                  </span>
                )}
                {comment.authorKind === 'human' && comment.authorOrganization && (
                  <span className="tiny-badge">
                    {comment.authorOrganization === 'deloitte'
                      ? 'Deloitte'
                      : t('Cliente', 'Client')}
                  </span>
                )}
                {comment.visibility === 'internal' && (
                  <span className="tiny-badge badge-amber">
                    {t('Interno · equipa', 'Internal · team')}
                  </span>
                )}
                {comment.version > 0 && (
                  <span className="tiny-badge">{t('Editada', 'Edited')}</span>
                )}
                <time dateTime={comment.updatedAt}>{dateTime(comment.updatedAt)}</time>
              </header>
              <MarkdownContent>{comment.body}</MarkdownContent>
              {revisions.length > 0 && (
                <details>
                  <summary>
                    {t('Histórico de correções', 'Correction history')} ({revisions.length})
                  </summary>
                  <ol className="content-list">
                    {revisions.map((revision) => (
                      <li key={revision.id}>
                        <span>
                          {t('Versão', 'Version')} {revision.version} · {revision.editorName} ·{' '}
                          {dateTime(revision.createdAt)}
                        </span>
                        <MarkdownContent>{revision.before ?? ''}</MarkdownContent>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {user.id === comment.authorId &&
                !comment.automated &&
                canEditComments &&
                (editingId === comment.id ? (
                  <CommentCorrectionForm
                    ticket={detail.ticket}
                    comment={comment}
                    onChanged={(message) => {
                      setEditingId(null);
                      onChanged(message);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <button
                    className="button button-secondary"
                    onClick={() => setEditingId(comment.id)}
                  >
                    {t('Corrigir mensagem', 'Correct message')}
                  </button>
                ))}
            </article>
          </li>
        );
      })}
    </ol>
  );
}
