import type { Database, PoolClient } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { secret, sha256, tokenHash, verifyPassword } from './credentials.js';
import { type UserRow } from './identity.rows.js';
import { defaultProjectContext, requiresMfa } from './membership.js';
import { issueSession, type AuthenticatedSession } from './sessions.js';
import { acceptPendingInvites, acceptTemporaryInvite } from './invitations.js';
import {
  authenticator,
  IdentityCipher,
  recoveryCodes,
  verifySecondFactor,
  auditIdentity,
  type PrivateIdentityMail,
} from './identity-security.js';

export type AuthenticationStep = AuthenticatedSession & {
  status: 'authenticated' | 'mfa_required' | 'enrollment_required';
  recoveryCodes?: string[];
};
/** Escolhe sessão direta ou desafio MFA conforme a política ativa da identidade/projeto. */
export async function beginAuthentication(
  client: PoolClient,
  row: UserRow,
  forceEnrollment = false,
  projectId?: string,
): Promise<AuthenticationStep> {
  const user = await defaultProjectContext(client, row, projectId);
  if (!row.mfa_secret && !forceEnrollment && !(await requiresMfa(client, row.id))) {
    return { ...(await issueSession(client, user)), status: 'authenticated' };
  }
  const token = secret();
  const stage = row.mfa_secret ? 'mfa' : 'enrollment';
  await client.query('DELETE FROM identity_challenges WHERE user_id=$1', [row.id]);
  await client.query('INSERT INTO identity_challenges(token_hash,user_id,stage) VALUES($1,$2,$3)', [
    sha256(token),
    row.id,
    stage,
  ]);
  return {
    user,
    token,
    csrfToken: sha256(`zeroops:challenge:${token}`),
    status: stage === 'mfa' ? 'mfa_required' : 'enrollment_required',
  };
}

