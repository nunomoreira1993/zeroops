import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import type { User } from '../../../../contracts/src/index.js';
import { AccountService } from './account.service.js';
import { IdentityService } from './identity.service.js';
import { ProjectLogoService } from './project-logo.service.js';
import { requireProjectAdmin } from './membership.js';
import { hashPassword, secret, sha256 } from './credentials.js';
import { IdentityCipher, type PrivateIdentityMail } from './identity-security.js';
import { IntegrationSettingsService } from '../integrations/integration-settings.service.js';
import { AgentInstructionsService } from '../agents/agent-instructions.service.js';
import { createApplication } from '../../../../../apps/api/src/application.js';
import { acceptPendingInvites } from './invitations.js';
import type { UserRow } from './identity.rows.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
const cipher = new IdentityCipher(randomBytes(32).toString('base64'));
const password = 'Project-admin-password-123!';
let hash: string;
let accounts: AccountService;
let identity: IdentityService;
let logos: ProjectLogoService;
const mail: PrivateIdentityMail = { assertConfigured() {}, async enqueue() {} };
const logo = {
  mime: 'image/png' as const,
  data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
};

beforeAll(async () => {
  fixture = await startTestDatabase();
  hash = await hashPassword(password);
  accounts = new AccountService(fixture.db, cipher, mail);
  identity = new IdentityService(fixture.db, cipher, mail);
  logos = new ProjectLogoService(fixture.db);
});
afterAll(async () => fixture?.stop());

async function user(
  projectId: string = randomUUID(),
  instanceAdmin = false,
  role: User['role'] = 'admin',
): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects(id,name) VALUES($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, `Project ${projectId}`],
  );
  await fixture.db.query(
    `INSERT IGNORE INTO identity_organizations(project_id,code,name)
    VALUES($1,'client','Cliente'),($1,'deloitte','Deloitte')`,
    [projectId],
  );
  const actor: User = {
    id: randomUUID(),
    projectId,
    email: `${randomUUID()}@example.test`,
    displayName: 'Test identity',
    role,
    organization: 'client',
    locale: 'pt-PT',
    instanceAdmin,
  };
  await fixture.db.query(
    `INSERT INTO users(id,project_id,email,display_name,role,organization,password_hash,instance_admin,mfa_opt_out)
    VALUES($1,$2,$3,$4,$5,'client',$6,$7,true)`,
    [actor.id, projectId, actor.email, actor.displayName, role, hash, instanceAdmin],
  );
  return actor;
}

async function confirmation(actor: User, projectId: string, action: string, target: string) {
  const session = await identity.login(actor.email, password);
  return accounts.reauthenticate(actor, session.token, { password, action, target }, projectId);
}

