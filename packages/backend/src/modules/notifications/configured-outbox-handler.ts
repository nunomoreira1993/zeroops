import { z } from 'zod';
import type { IntegrationSetting } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import type { Queryable } from '../identity/membership.js';
import type { IntegrationSettingsService } from '../integrations/integration-settings.service.js';
import { createMailTransport, type SmtpConfig } from '../smtp/smtp-transport.js';
import type { MailBrandResolver, MailInlineAttachment } from '../smtp/mail-branding.js';
import { renderMailHtml } from '../smtp/mail-layout.js';
import type { OutboxHandler } from './outbox.js';

const eventSchema = z.object({
  ticketId: z.uuid(),
  projectId: z.uuid(),
  actorId: z.uuid().optional(),
  userId: z.uuid().optional(),
  commentId: z.uuid().optional(),
  status: z.string().optional(),
});

type MailMessage = {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: MailInlineAttachment[];
};
export type NotificationMailSender = (smtp: SmtpConfig, message: MailMessage) => Promise<void>;

interface TicketRow {
  id: string;
  key: string;
  title: string;
}

interface RecipientRow {
  email: string;
}

const sendMail: NotificationMailSender = async (smtp, message) => {
  const transport = createMailTransport(smtp);
  try {
    await transport.sendMail({ from: smtp.from, ...message });
  } finally {
    transport.close();
  }
};

/** Entrega emails genéricos de ticket sem incluir descrição, comentários ou notas internas. */
export class ConfiguredOutboxHandler implements OutboxHandler {
  constructor(
    private readonly db: Queryable,
    private readonly settings: Pick<IntegrationSettingsService, 'runtimeSmtp'>,
    private readonly environment: IntegrationSetting['environment'],
    private readonly bootstrapSmtp: SmtpConfig | undefined,
    private readonly publicUrl: string,
    private readonly send: NotificationMailSender = sendMail,
    private readonly brand: MailBrandResolver = async () => null,
  ) {}

  /** Envia aviso suportado apenas a destinatários atuais, sem conteúdo de comentários/notas. */
  async deliver(_id: string, topic: string, rawPayload: Record<string, unknown>) {
    if (
      ![
        'ticket.created',
        'ticket.changed',
        'ticket.comment_created',
        'ticket.participant_added',
      ].includes(topic)
    )
      return { status: 'blocked' as const, errorCode: 'unsupported_topic' };
    const parsed = eventSchema.safeParse(rawPayload);
    if (!parsed.success) return { status: 'blocked' as const, errorCode: 'payload_invalid' };
    const event = parsed.data;
    const found = await this.db.query<TicketRow>(
      `SELECT t.id,t.\`key\`,t.title FROM tickets t JOIN projects p ON p.id=t.project_id
       WHERE t.id=$1 AND t.project_id=$2 AND NOT p.archived`,
      [event.ticketId, event.projectId],
    );
    const ticket = found.rows[0];
    if (!ticket) return { status: 'blocked' as const, errorCode: 'ticket_unavailable' };

    let internal = false;
    if (topic === 'ticket.comment_created') {
      if (!event.commentId) return { status: 'blocked' as const, errorCode: 'payload_invalid' };
      const comment = await this.db.query<{ visibility: 'public' | 'internal' }>(
        'SELECT visibility FROM ticket_comments WHERE id=$1 AND ticket_id=$2',
        [event.commentId, ticket.id],
      );
      if (!comment.rows[0]) return { status: 'blocked' as const, errorCode: 'comment_unavailable' };
      internal = comment.rows[0].visibility === 'internal';
    }

    const recipients = await this.recipients(event.projectId, ticket.id, topic, {
      actorId: event.actorId,
      userId: event.userId,
      internal,
    });
    if (!recipients.length) return { status: 'blocked' as const, errorCode: 'no_recipients' };
    if (recipients.length > 100)
      return { status: 'blocked' as const, errorCode: 'recipient_limit' };

    let smtp: SmtpConfig | null;
    try {
      smtp = (await this.settings.runtimeSmtp(this.environment)) ?? this.bootstrapSmtp ?? null;
    } catch (error) {
      if (error instanceof DomainError)
        return { status: 'blocked' as const, errorCode: error.code.toLowerCase() };
      throw error;
    }
    if (!smtp) return { status: 'blocked' as const, errorCode: 'smtp_not_configured' };

    const action =
      topic === 'ticket.created'
        ? 'foi criado'
        : topic === 'ticket.comment_created'
          ? internal
            ? 'recebeu uma nota interna'
            : 'recebeu uma nova resposta'
          : topic === 'ticket.participant_added'
            ? 'recebeu uma nova participação'
            : `foi atualizado${event.status ? ` para ${event.status}` : ''}`;
    const url = `${this.publicUrl.replace(/\/+$/, '')}/#tickets/${encodeURIComponent(ticket.id)}`;
    const headline = `${ticket.key} ${action}`;
    const brand = await this.brand(event.projectId).catch(() => null);
    await this.send(smtp, {
      to: recipients,
      subject: `[ZeroOps] ${ticket.key}: atualização do pedido`,
      text: `O pedido ${ticket.key} — ${ticket.title} ${action}.\n\nConsulte o pedido: ${url}\n\nEsta mensagem não inclui o conteúdo da conversa.`,
      ...(brand?.attachments.length ? { attachments: brand.attachments } : {}),
      html: renderMailHtml({
        brand: brand?.brand,
        title: ticket.title,
        eyebrow: `Pedido ${ticket.key}`,
        badge: internal
          ? 'Nota interna'
          : topic === 'ticket.created'
            ? 'Novo pedido'
            : 'Atualização',
        tone: internal ? 'warning' : 'primary',
        preheader: `O pedido ${headline}.`,
        paragraphs: [`O pedido ${headline}.`],
        facts: [
          ['Pedido', ticket.key],
          ['Assunto', ticket.title],
          ...(event.status ? ([['Estado', event.status]] as [string, string][]) : []),
        ],
        action: { label: 'Abrir pedido', url },
        note: 'Por segurança, esta mensagem não inclui o conteúdo da conversa. Consulte-o no ZeroOps.',
      }),
    });
    return { status: 'sent' as const };
  }

