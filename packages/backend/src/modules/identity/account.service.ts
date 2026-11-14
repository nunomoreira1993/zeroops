import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ManagedInvitation, ManagedUser, User } from '../../../../contracts/src/index.js';
import { roleSchema } from '../../../../contracts/src/index.js';
import type { Database, PoolClient } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { hashPassword, verifyPassword, secret, sha256, tokenHash } from './credentials.js';
import { toUser, type UserRow } from './identity.rows.js';
import {
  requireMember,
  requireInstanceAdmin,
  membershipColumns,
  requiresMfa,
  requireProjectAdmin,
  isProjectAdminContext,
} from './membership.js';
import { emailSchema, passwordSchema, parseInput } from './identity.validation.js';
import { beginAuthentication } from './authentication.js';
import { AccountMfaService } from './account-mfa.service.js';
import { AccountInvitationService } from './account-invitations.service.js';
import {
  IdentityCipher,
  type PrivateIdentityMail,
  verifySecondFactor,
  revokeAccess,
  revokeIdentityTokens,
  auditIdentity,
  consumeConfirmation,
  countIdentityRequest,
  lockIdentityAdministration,
  lockIdentityEmail,
  revokeProjectAccess,
} from './identity-security.js';

const localeSchema = z.enum(['pt-PT', 'en']);
const organizationSchema = z.enum(['client', 'deloitte']);
const profileSchema = z.strictObject({
  displayName: z.string().trim().min(2).max(100),
  locale: localeSchema,
});
const updateSchema = profileSchema.extend({
  role: roleSchema,
  organization: organizationSchema,
});
/** Ações sobre outras contas que continuam a exigir password/MFA recentes. */
const reauthActions = new Set(['sessions', 'mfa-reset']);
function managed(row: UserRow): ManagedUser {
  return {
    ...toUser(row),
    disabled: Boolean(row.disabled),
    lockedUntil: row.locked_until?.toISOString() ?? null,
    mfaEnabled: !!row.mfa_secret,
  };
}

/** Casos de uso de perfil, administração de contas, convites, confirmações e MFA. */
export class AccountService {
  private readonly mfa: AccountMfaService;
  private readonly invitationFlow: AccountInvitationService;

