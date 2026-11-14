import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { Database } from '../../database/database.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { hashPassword, secret, sha256 } from './credentials.js';
import { IdentityService } from './identity.service.js';

const password = 'A-strong-test-password-123!';
let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let identity: IdentityService;
let passwordHash: string;

beforeAll(async () => {
  fixture = await startTestDatabase();
  identity = new IdentityService(fixture.db);
  passwordHash = await hashPassword(password);
});
afterAll(async () => {
  await fixture?.stop();
});

async function user(role: Role = 'client'): Promise<User> {
  const projectId = randomUUID();
  const actor: User = {
    id: randomUUID(),
    projectId,
    email: `${randomUUID()}@example.test`,
    displayName: 'Test member',
    role,
    organization: null,
    locale: 'pt-PT',
  };
  await fixture.db.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [
    projectId,
    'Identity test',
  ]);
  await fixture.db.query(
    'INSERT INTO users (id, project_id, email, display_name, role, password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, passwordHash],
  );
  return actor;
}

describe('IdentityService', () => {
  it('can reapply its migration without replacing project or account data', async () => {
    const actor = await user();
    const migration = await readFile(
      new URL('../../../../../sql/001_baseline.sql', import.meta.url),
      'utf8',
    );
    const name = (await fixture.db.query<{ name: string }>('SELECT DATABASE() AS name')).rows[0]!
      .name;
    const url = new URL(inject('zeroopsDatabaseServer'));
    url.pathname = `/${name}`;
    const migrator = new Database(url.href, { multipleStatements: true });
    try {
      await migrator.query(migration);
    } finally {
      await migrator.close();
    }
    expect((await identity.login(actor.email, password)).user).toEqual(actor);
    const project = await fixture.db.query<{ name: string }>(
      'SELECT name FROM projects WHERE id=$1',
      ['00000000-0000-4000-8000-000000000001'],
    );
    expect(project.rows).toEqual([{ name: 'Pizza Hut' }]);
  });

  it('authenticates normalized email, stores only session/CSRF hashes, and durably logs out', async () => {
    const actor = await user();
    const result = await identity.login(` ${actor.email.toUpperCase()} `, password);
    expect(result.user).toEqual(actor);
    expect(await new IdentityService(fixture.db).authenticate(result.token)).toEqual({
      user: actor,
      csrfHash: sha256(result.csrfToken),
      csrfToken: result.csrfToken,
    });
    const stored = await fixture.db.query<{ token_hash: string; csrf_hash: string }>(
      'SELECT token_hash, csrf_hash FROM identity_sessions WHERE user_id=$1',
      [actor.id],
    );
    expect(stored.rows[0]).toEqual({
      token_hash: sha256(result.token),
      csrf_hash: sha256(result.csrfToken),
    });
    await identity.logout(result.token);
    await expect(identity.authenticate(result.token)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects wrong passwords, unknown accounts, expired sessions, and disabled users', async () => {
    const actor = await user();
    for (const email of [actor.email, `${randomUUID()}@example.test`]) {
      await expect(identity.login(email, 'not-the-password')).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        status: 401,
      });
    }
    const expired = await identity.login(actor.email, password);
    await fixture.db.query(
      'UPDATE identity_sessions SET expires_at=NOW(3) - INTERVAL 1 SECOND WHERE user_id=$1',
      [actor.id],
    );
    await expect(identity.authenticate(expired.token)).rejects.toMatchObject({ status: 401 });
    const disabled = await identity.login(actor.email, password);
    await fixture.db.query('UPDATE users SET disabled=true WHERE id=$1', [actor.id]);
    await expect(identity.authenticate(disabled.token)).rejects.toMatchObject({ status: 401 });
    await expect(identity.login(actor.email, password)).rejects.toMatchObject({ status: 401 });
  });

  it('checks the database role and project instead of trusting a supplied actor', async () => {
    const client = await user();
    const admin = await user('admin');
    const data = {
      email: `${randomUUID()}@example.test`,
      displayName: 'Invitee',
      role: 'technical' as const,
    };
    await expect(identity.invite({ ...client, role: 'admin' }, data)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      identity.invite({ ...admin, projectId: client.projectId }, data),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('supersedes old invitations and activates a hashed token exactly once in its original project', async () => {
    const admin = await user('admin');
    const data = {
      email: `${randomUUID()}@example.test`,
      displayName: 'Invitee',
      role: 'technical' as const,
    };
    const stale = await identity.invite(admin, data);
    const current = await identity.invite(admin, data);
    const activation = { password, displayName: 'Activated member' };
    await expect(identity.activate({ ...activation, token: stale.token })).rejects.toMatchObject({
      status: 401,
    });

    const stored = await fixture.db.query<{ token_hash: string }>(
      'SELECT token_hash FROM identity_invites WHERE email=$1 AND revoked_at IS NULL',
      [data.email],
    );
    expect(stored.rows[0]?.token_hash).toBe(sha256(current.token));
    const results = await Promise.allSettled([
      identity.activate({ ...activation, token: current.token }),
      identity.activate({ ...activation, token: current.token }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const activated = await identity.login(data.email, password);
    expect(activated.user).toMatchObject({
      projectId: admin.projectId,
      role: 'technical',
      displayName: activation.displayName,
    });
  });

  it('adds an existing global account to another project without resetting its identity', async () => {
    const account = await user('client');
    const admin = await user('admin');
    const invitation = await identity.invite(admin, {
      email: account.email,
      displayName: 'Name must not replace the global profile',
      role: 'client',
    });
    await expect(
      identity.activate({
        token: invitation.token,
        password: 'incorrect-password',
        displayName: 'Ignored name',
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (
        await fixture.db.query('SELECT used_at FROM identity_invites WHERE token_hash=$1', [
          sha256(invitation.token),
        ])
      ).rows[0]!.used_at,
    ).toBeNull();
    const activated = await identity.activate({
      token: invitation.token,
      password,
      displayName: 'Ignored name',
    });
    expect(activated.user).toMatchObject({
      id: account.id,
      projectId: admin.projectId,
      displayName: account.displayName,
      role: 'client',
    });
    const saved = await fixture.db.query<{ count: number; display_name: string }>(
      'SELECT count(*) OVER() AS count,display_name FROM users WHERE lower(email)=$1',
      [account.email],
    );
    expect(saved.rows).toEqual([{ count: 1, display_name: account.displayName }]);
  });

  it('rejects expired invitations and invitations whose issuer lost administrator access', async () => {
    const admin = await user('admin');
    const makeInvite = () =>
      identity.invite(admin, {
        email: `${randomUUID()}@example.test`,
        displayName: 'Invitee',
        role: 'client',
      });
    const expired = await makeInvite();
    await fixture.db.query(
      'UPDATE identity_invites SET expires_at=NOW(3) - INTERVAL 1 SECOND WHERE token_hash=$1',
      [sha256(expired.token)],
    );
    await expect(
      identity.activate({ token: expired.token, password, displayName: 'Invitee' }),
    ).rejects.toMatchObject({ status: 401 });
    const revokedAuthority = await makeInvite();
    await fixture.db.query("UPDATE users SET role='client' WHERE id=$1", [admin.id]);
    await expect(
      identity.activate({ token: revokedAuthority.token, password, displayName: 'Invitee' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('has no automatic bootstrap and allows the explicit initial administrator only once', async () => {
    const before = await fixture.db.query('SELECT id FROM users WHERE project_id=$1', [
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(before.rows).toHaveLength(0);
    const input = {
      email: `${randomUUID()}@example.test`,
      displayName: 'Initial operator',
      password,
    };
    expect((await identity.createInitialAdmin(input)).user.role).toBe('admin');
    await expect(
      identity.createInitialAdmin({ ...input, email: `${randomUUID()}@example.test` }),
    ).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED', status: 409 });
  });

  it('blocks unavailable reset delivery identically for known and unknown emails without queueing secrets', async () => {
    const actor = await user();
    const before = await fixture.db.query<{ count: string }>(
      'SELECT count(*) FROM notification_outbox',
    );
    for (const email of [actor.email, `${randomUUID()}@example.test`]) {
      await expect(identity.requestPasswordReset(email)).rejects.toMatchObject({
        code: 'MAIL_TRANSPORT_NOT_CONFIGURED',
        status: 503,
      });
    }
    const after = await fixture.db.query<{ count: string }>(
      'SELECT count(*) FROM notification_outbox',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('consumes reset hashes once, changes the password, and revokes every existing session', async () => {
    const actor = await user();
    const session = await identity.login(actor.email, password);
    const token = secret();
    await fixture.db.query(
      'INSERT INTO identity_password_resets (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,NOW(3) + INTERVAL 1 HOUR)',
      [randomUUID(), actor.id, sha256(token)],
    );
    const newPassword = 'Different-strong-password-789!';
    await identity.resetPassword({ token, password: newPassword });
    await expect(identity.authenticate(session.token)).rejects.toMatchObject({ status: 401 });
    await expect(identity.login(actor.email, password)).rejects.toMatchObject({ status: 401 });
    expect((await identity.login(actor.email, newPassword)).user.id).toBe(actor.id);
    await expect(identity.resetPassword({ token, password })).rejects.toMatchObject({
      status: 401,
    });
  });
});
