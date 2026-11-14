import { formatLisbonTime, renderMailHtml } from '../smtp/mail-layout.js';
import type { ProjectMailBrand } from '../smtp/mail-branding.js';
import {
  CA_ATTACHMENT_NAME,
  inviteAccessMode,
  inviteMailContent,
  type IdentityMailAccess,
  type InviteMailDetails,
} from './invite-mail.content.js';

export type { IdentityMailAccess, InviteMailDetails };

/** Contexto opcional do envio: dados do convite e preparação de acesso ao portal. */
export interface IdentityMailContext {
  invite?: InviteMailDetails;
  access?: IdentityMailAccess;
  /** Marca do projeto (nome e logo inline) para o cabeçalho. */
  brand?: ProjectMailBrand;
}

export type IdentityMailKind = 'invite' | 'reset' | 'email-change' | 'lock' | 'mfa-reset';
export type IdentityMailLocale = 'pt-PT' | 'en';

export interface IdentityMailPayload {
  recipient: string;
  locale: IdentityMailLocale;
  token?: string;
  /** Só em convites para contas novas; apagado do outbox após a entrega. */
  temporaryPassword?: string;
}

const messages = {
  'pt-PT': {
    invite: ['Convite para o ZeroOps', 'Foi convidado para o ZeroOps. Ative a sua conta:'],
    reset: ['Repor palavra-passe do ZeroOps', 'Para repor a sua palavra-passe, abra:'],
    'email-change': [
      'Alteração de email do ZeroOps',
      'Foi pedida uma alteração do email da sua conta. Confirme o novo email:',
    ],
    lock: [
      'Aviso de bloqueio do ZeroOps',
      'A sua conta foi temporariamente bloqueada após tentativas de acesso incorretas. O bloqueio termina automaticamente após 15 minutos. Este email não permite desbloquear a conta.',
    ],
    'mfa-reset': [
      'Reposição MFA do ZeroOps',
      'Um administrador iniciou a reposição da autenticação multifator da sua conta após verificação da identidade. Terá de configurar novamente a sua aplicação autenticadora. Este email não substitui a autenticação multifator.',
    ],
  },
  en: {
    invite: ['ZeroOps invitation', 'You have been invited to ZeroOps. Activate your account:'],
    reset: ['Reset your ZeroOps password', 'To reset your password, open:'],
    'email-change': [
      'ZeroOps email change',
      'A change to your account email was requested. Confirm your new email:',
    ],
    lock: [
      'ZeroOps account lock notice',
      'Your account was temporarily locked after incorrect sign-in attempts. The lock ends automatically after 15 minutes. This email cannot unlock your account.',
    ],
    'mfa-reset': [
      'ZeroOps MFA reset',
      'An administrator initiated a multifactor authentication reset after verifying your identity. You must enroll your authenticator application again. This email does not replace multifactor authentication.',
    ],
  },
} as const;

const badges: Record<IdentityMailLocale, Record<IdentityMailKind, string>> = {
  'pt-PT': {
    invite: 'Convite',
    reset: 'Segurança',
    'email-change': 'Conta',
    lock: 'Segurança',
    'mfa-reset': 'Segurança',
  },
  en: {
    invite: 'Invitation',
    reset: 'Security',
    'email-change': 'Account',
    lock: 'Security',
    'mfa-reset': 'Security',
  },
};

const actions: Record<IdentityMailLocale, Record<IdentityMailKind, string>> = {
  'pt-PT': {
    invite: 'Ativar conta',
    reset: 'Repor palavra-passe',
    'email-change': 'Confirmar novo email',
    lock: 'Abrir ZeroOps',
    'mfa-reset': 'Configurar MFA',
  },
  en: {
    invite: 'Activate account',
    reset: 'Reset password',
    'email-change': 'Confirm new email',
    lock: 'Open ZeroOps',
    'mfa-reset': 'Set up MFA',
  },
};

const routes: Partial<Record<IdentityMailKind, string>> = {
  invite: '/activate',
  reset: '/reset-password',
  'email-change': '/verify-email',
  'mfa-reset': '/mfa-reset',
};