  constructor(
    private readonly db: Database,
    private readonly cipher: IdentityCipher,
    private readonly mail: PrivateIdentityMail,
  ) {
    this.mfa = new AccountMfaService(
      db,
      cipher,
      (client, actor) => this.selfRow(client, actor),
      (client, actor, token, action, target) =>
        this.confirmation(client, actor, token, action, target),
    );
    this.invitationFlow = new AccountInvitationService(db, mail, {
      limit: (key, max) => this.limit(key, max),
      row: (client, id, projectId) => this.row(client, id, projectId),
      admin: (client, actor) => this.admin(client, actor),
    });
  }
  private async limit(key: string, max = 5) {
    if ((await countIdentityRequest(this.db, sha256(`account:${key}`))) > max)
      throw new DomainError('rate_limit', 'Demasiadas tentativas. Tente mais tarde.', 429);
  }
  private async row(client: PoolClient, id: string, project: string) {
    const result = await client.query<UserRow>(
      `SELECT ${membershipColumns} FROM users u JOIN project_memberships m ON m.user_id=u.id
       WHERE u.id=$1 AND m.project_id=$2 FOR UPDATE`,
      [id, project],
    );
    if (!result.rows[0]) throw new DomainError('NOT_FOUND', 'Conta indisponível.', 404);
    return result.rows[0];
  }
  private async selfRow(client: PoolClient, actor: User) {
    const result = await client.query<UserRow>(
      'SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
      [actor.id],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('UNAUTHENTICATED', 'Conta indisponível.', 401);
    const context = await client.query<UserRow>(
      `SELECT ${membershipColumns} FROM users u JOIN project_memberships m ON m.user_id=u.id
       JOIN projects p ON p.id=m.project_id
       WHERE u.id=$1 AND m.project_id=$2 AND NOT m.disabled AND NOT p.archived`,
      [actor.id, actor.projectId],
    );
    if (context.rows[0]) return context.rows[0];
    if (row.instance_admin) return { ...row, project_id: actor.projectId };
    throw new DomainError('FORBIDDEN', 'Sem acesso a este projeto.', 403);
  }
  private async admin(client: PoolClient, actor: User) {
    await lockIdentityAdministration(client);
    const current = await requireMember(client, actor);
    if (current.role !== 'admin' && !current.instanceAdmin)
      throw new DomainError('FORBIDDEN', 'Ação reservada a administradores.', 403);
    return current;
  }
  private async confirmation(
    client: PoolClient,
    actor: User,
    token: string,
    action: string,
    target: string,
  ) {
    await consumeConfirmation(client, actor, token, action, target);
  }

  /** Revalida password/MFA e emite uma confirmação curta vinculada à ação, alvo, sessão e projeto. */
  async reauthenticate(actor: User, sessionToken: string, raw: unknown, targetProjectId?: string) {
    const input = parseInput(
      z.strictObject({
        password: passwordSchema,
        code: z.string().max(128).optional(),
        action: z.string().min(1).max(40),
        target: z.string().min(1).max(100),
      }),
      raw,
    );
    await this.limit(`reauth:${actor.id}`, 10);
    const result = await this.db.transaction(async (client) => {
      if (targetProjectId) await requireProjectAdmin(client, actor, targetProjectId, true);
      const row = await this.selfRow(client, actor);
      const session = await client.query(
        'SELECT 1 FROM identity_sessions WHERE user_id=$1 AND token_hash=$2 AND project_id=$3 AND expires_at>NOW(3)',
        [actor.id, tokenHash(sessionToken), actor.projectId],
      );
      const valid = await verifyPassword(input.password, row.password_hash);
      if (
        !session.rowCount ||
        row.disabled ||
        !valid ||
        ((await requiresMfa(client, actor.id)) && !row.mfa_secret) ||
        (row.mfa_secret && !(await verifySecondFactor(client, row, input.code ?? '', this.cipher)))
      )
        return null;
      const token = secret();
      // The original session remains unchanged; only the authorized confirmation target is scoped.
      await client.query(
        'INSERT INTO identity_confirmations(token_hash,user_id,session_hash,action,target,project_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          sha256(token),
          row.id,
          tokenHash(sessionToken),
          input.action,
          input.target,
          targetProjectId ?? actor.projectId,
        ],
      );
      return { confirmationToken: token };
    });
    if (!result)
      throw new DomainError('INVALID_CREDENTIALS', 'Não foi possível confirmar a identidade.', 401);
    return result;
  }

  /** Devolve os dados da conta autenticada e da pertença ativa ao projeto selecionado. */
  async account(actor: User) {
    return this.db.transaction(async (client) => managed(await this.selfRow(client, actor)));
  }

  /** Lista membros do projeto; apenas administradores do projeto ou da instância podem consultar. */
  async users(actor: User) {
    const current = await requireMember(this.db, actor);
    if (current.role !== 'admin' && !current.instanceAdmin)
      throw new DomainError('FORBIDDEN', 'Ação reservada a administradores.', 403);
    const result = await this.db.query<UserRow>(
      `SELECT ${membershipColumns} FROM users u JOIN project_memberships m ON m.user_id=u.id
       WHERE m.project_id=$1 ORDER BY u.display_name,u.id`,
      [actor.projectId],
    );
    return result.rows.map(managed);
  }

  /** Atualiza nome e idioma da própria identidade global e regista a alteração na auditoria. */
  async profile(actor: User, raw: unknown) {
    const input = parseInput(profileSchema, raw);
    return this.db.transaction(async (client) => {
      await this.selfRow(client, actor);
      await client.query('UPDATE users SET display_name=$2,locale=$3 WHERE id=$1', [
        actor.id,
        input.displayName,
        input.locale,
      ]);
      await auditIdentity(client, actor.id, 'identity.profile.updated', actor.id);
      return { ok: true };
    });
  }

