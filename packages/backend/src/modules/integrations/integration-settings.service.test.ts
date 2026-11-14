import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  integrationValuesSchema,
  type IntegrationValues,
  type User,
} from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { IdentityCipher } from '../identity/identity-security.js';
import { ConfiguredIdentityMail } from '../notifications/configured-identity-mail.js';
import { AuthorizedIntegrationProbe } from './integration-probe.js';
import {
  IntegrationSettingsService,
  type IntegrationProbe,
} from './integration-settings.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
const cipher = new IdentityCipher(randomBytes(32).toString('base64'));
const verified: IntegrationValues[] = [];
const probe: IntegrationProbe = {
  assertAllowed() {},
  async verify(values) {
    verified.push(values);
  },
};
const values = {
  kind: 'smtp' as const,
  host: '127.0.0.1',
  port: 2525,
  from: 'zeroops@example.test',
  secure: false,
  requireTLS: false,
  allowInsecureLoopback: true,
  username: 'synthetic-mail',
  password: 'TEST-SMTP-SECRET-ONLY',
};
beforeAll(async () => {
  fixture = await startTestDatabase();
});
afterAll(async () => {
  await fixture?.stop();
});
async function actor(root = false, projectId: string = randomUUID()): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects(id,name) VALUES($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, `Project ${projectId.slice(0, 8)}`],
  );
  const person: User = {
    id: randomUUID(),
    projectId,
    email: `${randomUUID()}@example.test`,
    displayName: 'Settings administrator',
    role: 'admin',
    instanceAdmin: root,
  };
  await fixture.db.query(
    "INSERT INTO users(id,project_id,email,display_name,role,password_hash,instance_admin) VALUES($1,$2,$3,$4,'admin','unusable-test-hash',$5)",
    [person.id, projectId, person.email, person.displayName, root],
  );
  return person;
}

