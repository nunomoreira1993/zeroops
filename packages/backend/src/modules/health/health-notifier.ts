import type { HealthSettings } from '../../../../contracts/src/index.js';
import type { MailBrandResolver, MailInlineAttachment } from '../smtp/mail-branding.js';
import { createMailTransport, type SmtpConfig } from '../smtp/smtp-transport.js';
import { errorCode } from './collectors/collector.js';
import { renderHealthMailHtml } from './health-mail.js';
import type { HealthRepository } from './health.repository.js';

export type SmtpResolver = (
  environment: HealthSettings['mailEnvironment'],
) => Promise<SmtpConfig | null>;
export type MailSender = (
  smtp: SmtpConfig,
  message: {
    to: string[];
    subject: string;
    text: string;
    html?: string;
    attachments?: MailInlineAttachment[];
  },
) => Promise<void>;

const MAX_ATTEMPTS = 3;

const nodemailerSender: MailSender = async (smtp, message) => {
  const transport = createMailTransport(smtp);
  try {
    await transport.sendMail({
      from: smtp.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    });
  } finally {
    transport.close();
  }
};

/** Envia por e-mail as notificacoes pendentes, com o SMTP de instancia do ambiente configurado. */
export class HealthNotifier {
  constructor(
    private readonly repository: HealthRepository,
    private readonly smtp: SmtpResolver,
    private readonly send: MailSender = nodemailerSender,
    private readonly brand: MailBrandResolver = async () => null,
  ) {}

  /** Tenta entregar e atualiza o estado de cada notificação de email pendente. */
  async deliverPending(limit = 20) {
    const pending = await this.repository.pendingEmails(limit);
    let sent = 0;
    const settingsCache = new Map<string, HealthSettings | null>();
    for (const notification of pending) {
      if (!settingsCache.has(notification.projectId))
        settingsCache.set(
          notification.projectId,
          (await this.repository.settings(notification.projectId))?.settings ?? null,
        );
      const settings = settingsCache.get(notification.projectId);
      let smtp: SmtpConfig | null;
      try {
        smtp = settings ? await this.smtp(settings.mailEnvironment) : null;
      } catch (error) {
        await this.repository.markNotification(notification.id, 'blocked', errorCode(error));
        continue;
      }
      if (!smtp) {
        await this.repository.markNotification(notification.id, 'blocked', 'smtp_not_configured');
        continue;
      }
      try {
        const brand = await this.brand(notification.projectId).catch(() => null);
        await this.send(smtp, {
          to: notification.recipients,
          subject: notification.subject,
          text: notification.body,
          html: renderHealthMailHtml(notification.subject, notification.body, brand?.brand),
          ...(brand?.attachments.length ? { attachments: brand.attachments } : {}),
        });
        await this.repository.markNotification(notification.id, 'sent', null);
        sent += 1;
      } catch (error) {
        const last = notification.attempts + 1 >= MAX_ATTEMPTS;
        await this.repository.markNotification(
          notification.id,
          last ? 'failed' : 'pending',
          errorCode(error),
        );
      }
    }
    return sent;
  }
}