  /** Altera a password após confirmação recente, limpa bloqueios e revoga sessões e confirmações. */
  async password(actor: User, raw: unknown) {
    const input = parseInput(
      z.strictObject({ password: passwordSchema, confirmationToken: z.string() }),
      raw,
    );
    const hash = await hashPassword(input.password);
    return this.db.transaction(async (client) => {
      await this.selfRow(client, actor);
      await this.confirmation(client, actor, input.confirmationToken, 'password', actor.id);
      await client.query(
        'UPDATE users SET password_hash=$2,password_failures=0,locked_until=NULL WHERE id=$1',
        [actor.id, hash],
      );
      await revokeAccess(client, actor.id);
      await revokeIdentityTokens(client, actor.id);
      await auditIdentity(client, actor.id, 'identity.password.changed', actor.id);
      return { ok: true };
    });
  }

  /**
   * Primeiro acesso com a palavra-passe temporária do convite: define a definitiva sem
   * reautenticação (a sessão acabou de ser criada) e liberta o resto da aplicação.
   */
  async initialPassword(actor: User, raw: unknown) {
    const input = parseInput(z.strictObject({ password: passwordSchema }), raw);
    const hash = await hashPassword(input.password);
    return this.db.transaction(async (client) => {
      const row = await this.selfRow(client, actor);
      if (!row.password_change_required)
        throw new DomainError('PASSWORD_ALREADY_SET', 'A palavra-passe já foi definida.', 409);
      if (await verifyPassword(input.password, row.password_hash))
        throw new DomainError(
          'PASSWORD_REUSED',
          'Escolha uma palavra-passe diferente da temporária.',
          400,
        );
      await client.query(
        'UPDATE users SET password_hash=$2,password_change_required=false,password_failures=0,locked_until=NULL WHERE id=$1',
        [actor.id, hash],
      );
      await auditIdentity(client, actor.id, 'identity.password.initial', actor.id);
      return { ok: true };
    });
  }