describe('Explicit project administration', () => {
  it('rechecks DB privileges, denies foreign projects and forged frontend flags', async () => {
    const actor = await user(),
      other = await user();
    await expect(requireProjectAdmin(fixture.db, actor, other.projectId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      requireProjectAdmin(fixture.db, { ...actor, instanceAdmin: true }, other.projectId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const session = await identity.login(actor.email, password);
    await expect(
      accounts.reauthenticate(
        actor,
        session.token,
        {
          password,
          action: 'project-update',
          target: other.projectId,
        },
        other.projectId,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await fixture.db.query(
      'UPDATE project_memberships SET disabled=true WHERE user_id=$1 AND project_id=$2',
      [actor.id, actor.projectId],
    );
    await expect(requireProjectAdmin(fixture.db, actor, actor.projectId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('allows instance admins without membership, scopes lists/mutations and never edits global identities', async () => {
    const root = await user(undefined, true),
      member = await user(),
      outsider = await user();
    const actor = await requireProjectAdmin(fixture.db, root, member.projectId);
    expect((await accounts.users(actor)).map((item) => item.id)).toEqual([member.id]);
    await accounts.update(actor, member.id, {
      role: 'admin',
      organization: 'deloitte',
      displayName: 'Ignored global edit',
      locale: 'en',
    });
    const stored = (
      await fixture.db.query('SELECT display_name,locale,instance_admin FROM users WHERE id=$1', [
        member.id,
      ])
    ).rows[0]!;
    expect(stored).toMatchObject({
      display_name: member.displayName,
      locale: 'pt-PT',
      instance_admin: false,
    });
    await expect(
      accounts.update(actor, outsider.id, { role: 'admin', organization: 'client' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      accounts.update(actor, member.id, {
        role: 'admin',
        organization: 'client',
        instanceAdmin: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(accounts.action(actor, member.id, { action: 'unlock' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      (
        await fixture.db.query(
          'SELECT * FROM project_memberships WHERE user_id=$1 AND project_id=$2',
          [root.id, member.projectId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('supports several admins and serializes concurrent removal, ignoring disabled users and pending invites', async () => {
    const root = await user(undefined, true),
      first = await user(),
      second = await user(first.projectId);
    const disabled = await user(first.projectId);
    await fixture.db.query('UPDATE users SET disabled=true WHERE id=$1', [disabled.id]);
    const actor = await requireProjectAdmin(fixture.db, root, first.projectId);
    await accounts.invite(actor, {
      email: `${randomUUID()}@example.test`,
      displayName: 'Pending admin',
      locale: 'pt-PT',
      role: 'admin',
      organization: 'client',
    });
    const results = await Promise.allSettled([
      accounts.action(actor, first.id, { action: 'disable' }),
      accounts.action(actor, second.id, { action: 'disable' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'LAST_ADMIN' }) }),
    ]);
    const remaining = (await accounts.users(actor)).find((item) => !item.disabled)!;
    await expect(
      accounts.update(actor, remaining.id, { role: 'client', organization: 'client' }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    const detail = await identity.administeredProject(root, first.projectId);
    expect(detail.adminCount).toBe(1);
    expect(detail.pendingAdminCount).toBe(1);
  });

  it('guards last admin demotion for project admins and permits promotion and membership-only disable', async () => {
    const admin = await user(),
      member = await user(admin.projectId, false, 'client');
    const actor = await requireProjectAdmin(fixture.db, admin, admin.projectId);
    await expect(
      accounts.update(actor, admin.id, { role: 'client', organization: 'client' }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await accounts.update(actor, member.id, { role: 'admin', organization: 'client' });
    await accounts.action(actor, member.id, { action: 'disable' });
    expect(
      (await fixture.db.query('SELECT disabled FROM users WHERE id=$1', [member.id])).rows[0]!
        .disabled,
    ).toBe(false);
    await accounts.action(actor, member.id, { action: 'enable' });
    expect((await identity.administeredProject(admin, admin.projectId)).adminCount).toBe(2);
  });

  it('saves general/client fields atomically with optimistic version and project-bound confirmation/audit', async () => {
    const root = await user(undefined, true),
      member = await user(),
      other = await user();
    const name = `Updated ${randomUUID()}`;
    const token = await confirmation(root, member.projectId, 'project-update', member.projectId);
    const input = {
      name,
      clientName: 'Customer A',
      siteKey: 'pizzahut' as const,
      expectedVersion: 0,
      reason: 'Approved metadata change',
      ...token,
    };
    await expect(identity.updateProject(root, other.projectId, input, true)).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });
    await identity.updateProject(root, member.projectId, input, true);
    expect(await identity.administeredProject(root, member.projectId)).toMatchObject({
      name,
      clientName: 'Customer A',
      siteKey: 'pizzahut',
      version: 1,
    });
    await expect(identity.updateProject(root, member.projectId, input, true)).rejects.toMatchObject(
      { code: 'STALE_VERSION' },
    );
    const audit = (
      await fixture.db.query<{
        details: { before: { clientName: string }; after: { clientName: string }; reason: string };
      }>(
        "SELECT details FROM audit_events WHERE action='identity.project.updated' AND actor_id=$1 ORDER BY created_at DESC LIMIT 1",
        [root.id],
      )
    ).rows[0]!;
    expect(audit.details).toMatchObject({
      before: { clientName: 'Cliente' },
      after: { clientName: 'Customer A' },
      reason: input.reason,
    });
  });

  it('validates the original authenticated session and rejects spoofed target session context', async () => {
    const root = await user(undefined, true),
      member = await user();
    const session = await identity.login(root.email, password);
    const raw = { password, action: 'project-update', target: member.projectId };
    await expect(
      accounts.reauthenticate(
        { ...root, projectId: member.projectId },
        session.token,
        raw,
        member.projectId,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const token = await accounts.reauthenticate(root, session.token, raw, member.projectId);
    await identity.logout(session.token);
    await expect(
      identity.updateProject(
        root,
        member.projectId,
        {
          name: member.displayName,
          clientName: 'Cliente',
          expectedVersion: 0,
          reason: 'Approved metadata change',
          ...token,
        },
        true,
      ),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });

  it('allows metadata and logo for project admins, prevents archived operations and restricts reactivation', async () => {
    const admin = await user(),
      root = await user(undefined, true);
    const actor = await requireProjectAdmin(fixture.db, admin, admin.projectId);
    expect(await logos.update(actor, admin.projectId, logo)).toMatchObject({ logoVersion: 1 });
    const token = await confirmation(admin, admin.projectId, 'project-update', admin.projectId);
    const input = {
      name: `Admin ${randomUUID()}`,
      clientName: 'Client name',
      expectedVersion: 0,
      reason: 'Approved metadata change',
      ...token,
    };
    await expect(
      identity.updateProject(admin, admin.projectId, { ...input, archived: true }, true),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await identity.updateProject(admin, admin.projectId, input, true);
    await fixture.db.query('UPDATE projects SET archived=true WHERE id=$1', [admin.projectId]);
    await expect(
      requireProjectAdmin(fixture.db, admin, admin.projectId, true),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
    expect((await identity.administeredProject(root, admin.projectId)).archived).toBe(true);
    await expect(logos.update(actor, admin.projectId, logo)).rejects.toMatchObject({
      code: 'PROJECT_ARCHIVED',
    });
    const reactivate = await confirmation(root, admin.projectId, 'project-update', admin.projectId);
    await identity.updateProject(
      root,
      admin.projectId,
      { ...input, ...reactivate, archived: false, expectedVersion: 1 },
      true,
    );
    expect((await identity.administeredProject(admin, admin.projectId)).archived).toBe(false);
  });

  it('creates a logo, default organizations and initial invitation together; invalid logo leaves no project', async () => {
    const root = await user(undefined, true),
      initialAdmin = await user();
    const name = `Create ${randomUUID()}`;
    const session = await identity.login(root.email, password);
    const token = await accounts.reauthenticate(root, session.token, {
      password,
      action: 'project-create',
      target: `${initialAdmin.id}:${name}`,
    });
    const raw = { name, initialAdminUserId: initialAdmin.id, logo, ...token };
    await expect(
      identity.createProject(root, {
        ...raw,
        logo: { ...logo, data: Buffer.from('invalid').toString('base64') },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LOGO' });
    expect((await fixture.db.query('SELECT id FROM projects WHERE name=$1', [name])).rowCount).toBe(
      0,
    );
    const created = await identity.createProject(root, raw);
    expect(created.logoVersion).toBe(1);
    expect(
      (
        await fixture.db.query('SELECT code FROM identity_organizations WHERE project_id=$1', [
          created.id,
        ])
      ).rowCount,
    ).toBe(2);
    expect(
      (
        await fixture.db.query('SELECT * FROM project_memberships WHERE project_id=$1', [
          created.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await identity.administeredProject(root, created.id)).toMatchObject({
      clientName: 'Cliente',
      adminCount: 0,
      pendingAdminCount: 1,
    });
  });

  it('rolls back project, logo, organizations, invitation and consumed confirmation when enqueue fails', async () => {
    const root = await user(undefined, true),
      initialAdmin = await user();
    const name = `Rollback ${randomUUID()}`;
    const session = await identity.login(root.email, password);
    const token = await accounts.reauthenticate(root, session.token, {
      password,
      action: 'project-create',
      target: `${initialAdmin.id}:${name}`,
    });
    const failing = new IdentityService(fixture.db, cipher, {
      assertConfigured() {},
      async enqueue() {
        throw new Error('Queue unavailable');
      },
    });
    await expect(
      failing.createProject(root, { name, initialAdminUserId: initialAdmin.id, logo, ...token }),
    ).rejects.toThrow('Queue unavailable');
    expect((await fixture.db.query('SELECT id FROM projects WHERE name=$1', [name])).rowCount).toBe(
      0,
    );
    await expect(
      identity.createProject(root, { name, initialAdminUserId: initialAdmin.id, logo, ...token }),
    ).resolves.toMatchObject({ logoVersion: 1 });
  });

  it('scopes integration/agent configuration and cannot mutate global integration even as instance admin', async () => {
    const root = await user(undefined, true),
      member = await user(),
      other = await user();
    const actor = await requireProjectAdmin(fixture.db, root, member.projectId);
    const settings = new IntegrationSettingsService(fixture.db, cipher, {
      assertAllowed() {},
      async verify() {},
    });
    const body = {
      scope: 'instance' as const,
      environment: 'quality' as const,
      expectedVersion: 0,
      values: {
        kind: 'smtp' as const,
        host: 'localhost',
        port: 25,
        from: 'ops@example.test',
        secure: false,
        requireTLS: false,
        allowInsecureLoopback: true,
        username: '',
      },
    };
    const global = await settings.save(root, body);
    expect(await settings.list(actor)).toEqual([]);
    await expect(settings.save(actor, body)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      settings.revoke(actor, global.id, { expectedVersion: global.version }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const saved = await settings.save(actor, {
      ...body,
      scope: 'project',
      values: { kind: 'documentation', rootReference: 'project-docs' },
    });
    expect((await settings.list(actor)).map((item) => item.id)).toEqual([saved.id]);
    expect(
      await settings.list(await requireProjectAdmin(fixture.db, root, other.projectId)),
    ).toEqual([]);
    const instructions = new AgentInstructionsService(fixture.db);
    await instructions.save(actor, { body: 'Scoped project instructions', expectedVersion: 0 });
    expect((await instructions.get(actor)).body).toBe('Scoped project instructions');
    expect(
      (await instructions.get(await requireProjectAdmin(fixture.db, root, other.projectId)))
        .version,
    ).toBe(0);
  });

  it('does not demote an administrator through a stale pending invite after membership was reenabled', async () => {
    const root = await user(undefined, true),
      admin = await user();
    await fixture.db.query(
      `INSERT INTO identity_invites(id,project_id,email,display_name,role,token_hash,created_by,expires_at,organization,locale)
      VALUES($1,$2,$3,$4,'client',$5,$6,NOW(3)+INTERVAL 1 DAY,'client','pt-PT')`,
      [randomUUID(), admin.projectId, admin.email, admin.displayName, sha256(secret()), root.id],
    );
    const row = (await fixture.db.query<UserRow>('SELECT * FROM users WHERE id=$1', [admin.id]))
      .rows[0]!;
    await fixture.db.transaction((client) => acceptPendingInvites(client, row));
    expect((await identity.administeredProject(root, admin.projectId)).adminCount).toBe(1);
  });

  it('registers protected HTTP routes, scoped invitations and large atomic creation bodies with CSRF intact', async () => {
    const root = await user(undefined, true),
      member = await user(),
      outsider = await user();
    const rootSession = await identity.login(root.email, password),
      outsideSession = await identity.login(outsider.email, password);
    const app = await createApplication(
      fixture.db,
      { publicUrl: 'http://127.0.0.1' },
      { encryptionKey: randomBytes(32).toString('base64'), mail },
    );
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    const base = `http://127.0.0.1:${address.port}/api`;
    const headers = {
      Cookie: `zeroops_session=${rootSession.token}`,
      Origin: 'http://127.0.0.1',
      'Content-Type': 'application/json',
      'X-CSRF-Token': rootSession.csrfToken,
    };
    try {
      expect((await fetch(`${base}/project-admin/${member.projectId}`, { headers })).status).toBe(
        200,
      );
      expect(
        (
          await fetch(`${base}/project-admin/${member.projectId}/users`, {
            headers: { Cookie: `zeroops_session=${outsideSession.token}` },
          })
        ).status,
      ).toBe(403);
      const reauth = await fetch(`${base}/project-admin/${member.projectId}/account/reauth`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password, action: 'project-update', target: member.projectId }),
      });
      expect(reauth.status).toBe(201);
      const scopedConfirmation = (await reauth.json()) as { confirmationToken: string };
      const general = await fetch(`${base}/project-admin/${member.projectId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: `Scoped HTTP ${randomUUID()}`,
          clientName: 'HTTP client',
          expectedVersion: 0,
          reason: 'Approved HTTP metadata update',
          ...scopedConfirmation,
        }),
      });
      expect(general.status).toBe(201);
      expect((await identity.authenticate(rootSession.token)).user.projectId).toBe(root.projectId);
      const invite = {
        email: outsider.email,
        displayName: outsider.displayName,
        role: 'admin',
        organization: 'client',
        locale: 'pt-PT',
      };
      expect(
        (
          await fetch(`${base}/project-admin/${member.projectId}/invitations`, {
            method: 'POST',
            headers,
            body: JSON.stringify(invite),
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await fetch(`${base}/project-admin/${member.projectId}/logo`, {
            method: 'POST',
            headers: { ...headers, 'X-CSRF-Token': 'invalid' },
            body: JSON.stringify(logo),
          })
        ).status,
      ).toBe(403);
      const name = `HTTP ${randomUUID()}`;
      const confirm = await accounts.reauthenticate(root, rootSession.token, {
        password,
        action: 'project-create',
        target: `${member.id}:${name}`,
      });
      const largeLogo = {
        ...logo,
        data: Buffer.concat([
          Buffer.from('89504e470d0a1a0a', 'hex'),
          Buffer.alloc(100000),
        ]).toString('base64'),
      };
      const created = await fetch(`${base}/instance/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, initialAdminUserId: member.id, logo: largeLogo, ...confirm }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ logoVersion: 1, status: 'invitation_pending' });
    } finally {
      await app.close();
    }
  });
});
