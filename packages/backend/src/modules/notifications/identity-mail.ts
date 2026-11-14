import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import type { Database, PoolClient } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { createMailTransport, type SmtpConfig } from '../smtp/smtp-transport.js';
import { MailBranding } from '../smtp/mail-branding.js';
import {
  renderIdentityMail,
  type IdentityMailAccess,
  type IdentityMailKind,
  type IdentityMailLocale,
  type IdentityMailPayload,
  type InviteMailDetails,
} from './identity-mail.templates.js';

export interface IdentityMailInput extends IdentityMailPayload {
  userId?: string;
  kind: IdentityMailKind;
  expiresAt?: string;
  tokenHash?: string;
}

export type IdentitySmtpConfig = SmtpConfig;

export interface IdentityMailConfig {
  publicUrl: string;
  encryptionKey?: string;
  smtp?: IdentitySmtpConfig;
  /** Instruções de acesso incluídas no convite (entrada `hosts` e CA privada do portal). */
  access?: IdentityMailAccess;
}

export { createMailTransport };

/** Lê só certificados PEM; ficheiro vazio, ausente ou inválido desativa o anexo. */
function readCaCertificate(path?: string) {
  if (!path) return undefined;
  try {
    const pem = readFileSync(path, 'utf8').trim();
    return /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(pem) &&
      !pem.includes('PRIVATE KEY')
      ? `${pem}\n`
      : undefined;
  } catch {
    return undefined;
  }
}

/** Acesso ao portal descrito no convite: `ZEROOPS_ACCESS_HOSTS_IP` e `ZEROOPS_ACCESS_CA_FILE`. */
export function identityMailAccessFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IdentityMailAccess {
  const ip = env.ZEROOPS_ACCESS_HOSTS_IP?.trim();
  return {
    hostsIp: ip && isIPv4(ip) ? ip : undefined,
    caCertificatePem: readCaCertificate(env.ZEROOPS_ACCESS_CA_FILE?.trim()),
  };
}

type MailRow = {
  id: string;
  user_id: string | null;
  kind: IdentityMailKind;
  token_hash: string | null;
  expires_at: Date;
  key_version: number;
  payload_ciphertext: string | null;
  lease_id: string | null;
};

export type IdentityMailState =
  'pending' | 'processing' | 'delivered' | 'failed' | 'blocked' | 'uncertain';

const loopback = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
export type IdentityMailDelivery = {
  id: string;
  kind: IdentityMailKind;
  state: IdentityMailState;
  attempts: number;
  error_code: string | null;
  created_at: Date;
  delivered_at: Date | null;
};

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const emailValid = (value: string) =>
  value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);

function keyFromConfig(value?: string) {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  const key = Buffer.from(value, 'base64');
  return key.length === 32 ? key : undefined;
}

function associatedData(row: MailRow) {
  return Buffer.from(
    JSON.stringify([
      'zeroops.identity-mail',
      row.id,
      row.user_id,
      row.kind,
      row.token_hash,
      row.expires_at.toISOString(),
      row.key_version,
    ]),
  );
}

function seal(row: MailRow, payload: IdentityMailPayload, key: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData(row));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
}

function unseal(row: MailRow, key: Buffer): IdentityMailPayload {
  if (!row.payload_ciphertext) throw new Error('Payload missing');
  const data = Buffer.from(row.payload_ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(associatedData(row));
  decipher.setAuthTag(data.subarray(12, 28));
  const payload: IdentityMailPayload = JSON.parse(
    Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'),
  );
  if (!emailValid(payload.recipient) || !['pt-PT', 'en'].includes(payload.locale))
    throw new Error('Payload invalid');
  return payload;
}

/** Configuration values are never included in errors, audit events or delivery listings. */
export function identityMailConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): IdentityMailConfig {
  return {
    publicUrl: env.ZEROOPS_PUBLIC_URL ?? '',
    encryptionKey: env.ZEROOPS_IDENTITY_KEY,
    access: identityMailAccessFromEnv(env),
    smtp:
      env.ZEROOPS_SMTP_HOST && env.ZEROOPS_SMTP_FROM
        ? {
            host: env.ZEROOPS_SMTP_HOST,
            port: Number(env.ZEROOPS_SMTP_PORT ?? '25'),
            from: env.ZEROOPS_SMTP_FROM,
            secure: env.ZEROOPS_SMTP_SECURE === 'true',
            requireTLS: env.ZEROOPS_SMTP_REQUIRE_TLS !== 'false',
            allowInsecureLoopback: env.ZEROOPS_SMTP_ALLOW_INSECURE_LOOPBACK === 'true',
            auth:
              env.ZEROOPS_SMTP_USER || env.ZEROOPS_SMTP_PASSWORD
                ? {
                    user: env.ZEROOPS_SMTP_USER ?? '',
                    pass: env.ZEROOPS_SMTP_PASSWORD ?? '',
                  }
                : undefined,
          }
        : undefined,
  };
}