  /**
   * Atualiza o papel/organização da pertença; alterações globais exigem administrador da instância.
   * Usa a sessão de administrador já verificada com MFA, sem reautenticação por ação.
   */
  async update(actor: User, id: string, raw: unknown) {
    const scoped = isProjectAdminContext(actor);
    const input = scoped
      ? parseInput(
          z.strictObject({
            role: roleSchema,
            organization: organizationSchema,
            displayName: profileSchema.shape.displayName.optional(),
            locale: localeSchema.optional(),
          }),
          raw,
        )
      : parseInput(updateSchema, raw);
    return this.db.transaction(async (client) => {
      const current = await this.admin(client, actor);
      const row = await this.row(client, id, actor.projectId);
      await this.lastAdmin(client, row, input.role !== 'admin');
      if (
        !scoped &&
        !current.instanceAdmin &&
        (row.display_name !== input.displayName || row.locale !== input.locale)
      )
        throw new DomainError(
          'FORBIDDEN',
          'O perfil global é gerido pela pessoa ou pela administração da instância.',
          403,
        );
      await client.query(
        'UPDATE project_memberships SET role=$3,organization=$4,updated_at=NOW(3) WHERE user_id=$1 AND project_id=$2',
        [id, actor.projectId, input.role, input.organization],
      );
      if (!scoped && current.instanceAdmin)
        await client.query('UPDATE users SET display_name=$2,locale=$3 WHERE id=$1', [
          id,
          input.displayName,
          input.locale,
        ]);
      if (row.role !== input.role) {
        await revokeProjectAccess(client, id, actor.projectId);
      }
      await auditIdentity(client, actor.id, 'identity.user.updated', id);
      return { ok: true };
    });
  }
  private async lastAdmin(client: PoolClient, row: UserRow, removing: boolean) {
    if (row.role === 'admin' && !row.disabled && removing) {
      const count = await client.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM project_memberships m JOIN users u ON u.id=m.user_id
         WHERE m.project_id=$1 AND m.role='admin' AND NOT m.disabled AND NOT u.disabled`,
        [row.project_id],
      );
      if (Number(count.rows[0]!.count) <= 1)
        throw new DomainError(
          'LAST_ADMIN',
          'Não é possível remover o último administrador ativo.',
          409,
        );
    }
  }

  /**
   * Executa uma ação administrativa sobre a pertença/identidade, com auditoria. Só revogar
   * sessões e repor MFA exigem reautenticação; as restantes usam a sessão de administrador.
   */
  async action(actor: User, id: string, raw: unknown) {
    const input = parseInput(
      z.strictObject({
        action: z.enum(['disable', 'enable', 'unlock', 'sessions', 'mfa-reset']),
        reason: z.string().trim().max(1000).optional(),
        confirmationToken: z.string().optional(),
      }),
      raw,
    );
    if (isProjectAdminContext(actor) && !['disable', 'enable'].includes(input.action))
      throw new DomainError('FORBIDDEN', 'A ação altera a identidade global.', 403);
    return this.db.transaction(async (client) => {
      await this.admin(client, actor);
      const row = await this.row(client, id, actor.projectId);
      if (reauthActions.has(input.action))
        await this.confirmation(client, actor, input.confirmationToken ?? '', input.action, id);
      if (['unlock', 'sessions', 'mfa-reset'].includes(input.action))
        await requireInstanceAdmin(client, actor);
      if (input.action === 'disable') await this.lastAdmin(client, row, true);
      if (input.action === 'mfa-reset') {
        if (id === actor.id || !input.reason || input.reason.length < 10 || row.disabled)
          throw new DomainError(
            'INVALID_RESET',
            'Verifique a identidade de outra conta e registe o motivo.',
            400,
          );
        await this.mail.assertConfigured();
        await revokeAccess(client, id);
        await revokeIdentityTokens(client, id);
        // Keep old factor until reset link + password are verified; suspend MFA authentication meanwhile.
        await client.query(
          'UPDATE identity_mfa_resets SET revoked_at=NOW(3) WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL',
          [id],
        );
        const token = secret();
        const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
        await client.query(
          'INSERT INTO identity_mfa_resets(token_hash,user_id,requested_by,expires_at) VALUES($1,$2,$3,$4)',
          [sha256(token), id, actor.id, new Date(expiresAt)],
        );
        await this.mail.enqueue(client, {
          userId: id,
          recipient: row.email,
          locale: row.locale,
          kind: 'mfa-reset',
          token,
          tokenHash: sha256(token),
          expiresAt,
        });
      } else if (input.action === 'disable' || input.action === 'enable') {
        await client.query(
          'UPDATE project_memberships SET disabled=$2,updated_at=NOW(3) WHERE user_id=$1 AND project_id=$3',
          [id, input.action === 'disable', actor.projectId],
        );
        await revokeProjectAccess(client, id, actor.projectId);
      } else if (input.action === 'unlock') {
        await client.query('UPDATE users SET password_failures=0,locked_until=NULL WHERE id=$1', [
          id,
        ]);
      } else await revokeAccess(client, id);
      await auditIdentity(client, actor.id, `identity.user.${input.action}`, id, input.reason);
      return { ok: true };
    });
  }

  /** Revoga todas as sessões da própria identidade após confirmação recente. */
  async revokeSessions(actor: User, confirmationToken: string) {
    return this.db.transaction(async (client) => {
      await this.selfRow(client, actor);
      await this.confirmation(client, actor, confirmationToken, 'sessions', actor.id);
      await revokeAccess(client, actor.id);
      return { ok: true };
    });
  }

  /** Enfileira reposição de password sem revelar se o endereço pertence a uma conta ativa. */
  async requestReset(raw: unknown) {
    const input = parseInput(
      z.strictObject({ email: emailSchema, locale: localeSchema.default('pt-PT') }),
      raw,
    );
    await this.mail.assertConfigured();
    await this.limit(`reset:${input.email}`);
    return this.db.transaction(async (client) => {
      const result = await client.query<UserRow>(
        'SELECT * FROM users WHERE lower(email)=$1 AND NOT disabled FOR UPDATE',
        [input.email],
      );
      const row = result.rows[0];
      if (row) {
        await client.query(
          'UPDATE identity_password_resets SET revoked_at=NOW(3) WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL',
          [row.id],
        );
        const token = secret();
        const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
        await client.query(
          'INSERT INTO identity_password_resets(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)',
          [randomUUID(), row.id, sha256(token), new Date(expiresAt)],
        );
        await this.mail.enqueue(client, {
          userId: row.id,
          recipient: row.email,
          locale: input.locale,
          kind: 'reset',
          token,
          tokenHash: sha256(token),
          expiresAt,
        });
      }
      return { ok: true };
    });
  }

  /** Inicia uma alteração global de email; o novo endereço só passa a ativo após confirmação. */
  async email(actor: User, id: string, raw: unknown) {
    const input = parseInput(
      z.strictObject({ email: emailSchema, confirmationToken: z.string() }),
      raw,
    );
    await this.mail.assertConfigured();
    await this.limit(`email:${actor.id}:${id}`);
    return this.db.transaction(async (client) => {
      await this.admin(client, actor);
      await requireInstanceAdmin(client, actor);
      const row = await this.row(client, id, actor.projectId);
      await this.confirmation(client, actor, input.confirmationToken, 'email', id);
      await lockIdentityEmail(client, input.email);
      const existing = await client.query('SELECT id FROM users WHERE lower(email)=$1', [
        input.email,
      ]);
      if (existing.rowCount)
        throw new DomainError('EMAIL_IN_USE', 'Este email já tem uma conta.', 409);
      await client.query(
        'UPDATE identity_email_changes SET revoked_at=NOW(3) WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL',
        [id],
      );
      const token = secret(),
        expiresAt = new Date(Date.now() + 30 * 60000).toISOString();
      await client.query(
        'INSERT INTO identity_email_changes(token_hash,user_id,requested_by,email,expires_at) VALUES($1,$2,$3,$4,$5)',
        [sha256(token), id, actor.id, input.email, new Date(expiresAt)],
      );
      await this.mail.enqueue(client, {
        userId: id,
        recipient: input.email,
        locale: row.locale,
        kind: 'email-change',
        token,
        tokenHash: sha256(token),
        expiresAt,
      });
      // Inform previous address without sending a confirmation token to it.
      await this.mail.enqueue(client, {
        userId: id,
        recipient: row.email,
        locale: row.locale,
        kind: 'email-change',
      });
      await auditIdentity(client, actor.id, 'identity.email.requested', id);
      return { ok: true };
    });
  }

  /** Confirma a alteração de email por token válido e revoga as sessões da conta alterada. */
  async confirmEmail(token: string) {
    return this.db.transaction(async (client) => {
      await lockIdentityAdministration(client);
      const lookup = await client.query<{ user_id: string }>(
        'SELECT user_id FROM identity_email_changes WHERE token_hash=$1',
        [tokenHash(token)],
      );
      if (!lookup.rows[0])
        throw new DomainError('INVALID_TOKEN', 'Ligação inválida ou expirada.', 401);
      const row = await client.query<UserRow>(
        'SELECT * FROM users WHERE id=$1 AND NOT disabled FOR UPDATE',
        [lookup.rows[0].user_id],
      );
      const change = await client.query<{ email: string; requested_by: string }>(
        'SELECT email,requested_by FROM identity_email_changes WHERE token_hash=$1 AND expires_at>NOW(3) AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE',
        [tokenHash(token)],
      );
      const target = row.rows[0],
        input = change.rows[0];
      if (!target || !input)
        throw new DomainError('INVALID_TOKEN', 'Ligação inválida ou expirada.', 401);
      const issuer = await client.query(
        'SELECT id FROM users WHERE id=$1 AND instance_admin AND NOT disabled',
        [input.requested_by],
      );
      if (!issuer.rowCount)
        throw new DomainError('INVALID_TOKEN', 'Ligação inválida ou expirada.', 401);
      await lockIdentityEmail(client, input.email);
      if (
        (await client.query('SELECT id FROM users WHERE lower(email)=$1', [input.email])).rowCount
      )
        throw new DomainError('EMAIL_IN_USE', 'Este email já tem uma conta.', 409);
      await client.query('UPDATE users SET email=$2 WHERE id=$1', [target.id, input.email]);
      await client.query('UPDATE identity_email_changes SET used_at=NOW(3) WHERE token_hash=$1', [
        tokenHash(token),
      ]);
      await revokeAccess(client, target.id);
      await revokeIdentityTokens(client, target.id);
      await auditIdentity(client, target.id, 'identity.email.confirmed', target.id);
      return { ok: true };
    });
  }

  /** Valida o link e a password de reposição de MFA, limpa fatores antigos e exige nova inscrição. */
  async confirmMfaReset(raw: unknown) {
    const input = parseInput(
      z.strictObject({ token: z.string(), email: emailSchema, password: passwordSchema }),
      raw,
    );
    await this.limit(`mfa-reset:${input.email}`);
    return this.db.transaction(async (client) => {
      await lockIdentityAdministration(client);
      const row = await client.query<UserRow>(
        'SELECT * FROM users WHERE lower(email)=$1 AND NOT disabled FOR UPDATE',
        [input.email],
      );
      const user = row.rows[0];
      const valid = await verifyPassword(input.password, user?.password_hash ?? null);
      if (!user || !valid)
        throw new DomainError('INVALID_TOKEN', 'Ligação ou credenciais inválidas.', 401);
      const reset = await client.query(
        `UPDATE identity_mfa_resets r SET used_at=NOW(3) WHERE token_hash=$1 AND user_id=$2 AND expires_at>NOW(3) AND used_at IS NULL AND revoked_at IS NULL
        AND EXISTS(SELECT 1 FROM users a WHERE a.id=r.requested_by AND a.instance_admin AND NOT a.disabled)`,
        [tokenHash(input.token), user.id],
      );
      if (!reset.rowCount)
        throw new DomainError('INVALID_TOKEN', 'Ligação ou credenciais inválidas.', 401);
      await client.query(
        'UPDATE users SET mfa_secret=NULL,mfa_last_step=NULL,mfa_enrollment_required=true,mfa_opt_out=false WHERE id=$1',
        [user.id],
      );
      await client.query('DELETE FROM identity_recovery_codes WHERE user_id=$1', [user.id]);
      await revokeAccess(client, user.id);
      await revokeIdentityTokens(client, user.id);
      // Even an optional-MFA client must enroll again after administrative reset.
      return beginAuthentication(client, { ...user, mfa_secret: null }, true);
    });
  }

  /** Lista convites do projeto e o estado de entrega sem expor os tokens de ativação. */
  async invitations(actor: User): Promise<ManagedInvitation[]> {
    return this.invitationFlow.list(actor);
  }

  /** Consulta o histórico de entregas de identidade para um membro, reservado à administração da instância. */
  async deliveries(actor: User, userId: string) {
    return this.invitationFlow.deliveries(actor, userId);
  }

  /** Repete uma entrega elegível após autorização recente; resultados incertos não são repetidos. */
  async retryDelivery(actor: User, userId: string, deliveryId: string) {
    return this.invitationFlow.retryDelivery(actor, userId, deliveryId);
  }

  /** Cria um convite de uso único, com papel e organização explícitos, e coloca o email na fila privada. */
  async invite(actor: User, raw: unknown) {
    return this.invitationFlow.invite(actor, raw);
  }

  /** Revoga um convite pendente ou cria um novo convite ao reenviar, preservando a auditoria. */
  async invitationAction(actor: User, id: string, raw: unknown) {
    return this.invitationFlow.invitationAction(actor, id, raw);
  }

  /** Inicia inscrição TOTP após confirmação recente e devolve o URI/chave para apresentação única. */
  async mfaStart(actor: User, confirmationToken: string) {
    return this.mfa.start(actor, confirmationToken);
  }

  /** Confirma o primeiro código TOTP, ativa MFA, emite códigos de recuperação e revoga sessões antigas. */
  async mfaConfirm(actor: User, code: string) {
    return this.mfa.confirm(actor, code);
  }

  /** Desativa MFA apenas quando a política permite, ou emite novos códigos de recuperação. */
  async mfaManage(actor: User, confirmationToken: string, action: 'mfa-disable' | 'mfa-codes') {
    return this.mfa.manage(actor, confirmationToken, action);
  }
}
