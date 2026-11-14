import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ManagedInvitation, User } from '../../../../contracts/src/index.js';
import { roleSchema } from '../../../../contracts/src/index.js';
import type { Database, PoolClient } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { hashPassword, secret, sha256, temporaryPassword } from './credentials.js';
import type { UserRow } from './identity.rows.js';
import { auditIdentity, lockIdentityEmail, type PrivateIdentityMail } from './identity-security.js';
import { emailSchema, parseInput } from './identity.validation.js';
import { requireInstanceAdmin, requireMember } from './membership.js';

const invitationSchema = z.strictObject({
  email: emailSchema,
  displayName: z.string().trim().min(2).max(100),
  role: roleSchema,
  organization: z.enum(['client', 'deloitte']),
  locale: z.enum(['pt-PT', 'en']),
});

interface AccountInvitationGuards {
  limit(key: string, max?: number): Promise<void>;
  row(client: PoolClient, id: string, projectId: string): Promise<UserRow>;
  admin(client: PoolClient, actor: User): Promise<User>;
}

type InviteData = Pick<
  z.infer<typeof invitationSchema>,
  'email' | 'displayName' | 'role' | 'organization' | 'locale'
>;

/** Casos de uso de convites e histórico/repetição de emails de identidade. */
export class AccountInvitationService {
  constructor(
    private readonly db: Database,
    private readonly mail: PrivateIdentityMail,
    private readonly guards: AccountInvitationGuards,
  ) {}

