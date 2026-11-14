import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { IdentityService } from './identity.service.js';
import { AccountService } from './account.service.js';
import { IdentityCipher, authenticator, type PrivateIdentityMail } from './identity-security.js';
import type { User } from '../../../../contracts/src/index.js';
import { hashPassword, secret } from './credentials.js';
import { resetPassword } from './password-reset.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let identity: IdentityService;
let accounts: AccountService;
const cipher = new IdentityCipher(randomBytes(32).toString('base64'));
const messages: Parameters<PrivateIdentityMail['enqueue']>[1][] = [];
const mail: PrivateIdentityMail = {
  assertConfigured() {},
  async enqueue(_client, input) {
    messages.push(input);
  },
};
const password = 'Synthetic-account-password-123!';
let passwordHash: string;
beforeAll(async () => {
  fixture = await startTestDatabase();
  identity = new IdentityService(fixture.db, cipher, mail);
  accounts = new AccountService(fixture.db, cipher, mail);
  passwordHash = await hashPassword(password);
});
afterAll(async () => {
  await fixture?.stop();
});
async function user(
  role: User['role'] = 'client',
  projectId: string = randomUUID(),
): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects(id,name) VALUES($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, 'Test'],
  );
  const actor: User = {
    id: randomUUID(),
    projectId,
    email: `${randomUUID()}@example.test`,
    displayName: 'Test',
    role,
    organization: null,
    locale: 'pt-PT',
  };
  await fixture.db.query(
    'INSERT INTO users(id,project_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, passwordHash],
  );
  return actor;
}
async function enroll(actor: User) {
  const step = await identity.login(actor.email, password);
  const seed = await identity.authentication.enrollment(step.token);
  return {
    seed,
    ...(await identity.authentication.complete(
      step.token,
      authenticator(seed.secret).generate(),
      true,
    )),
  };
}
describe('Identity access gates', () => {
  it('persists three failures despite errors, blocks correct password and never extends lock or repeats notice', async () => {
    const actor = await user(),
      before = messages.length;
    for (let i = 0; i < 3; i++)
      await expect(identity.login(actor.email, 'incorrect')).rejects.toMatchObject({ status: 401 });
    const row = await fixture.db.query<{ password_failures: number; locked_until: Date }>(
      'SELECT password_failures,locked_until FROM users WHERE id=$1',
      [actor.id],
    );
    expect(row.rows[0]!.password_failures).toBe(3);
    expect(row.rows[0]!.locked_until.getTime() - Date.now()).toBeGreaterThan(14 * 60000);
    await expect(
      new IdentityService(fixture.db, cipher, mail).login(actor.email, password),
    ).rejects.toMatchObject({ status: 401 });
    expect(messages.length).toBe(before + 1);
    expect(
      (await fixture.db.query('SELECT locked_until FROM users WHERE id=$1', [actor.id])).rows[0]!
        .locked_until,
    ).toEqual(row.rows[0]!.locked_until);
    await fixture.db.query('UPDATE users SET locked_until=NOW(3) - INTERVAL 1 SECOND WHERE id=$1', [
      actor.id,
    ]);
    expect((await identity.login(actor.email, password)).status).toBe('authenticated');
    expect(
      (await fixture.db.query('SELECT password_failures FROM users WHERE id=$1', [actor.id]))
        .rows[0]!.password_failures,
    ).toBe(0);
  });
  it('counts concurrent failures without rollback or lost updates', async () => {
    const actor = await user();
    await Promise.allSettled(Array.from({ length: 3 }, () => identity.login(actor.email, 'bad')));
    expect(
      (await fixture.db.query('SELECT password_failures FROM users WHERE id=$1', [actor.id]))
        .rows[0]!.password_failures,
    ).toBe(3);
  });
  it('requires enrollment and MFA for staff, rejects replay and consumes recovery codes once', async () => {
    const actor = await user('technical'),
      step = await identity.login(actor.email, password);
    expect(step.status).toBe('enrollment_required');
    await expect(identity.authenticate(step.token)).rejects.toMatchObject({ status: 401 });
    const enrollment = await identity.authentication.enrollment(step.token);
    const completed = await identity.authentication.complete(
      step.token,
      authenticator(enrollment.secret).generate(),
      true,
    );
    expect(completed.recoveryCodes).toHaveLength(10);
    expect((await identity.authenticate(completed.token)).user.role).toBe('technical');
    await expect(
      identity.authentication.complete(step.token, '000000', true),
    ).rejects.toMatchObject({ status: 401 });
    const login = await identity.login(actor.email, password);
    expect(login.status).toBe('mfa_required');
    await expect(
      identity.authentication.complete(login.token, authenticator(enrollment.secret).generate()),
    ).rejects.toMatchObject({ code: 'INVALID_FACTOR' });
    const recovery = completed.recoveryCodes![0]!;
    expect((await identity.authentication.complete(login.token, recovery)).status).toBe(
      'authenticated',
    );
    const next = await identity.login(actor.email, password);
    await expect(identity.authentication.complete(next.token, recovery)).rejects.toMatchObject({
      code: 'INVALID_FACTOR',
    });
  });
  it('five failed factors durably expire a challenge and do not lock password', async () => {
    const actor = await user('qa');
    const { recoveryCodes } = await enroll(actor);
    const step = await identity.login(actor.email, password);
    for (let i = 0; i < 5; i++)
      await expect(identity.authentication.complete(step.token, 'wrong')).rejects.toMatchObject({
        status: 401,
      });
    await expect(
      identity.authentication.complete(step.token, recoveryCodes![0]!),
    ).rejects.toMatchObject({ code: 'INVALID_CHALLENGE' });
    expect(
      (await fixture.db.query('SELECT password_failures FROM users WHERE id=$1', [actor.id]))
        .rows[0]!.password_failures,
    ).toBe(0);
  });
  it('staff can disable their own MFA, sign in with password only and re-enabling restores the requirement', async () => {
    const actor = await user('technical'),
      session = await enroll(actor);
    const confirm = await accounts.reauthenticate(actor, session.token, {
      password,
      code: session.recoveryCodes![0]!,
      action: 'mfa-disable',
      target: actor.id,
    });
    await accounts.mfaManage(actor, confirm.confirmationToken, 'mfa-disable');
    await expect(identity.authenticate(session.token)).rejects.toMatchObject({ status: 401 });
    const login = await identity.login(actor.email, password);
    expect(login.status).toBe('authenticated');
    expect((await identity.authenticate(login.token)).user.id).toBe(actor.id);
    const again = await accounts.reauthenticate(actor, login.token, {
      password,
      action: 'mfa-start',
      target: actor.id,
    });
    const seed = await accounts.mfaStart(actor, again.confirmationToken);
    await accounts.mfaConfirm(actor, authenticator(seed.secret).generate());
    expect(
      (await fixture.db.query('SELECT mfa_opt_out FROM users WHERE id=$1', [actor.id])).rows[0]!
        .mfa_opt_out,
    ).toBeFalsy();
    expect((await identity.login(actor.email, password)).status).toBe('mfa_required');
  });
  it('reset links expire in 30 minutes, revoke old links and never remove MFA', async () => {
    const actor = await user('technical');
    await enroll(actor);
    await accounts.requestReset({ email: actor.email, locale: 'en' });
    const first = messages.at(-1)!;
    await accounts.requestReset({ email: actor.email, locale: 'en' });
    const second = messages.at(-1)!;
    expect(Date.parse(second.expiresAt!) - Date.now()).toBeLessThanOrEqual(30 * 60000);
    await expect(
      resetPassword(fixture.db, { token: first.token!, password }),
    ).rejects.toMatchObject({ status: 401 });
    await resetPassword(fixture.db, { token: second.token!, password });
    expect((await identity.login(actor.email, password)).status).toBe('mfa_required');
  });
  it('binds sensitive confirmations to action and target and protects the last administrator', async () => {
    const admin = await user('admin'),
      session = await enroll(admin),
      code = session.recoveryCodes![0]!;
    const confirm = await accounts.reauthenticate(admin, session.token, {
      password,
      code,
      action: 'disable',
      target: admin.id,
    });
    await expect(
      accounts.action(admin, admin.id, {
        action: 'disable',
        confirmationToken: confirm.confirmationToken,
      }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(
      accounts.action(admin, admin.id, {
        action: 'sessions',
        confirmationToken: confirm.confirmationToken,
      }),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    const second = await user('admin', admin.projectId);
    expect(second.id).not.toBe(admin.id);
    await accounts.action(admin, admin.id, {
      action: 'disable',
      confirmationToken: confirm.confirmationToken,
    });
    await expect(identity.authenticate(session.token)).rejects.toMatchObject({ status: 401 });
    expect((await fixture.db.query('SELECT id FROM users WHERE id=$1', [admin.id])).rowCount).toBe(
      1,
    );
  });
  it('administrator MFA reset cannot target self and requires password + verified reset before enrollment', async () => {
    const admin = await user('admin'),
      target = await user('technical', admin.projectId);
    await fixture.db.query('UPDATE users SET instance_admin=true WHERE id=$1', [admin.id]);
    const session = await enroll(admin);
    await enroll(target);
    const c = await accounts.reauthenticate(admin, session.token, {
      password,
      code: session.recoveryCodes![0],
      action: 'mfa-reset',
      target: target.id,
    });
    await accounts.action(admin, target.id, {
      action: 'mfa-reset',
      reason: 'Identity verified through an approved human procedure.',
      confirmationToken: c.confirmationToken,
    });
    const notice = messages.at(-1)!;
    await expect(identity.login(target.email, password)).rejects.toMatchObject({ status: 401 });
    await expect(
      accounts.confirmMfaReset({
        token: notice.token,
        email: target.email,
        password: 'wrong-password-123',
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (await accounts.confirmMfaReset({ token: notice.token, email: target.email, password }))
        .status,
    ).toBe('enrollment_required');
    await fixture.db.query(
      'UPDATE identity_challenges SET expires_at=NOW(3) - INTERVAL 1 SECOND WHERE user_id=$1',
      [target.id],
    );
    expect((await identity.login(target.email, password)).status).toBe('enrollment_required');
    const own = await accounts.reauthenticate(admin, session.token, {
      password,
      code: session.recoveryCodes![1],
      action: 'mfa-reset',
      target: admin.id,
    });
    await expect(
      accounts.action(admin, admin.id, {
        action: 'mfa-reset',
        reason: 'Verified identity',
        confirmationToken: own.confirmationToken,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('switches projects only through a valid MFA-verified session and invalidates the old session', async () => {
    const actor = await user('client');
    const nextProject = randomUUID();
    await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [nextProject, 'Second']);
    await fixture.db.query(
      "INSERT INTO project_memberships(user_id,project_id,role) VALUES($1,$2,'technical')",
      [actor.id, nextProject],
    );
    const session = await enroll(actor);
    await expect(identity.switchProject(actor, session.token, randomUUID())).rejects.toMatchObject({
      status: 403,
    });
    const switched = await identity.switchProject(actor, session.token, nextProject);
    expect(switched.user).toMatchObject({
      id: actor.id,
      projectId: nextProject,
      role: 'technical',
    });
    expect((await identity.authenticate(switched.token)).user.projectId).toBe(nextProject);
    await expect(identity.authenticate(session.token)).rejects.toMatchObject({ status: 401 });
  });
  it('creates projects only for an instance administrator and queues a project-admin invitation', async () => {
    const root = await user('admin');
    await fixture.db.query('UPDATE users SET instance_admin=true WHERE id=$1', [root.id]);
    const session = await enroll(root);
    const target = await user('client');
    const targetValue = `${target.id}:Quality Sandbox`;
    const confirmation = await accounts.reauthenticate(root, session.token, {
      password,
      code: session.recoveryCodes![0],
      action: 'project-create',
      target: targetValue,
    });
    const created = await identity.createProject(root, {
      name: 'Quality Sandbox',
      initialAdminUserId: target.id,
      confirmationToken: confirmation.confirmationToken,
    });
    expect(created).toMatchObject({ name: 'Quality Sandbox', status: 'invitation_pending' });
    expect(
      (
        await fixture.db.query<{ role: string; created_by: string }>(
          `SELECT i.role,i.created_by FROM identity_invites i
           WHERE i.project_id=$1 AND i.email=$2 AND i.used_at IS NULL`,
          [created.id, target.email],
        )
      ).rows,
    ).toEqual([{ role: 'admin', created_by: root.id }]);
    expect(messages.at(-1)).toMatchObject({
      recipient: target.email,
      kind: 'invite',
    });
    await expect(identity.instanceProjects(target)).rejects.toMatchObject({ status: 403 });
  });
  it('ciphertext authenticates identity context and never contains a plaintext seed', () => {
    const seed = secret(),
      encrypted = cipher.encrypt(seed, 'one');
    expect(encrypted).not.toContain(seed);
    expect(cipher.decrypt(encrypted, 'one')).toBe(seed);
    expect(() => cipher.decrypt(encrypted, 'two')).toThrow();
  });

  it('archives and restores a project without deleting data and refuses outstanding execution or stale edits', async () => {
    const root = await user('admin');
    await fixture.db.query('UPDATE users SET instance_admin=true WHERE id=$1', [root.id]);
    const session = await enroll(root);
    const customer = await user('client', root.projectId);
    const customerSession = await identity.login(customer.email, password);
    const ticketId = randomUUID();
    await fixture.db.query(
      `INSERT INTO tickets(id,project_id,created_by,title,description,category,environment,priority,status)
       VALUES($1,$2,$3,'Project archive test','Preserve all historical ticket content.','question','quality','medium','implementing')`,
      [ticketId, root.projectId, customer.id],
    );
    const confirmation = await accounts.reauthenticate(root, session.token, {
      password,
      code: session.recoveryCodes![0],
      action: 'project-update',
      target: root.projectId,
    });
    const input = {
      name: `Workspace ${root.id.slice(0, 8)}`,
      archived: true,
      expectedVersion: 0,
      reason: 'Projeto encerrado após revisão operacional.',
      confirmationToken: confirmation.confirmationToken,
    };
    await expect(identity.updateProject(root, root.projectId, input)).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
    });
    await fixture.db.query("UPDATE tickets SET status='new' WHERE id=$1", [ticketId]);
    await expect(identity.updateProject(customer, root.projectId, input)).rejects.toMatchObject({
      status: 403,
    });
    expect(await identity.updateProject(root, root.projectId, input)).toMatchObject({
      archived: true,
      version: 1,
    });
    await expect(identity.authenticate(customerSession.token)).rejects.toMatchObject({
      status: 401,
    });
    expect((await identity.authenticate(session.token)).user.instanceAdmin).toBe(true);
    expect(await identity.projects(session.user)).toEqual([]);
    await expect(identity.updateProject(root, root.projectId, input)).rejects.toMatchObject({
      code: 'STALE_VERSION',
    });
    const restored = await accounts.reauthenticate(root, session.token, {
      password,
      code: session.recoveryCodes![1],
      action: 'project-update',
      target: root.projectId,
    });
    await identity.updateProject(root, root.projectId, {
      ...input,
      archived: false,
      expectedVersion: 1,
      confirmationToken: restored.confirmationToken,
    });
    expect(
      (await fixture.db.query('SELECT description FROM tickets WHERE id=$1', [ticketId])).rows[0]
        ?.description,
    ).toBe('Preserve all historical ticket content.');
    expect((await identity.login(customer.email, password)).status).toBe('authenticated');
  });
  it('does not change email before verification and consumes links only once, revoking sessions', async () => {
    const admin = await user('admin'),
      target = await user('client', admin.projectId),
      session = await enroll(admin);
    await fixture.db.query('UPDATE users SET instance_admin=true WHERE id=$1', [admin.id]);
    const targetSession = await identity.login(target.email, password);
    const c = await accounts.reauthenticate(admin, session.token, {
      password,
      code: session.recoveryCodes![0],
      action: 'email',
      target: target.id,
    });
    const next = `${randomUUID()}@example.test`;
    await accounts.email(admin, target.id, { email: next, confirmationToken: c.confirmationToken });
    expect((await identity.login(target.email, password)).status).toBe('authenticated');
    const message = messages.findLast((m) => m.kind === 'email-change' && m.token)!;
    await accounts.confirmEmail(message.token!);
    expect((await identity.login(next, password)).user.id).toBe(target.id);
    await expect(identity.authenticate(targetSession.token)).rejects.toMatchObject({ status: 401 });
    await expect(accounts.confirmEmail(message.token!)).rejects.toMatchObject({ status: 401 });
  });
  it('queues 48 hour invitations with explicit organization and locale instead of exposing tokens', async () => {
    const admin = await user('admin');
    await enroll(admin);
    await fixture.db.query(
      "INSERT INTO identity_organizations(project_id,code,name) VALUES($1,'deloitte','Deloitte')",
      [admin.projectId],
    );
    const email = `${randomUUID()}@example.test`;
    expect(
      await accounts.invite(admin, {
        email,
        displayName: 'New staff',
        role: 'technical',
        organization: 'deloitte',
        locale: 'en',
      }),
    ).toEqual({ ok: true });
    const message = messages.at(-1)!;
    expect(Date.parse(message.expiresAt!) - Date.now()).toBeGreaterThan(47 * 3600000);
    expect(message.temporaryPassword).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
    const activated = await identity.activate({
      token: message.token!,
      displayName: 'New staff',
      password,
    });
    expect(activated.status).toBe('enrollment_required');
    expect(activated.user.organization).toBe('deloitte');
    expect(activated.user.locale).toBe('en');
  });
  it('signs in a new invitee with the temporary password and forces a new password', async () => {
    const admin = await user('admin');
    await enroll(admin);
    await fixture.db.query(
      "INSERT IGNORE INTO identity_organizations(project_id,code,name) VALUES($1,'client','Cliente')",
      [admin.projectId],
    );
    const email = `${randomUUID()}@example.test`;
    await accounts.invite(admin, {
      email,
      displayName: 'Client user',
      role: 'client',
      organization: 'client',
      locale: 'pt-PT',
    });
    const temporary = messages.at(-1)!.temporaryPassword!;
    await expect(identity.login(email, 'Wrong-temporary-password-1')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    const first = await identity.login(email, temporary);
    expect(first.status).toBe('authenticated');
    expect(first.user.passwordChangeRequired).toBe(true);
    expect(first.user.projectId).toBe(admin.projectId);
    await expect(
      accounts.initialPassword(first.user, { password: temporary }),
    ).rejects.toMatchObject({ code: 'PASSWORD_REUSED' });
    await accounts.initialPassword(first.user, { password });
    await expect(accounts.initialPassword(first.user, { password })).rejects.toMatchObject({
      code: 'PASSWORD_ALREADY_SET',
    });
    await expect(identity.login(email, temporary)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    const next = await identity.login(email, password);
    expect(next.user.passwordChangeRequired).toBeFalsy();
  });
  it('gives an existing account access to the invited project at its next sign-in', async () => {
    const admin = await user('admin'),
      other = await user('admin'),
      existing = await user('client', other.projectId);
    await enroll(admin);
    await fixture.db.query(
      "INSERT IGNORE INTO identity_organizations(project_id,code,name) VALUES($1,'client','Cliente')",
      [admin.projectId],
    );
    await accounts.invite(admin, {
      email: existing.email,
      displayName: 'Existing user',
      role: 'client',
      organization: 'client',
      locale: 'pt-PT',
    });
    expect(messages.at(-1)!.temporaryPassword).toBeUndefined();
    await identity.login(existing.email, password);
    const membership = await fixture.db.query(
      'SELECT role FROM project_memberships WHERE user_id=$1 AND project_id=$2 AND NOT disabled',
      [existing.id, admin.projectId],
    );
    expect(membership.rowCount).toBe(1);
  });
  it('serializes competing last-admin removals so exactly one can succeed', async () => {
    const first = await user('admin'),
      second = await user('admin', first.projectId);
    const a = await enroll(first),
      b = await enroll(second);
    const ca = await accounts.reauthenticate(first, a.token, {
      password,
      code: a.recoveryCodes![0],
      action: 'disable',
      target: first.id,
    });
    const cb = await accounts.reauthenticate(second, b.token, {
      password,
      code: b.recoveryCodes![0],
      action: 'disable',
      target: second.id,
    });
    const results = await Promise.allSettled([
      accounts.action(first, first.id, {
        action: 'disable',
        confirmationToken: ca.confirmationToken,
      }),
      accounts.action(second, second.id, {
        action: 'disable',
        confirmationToken: cb.confirmationToken,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await fixture.db.query(
          `SELECT m.user_id AS id FROM project_memberships m JOIN users u ON u.id=m.user_id
           WHERE m.project_id=$1 AND m.role='admin' AND NOT m.disabled AND NOT u.disabled`,
          [first.projectId],
        )
      ).rowCount,
    ).toBe(1);
  });
});
