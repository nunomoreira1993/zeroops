import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { lockInTransaction, type Database, type PoolClient } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { secret, sha256 } from './credentials.js';
import type { UserRow } from './identity.rows.js';
import type { User } from '../../../../contracts/src/index.js';
import { tokenHash } from './credentials.js';

export interface PrivateIdentityMail {
  assertConfigured(): void | Promise<void>;
  enqueue(
    client: PoolClient,
    input: {
      userId?: string;
      recipient: string;
      locale: 'pt-PT' | 'en';
      kind: 'invite' | 'reset' | 'email-change' | 'lock' | 'mfa-reset';
      token?: string;
      expiresAt?: string;
      tokenHash?: string;
      /** Só em convites para contas novas; viaja cifrado no outbox e é apagado após a entrega. */
      temporaryPassword?: string;
    },
  ): Promise<unknown>;
  listForUser?(userId: string): Promise<
    {
      id: string;
      kind: string;
      state: string;
      attempts: number;
      error_code: string | null;
      created_at: Date;
      delivered_at: Date | null;
    }[]
  >;
  listForToken?(
    kind: 'invite',
    tokenHash: string,
  ): Promise<
    { state: 'pending' | 'processing' | 'delivered' | 'failed' | 'blocked' | 'uncertain' }[]
  >;
  retry?(client: PoolClient, id: string, userId: string): Promise<boolean>;
}
export const unavailableMail: PrivateIdentityMail = {
  assertConfigured() {
    throw new DomainError(
      'MAIL_TRANSPORT_NOT_CONFIGURED',
      'Serviço de email indisponível. Tente mais tarde.',
      503,
    );
  },
  async enqueue() {
    await this.assertConfigured();
  },
};

