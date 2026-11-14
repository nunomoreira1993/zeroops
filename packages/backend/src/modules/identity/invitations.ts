import { randomUUID } from 'node:crypto';
import type { Role, User } from '../../../../contracts/src/index.js';
import type { Database, PoolClient } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { hashPassword, secret, sha256, tokenHash, verifyPassword } from './credentials.js';
import { type UserRow } from './identity.rows.js';
import { activationSchema, inviteSchema, parseInput } from './identity.validation.js';
import { requireMember } from './membership.js';
import { beginAuthentication } from './authentication.js';
import { auditIdentity, lockIdentityEmail, lockIdentityProject } from './identity-security.js';

export interface InviteInput {
  email: string;
  displayName: string;
  role: Role;
}
export interface ActivateInput {
  token: string;
  password: string;
  displayName: string;
}
interface InviteRow {
  id: string;
  project_id: string;
  email: string;
  role: Role;
  organization: 'client' | 'deloitte' | null;
  locale: 'pt-PT' | 'en';
}

/** Cria convite único de 48 horas após autorização e serialização do email no projeto. */
export async function createInvitation(db: Database, actor: User, input: InviteInput) {
  const data = parseInput(inviteSchema, input);
  return db.transaction(async (client) => {
    const member = await requireMember(client, actor, true);
    if (member.role !== 'admin') {
      throw new DomainError(
        'FORBIDDEN',
        'Apenas administradores podem convidar utilizadores.',
        403,
      );
    }
    // Serializes invitations and activation for the globally unique email address.
    await lockIdentityEmail(client, data.email);
    const existing = await client.query(
      `SELECT m.user_id FROM users u JOIN project_memberships m ON m.user_id=u.id
       WHERE lower(u.email)=$1 AND m.project_id=$2 AND NOT m.disabled`,
      [data.email, member.projectId],
    );
    if (existing.rowCount) {
      throw new DomainError('EMAIL_IN_USE', 'Este email já tem uma conta.', 409);
    }
    await client.query(
      `UPDATE identity_invites SET revoked_at = NOW(3)
       WHERE project_id = $1 AND email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [member.projectId, data.email],
    );
    const token = secret();
    await client.query(
      `INSERT INTO identity_invites
         (id, project_id, email, display_name, role, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(3) + INTERVAL 48 HOUR)`,
      [
        randomUUID(),
        member.projectId,
        data.email,
        data.displayName,
        data.role,
        sha256(token),
        member.id,
      ],
    );
    return { token };
  });
}

/** Convite pendente e emitido por quem ainda é administrador (do projeto ou da instância). */
const validIssuer = `EXISTS (SELECT 1 FROM users issuer
           LEFT JOIN project_memberships issuer_membership
             ON issuer_membership.user_id=issuer.id
             AND issuer_membership.project_id=identity_invites.project_id
           WHERE issuer.id=identity_invites.created_by AND NOT issuer.disabled
           AND (issuer.instance_admin OR
             (issuer_membership.role='admin' AND NOT issuer_membership.disabled)))`;

/**
 * Primeiro login de uma conta nova com a palavra-passe temporária do convite: consome o convite
 * e cria a identidade marcada para definir nova palavra-passe. Devolve `null` se não corresponder.
 */
export async function acceptTemporaryInvite(
  client: PoolClient,
  email: string,
  password: string,
): Promise<UserRow | null> {
  const pending = await client.query<
    InviteRow & { display_name: string; temp_password_hash: string }
  >(
    `SELECT id, project_id, email, display_name, role, organization, locale, temp_password_hash
     FROM identity_invites
     WHERE lower(email)=$1 AND temp_password_hash IS NOT NULL AND expires_at > NOW(3)
       AND used_at IS NULL AND revoked_at IS NULL AND ${validIssuer}
     ORDER BY created_at DESC`,
    [email],
  );
  for (const invite of pending.rows) {
    if (!(await verifyPassword(password, invite.temp_password_hash))) continue;
    await lockIdentityProject(client, invite.project_id);
    await lockIdentityEmail(client, invite.email);
    if ((await client.query('SELECT id FROM users WHERE lower(email)=$1', [email])).rowCount)
      return null;
    const consumed = await client.query(
      `UPDATE identity_invites SET used_at=NOW(3)
       WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW(3)`,
      [invite.id],
    );
    if (!consumed.rowCount) return null;
    const userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, project_id, email, display_name, role, password_hash, organization, locale, password_change_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [
        userId,
        invite.project_id,
        invite.email,
        invite.display_name,
        invite.role,
        invite.temp_password_hash,
        invite.organization,
        invite.locale,
      ],
    );
    await auditIdentity(client, userId, 'identity.invite.accepted', invite.project_id);
    return (await client.query<UserRow>('SELECT * FROM users WHERE id=$1', [userId])).rows[0]!;
  }
  return null;
}

/**
 * Conta existente que entra com a sua palavra-passe: aceita os convites pendentes para o mesmo
 * email, dando acesso aos novos projetos sem ligação de ativação.
 */
export async function acceptPendingInvites(client: PoolClient, row: UserRow) {
  const pending = await client.query<InviteRow>(
    `SELECT id, project_id, email, role, organization, locale FROM identity_invites
     WHERE lower(email)=$1 AND expires_at > NOW(3) AND used_at IS NULL AND revoked_at IS NULL
       AND ${validIssuer}
     FOR UPDATE`,
    [row.email.toLowerCase()],
  );
  for (const invite of pending.rows) {
    await client.query('UPDATE identity_invites SET used_at=NOW(3) WHERE id=$1', [invite.id]);
    await client.query(
      `INSERT INTO project_memberships(user_id,project_id,role,organization,disabled)
       VALUES($1,$2,$3,$4,false)
       ON DUPLICATE KEY UPDATE
       role=IF(disabled,VALUES(role),role),organization=IF(disabled,VALUES(organization),organization),
       disabled=false,updated_at=NOW(3)`,
      [row.id, invite.project_id, invite.role, invite.organization],
    );
    await auditIdentity(client, row.id, 'identity.invite.accepted', invite.project_id);
  }
}

/** Consome convite válido e cria ou reativa a pertença sem criar uma identidade duplicada. */
export async function activateInvitation(db: Database, input: ActivateInput) {
  const data = parseInput(activationSchema, input);
  const hash = tokenHash(data.token);
  const passwordHash = await hashPassword(data.password);
  return db.transaction(async (client) => {
    const lookup = await client.query<InviteRow>(
      `SELECT id, project_id, email, role, organization, locale FROM identity_invites
       WHERE token_hash = $1 AND expires_at > NOW(3) AND used_at IS NULL AND revoked_at IS NULL`,
      [hash],
    );
    const candidate = lookup.rows[0];
    if (!candidate) throw new DomainError('INVALID_INVITE', 'Convite inválido ou expirado.', 401);
    await lockIdentityProject(client, candidate.project_id);
    await lockIdentityEmail(client, candidate.email);
    const consumed = await client.query(
      `UPDATE identity_invites SET used_at = NOW(3)
       WHERE id = $1 AND expires_at > NOW(3) AND used_at IS NULL AND revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM users issuer
           LEFT JOIN project_memberships issuer_membership
             ON issuer_membership.user_id=issuer.id
             AND issuer_membership.project_id=identity_invites.project_id
           WHERE issuer.id=identity_invites.created_by AND NOT issuer.disabled
           AND (issuer.instance_admin OR
             (issuer_membership.role='admin' AND NOT issuer_membership.disabled)))`,
      [candidate.id],
    );
    if (!consumed.rowCount)
      throw new DomainError('INVALID_INVITE', 'Convite inválido ou expirado.', 401);
    const invite = (
      await client.query<InviteRow>(
        'SELECT id, project_id, email, role, organization, locale FROM identity_invites WHERE id = $1',
        [candidate.id],
      )
    ).rows[0]!;
    const existing = await client.query<UserRow>(
      'SELECT * FROM users WHERE lower(email)=$1 FOR UPDATE',
      [invite.email],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].disabled ||
        !(await verifyPassword(data.password, existing.rows[0].password_hash))
      )
        throw new DomainError('INVALID_INVITE', 'Convite inválido ou credenciais incorretas.', 401);
      await client.query(
        `INSERT INTO project_memberships(user_id,project_id,role,organization,disabled)
         VALUES($1,$2,$3,$4,false)
         ON DUPLICATE KEY UPDATE
         role=IF(disabled,VALUES(role),role),organization=IF(disabled,VALUES(organization),organization),
         disabled=false,updated_at=NOW(3)`,
        [existing.rows[0].id, invite.project_id, invite.role, invite.organization],
      );
      return beginAuthentication(client, existing.rows[0], false, invite.project_id);
    }
    const userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, project_id, email, display_name, role, password_hash, organization, locale)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        invite.project_id,
        invite.email,
        data.displayName,
        invite.role,
        passwordHash,
        invite.organization,
        invite.locale,
      ],
    );
    const user = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    return beginAuthentication(client, user.rows[0]!);
  });
}