/** Valida, cifra, entrega e audita mensagens privadas de autenticação e recuperação. */
export class IdentityMailService {
  private readonly branding: MailBranding;

  constructor(
    private readonly db: Database,
    private readonly config: IdentityMailConfig,
  ) {
    this.branding = new MailBranding(db);
  }

  /** Valida origem HTTPS, chave de cifra e SMTP antes de aceitar qualquer mensagem. */
  assertConfigured() {
    const smtp = this.config.smtp;
    let validUrl = false;
    try {
      const url = new URL(this.config.publicUrl);
      validUrl =
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname)));
    } catch {
      // A missing public origin must fail uniformly for known and unknown accounts.
    }
    if (
      !keyFromConfig(this.config.encryptionKey) ||
      !validUrl ||
      !smtp ||
      !smtp.host ||
      /[\r\n]/.test(smtp.host) ||
      !emailValid(smtp.from) ||
      !Number.isInteger(smtp.port) ||
      smtp.port < 1 ||
      smtp.port > 65535 ||
      (smtp.timeoutMs !== undefined && (!Number.isFinite(smtp.timeoutMs) || smtp.timeoutMs <= 0)) ||
      (!smtp.secure &&
        smtp.requireTLS === false &&
        !(smtp.allowInsecureLoopback && loopback(smtp.host))) ||
      (smtp.auth && (!smtp.auth.user || !smtp.auth.pass))
    ) {
      throw new DomainError(
        'MAIL_TRANSPORT_NOT_CONFIGURED',
        'O serviço privado de email está indisponível.',
        503,
      );
    }
  }

  /** Valida, cifra e persiste mensagem de identidade e token apenas no outbox privado. */
  async enqueue(client: PoolClient, input: IdentityMailInput): Promise<{ id: string }> {
    this.assertConfigured();
    if (
      !emailValid(input.recipient) ||
      !['pt-PT', 'en'].includes(input.locale) ||
      !['invite', 'reset', 'email-change', 'lock', 'mfa-reset'].includes(input.kind) ||
      (['invite', 'reset'].includes(input.kind) && !input.token) ||
      (input.kind !== 'invite' && !input.userId) ||
      (input.kind === 'lock' && input.token) ||
      (input.temporaryPassword !== undefined &&
        (input.kind !== 'invite' || !input.temporaryPassword)) ||
      (input.tokenHash && (!input.token || input.tokenHash !== digest(input.token)))
    )
      throw new DomainError('INVALID_MAIL', 'Mensagem de identidade inválida.', 400);
    const expires = new Date(input.expiresAt ?? Date.now() + 30 * 60 * 1000);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())
      throw new DomainError('INVALID_MAIL', 'Mensagem de identidade expirada.', 400);
    const row: MailRow = {
      id: randomUUID(),
      user_id: input.userId ?? null,
      kind: input.kind,
      token_hash: input.token ? digest(input.token) : null,
      expires_at: expires,
      key_version: 1,
      payload_ciphertext: null,
      lease_id: null,
    };
    const encrypted = seal(
      row,
      {
        recipient: input.recipient.toLowerCase(),
        locale: input.locale,
        token: input.token,
        ...(input.temporaryPassword ? { temporaryPassword: input.temporaryPassword } : {}),
      },
      keyFromConfig(this.config.encryptionKey)!,
    );
    await client.query(
      `INSERT INTO identity_mail
       (id,user_id,kind,token_hash,expires_at,payload_ciphertext)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.id, row.user_id, row.kind, row.token_hash, expires, encrypted],
    );
    return { id: row.id };
  }

  /** Nome, perfil, projeto e autor do convite, para personalizar o email (só leitura). */
  private async inviteDetails(client: PoolClient, row: MailRow) {
    if (!row.token_hash) return null;
    const result = await client.query<{
      display_name: string;
      role: InviteMailDetails['role'];
      organization: InviteMailDetails['organization'];
      project_id: string;
      project_name: string;
      invited_by: string;
      existing_account: number;
    }>(
      `SELECT i.display_name,i.role,i.organization,p.id AS project_id,p.name AS project_name,u.display_name AS invited_by,
         EXISTS(SELECT 1 FROM users e WHERE lower(e.email)=lower(i.email)) AS existing_account
       FROM identity_invites i JOIN projects p ON p.id=i.project_id JOIN users u ON u.id=i.created_by
       WHERE i.token_hash=$1 LIMIT 1`,
      [row.token_hash],
    );
    const found = result.rows[0];
    return found
      ? {
          projectId: found.project_id,
          details: {
            displayName: found.display_name,
            role: found.role,
            organization: found.organization ?? null,
            projectName: found.project_name,
            invitedBy: found.invited_by,
            existingAccount: Boolean(found.existing_account),
          } satisfies InviteMailDetails,
        }
      : null;
  }

  private async validate(client: PoolClient, row: MailRow, payload: IdentityMailPayload) {
    if (row.expires_at.getTime() <= Date.now()) return false;
    if (row.token_hash && (!payload.token || digest(payload.token) !== row.token_hash))
      return false;
    if (row.kind === 'invite') {
      const result = await client.query(
        `SELECT i.id FROM identity_invites i
         JOIN users u ON u.id=i.created_by
         LEFT JOIN project_memberships m ON m.user_id=i.created_by AND m.project_id=i.project_id
         WHERE i.token_hash=$1 AND lower(i.email)=$2 AND i.expires_at>NOW(3)
         AND i.used_at IS NULL AND i.revoked_at IS NULL AND NOT u.disabled
         AND (u.instance_admin OR (NOT m.disabled AND m.role='admin'))
         LOCK IN SHARE MODE`,
        [row.token_hash, payload.recipient],
      );
      return Boolean(result.rowCount);
    }
    if (!row.user_id) return false;
    if (!row.token_hash) {
      const result = await client.query(
        `SELECT id FROM users WHERE id=$1 AND NOT disabled AND lower(email)=$2 LOCK IN SHARE MODE`,
        [row.user_id, payload.recipient],
      );
      return Boolean(result.rowCount);
    }
    const table = {
      reset: 'identity_password_resets',
      'email-change': 'identity_email_changes',
      'mfa-reset': 'identity_mfa_resets',
      lock: '',
    }[row.kind];
    if (!table) return false;
    const recipient = row.kind === 'email-change' ? 'r.email' : 'u.email';
    const result = await client.query(
      `SELECT r.token_hash FROM ${table} r JOIN users u ON u.id=r.user_id
       WHERE r.token_hash=$1 AND r.user_id=$2 AND lower(${recipient})=$3
       AND r.expires_at>NOW(3) AND r.used_at IS NULL
       AND r.revoked_at IS NULL AND NOT u.disabled LOCK IN SHARE MODE`,
      [row.token_hash, row.user_id, payload.recipient],
    );
    return Boolean(result.rowCount);
  }

  private async finish(
    client: PoolClient,
    row: MailRow,
    state: IdentityMailState,
    code: string | null,
    clearPayload = false,
  ) {
    const result = await client.query(
      `UPDATE identity_mail SET state=$3,error_code=$4,lease_id=NULL,lease_until=NULL,
       updated_at=NOW(3),delivered_at=CASE WHEN $3='delivered' THEN NOW(3) ELSE delivered_at END,
       payload_ciphertext=CASE WHEN $5 THEN NULL ELSE payload_ciphertext END
       WHERE id=$1 AND lease_id=$2 AND state='processing'`,
      [row.id, row.lease_id, state, code, clearPayload],
    );
    if (!result.rowCount) throw new Error('Mail lease lost');
  }

  /** Claims the oldest pending message under a short-lived lease (locking read, no skip). */
  private claim(lease: string): Promise<MailRow | undefined> {
    return this.db.transaction(async (client) => {
      const pending = await client.query<{ id: string }>(
        `SELECT id FROM identity_mail WHERE state='pending' AND expires_at>NOW(3)
         ORDER BY created_at LIMIT 1 FOR UPDATE`,
      );
      const id = pending.rows[0]?.id;
      if (!id) return undefined;
      const updated = await client.query(
        `UPDATE identity_mail SET state='processing',lease_id=$1,
         lease_until=NOW(3) + INTERVAL 2 MINUTE,attempts=attempts+1,updated_at=NOW(3)
         WHERE id=$2 AND state='pending'`,
        [lease, id],
      );
      if (!updated.rowCount) return undefined;
      const claimed = await client.query<MailRow>(
        'SELECT * FROM identity_mail WHERE id=$1 AND lease_id=$2',
        [id, lease],
      );
      return claimed.rows[0];
    });
  }

  /** SMTP accepted by the relay is recorded as delivered, not proof of inbox arrival.
   * Expired leases are uncertain and cannot be blindly retried (SMTP is not exactly-once).
   */
  async deliverPending(limit = 10): Promise<number> {
    await this.db.query(
      `UPDATE identity_mail SET state='uncertain',error_code='lease_expired',
       lease_id=NULL,lease_until=NULL,payload_ciphertext=NULL,updated_at=NOW(3)
       WHERE state='processing' AND lease_until<NOW(3)`,
    );
    await this.db.query(
      `UPDATE identity_mail SET state=CASE WHEN state='pending' THEN 'blocked' ELSE state END,
       payload_ciphertext=NULL,error_code='message_expired',updated_at=NOW(3)
       WHERE expires_at<=NOW(3) AND payload_ciphertext IS NOT NULL AND state<>'processing'`,
    );
    let processed = 0;
    for (let i = 0; i < Math.min(Math.max(limit, 0), 100); i++) {
      const row = await this.claim(randomUUID());
      if (!row) break;
      processed++;
      await this.db.transaction(async (client) => {
        try {
          this.assertConfigured();
        } catch {
          await this.finish(client, row, 'blocked', 'mail_not_configured');
          return;
        }
        let payload: IdentityMailPayload;
        try {
          payload = unseal(row, keyFromConfig(this.config.encryptionKey)!);
        } catch {
          await this.finish(client, row, 'blocked', 'payload_invalid', true);
          return;
        }
        if (!(await this.validate(client, row, payload))) {
          await this.finish(client, row, 'blocked', 'identity_reference_invalid', true);
          return;
        }
        const invite = row.kind === 'invite' ? await this.inviteDetails(client, row) : null;
        const brand = invite
          ? await this.branding.forProject(invite.projectId).catch(() => null)
          : null;
        const smtp = this.config.smtp!;
        const transport = createMailTransport(smtp);
        let state: IdentityMailState = 'delivered';
        let code: string | null = null;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const info = await Promise.race([
            transport.sendMail({
              from: smtp.from,
              to: payload.recipient,
              messageId: `<${row.id}@${new URL(this.config.publicUrl).hostname}>`,
              ...renderIdentityMail(row.kind, payload, this.config.publicUrl, row.expires_at, {
                invite: invite?.details,
                access: this.config.access,
                brand: brand ?? undefined,
              }),
            }),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => reject(new Error('SMTP deadline')), 60000);
            }),
          ]);
          if (info.accepted.length !== 1 || info.rejected.length) {
            state = 'failed';
            code = 'smtp_rejected';
          }
        } catch (error) {
          const failure = error as {
            code?: string;
            command?: string;
            responseCode?: number;
            syscall?: string;
          };
          const rejected = Boolean(failure.responseCode && failure.responseCode >= 400);
          // Nodemailer reports socket timeouts with command=CONN even after DATA.
          // Never infer non-delivery from that command without a definite rejection.
          const beforeData =
            failure.code !== 'ETIMEDOUT' &&
            (failure.syscall === 'connect' ||
              ['EDNS', 'EAUTH'].includes(failure.code ?? '') ||
              ['EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(
                failure.command ?? '',
              ));
          state = rejected || beforeData ? 'failed' : 'uncertain';
          code = state === 'failed' ? 'smtp_rejected_or_unavailable' : 'smtp_result_uncertain';
        } finally {
          clearTimeout(deadline);
          transport.close();
        }
        await this.finish(client, row, state, code, state === 'delivered' || state === 'uncertain');
      });
    }
    return processed;
  }

  /** Call only from a separately authorized admin use case scoped to the user's project. */
  async listForUser(userId: string) {
    return (
      await this.db.query<IdentityMailDelivery>(
        `SELECT id,kind,state,attempts,error_code,created_at,delivered_at
         FROM identity_mail WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [userId],
      )
    ).rows;
  }

  /** Invitations have no user yet. The caller must authorize the invitation/project first. */
  async listForToken(kind: IdentityMailKind, tokenHash: string) {
    return (
      await this.db.query<IdentityMailDelivery>(
        `SELECT id,kind,state,attempts,error_code,created_at,delivered_at
         FROM identity_mail WHERE kind=$1 AND token_hash=$2
         ORDER BY created_at DESC LIMIT 50`,
        [kind, tokenHash],
      )
    ).rows;
  }

  /** Never retries uncertain delivery. Revoked/expired tokens are rechecked by the consumer. */
  async retry(client: PoolClient, id: string, userId: string): Promise<boolean> {
    this.assertConfigured();
    const result = await client.query(
      `UPDATE identity_mail SET state='pending',error_code=NULL,updated_at=NOW(3)
       WHERE id=$1 AND user_id=$2 AND state IN ('failed','blocked')
       AND payload_ciphertext IS NOT NULL AND expires_at>NOW(3) AND attempts<5`,
      [id, userId],
    );
    return Boolean(result.rowCount);
  }

  /** Scoped by a previously authorized invitation/token record; never accept a raw token. */
  async retryForToken(client: PoolClient, id: string, tokenHash: string): Promise<boolean> {
    this.assertConfigured();
    const result = await client.query(
      `UPDATE identity_mail SET state='pending',error_code=NULL,updated_at=NOW(3)
       WHERE id=$1 AND token_hash=$2 AND state IN ('failed','blocked')
       AND payload_ciphertext IS NOT NULL AND expires_at>NOW(3) AND attempts<5`,
      [id, tokenHash],
    );
    return Boolean(result.rowCount);
  }
}

export type { IdentityMailKind, IdentityMailLocale };