/** Cifra segredos de identidade com AES-256-GCM e associação autenticada ao utilizador. */
export class IdentityCipher {
  constructor(private readonly encodedKey?: string) {}
  private key() {
    const key = Buffer.from(this.encodedKey ?? '', 'base64');
    if (key.length !== 32)
      throw new DomainError(
        'IDENTITY_KEY_NOT_CONFIGURED',
        'Configuração privada de identidade indisponível.',
        503,
      );
    return key;
  }
  /** Cifra dados com AES-256-GCM e associa o identificador do utilizador como contexto autenticado. */
  encrypt(value: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
  }
  /** Decifra apenas ciphertext válido para a chave e contexto autenticado fornecidos. */
  decrypt(value: string, context: string) {
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error('Invalid identity ciphertext.');
    const [iv, tag, body] = parts.map((part) => Buffer.from(part, 'base64'));
    if (!iv || !tag || !body) throw new Error('Invalid identity ciphertext.');
    const cipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8');
  }
}
/** Cria o gerador/verificador TOTP com o formato de inscrição usado pelo ZeroOps. */
export function authenticator(secretValue?: string, email = 'ZeroOps') {
  return new OTPAuth.TOTP({
    issuer: 'ZeroOps',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: secretValue ? OTPAuth.Secret.fromBase32(secretValue) : new OTPAuth.Secret({ size: 20 }),
  });
}
/** Valida TOTP anti-replay ou consome atomicamente um código de recuperação de uso único. */
export async function verifySecondFactor(
  client: PoolClient,
  row: UserRow,
  code: string,
  cipher: IdentityCipher,
) {
  if (!row.mfa_secret) return false;
  if (/^\d{6}$/.test(code)) {
    const totp = authenticator(cipher.decrypt(row.mfa_secret, row.id));
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30000) + delta;
    if (row.mfa_last_step !== null && step <= Number(row.mfa_last_step)) return false;
    await client.query('UPDATE users SET mfa_last_step=$2 WHERE id=$1', [row.id, step]);
    return true;
  }
  const result = await client.query(
    'UPDATE identity_recovery_codes SET used_at=NOW(3) WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL',
    [row.id, sha256(code.trim())],
  );
  return result.rowCount === 1;
}
/** Substitui os códigos de recuperação anteriores e devolve um novo conjunto de uso único. */
export async function recoveryCodes(client: PoolClient, userId: string) {
  const codes = Array.from({ length: 10 }, () => secret().slice(0, 20));
  await client.query('DELETE FROM identity_recovery_codes WHERE user_id=$1', [userId]);
  for (const code of codes)
    await client.query('INSERT INTO identity_recovery_codes(user_id,code_hash) VALUES($1,$2)', [
      userId,
      sha256(code),
    ]);
  return codes;
}
/** Revoga todas as sessões, desafios e confirmações pendentes da identidade. */
export async function revokeAccess(client: PoolClient, userId: string) {
  await client.query('DELETE FROM identity_sessions WHERE user_id=$1', [userId]);
  await client.query('DELETE FROM identity_challenges WHERE user_id=$1', [userId]);
  await client.query('DELETE FROM identity_confirmations WHERE user_id=$1', [userId]);
}
/** Revoga sessões, confirmações e convites da identidade limitados ao projeto indicado. */
export async function revokeProjectAccess(client: PoolClient, userId: string, projectId: string) {
  await client.query('DELETE FROM identity_sessions WHERE user_id=$1 AND project_id=$2', [
    userId,
    projectId,
  ]);
  await client.query('DELETE FROM identity_challenges WHERE user_id=$1', [userId]);
  await client.query('DELETE FROM identity_confirmations WHERE user_id=$1 AND project_id=$2', [
    userId,
    projectId,
  ]);
  await client.query(
    `UPDATE identity_invites SET revoked_at=NOW(3) WHERE created_by=$1 AND project_id=$2
     AND used_at IS NULL AND revoked_at IS NULL`,
    [userId, projectId],
  );
}
/** Serializa alterações concorrentes que afetam a administração global de identidades. */
export async function lockIdentityAdministration(client: PoolClient) {
  await lockInTransaction(client, 'zeroops:identity-administration');
}
// Lock names are hashed because emails can exceed the zeroops_locks key length.
/** Serializa criação/ativação de contas para o endereço normalizado indicado. */
export async function lockIdentityEmail(client: PoolClient, email: string) {
  await lockInTransaction(client, `zeroops:identity-email:${sha256(email.toLowerCase())}`);
}
/** Serializa operações de identidade que alteram a pertença ao mesmo projeto. */
export async function lockIdentityProject(client: PoolClient, projectId: string) {
  await lockInTransaction(client, `zeroops:identity-project:${projectId}`);
}
/** Incrementa atomicamente o contador de tentativas na janela de dez minutos. */
export async function countIdentityRequest(db: Database, keyHash: string) {
  return db.transaction(async (client) => {
    await client.query(
      `INSERT INTO identity_request_limits(key_hash,count,expires_at) VALUES($1,1,NOW(3) + INTERVAL 10 MINUTE)
      ON DUPLICATE KEY UPDATE count=IF(expires_at<=NOW(3),1,count+1),
      expires_at=IF(expires_at<=NOW(3),NOW(3) + INTERVAL 10 MINUTE,expires_at)`,
      [keyHash],
    );
    const result = await client.query<{ count: number }>(
      'SELECT count FROM identity_request_limits WHERE key_hash=$1',
      [keyHash],
    );
    return result.rows[0]!.count;
  });
}
/** Consome confirmação recente apenas para o ator, sessão, projeto, ação e alvo exatos. */
export async function consumeConfirmation(
  client: PoolClient,
  actor: User,
  token: string,
  action: string,
  target: string,
) {
  const result = await client.query(
    `DELETE FROM identity_confirmations WHERE token_hash=$1 AND user_id=$2
     AND action=$3 AND target=$4 AND project_id=$5 AND expires_at>NOW(3)
     AND EXISTS (SELECT 1 FROM identity_sessions s WHERE s.token_hash=identity_confirmations.session_hash
       AND s.user_id=identity_confirmations.user_id
       AND s.expires_at>NOW(3))`,
    [tokenHash(token), actor.id, action, target, actor.projectId],
  );
  if (!result.rowCount)
    throw new DomainError(
      'REAUTH_REQUIRED',
      'Confirme novamente a sua identidade para esta ação.',
      403,
    );
}
/** Revoga tokens pendentes de recuperação, alteração de email/MFA e convites criados pela conta. */
export async function revokeIdentityTokens(client: PoolClient, userId: string) {
  for (const table of [
    'identity_password_resets',
    'identity_email_changes',
    'identity_mfa_resets',
  ]) {
    await client.query(
      `UPDATE ${table} SET revoked_at=NOW(3) WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL`,
      [userId],
    );
  }
  await client.query(
    `UPDATE identity_invites SET revoked_at=NOW(3) WHERE created_by=$1 AND used_at IS NULL AND revoked_at IS NULL`,
    [userId],
  );
}
/** Regista ação de identidade e alvo sem guardar tokens ou credenciais. */
export async function auditIdentity(
  client: PoolClient,
  actorId: string | null,
  action: string,
  target: string,
  reason?: string,
) {
  await client.query('INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,$3,$4)', [
    randomUUID(),
    actorId,
    action,
    JSON.stringify({ target, ...(reason ? { reason } : {}) }),
  ]);
}
