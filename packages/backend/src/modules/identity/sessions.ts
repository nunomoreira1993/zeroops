import { randomUUID } from 'node:crypto';
import type { PoolClient } from '../../database/database.js';
import type { User } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { secret, sha256, tokenHash } from './credentials.js';
import { toUser, type UserRow } from './identity.rows.js';

/** Deriva o token CSRF da sessão e do projeto, impedindo reutilização entre contextos. */
export function sessionCsrf(token: string, projectId: string) {
  return sha256(`zeroops:csrf:${token}:${projectId}`);
}

export interface AuthenticatedSession {
  token: string;
  csrfToken: string;
  user: User;
}

/** Emite sessão persistida de oito horas e o respetivo token CSRF para o projeto. */
export async function issueSession(
  client: PoolClient,
  user: User,
  mfaVerified = false,
): Promise<AuthenticatedSession> {
  const token = secret();
  const csrfToken = sessionCsrf(token, user.projectId);
  await client.query(
    `INSERT INTO identity_sessions (id, user_id, token_hash, csrf_hash, expires_at, mfa_verified, project_id)
     VALUES ($1, $2, $3, $4, NOW(3) + INTERVAL 8 HOUR, $5, $6)`,
    [randomUUID(), user.id, sha256(token), sha256(csrfToken), mfaVerified, user.projectId],
  );
  return { token, csrfToken, user };
}

/** Resolve sessão não expirada e exige pertença ativa e estado MFA compatível com a política. */
export async function authenticateSession(
  db: Database,
  token: string,
): Promise<{ user: User; csrfHash: string; csrfToken: string }> {
  const result = await db.query<UserRow & { csrf_hash: string }>(
    `SELECT u.*, s.project_id, COALESCE(m.role,u.role) AS role,
       CASE WHEN m.user_id IS NOT NULL THEN m.organization ELSE u.organization END AS organization, s.csrf_hash
     FROM identity_sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN project_memberships m ON m.user_id=u.id AND m.project_id=s.project_id
     LEFT JOIN projects p ON p.id=m.project_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW(3) AND NOT u.disabled
       AND s.project_id IS NOT NULL
       AND ((m.user_id IS NOT NULL AND NOT m.disabled AND NOT p.archived) OR u.instance_admin)
       AND ((u.mfa_secret IS NOT NULL AND s.mfa_verified AND NOT u.mfa_enrollment_required)
         OR (u.mfa_secret IS NULL AND NOT u.mfa_enrollment_required AND (u.mfa_opt_out
           OR (NOT u.instance_admin AND NOT EXISTS (SELECT 1 FROM project_memberships staff JOIN projects sp ON sp.id=staff.project_id
             WHERE staff.user_id=u.id AND NOT staff.disabled AND NOT sp.archived AND staff.role<>'client')))))`,
    [tokenHash(token)],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError('UNAUTHENTICATED', 'Sessão inválida ou expirada.', 401);
  return {
    user: toUser(row),
    csrfHash: row.csrf_hash,
    csrfToken: sessionCsrf(token, row.project_id),
  };
}
