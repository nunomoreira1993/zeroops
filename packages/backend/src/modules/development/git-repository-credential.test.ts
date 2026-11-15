import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { IdentityCipher } from '../identity/identity-security.js';
import { GitRepositoriesService } from './git-repositories.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
const cipher = new IdentityCipher(randomBytes(32).toString('base64'));

beforeAll(async () => {
  fixture = await startTestDatabase();
});

afterAll(async () => {
  await fixture?.stop();
});

afterEach(() => vi.unstubAllGlobals());

describe('Git repository credential lifecycle', () => {
  it('removes the encrypted project credential with version check and audit', async () => {
    const projectId = randomUUID();
    const userId = randomUUID();
    await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Git test']);
    await fixture.db.query(
      `INSERT INTO users(id,project_id,email,display_name,role,password_hash,instance_admin)
       VALUES($1,$2,$3,$4,'admin','unused',1)`,
      [userId, projectId, `${userId}@example.test`, 'Project Admin'],
    );
    const actor: User = {
      id: userId,
      projectId,
      role: 'admin',
      instanceAdmin: true,
      email: `${userId}@example.test`,
      displayName: 'Project Admin',
    };
    const repositories = new GitRepositoriesService(fixture.db, cipher, {
      allowedRoots: ['https://github.com/Deloitte-Portugal/'],
      probe: async () => '2c38b0f581dfa7e9dc6b31b39219377b93b54b3f',
    });
    const created = await repositories.create(actor, projectId, {
      name: 'Pizza Hut website',
      url: 'https://github.com/Deloitte-Portugal/pizzahut.git',
      baseBranch: 'qa',
      allowedRefs: ['qa'],
      testCommands: [{ name: 'smoke', command: 'test -s zeroops-check.txt' }],
      credential: 'github-token-for-test-only',
    });
    await fixture.db.query(
      `UPDATE project_git_repositories
       SET credential_provider='github_cli',credential_identity='test-account',version=version+1
       WHERE id=$1`,
      [created.id],
    );

    await expect(
      repositories.revokeCredential(actor, projectId, created.id, {
        expectedVersion: created.version,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const removed = await repositories.revokeCredential(actor, projectId, created.id, {
      expectedVersion: created.version + 1,
    });
    const stored = (
      await fixture.db.query<{
        credential_ciphertext: string | null;
        credential_provider: string;
        credential_identity: string | null;
      }>(
        `SELECT credential_ciphertext,credential_provider,credential_identity
         FROM project_git_repositories WHERE id=$1`,
        [created.id],
      )
    ).rows[0];
    const audit = await fixture.db.query(
      `SELECT id FROM audit_events WHERE actor_id=$1 AND action='git_repository.credential_revoked'`,
      [userId],
    );

    expect(removed.hasCredential).toBe(false);
    expect(removed.credentialIdentity).toBeNull();
    expect(stored).toEqual({
      credential_ciphertext: null,
      credential_provider: 'token',
      credential_identity: null,
    });
    expect(audit.rowCount).toBe(1);
  });

  it('verifies GitHub CLI identity and reports revoked credentials', async () => {
    const projectId = randomUUID();
    const userId = randomUUID();
    await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [
      projectId,
      'Git verify',
    ]);
    await fixture.db.query(
      `INSERT INTO users(id,project_id,email,display_name,role,password_hash,instance_admin)
       VALUES($1,$2,$3,$4,'admin','unused',1)`,
      [userId, projectId, `${userId}@example.test`, 'Project Admin'],
    );
    const actor: User = {
      id: userId,
      projectId,
      role: 'admin',
      instanceAdmin: true,
      email: `${userId}@example.test`,
      displayName: 'Project Admin',
    };
    const repositories = new GitRepositoriesService(fixture.db, cipher, {
      allowedRoots: ['https://github.com/Deloitte-Portugal/'],
      probe: async () => '2c38b0f581dfa7e9dc6b31b39219377b93b54b3f',
    });
    const created = await repositories.create(actor, projectId, {
      name: 'GitHub CLI',
      url: 'https://github.com/Deloitte-Portugal/pizzahut.git',
      baseBranch: 'qa',
      allowedRefs: ['qa'],
      testCommands: [{ name: 'smoke', command: 'test -s zeroops-check.txt' }],
      credential: `gho_${'a'.repeat(36)}`,
    });
    await fixture.db.query(
      `UPDATE project_git_repositories
       SET credential_provider='github_cli',credential_identity='stale-account' WHERE id=$1`,
      [created.id],
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ login: 'current-account', id: 123, type: 'User' }), {
            status: 200,
            headers: { 'x-oauth-scopes': 'repo' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ permissions: { pull: true, push: true } }), {
            status: 200,
          }),
        ),
    );

    const verified = await repositories.verify(actor, projectId, created.id);
    expect(verified.credentialIdentity).toBe('current-account');
    expect(verified.verifiedBaseSha).toBe('2c38b0f581dfa7e9dc6b31b39219377b93b54b3f');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    const expired = await repositories.verify(actor, projectId, created.id);
    expect(expired.verifiedAt).toBeNull();
    expect(expired.verificationError).toContain('HTTP 401');
    expect(expired.hasCredential).toBe(true);
  });
});
