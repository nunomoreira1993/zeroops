import { z } from 'zod';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { hashPassword, tokenHash } from './credentials.js';
import { parseInput, passwordSchema } from './identity.validation.js';
import { revokeAccess, revokeIdentityTokens, auditIdentity } from './identity-security.js';

const resetSchema = z.strictObject({ token: z.string(), password: passwordSchema });

/** Recusa emitir links até existir transporte privado de email configurado. */
export function requestPasswordReset(_email: string): never {
  // Do not mint unusable credentials or place plaintext tokens in a generic outbox.
  throw new DomainError(
    'MAIL_TRANSPORT_NOT_CONFIGURED',
    'A recuperação de palavra-passe requer um serviço de email privado configurado.',
    503,
  );
}

/** Consome um link de reposição válido, altera a password e revoga credenciais antigas. */
export async function resetPassword(db: Database, input: { token: string; password: string }) {
  const data = parseInput(resetSchema, input);
  const hash = tokenHash(data.token);
  const passwordHash = await hashPassword(data.password);
  await db.transaction(async (client) => {
    const result = await client.query<{ user_id: string }>(
      `SELECT r.user_id FROM identity_password_resets r JOIN users u ON u.id = r.user_id
       WHERE r.token_hash = $1 AND r.expires_at > NOW(3)
         AND r.used_at IS NULL AND r.revoked_at IS NULL AND NOT u.disabled
       FOR UPDATE`,
      [hash],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('INVALID_RESET', 'Token inválido ou expirado.', 401);
    const consumed = await client.query(
      `UPDATE identity_password_resets SET used_at = NOW(3)
       WHERE token_hash = $1 AND expires_at > NOW(3)
         AND used_at IS NULL AND revoked_at IS NULL`,
      [hash],
    );
    if (!consumed.rowCount)
      throw new DomainError('INVALID_RESET', 'Token inválido ou expirado.', 401);
    await client.query(
      'UPDATE users SET password_hash = $1,password_failures=0,locked_until=NULL WHERE id = $2',
      [passwordHash, row.user_id],
    );
    await revokeAccess(client, row.user_id);
    await revokeIdentityTokens(client, row.user_id);
    await auditIdentity(client, row.user_id, 'identity.password.reset', row.user_id);
    await client.query(
      `UPDATE identity_password_resets SET revoked_at = NOW(3)
       WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [row.user_id],
    );
  });
}
