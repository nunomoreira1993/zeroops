import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  InstanceProject,
  AdministeredProject,
  InstanceUser,
  ProjectAccess,
  User,
} from '../../../../contracts/src/index.js';
import {
  projectInputSchema,
  projectUpdateSchema,
  projectAdminUpdateSchema,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { hashPassword, secret, sha256, tokenHash } from './credentials.js';
import { toUser, type UserRow } from './identity.rows.js';
import { emailSchema, initialAdminSchema, parseInput } from './identity.validation.js';
import {
  activateInvitation,
  createInvitation,
  type ActivateInput,
  type InviteInput,
} from './invitations.js';
import { authenticateSession, issueSession } from './sessions.js';
import { requestPasswordReset, resetPassword } from './password-reset.js';
import { AuthenticationService, beginAuthentication } from './authentication.js';
import {
  IdentityCipher,
  unavailableMail,
  type PrivateIdentityMail,
  lockIdentityAdministration,
  lockIdentityEmail,
  auditIdentity,
  revokeAccess,
  consumeConfirmation,
} from './identity-security.js';
import {
  requireInstanceAdmin,
  requireMember,
  requireProjectAdmin,
  requiresMfa,
} from './membership.js';
import { decodeProjectLogo } from './project-logo.service.js';

const initialProjectId = '00000000-0000-4000-8000-000000000001';
const logoVersionColumn =
  'CASE WHEN p.logo_mime IS NULL THEN NULL ELSE p.logo_version END AS "logoVersion"';
const projectAdminColumns = `
  p.id,p.name,p.archived,p.version,p.site_key AS "siteKey",${logoVersionColumn},
  COALESCE((SELECT o.name FROM identity_organizations o WHERE o.project_id=p.id AND o.code='client'),'Cliente') AS "clientName",
  (SELECT COUNT(*) FROM project_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.project_id=p.id AND NOT m.disabled AND NOT u.disabled) AS "memberCount",
  (SELECT COUNT(*) FROM project_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.project_id=p.id AND m.role='admin' AND NOT m.disabled AND NOT u.disabled) AS "adminCount",
  (SELECT COUNT(*) FROM identity_invites i WHERE i.project_id=p.id AND i.role='admin'
    AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>NOW(3)) AS "pendingAdminCount"`;
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });

/** Casos de uso de autenticação, pertenças e administração de projetos da instância. */
export class IdentityService {
  readonly authentication: AuthenticationService;
  constructor(
    private readonly db: Database,
    cipher = new IdentityCipher(),
    private readonly mail: PrivateIdentityMail = unavailableMail,
  ) {
    this.authentication = new AuthenticationService(db, cipher, mail);
  }