  private async recipients(
    projectId: string,
    ticketId: string,
    topic: string,
    options: { actorId?: string; userId?: string; internal: boolean },
  ): Promise<string[]> {
    if (topic === 'ticket.created') {
      const result = await this.db.query<RecipientRow>(
        `SELECT DISTINCT u.email FROM users u
         JOIN project_memberships m ON m.user_id=u.id
         JOIN projects p ON p.id=m.project_id
         WHERE m.project_id=$1 AND m.role<>'client' AND NOT m.disabled AND NOT u.disabled AND NOT p.archived
         ORDER BY u.email LIMIT 101`,
        [projectId],
      );
      return result.rows.map((row) => row.email);
    }
    if (topic === 'ticket.participant_added') {
      if (!options.userId) return [];
      const result = await this.db.query<RecipientRow>(
        `SELECT u.email FROM users u
         JOIN project_memberships m ON m.user_id=u.id
         JOIN projects p ON p.id=m.project_id
         WHERE u.id=$1 AND m.project_id=$2 AND NOT m.disabled AND NOT u.disabled AND NOT p.archived`,
        [options.userId, projectId],
      );
      return result.rows.map((row) => row.email);
    }
    const result = await this.db.query<RecipientRow>(
      `SELECT DISTINCT u.email FROM (
         SELECT created_by AS user_id FROM tickets WHERE id=$1
         UNION SELECT user_id FROM ticket_assignments WHERE ticket_id=$1
         UNION SELECT user_id FROM ticket_participants WHERE ticket_id=$1 AND active
       ) people
       JOIN users u ON u.id=people.user_id
       JOIN project_memberships m ON m.user_id=u.id AND m.project_id=$2
       JOIN projects p ON p.id=m.project_id
       WHERE NOT u.disabled AND NOT m.disabled AND NOT p.archived
         AND ($3 IS NULL OR u.id<>$3)
         AND (NOT $4 OR m.role<>'client')
       ORDER BY u.email LIMIT 101`,
      [ticketId, projectId, options.actorId ?? null, options.internal],
    );
    return result.rows.map((row) => row.email);
  }
}