/** Coordena password, desafios MFA e emissão de sessões autenticadas. */
export class AuthenticationService {
  constructor(
    private readonly db: Database,
    private readonly cipher: IdentityCipher,
    private readonly mail: PrivateIdentityMail,
  ) {}
  /** Valida credenciais, persiste bloqueios e inicia sessão ou desafio MFA. */
  async login(email: string, password: string): Promise<AuthenticationStep> {
    const result = await this.db.transaction(async (client) => {
      const data = await client.query<UserRow>(
        'SELECT * FROM users WHERE lower(email)=$1 FOR UPDATE',
        [email],
      );
      const row = data.rows[0];
      const valid = await verifyPassword(password, row?.password_hash ?? null);
      if (!row) {
        const invited = await acceptTemporaryInvite(client, email, password);
        return invited ? beginAuthentication(client, invited) : null;
      }
      if (row.disabled) return null;
      const resetting = await client.query(
        'SELECT 1 FROM identity_mfa_resets WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>NOW(3)',
        [row.id],
      );
      if (resetting.rowCount) return null;
      const locked = row.locked_until && row.locked_until.getTime() > Date.now();
      if (locked) return null;
      if (!valid) {
        const count = (row.locked_until ? 0 : row.password_failures) + 1;
        await client.query(
          'UPDATE users SET password_failures=$2, locked_until=CASE WHEN $2>=3 THEN NOW(3) + INTERVAL 15 MINUTE ELSE NULL END WHERE id=$1',
          [row.id, count],
        );
        if (count === 3) {
          await auditIdentity(client, row.id, 'identity.locked', row.id);
          try {
            await this.mail.assertConfigured();
            await this.mail.enqueue(client, {
              userId: row.id,
              recipient: row.email,
              locale: row.locale,
              kind: 'lock',
            });
          } catch (error) {
            if (
              !(error instanceof DomainError) ||
              !['MAIL_TRANSPORT_NOT_CONFIGURED', 'IDENTITY_KEY_NOT_CONFIGURED'].includes(error.code)
            )
              throw error;
            await auditIdentity(client, row.id, 'identity.lock_notice.blocked', row.id);
          }
        }
        return null;
      }
      await client.query('UPDATE users SET password_failures=0,locked_until=NULL WHERE id=$1', [
        row.id,
      ]);
      await acceptPendingInvites(client, row);
      return beginAuthentication(client, row);
    });
    if (!result)
      throw new DomainError(
        'INVALID_CREDENTIALS',
        'Não foi possível iniciar sessão. Verifique os dados ou tente novamente mais tarde.',
        401,
      );
    return result;
  }
  /** Consulta a etapa e o CSRF de um desafio ainda válido, sem consumir o token. */
  async challenge(token: string) {
    const result = await this.db.query<{ stage: 'mfa' | 'enrollment' }>(
      `SELECT c.stage FROM identity_challenges c JOIN users u ON u.id=c.user_id
       WHERE c.token_hash=$1 AND c.expires_at>NOW(3) AND c.failures<5 AND NOT u.disabled`,
      [tokenHash(token)],
    );
    const row = result.rows[0];
    if (!row)
      throw new DomainError(
        'INVALID_CHALLENGE',
        'Autenticação expirada. Inicie sessão novamente.',
        401,
      );
    return {
      status: row.stage === 'mfa' ? ('mfa_required' as const) : ('enrollment_required' as const),
      csrfToken: sha256(`zeroops:challenge:${token}`),
    };
  }
  private async lockedChallenge(client: PoolClient, token: string) {
    // Lock user before challenge consistently with login and administrative revocation.
    const user = await client.query<UserRow>(
      `SELECT u.* FROM users u JOIN identity_challenges c ON c.user_id=u.id
       WHERE c.token_hash=$1 AND c.expires_at>NOW(3) AND c.failures<5 AND NOT u.disabled FOR UPDATE`,
      [tokenHash(token)],
    );
    const row = user.rows[0];
    const challenge = await client.query<{ stage: string; pending_secret: string | null }>(
      'SELECT * FROM identity_challenges WHERE token_hash=$1 AND expires_at>NOW(3) AND failures<5 FOR UPDATE',
      [tokenHash(token)],
    );
    if (!row || !challenge.rows[0])
      throw new DomainError(
        'INVALID_CHALLENGE',
        'Autenticação expirada. Inicie sessão novamente.',
        401,
      );
    return { row, challenge: challenge.rows[0] };
  }
  /** Cria ou recupera o segredo TOTP cifrado de uma inscrição MFA pendente. */
  async enrollment(token: string) {
    return this.db.transaction(async (client) => {
      const { row, challenge } = await this.lockedChallenge(client, token);
      if (challenge.stage !== 'enrollment' || row.mfa_secret)
        throw new DomainError('INVALID_CHALLENGE', 'Etapa de autenticação inválida.', 403);
      let value = challenge.pending_secret && this.cipher.decrypt(challenge.pending_secret, row.id);
      if (!value) {
        value = authenticator().secret.base32;
        await client.query('UPDATE identity_challenges SET pending_secret=$2 WHERE token_hash=$1', [
          tokenHash(token),
          this.cipher.encrypt(value, row.id),
        ]);
      }
      return { secret: value, uri: authenticator(value, row.email).toString() };
    });
  }
  /** Valida TOTP/código de recuperação, consome o desafio e emite sessão autenticada. */
  async complete(token: string, code: string, enroll = false) {
    const result = await this.db.transaction(async (client) => {
      const { row, challenge } = await this.lockedChallenge(client, token);
      let codes: string[] | undefined;
      let valid = false;
      if (
        enroll &&
        challenge.stage === 'enrollment' &&
        challenge.pending_secret &&
        !row.mfa_secret &&
        /^\d{6}$/.test(code)
      ) {
        const value = this.cipher.decrypt(challenge.pending_secret, row.id);
        const delta = authenticator(value).validate({ token: code, window: 1 });
        if (delta !== null) {
          valid = true;
          await client.query(
            'UPDATE users SET mfa_secret=$2,mfa_last_step=$3,mfa_enrollment_required=false,mfa_opt_out=false WHERE id=$1',
            [row.id, challenge.pending_secret, Math.floor(Date.now() / 30000) + delta],
          );
          codes = await recoveryCodes(client, row.id);
          await auditIdentity(client, row.id, 'identity.mfa.enrolled', row.id);
        }
      } else if (!enroll && challenge.stage === 'mfa') {
        valid = await verifySecondFactor(client, row, code, this.cipher);
      }
      if (!valid) {
        await client.query(
          'UPDATE identity_challenges SET failures=failures+1 WHERE token_hash=$1',
          [tokenHash(token)],
        );
        return null;
      }
      await client.query('DELETE FROM identity_challenges WHERE token_hash=$1', [tokenHash(token)]);
      return {
        ...(await issueSession(client, await defaultProjectContext(client, row), true)),
        status: 'authenticated' as const,
        ...(codes ? { recoveryCodes: codes } : {}),
      };
    });
    if (!result)
      throw new DomainError(
        'INVALID_FACTOR',
        'Código inválido ou já utilizado. Tente um novo código.',
        401,
      );
    return result;
  }
}