/** Renderiza assunto/corpo localizado com links de uso único no fragmento, fora dos logs HTTP. */
export function renderIdentityMail(
  kind: IdentityMailKind,
  payload: IdentityMailPayload,
  publicUrl: string,
  expiresAt?: Date,
  context: IdentityMailContext = {},
) {
  if (kind === 'invite') return renderInviteMail(payload, publicUrl, expiresAt, context);
  const [subject, configuredIntroduction] = messages[payload.locale][kind];
  const introduction =
    kind === 'email-change' && !payload.token
      ? payload.locale === 'pt-PT'
        ? 'Foi pedida uma alteração do email da sua conta. Este endereço permanece ativo até à confirmação do novo email. Esta mensagem é apenas um aviso.'
        : 'A change to your account email was requested. This address remains active until the new email is confirmed. This message is a notice only.'
      : configuredIntroduction;
  const url = new URL(routes[kind] ?? '/login', publicUrl);
  // Fragments avoid putting bearer tokens into HTTP/access logs or referrer URLs.
  if (payload.token) url.hash = new URLSearchParams({ token: payload.token }).toString();
  const safety =
    payload.locale === 'pt-PT'
      ? 'Se não reconhece esta ação, contacte o administrador. Não partilhe esta mensagem.'
      : 'If you do not recognize this action, contact your administrator. Do not share this message.';
  const text = [
    introduction,
    ...(payload.token ? ['', url.href] : []),
    ...(payload.token && expiresAt
      ? [
          '',
          payload.locale === 'pt-PT'
            ? `Ligação de uso único, válida até ${expiresAt.toISOString()}.`
            : `Single-use link, valid until ${expiresAt.toISOString()}.`,
        ]
      : []),
    '',
    safety,
  ].join('\n');
  const en = payload.locale === 'en';
  const validity =
    payload.token && expiresAt
      ? en
        ? `Single-use link, valid until ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
        : `Ligação de uso único, válida até ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
      : undefined;
  const html = renderMailHtml({
    locale: payload.locale,
    title: subject,
    tone: kind === 'lock' ? 'warning' : kind === 'mfa-reset' ? 'danger' : 'primary',
    badge: badges[payload.locale][kind],
    preheader: introduction,
    paragraphs: [introduction.replace(/:$/, '.')],
    facts: [[en ? 'Account' : 'Conta', payload.recipient]],
    action: payload.token ? { label: actions[payload.locale][kind], url: url.href } : undefined,
    note: [validity, safety].filter(Boolean).join(' '),
  });
  return { subject, text, html };
}

const safetyNotice = (en: boolean) =>
  en
    ? 'If you do not recognize this action, contact your administrator. Do not share this message.'
    : 'Se não reconhece esta ação, contacte o administrador. Não partilhe esta mensagem.';

/** Data/hora de Lisboa legível, com o fuso explícito para evitar ambiguidade. */

/** Convite completo: dados da conta, preparação da máquina, ativação, MFA e utilização diária. */
function renderInviteMail(
  payload: IdentityMailPayload,
  publicUrl: string,
  expiresAt: Date | undefined,
  context: IdentityMailContext,
) {
  const en = payload.locale === 'en';
  const [subject] = messages[payload.locale].invite;
  const mode = inviteAccessMode(payload.temporaryPassword, context.invite);
  const url = new URL(mode === 'link' ? routes.invite! : '/login', publicUrl);
  // Fragments avoid putting bearer tokens into HTTP/access logs or referrer URLs.
  if (mode === 'link' && payload.token)
    url.hash = new URLSearchParams({ token: payload.token }).toString();
  const validUntil = expiresAt ? formatLisbonTime(expiresAt, en ? 'en' : 'pt-PT') : undefined;
  const content = inviteMailContent({
    locale: payload.locale,
    recipient: payload.recipient,
    publicUrl,
    details: context.invite,
    access: context.access,
    validUntil,
    temporaryPassword: payload.temporaryPassword,
  });
  const safety = safetyNotice(en);
  const activateLabel =
    mode === 'link'
      ? actions[payload.locale].invite
      : en
        ? 'Sign in to ZeroOps'
        : 'Entrar no ZeroOps';
  const hasAction = mode !== 'link' || Boolean(payload.token);
  const text = [
    content.greeting,
    content.order,
    '',
    ...content.facts.map(([label, value]) => `${label}: ${value}`),
    ...content.sections.flatMap((section) => [
      '',
      section.title,
      ...section.items.map((item) => `- ${item}`),
    ]),
    ...(hasAction ? ['', `${activateLabel}: ${url.href}`] : []),
    '',
    safety,
  ].join('\n');
  const html = renderMailHtml({
    locale: payload.locale,
    title: subject,
    tone: 'primary',
    brand: context.brand?.brand,
    badge: badges[payload.locale].invite,
    preheader: content.greeting,
    paragraphs: [content.greeting, content.order],
    facts: content.facts,
    sections: content.sections,
    action: hasAction ? { label: activateLabel, url: url.href } : undefined,
    note: [
      validUntil
        ? mode === 'temporary'
          ? en
            ? `Invitation valid until ${validUntil}. Change the temporary password at first sign-in.`
            : `Convite válido até ${validUntil}. A palavra-passe temporária é trocada no primeiro acesso.`
          : mode === 'existing'
            ? en
              ? `Invitation valid until ${validUntil}.`
              : `Convite válido até ${validUntil}.`
            : en
              ? `Single-use link, valid until ${validUntil}.`
              : `Ligação de uso único, válida até ${validUntil}.`
        : undefined,
      safety,
    ]
      .filter(Boolean)
      .join(' '),
  });
  const ca = context.access?.caCertificatePem;
  const attachments = [
    ...(context.brand?.attachments ?? []),
    ...(ca
      ? [{ filename: CA_ATTACHMENT_NAME, content: ca, contentType: 'application/x-x509-ca-cert' }]
      : []),
  ];
  return { subject, text, html, ...(attachments.length ? { attachments } : {}) };
}
