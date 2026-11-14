import type { User } from '../../../../contracts/src/index.js';
import type { Database, PoolClient } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { secret, sha256 } from './credentials.js';
import {
  authenticator,
  recoveryCodes,
  revokeAccess,
  auditIdentity,
  type IdentityCipher,
} from './identity-security.js';
import type { UserRow } from './identity.rows.js';

type SelfRowLoader = (client: PoolClient, actor: User) => Promise<UserRow>;
type ConfirmationConsumer = (
  client: PoolClient,
  actor: User,
  token: string,
  action: string,
  target: string,
) => Promise<void>;

/** Casos de uso de inscrição, confirmação, gestão e recuperação de MFA da conta. */
export class AccountMfaService {
  constructor(
    private readonly db: Database,
    private readonly cipher: IdentityCipher,
    private readonly loadSelf: SelfRowLoader,
    private readonly consumeConfirmation: ConfirmationConsumer,
  ) {}

  /** Inicia inscrição TOTP apenas após confirmação recente e devolve segredo para apresentação única. */
  async start(actor: User, confirmationToken: string) {
    return this.db.transaction(async (client) => {
      const row = await this.loadSelf(client, actor);
      await this.consumeConfirmation(client, actor, confirmationToken, 'mfa-start', actor.id);
      if (row.mfa_secret) throw new DomainError('MFA_ENABLED', 'MFA já configurado.', 409);
      const totp = authenticator(undefined, row.email),
        token = secret();
      await client.query('DELETE FROM identity_challenges WHERE user_id=$1', [actor.id]);
      await client.query(
        "INSERT INTO identity_challenges(token_hash,user_id,stage,pending_secret) VALUES($1,$2,'enrollment',$3)",
        [sha256(token), actor.id, this.cipher.encrypt(totp.secret.base32, actor.id)],
      );
      return { uri: totp.toString(), secret: totp.secret.base32 };
    });
  }

  /** Confirma primeiro código TOTP, ativa MFA, emite recuperação e revoga sessões anteriores. */
  async confirm(actor: User, code: string) {
    const result = await this.db
      .transaction(async (client) => {
        const row = await this.loadSelf(client, actor);
        const challenge = await client.query<{ pending_secret: string }>(
          "SELECT pending_secret FROM identity_challenges WHERE user_id=$1 AND stage='enrollment' AND expires_at>NOW(3) AND failures<5 FOR UPDATE",
          [actor.id],
        );
        const pending = challenge.rows[0]?.pending_secret;
        if (!pending || row.mfa_secret)
          throw new DomainError('INVALID_CHALLENGE', 'Inscrição expirada.', 401);
        const delta = authenticator(this.cipher.decrypt(pending, actor.id)).validate({
          token: code,
          window: 1,
        });
        if (delta === null) {
          await client.query(
            'UPDATE identity_challenges SET failures=failures+1 WHERE user_id=$1',
            [actor.id],
          );
          return null;
        }
        await client.query(
          'UPDATE users SET mfa_secret=$2,mfa_last_step=$3,mfa_enrollment_required=false,mfa_opt_out=false WHERE id=$1',
          [actor.id, pending, Math.floor(Date.now() / 30000) + delta],
        );
        const codes = await recoveryCodes(client, actor.id);
        await revokeAccess(client, actor.id);
        await auditIdentity(client, actor.id, 'identity.mfa.enrolled', actor.id);
        return { recoveryCodes: codes };
      })
      .then((value) => {
        if (!value) throw new DomainError('INVALID_FACTOR', 'Código inválido.', 401);
        return value;
      });
    return result;
  }

  /**
   * Desativa o MFA da própria conta (fica registado como opção do utilizador, mesmo em perfis que o
   * exigem por defeito) ou substitui os códigos de recuperação. Exige confirmação com password e MFA.
   */
  async manage(actor: User, confirmationToken: string, action: 'mfa-disable' | 'mfa-codes') {
    return this.db.transaction(async (client) => {
      const row = await this.loadSelf(client, actor);
      await this.consumeConfirmation(client, actor, confirmationToken, action, actor.id);
      if (!row.mfa_secret) throw new DomainError('MFA_NOT_ENABLED', 'MFA não configurado.', 409);
      if (action === 'mfa-disable') {
        await client.query(
          'UPDATE users SET mfa_secret=NULL,mfa_last_step=NULL,mfa_enrollment_required=false,mfa_opt_out=true WHERE id=$1',
          [actor.id],
        );
        await client.query('DELETE FROM identity_recovery_codes WHERE user_id=$1', [actor.id]);
        await revokeAccess(client, actor.id);
      }
      await auditIdentity(client, actor.id, `identity.${action}`, actor.id);
      return action === 'mfa-codes'
        ? { recoveryCodes: await recoveryCodes(client, actor.id) }
        : { ok: true };
    });
  }
}
