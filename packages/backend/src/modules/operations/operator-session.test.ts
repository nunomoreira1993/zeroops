import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { IdentityCipher } from '../identity/identity-security.js';
import { IntegrationSettingsService } from '../integrations/integration-settings.service.js';
import { OperatorSession } from './operator-session.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => {
  fixture = await startTestDatabase();
});
afterAll(async () => {
  await fixture?.stop();
});

async function person(role: string, instanceAdmin: boolean) {
  const projectId = randomUUID(),
    email = `${randomUUID()}@example.test`;
  await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Ops']);
  await fixture.db.query(
    `INSERT INTO users(id,project_id,email,display_name,role,password_hash,instance_admin)
     VALUES($1,$2,$3,'Ops',$4,'unusable-test-hash',$5)`,
    [randomUUID(), projectId, email, role, instanceAdmin],
  );
  return email;
}

describe('OperatorSession', () => {
  it('refuses non-administrators', async () => {
    await expect(
      OperatorSession.forAdmin(fixture.db, await person('technical', false)),
    ).rejects.toThrow(/Sem administrador/);
  });

  it('saves through the service without creating sessions or confirmations', async () => {
    const operator = await OperatorSession.forAdmin(fixture.db, await person('admin', true));
    const settings = new IntegrationSettingsService(
      fixture.db,
      new IdentityCipher(randomBytes(32).toString('base64')),
      { assertAllowed() {}, async verify() {} },
    );
    const saved = await settings.save(operator.actor, {
      scope: 'instance',
      environment: 'quality',
      expectedVersion: 0,
      values: {
        kind: 'smtp',
        host: 'localhost',
        port: 25,
        from: 'noreply@example.test',
        secure: false,
        requireTLS: false,
        allowInsecureLoopback: true,
        username: '',
      },
    });
    expect(saved.version).toBe(1);
    const left = await fixture.db.query(
      'SELECT (SELECT COUNT(*) FROM identity_sessions WHERE user_id=$1) AS sessions, (SELECT COUNT(*) FROM identity_confirmations WHERE user_id=$1) AS confirmations',
      [operator.actor.id],
    );
    expect(left.rows[0]).toMatchObject({ sessions: 0, confirmations: 0 });
  });
});