  /** Lista convites do projeto e estado de entrega sem expor tokens de ativação. */
  async list(actor: User): Promise<ManagedInvitation[]> {
    const member = await requireMember(this.db, actor);
    if (member.role !== 'admin' && !member.instanceAdmin)
      throw new DomainError('FORBIDDEN', 'Ação reservada a administradores.', 403);
    const result = await this.db.query<{
      id: string;
      email: string;
      display_name: string;
      role: User['role'];
      organization: 'client' | 'deloitte';
      locale: 'pt-PT' | 'en';
      expires_at: Date;
      token_hash: string;
      used_at: Date | null;
      revoked_at: Date | null;
    }>('SELECT * FROM identity_invites WHERE project_id=$1 ORDER BY created_at DESC', [
      actor.projectId,
    ]);
    return Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        organization: row.organization,
        locale: row.locale,
        expiresAt: row.expires_at.toISOString(),
        usedAt: row.used_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        deliveryState:
          (await this.mail.listForToken?.('invite', row.token_hash))?.[0]?.state ?? null,
      })),
    );
  }

  /** Consulta entregas de identidade para um membro, reservado à administração da instância. */
  async deliveries(actor: User, userId: string) {
    await requireInstanceAdmin(this.db, actor);
    if (
      !(
        await this.db.query(
          'SELECT user_id FROM project_memberships WHERE user_id=$1 AND project_id=$2',
          [userId, actor.projectId],
        )
      ).rowCount
    )
      throw new DomainError('NOT_FOUND', 'Conta indisponível.', 404);
    if (!this.mail.listForUser)
      throw new DomainError('MAIL_TRANSPORT_NOT_CONFIGURED', 'Serviço de email indisponível.', 503);
    return this.mail.listForUser(userId);
  }

  /** Repete entrega elegível com a sessão de administrador; resultados incertos não são repetidos. */
  async retryDelivery(actor: User, userId: string, deliveryId: string) {
    if (!this.mail.retry)
      throw new DomainError('MAIL_TRANSPORT_NOT_CONFIGURED', 'Serviço de email indisponível.', 503);
    const retry = this.mail.retry.bind(this.mail);
    return this.db.transaction(async (client) => {
      await this.guards.admin(client, actor);
      await requireInstanceAdmin(client, actor);
      await this.guards.row(client, userId, actor.projectId);
      if (!(await retry(client, deliveryId, userId)))
        throw new DomainError(
          'DELIVERY_NOT_RETRYABLE',
          'Entrega indisponível para repetição; confirme o estado ou crie um novo pedido.',
          409,
        );
      await auditIdentity(client, actor.id, 'identity.mail.retry', userId);
      return { ok: true };
    });
  }

  /**
   * Cria convite de uso único com a sessão de administrador (já verificada com MFA) e enfileira o
   * email privado; para contas novas o email leva uma palavra-passe temporária.
   */
  async invite(actor: User, raw: unknown) {
    const input = parseInput(invitationSchema, raw);
    await this.mail.assertConfigured();
    await this.guards.limit(`invite:${actor.id}`);
    return this.db.transaction(async (client) => {
      await this.guards.admin(client, actor);
      await this.queueInvite(client, actor, input);
      return { ok: true };
    });
  }

  /** Revoga convite pendente ou cria outro convite, preservando o histórico de auditoria. */
  async invitationAction(actor: User, id: string, raw: unknown) {
    const input = parseInput(z.strictObject({ action: z.enum(['resend', 'revoke']) }), raw);
    if (input.action === 'resend') await this.mail.assertConfigured();
    if (input.action === 'resend') await this.guards.limit(`resend:${actor.id}:${id}`);
    return this.db.transaction(async (client) => {
      await this.guards.admin(client, actor);
      const result = await client.query<{
        email: string;
        display_name: string;
        role: User['role'];
        organization: 'client' | 'deloitte';
        locale: 'pt-PT' | 'en';
      }>(
        'SELECT * FROM identity_invites WHERE id=$1 AND project_id=$2 AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE',
        [id, actor.projectId],
      );
      const invitation = result.rows[0];
      if (!invitation) throw new DomainError('NOT_FOUND', 'Convite indisponível.', 404);
      await client.query('UPDATE identity_invites SET revoked_at=NOW(3) WHERE id=$1', [id]);
      if (input.action === 'resend') {
        if (!invitation.organization)
          throw new DomainError(
            'ORGANIZATION_REQUIRED',
            'Crie um novo convite com organização explícita.',
            409,
          );
        await this.queueInvite(client, actor, {
          email: invitation.email,
          displayName: invitation.display_name,
          role: invitation.role,
          organization: invitation.organization,
          locale: invitation.locale,
        });
      }
      await auditIdentity(client, actor.id, `identity.invite.${input.action}`, id);
      return { ok: true };
    });
  }

  private async queueInvite(client: PoolClient, actor: User, input: InviteData) {
    const { email, displayName, role, organization, locale } = input;
    await lockIdentityEmail(client, email);
    if (
      (
        await client.query(
          `SELECT m.user_id FROM users u JOIN project_memberships m ON m.user_id=u.id
           WHERE lower(u.email)=$1 AND m.project_id=$2 AND NOT m.disabled`,
          [email, actor.projectId],
        )
      ).rowCount
    )
      throw new DomainError('EMAIL_IN_USE', 'Este email já tem acesso a este projeto.', 409);
    await client.query(
      'UPDATE identity_invites SET revoked_at=NOW(3) WHERE project_id=$1 AND email=$2 AND used_at IS NULL AND revoked_at IS NULL',
      [actor.projectId, email],
    );
    const token = secret();
    const expiresAt = new Date(Date.now() + 48 * 3600000).toISOString();
    // Contas existentes entram com a palavra-passe atual; só contas novas recebem uma temporária.
    const existing = await client.query('SELECT id FROM users WHERE lower(email)=$1', [email]);
    const password = existing.rowCount ? undefined : temporaryPassword();
    await client.query(
      'INSERT INTO identity_invites(id,project_id,email,display_name,role,token_hash,created_by,expires_at,organization,locale,temp_password_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        randomUUID(),
        actor.projectId,
        email,
        displayName,
        role,
        sha256(token),
        actor.id,
        new Date(expiresAt),
        organization,
        locale,
        password ? await hashPassword(password) : null,
      ],
    );
    await this.mail.enqueue(client, {
      recipient: email,
      locale,
      kind: 'invite',
      token,
      tokenHash: sha256(token),
      expiresAt,
      ...(password ? { temporaryPassword: password } : {}),
    });
    await auditIdentity(client, actor.id, 'identity.invite.created', actor.projectId);
  }
}