describe('Integration settings', () => {
  it('encrypts credentials with scope/version binding, hides them from responses and audits, and requires instance authority for SMTP', async () => {
    const root = await actor(true);
    const admin = await actor(false, root.projectId);
    const settings = new IntegrationSettingsService(fixture.db, cipher, probe);
    const previous = (await settings.list(root)).find(
      (item) => item.kind === 'smtp' && item.environment === 'quality',
    );
    const input = {
      scope: 'instance',
      environment: 'quality',
      expectedVersion: previous?.version ?? 0,
      values,
    };
    await expect(settings.save(admin, input)).rejects.toMatchObject({ status: 403 });
    const saved = await settings.save(root, input);
    expect(saved).toMatchObject({
      status: 'draft',
      secretConfigured: true,
      version: input.expectedVersion + 1,
    });
    expect(JSON.stringify(saved)).not.toContain(values.password);
    expect(saved.values).not.toHaveProperty('password');
    const row = (
      await fixture.db.query<{ values_ciphertext: string }>(
        'SELECT values_ciphertext FROM integration_settings WHERE id=$1',
        [saved.id],
      )
    ).rows[0]!;
    expect(row.values_ciphertext).not.toContain(values.password);
    expect(await settings.list(admin)).toEqual([]);
    await expect(settings.runtimeSmtp('quality')).rejects.toMatchObject({
      code: 'SMTP_NOT_VERIFIED',
    });
    const audit = await fixture.db.query(
      "SELECT details FROM audit_events WHERE action='integration.saved' AND actor_id=$1",
      [root.id],
    );
    expect(JSON.stringify(audit.rows)).not.toContain(values.password);
  });

  it('verifies a concrete version, preserves an omitted credential on edit, resets verification and revokes without bootstrap fallback', async () => {
    const root = await actor(true);
    const settings = new IntegrationSettingsService(fixture.db, cipher, probe);
    const previous = (await settings.list(root)).find(
      (item) => item.kind === 'smtp' && item.environment === 'quality',
    );
    const current = await settings.save(root, {
      scope: 'instance',
      environment: 'quality',
      expectedVersion: previous?.version ?? 0,
      values,
    });
    await settings.test(root, current.id, {
      expectedVersion: current.version,
    });
    expect(await settings.runtimeSmtp('quality')).toMatchObject({
      auth: { pass: values.password },
    });
    const withoutPassword: Extract<IntegrationValues, { kind: 'smtp' }> = { ...values };
    delete withoutPassword.password;
    const rotated = await settings.save(root, {
      scope: 'instance',
      environment: 'quality',
      expectedVersion: current.version,
      values: { ...withoutPassword, from: 'other@example.test' },
    });
    expect(rotated.status).toBe('draft');
    await expect(settings.runtimeSmtp('quality')).rejects.toMatchObject({
      code: 'SMTP_NOT_VERIFIED',
    });
    await settings.test(root, rotated.id, {
      expectedVersion: rotated.version,
    });
    expect(verified.at(-1)).toMatchObject({
      password: values.password,
      from: 'other@example.test',
    });
    await settings.revoke(root, rotated.id, {
      expectedVersion: rotated.version,
    });
    const runtime = new ConfiguredIdentityMail(fixture.db, settings, 'quality', {
      publicUrl: 'http://127.0.0.1:4311',
      encryptionKey: randomBytes(32).toString('base64'),
      smtp: { host: '127.0.0.1', port: 25, from: 'bootstrap@example.test' },
    });
    await expect(runtime.assertConfigured()).rejects.toMatchObject({ code: 'SMTP_NOT_VERIFIED' });
    expect(
      (
        await fixture.db.query('SELECT values_ciphertext FROM integration_settings WHERE id=$1', [
          rotated.id,
        ])
      ).rows[0]?.values_ciphertext,
    ).toBeNull();
  });

  it('rejects unauthorized endpoints before connecting and isolates project settings', async () => {
    await expect(new AuthorizedIntegrationProbe(new Set()).verify(values)).rejects.toMatchObject({
      code: 'ENDPOINT_NOT_AUTHORIZED',
    });
    const first = await actor(),
      second = await actor();
    const settings = new IntegrationSettingsService(fixture.db, cipher, probe);
    const saved = await settings.save(first, {
      scope: 'project',
      environment: 'quality',
      expectedVersion: 0,
      values: {
        kind: 'svn',
        url: 'https://svn.example.test/repository',
        username: 'reader',
        password: 'TEST-SVN-ONLY',
      },
    });
    expect(await settings.list(second)).toEqual([]);
    await expect(
      settings.test(second, saved.id, {
        expectedVersion: saved.version,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(() =>
      integrationValuesSchema.parse({ kind: 'sandbox', profileReference: 'perfil' }),
    ).toThrow();
    await expect(
      fixture.db.query(
        `INSERT INTO integration_settings
         (id,project_id,environment,kind,version,public_values,updated_by)
         VALUES($1,$2,'quality','sandbox',1,'{}',$3)`,
        [randomUUID(), first.projectId, first.id],
      ),
    ).rejects.toThrow();
  });

  it('only exposes verified project values to runtime and enforces the connector endpoint policy', async () => {
    const person = await actor();
    const settings = new IntegrationSettingsService(fixture.db, cipher, probe);
    const saved = await settings.save(person, {
      scope: 'project',
      environment: 'production',
      expectedVersion: 0,
      values: { kind: 'copilot', token: 'TEST-COPILOT-ONLY', model: 'gpt-5' },
    });
    expect(saved.environment).toBe('quality');
    expect(await settings.runtimeValues(person.projectId, 'quality', 'copilot')).toBeNull();
    await settings.test(person, saved.id, {
      expectedVersion: saved.version,
    });
    expect(await settings.runtimeValues(person.projectId, 'quality', 'copilot')).toMatchObject({
      version: saved.version,
      values: { token: 'TEST-COPILOT-ONLY', model: 'gpt-5' },
    });
    expect(await settings.runtimeValues(person.projectId, 'production', 'copilot')).toMatchObject({
      id: saved.id,
    });

    const scoped = await settings.save(person, {
      scope: 'project',
      environment: 'production',
      expectedVersion: 0,
      values: { kind: 'telemetry', url: 'https://loki.example.test' },
    });
    expect(scoped.environment).toBe('production');
    await settings.test(person, scoped.id, { expectedVersion: scoped.version });
    expect(
      await settings.runtimeValues(person.projectId, 'production', 'telemetry'),
    ).not.toBeNull();
    expect(await settings.runtimeValues(person.projectId, 'quality', 'telemetry')).toBeNull();

    const metrics = await settings.save(person, {
      scope: 'project',
      environment: 'quality',
      expectedVersion: 0,
      values: { kind: 'metrics', url: 'http://127.0.0.1:9090', matchers: 'env="quality"' },
    });
    await settings.test(person, metrics.id, { expectedVersion: metrics.version });
    expect(await settings.runtimeValues(person.projectId, 'quality', 'metrics')).toMatchObject({
      values: { url: 'http://127.0.0.1:9090', matchers: 'env="quality"' },
    });

    const policy = new AuthorizedIntegrationProbe(new Set(), {
      connectorEndpoints: new Set(['db.example.test:3306']),
      fetch: (async () => new Response('', { status: 401 })) as typeof fetch,
    });
    const database = { kind: 'database' as const, port: 3306, database: 'site', username: 'u' };
    expect(() => policy.assertAllowed({ ...database, host: '127.0.0.1' })).not.toThrow();
    expect(() => policy.assertAllowed({ ...database, host: 'db.example.test' })).not.toThrow();
    expect(() => policy.assertAllowed({ ...database, host: 'db.other.test' })).toThrow(
      'ZEROOPS_CONNECTOR_ALLOWED_ENDPOINTS',
    );
    expect(() =>
      policy.assertAllowed({ kind: 'telemetry', url: 'https://loki.other.test' }),
    ).toThrow('ZEROOPS_CONNECTOR_ALLOWED_ENDPOINTS');
    await expect(policy.verify({ kind: 'copilot', token: 'invalid' })).rejects.toMatchObject({
      code: 'COPILOT_TOKEN_INVALID',
    });
  });

  it('discards a successful probe if credentials rotate while that probe is running', async () => {
    const person = await actor();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const settings = new IntegrationSettingsService(fixture.db, cipher, {
      assertAllowed() {},
      async verify() {
        started();
        await gate;
      },
    });
    const input = {
      scope: 'project',
      environment: 'quality',
      expectedVersion: 0,
      values: { kind: 'telemetry', url: 'https://telemetry.example.test', token: 'TEST-OLD-TOKEN' },
    };
    const saved = await settings.save(person, input);
    const testing = settings.test(person, saved.id, {
      expectedVersion: 1,
    });
    await ready;
    await settings.save(person, {
      ...input,
      expectedVersion: 1,
      values: { ...input.values, token: 'TEST-ROTATED-TOKEN' },
    });
    release();
    await expect(testing).rejects.toMatchObject({ code: 'STALE_VERSION' });
    expect((await settings.list(person))[0]).toMatchObject({
      version: 2,
      status: 'draft',
      testCode: null,
    });
  });
});