  /** Valida as credenciais e inicia o fluxo de autenticação/MFA sem revelar dados da conta. */
  async login(email: string, password: string) {
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success)
      throw new DomainError('INVALID_CREDENTIALS', 'Credenciais inválidas.', 401);
    return this.authentication.login(parsed.data.email, parsed.data.password);
  }

  /** Valida uma sessão persistida e devolve a identidade ligada ao projeto ativo. */
  authenticate(token: string) {
    return authenticateSession(this.db, token);
  }

  /** Lista os projetos ativos aos quais a identidade autenticada tem acesso. */
  async projects(actor: User): Promise<ProjectAccess[]> {
    if (actor.instanceAdmin) await requireInstanceAdmin(this.db, actor);
    else await requireMember(this.db, actor);
    const result = await this.db.query<{
      id: string;
      name: string;
      archived: boolean;
      role: User['role'];
      organization: 'client' | 'deloitte' | null;
      logoVersion: number | null;
    }>(
      `SELECT p.id,p.name,p.archived,m.role,m.organization,${logoVersionColumn}
       FROM project_memberships m JOIN projects p ON p.id=m.project_id
       JOIN users u ON u.id=m.user_id
       WHERE m.user_id=$1 AND NOT m.disabled AND NOT u.disabled AND NOT p.archived
       ORDER BY p.name,p.id`,
      [actor.id],
    );
    return result.rows;
  }

  /** Lista projetos da instância; operação reservada à administração global. */
  async instanceProjects(actor: User): Promise<InstanceProject[]> {
    await requireInstanceAdmin(this.db, actor);
    const result = await this.db.query<InstanceProject>(
      `SELECT ${projectAdminColumns} FROM projects p ORDER BY p.name,p.id`,
    );
    return result.rows;
  }

  async administeredProject(actor: User, projectId: string): Promise<AdministeredProject> {
    await requireProjectAdmin(this.db, actor, projectId, true);
    const result = await this.db.query<AdministeredProject>(
      `SELECT ${projectAdminColumns} FROM projects p WHERE p.id=$1`,
      [projectId],
    );
    if (!result.rows[0]) throw new DomainError('PROJECT_NOT_FOUND', 'Projeto não encontrado.', 404);
    return result.rows[0];
  }

  /** Lista identidades ativas da instância sem expor credenciais ou fatores MFA. */
  async instanceUsers(actor: User): Promise<InstanceUser[]> {
    await requireInstanceAdmin(this.db, actor);
    const result = await this.db.query<{
      id: string;
      email: string;
      display_name: string;
      locale: 'pt-PT' | 'en';
    }>(
      'SELECT id,email,display_name,locale FROM users WHERE NOT disabled ORDER BY display_name,id',
    );
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      locale: row.locale,
    }));
  }

  /** Cria um projeto e convida explicitamente o seu primeiro administrador numa transação auditada. */
  async createProject(actor: User, raw: unknown) {
    const input = parseInput(projectInputSchema, raw);
    const logoData = input.logo ? decodeProjectLogo(input.logo) : null;
    await this.mail.assertConfigured();
    return this.db.transaction(async (client) => {
      await lockIdentityAdministration(client);
      await requireInstanceAdmin(client, actor, true);
      await consumeConfirmation(
        client,
        actor,
        input.confirmationToken,
        'project-create',
        `${input.initialAdminUserId}:${input.name}`,
      );
      if (
        (await client.query('SELECT id FROM projects WHERE lower(name)=lower($1)', [input.name]))
          .rowCount
      )
        throw new DomainError('PROJECT_NAME_IN_USE', 'Já existe um projeto com este nome.', 409);
      const admin = await client.query<{
        id: string;
        email: string;
        display_name: string;
        locale: 'pt-PT' | 'en';
      }>('SELECT id,email,display_name,locale FROM users WHERE id=$1 AND NOT disabled FOR UPDATE', [
        input.initialAdminUserId,
      ]);
      const user = admin.rows[0];
      if (!user)
        throw new DomainError(
          'PROJECT_ADMIN_UNAVAILABLE',
          'A conta selecionada não está ativa.',
          404,
        );
      const projectId = randomUUID();
      await client.query(
        'INSERT INTO projects(id,name,site_key,logo_mime,logo_data,logo_version) VALUES($1,$2,$3,$4,$5,$6)',
        [
          projectId,
          input.name,
          input.siteKey ?? null,
          input.logo?.mime ?? null,
          logoData,
          input.logo ? 1 : 0,
        ],
      );
      await client.query(
        `INSERT INTO identity_organizations(project_id,code,name)
         VALUES($1,'client','Cliente'),($1,'deloitte','Deloitte')`,
        [projectId],
      );
      const inviteToken = secret();
      const expiresAt = new Date(Date.now() + 48 * 3600000).toISOString();
      await client.query(
        `INSERT INTO identity_invites
         (id,project_id,email,display_name,role,token_hash,created_by,expires_at,organization,locale)
         VALUES($1,$2,$3,$4,'admin',$5,$6,$7,'client',$8)`,
        [
          randomUUID(),
          projectId,
          user.email,
          user.display_name,
          sha256(inviteToken),
          actor.id,
          new Date(expiresAt),
          user.locale,
        ],
      );
      await this.mail.enqueue(client, {
        userId: user.id,
        recipient: user.email,
        locale: user.locale,
        kind: 'invite',
        token: inviteToken,
        tokenHash: sha256(inviteToken),
        expiresAt,
      });
      await auditIdentity(client, actor.id, 'identity.project.created', projectId);
      return {
        id: projectId,
        name: input.name,
        status: 'invitation_pending' as const,
        ...(input.logo ? { logoVersion: 1 } : {}),
      };
    });
  }

  /** Atualiza nome/arquivo do projeto sob versão e confirmação recentes, revogando acessos ao arquivar. */
  async updateProject(actor: User, projectId: string, raw: unknown, explicit = false) {
    const input = explicit
      ? parseInput(projectAdminUpdateSchema, raw)
      : parseInput(projectUpdateSchema, raw);
    return this.db.transaction(async (client) => {
      await lockIdentityAdministration(client);
      const scoped = explicit
        ? await requireProjectAdmin(client, actor, projectId, true, true)
        : actor;
      if (!explicit) await requireInstanceAdmin(client, actor, true);
      const result = await client.query<InstanceProject>(
        `SELECT id,name,archived,version,site_key AS "siteKey",
         COALESCE((SELECT name FROM identity_organizations WHERE project_id=projects.id AND code='client'),'Cliente') AS "clientName"
         FROM projects WHERE id=$1 FOR UPDATE`,
        [projectId],
      );
      const current = result.rows[0];
      if (!current) throw new DomainError('PROJECT_NOT_FOUND', 'Projeto não encontrado.', 404);
      if (current.version !== input.expectedVersion)
        throw new DomainError('STALE_VERSION', 'O projeto mudou. Recarregue a página.');
      await consumeConfirmation(
        client,
        scoped,
        input.confirmationToken,
        'project-update',
        projectId,
      );
      if (
        (
          await client.query('SELECT id FROM projects WHERE lower(name)=lower($1) AND id<>$2', [
            input.name,
            projectId,
          ])
        ).rowCount
      )
        throw new DomainError('PROJECT_NAME_IN_USE', 'Já existe um projeto com este nome.', 409);
      const archived = input.archived ?? Boolean(current.archived);
      if (explicit && current.archived && archived)
        throw new DomainError('PROJECT_ARCHIVED', 'Reative o projeto antes de o alterar.', 409);
      if (explicit && archived !== Boolean(current.archived) && !scoped.instanceAdmin)
        throw new DomainError(
          'FORBIDDEN',
          'O arquivo é reservado à administração da instância.',
          403,
        );
      if (archived && !current.archived) {
        const active = await client.query(
          `SELECT 1 FROM tickets t WHERE t.project_id=$1
           AND (t.status IN ('implementing','awaiting_qa','awaiting_release','deploying')
             OR EXISTS (SELECT 1 FROM execution_runs r WHERE r.ticket_id=t.id AND r.status IN ('pending','running'))
             OR EXISTS (SELECT 1 FROM deployment_runs r WHERE r.ticket_id=t.id AND r.status IN ('pending','running','uncertain')))
           LIMIT 1`,
          [projectId],
        );
        if (active.rowCount)
          throw new DomainError(
            'PROJECT_BUSY',
            'Reconcilie as execuções e releases antes de arquivar o projeto.',
          );
      }
      await client.query(
        `UPDATE projects SET name=$2,archived=$3,
           site_key=CASE WHEN $4 THEN $5 ELSE site_key END,version=version+1 WHERE id=$1`,
        [projectId, input.name, archived, input.siteKey !== undefined, input.siteKey ?? null],
      );
      if ('clientName' in input)
        await client.query(
          `INSERT INTO identity_organizations(project_id,code,name) VALUES($1,'client',$2)
           ON DUPLICATE KEY UPDATE name=VALUES(name)`,
          [projectId, input.clientName],
        );
      if (archived && !current.archived) {
        await client.query(
          `DELETE s FROM identity_sessions s JOIN users u ON u.id=s.user_id
           WHERE s.project_id=$1 AND NOT u.instance_admin`,
          [projectId],
        );
        await client.query('DELETE FROM identity_confirmations WHERE project_id=$1', [projectId]);
        await client.query(
          `UPDATE identity_invites SET revoked_at=NOW(3)
           WHERE project_id=$1 AND used_at IS NULL AND revoked_at IS NULL`,
          [projectId],
        );
      }
      await client.query(
        `INSERT INTO audit_events(id,actor_id,action,details)
         VALUES($1,$2,'identity.project.updated',$3)`,
        [
          randomUUID(),
          actor.id,
          JSON.stringify({
            projectId,
            before: {
              name: current.name,
              archived: current.archived,
              version: current.version,
              ...(explicit ? { clientName: current.clientName, siteKey: current.siteKey } : {}),
            },
            after: {
              name: input.name,
              archived,
              version: current.version + 1,
              ...(explicit
                ? {
                    clientName: 'clientName' in input ? input.clientName : current.clientName,
                    siteKey: input.siteKey !== undefined ? input.siteKey : current.siteKey,
                  }
                : {}),
            },
            reason: input.reason,
          }),
        ],
      );
      return {
        id: projectId,
        name: input.name,
        archived,
        version: current.version + 1,
        ...(explicit
          ? {
              clientName: 'clientName' in input ? input.clientName : current.clientName,
              siteKey: input.siteKey !== undefined ? input.siteKey : current.siteKey,
            }
          : {}),
      };
    });
  }

  /** Troca a sessão para uma pertença ativa e valida MFA e pertença ao projeto de destino. */
  async switchProject(actor: User, currentToken: string, projectId: string) {
    if (!z.uuid().safeParse(projectId).success)
      throw new DomainError('INVALID_INPUT', 'Projeto inválido.', 400);
    return this.db.transaction(async (client) => {
      if (actor.instanceAdmin) await requireInstanceAdmin(client, actor, true);
      else await requireMember(client, actor, true);
      const active = await client.query<{ mfa_verified: boolean }>(
        `SELECT mfa_verified FROM identity_sessions
         WHERE user_id=$1 AND project_id=$2 AND token_hash=$3 AND expires_at>NOW(3) FOR UPDATE`,
        [actor.id, actor.projectId, tokenHash(currentToken)],
      );
      if (!active.rows[0])
        throw new DomainError('UNAUTHENTICATED', 'Sessão inválida ou expirada.', 401);
      const target = await client.query<UserRow>(
        `SELECT u.*,m.project_id,m.role,m.organization,(u.disabled OR m.disabled) AS disabled
         FROM users u JOIN project_memberships m ON m.user_id=u.id
         JOIN projects p ON p.id=m.project_id
         WHERE u.id=$1 AND m.project_id=$2 AND NOT u.disabled AND NOT m.disabled AND NOT p.archived
         LOCK IN SHARE MODE`,
        [actor.id, projectId],
      );
      if (!target.rows[0])
        throw new DomainError('FORBIDDEN', 'Sem acesso ao projeto selecionado.', 403);
      if ((await requiresMfa(client, actor.id)) && !active.rows[0].mfa_verified)
        throw new DomainError('MFA_REQUIRED', 'É necessária autenticação multifator.', 403);
      const session = await issueSession(
        client,
        toUser(target.rows[0]),
        active.rows[0].mfa_verified,
      );
      await client.query('DELETE FROM identity_sessions WHERE user_id=$1 AND token_hash=$2', [
        actor.id,
        tokenHash(currentToken),
      ]);
      await client.query('DELETE FROM identity_confirmations WHERE user_id=$1 AND project_id=$2', [
        actor.id,
        actor.projectId,
      ]);
      return { ...session, status: 'authenticated' as const };
    });
  }

  /** Termina a sessão identificada pelo token sem invalidar as sessões de outras contas. */
  async logout(token: string): Promise<void> {
    await this.db.query('DELETE FROM identity_sessions WHERE token_hash = $1', [tokenHash(token)]);
  }

  /** Cria um convite de projeto através do fluxo de identidade e email configurado. */
  invite(actor: User, input: InviteInput) {
    return createInvitation(this.db, actor, input);
  }

  /** Ativa um convite de uso único e conclui a autenticação inicial da pessoa convidada. */
  activate(input: ActivateInput) {
    return activateInvitation(this.db, input);
  }

  /** Inicia o pedido de reposição sem revelar se o email corresponde a uma conta existente. */
  async requestPasswordReset(email: string): Promise<never> {
    return requestPasswordReset(email);
  }

  /** Consome um token válido de reposição e altera a password com as revogações necessárias. */
  resetPassword(input: { token: string; password: string }): Promise<void> {
    return resetPassword(this.db, input);
  }

  /** Cria a primeira identidade administrativa apenas se as migrações e projeto base existirem. */
  async createInitialAdmin(input: { email: string; displayName: string; password: string }) {
    const data = parseInput(initialAdminSchema, input);
    const passwordHash = await hashPassword(data.password);
    return this.db.transaction(async (client) => {
      await lockIdentityAdministration(client);
      const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [
        initialProjectId,
      ]);
      if (!project.rowCount)
        throw new DomainError('PROJECT_NOT_INITIALIZED', 'Execute as migrações primeiro.', 503);
      const existing = await client.query(
        "SELECT user_id FROM project_memberships WHERE project_id = $1 AND role = 'admin'",
        [initialProjectId],
      );
      if (existing.rowCount) {
        throw new DomainError('ALREADY_INITIALIZED', 'Já existe um administrador inicial.', 409);
      }
      await lockIdentityEmail(client, data.email);
      const account = await client.query('SELECT id FROM users WHERE lower(email) = $1', [
        data.email,
      ]);
      if (account.rowCount)
        throw new DomainError('EMAIL_IN_USE', 'Este email já tem uma conta.', 409);
      const userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, project_id, email, display_name, role, password_hash, instance_admin)
         VALUES ($1, $2, $3, $4, 'admin', $5, true)`,
        [userId, initialProjectId, data.email, data.displayName, passwordHash],
      );
      const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
      return beginAuthentication(client, result.rows[0]!);
    });
  }

  /** Designa explicitamente um administrador de instância e revoga o acesso anterior da conta. */
  async designateInitialInstanceAdmin(email: string) {
    const normalized = parseInput(emailSchema, email);
    return this.db.transaction(async (client) => {
      await lockIdentityAdministration(client);
      if ((await client.query('SELECT id FROM users WHERE instance_admin')).rowCount)
        throw new DomainError(
          'ALREADY_INITIALIZED',
          'A administração da instância já foi designada.',
          409,
        );
      const target = await client.query<UserRow>(
        `SELECT u.* FROM users u JOIN project_memberships m ON m.user_id=u.id
         WHERE lower(u.email)=$1 AND m.project_id=$2 AND m.role='admin'
         AND NOT u.disabled AND NOT m.disabled FOR UPDATE`,
        [normalized, initialProjectId],
      );
      const row = target.rows[0];
      if (!row)
        throw new DomainError('NOT_FOUND', 'Administrador inicial ativo não encontrado.', 404);
      await client.query('UPDATE users SET instance_admin=true WHERE id=$1', [row.id]);
      await revokeAccess(client, row.id);
      await auditIdentity(client, null, 'identity.instance.bootstrap', row.id);
      return { ok: true };
    });
  }
}
