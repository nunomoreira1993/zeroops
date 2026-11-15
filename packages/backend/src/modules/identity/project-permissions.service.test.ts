import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectPermission, Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { migrationChecksums, migrateDatabase } from '../../database/migrate.js';
import { ProjectPermissionsService } from './project-permissions.service.js';
import { projectPermissionContext, requireProjectPermission } from './project-permissions.js';
import { isProjectAdminContext, requireProjectAdmin } from './membership.js';
import { FlowsService } from '../flows/flows.service.js';
import { FlowEngine } from '../flows/flow-engine.js';
import { createFlowActionRegistry } from '../incidents/incident.module.js';
import { FlowAssistantQueue } from '../flows/flow-assistant.js';
import { AgentProfilesService } from '../agents/agent-profiles.service.js';
import { createApplication } from '../../../../../apps/api/src/application.js';
import { IdentityService } from './identity.service.js';
import { IdentityCipher } from './identity-security.js';
import { hashPassword } from './credentials.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let grants: ProjectPermissionsService;
let flows: FlowsService;
let profiles: AgentProfilesService;
beforeAll(async () => {
  fixture = await startTestDatabase();
  grants = new ProjectPermissionsService(fixture.db);
  flows = new FlowsService(
    fixture.db,
    new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db)),
  );
  profiles = new AgentProfilesService(fixture.db);
});
afterAll(async () => fixture?.stop());

async function member(
  projectId: string,
  role: Role = 'technical',
  instanceAdmin = false,
): Promise<User> {
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    instanceAdmin,
    email: `${randomUUID()}@example.test`,
    displayName: `Membro ${role}`,
  };
  await fixture.db.query(
    'INSERT INTO users(id,project_id,email,display_name,role,password_hash,instance_admin) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      actor.id,
      projectId,
      actor.email,
      actor.displayName,
      role,
      'unusable-test-hash',
      instanceAdmin,
    ],
  );
  return actor;
}

async function project() {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [id, `Permissões ${id}`]);
  const admin = await member(id, 'admin');
  return { id, admin, delegate: await member(id), target: await member(id, 'client') };
}

async function set(
  actor: User,
  target: User,
  permissions: ProjectPermission[],
  expectedVersion?: number,
) {
  return grants.update(actor, target.projectId, {
    userId: target.id,
    permissions,
    expectedVersion:
      expectedVersion ?? (await grants.access(actor, target.projectId)).project.version,
  });
}

describe('Project permission grants', () => {
  it('validates persistent membership, ignores forged privilege flags and does not promote delegates', async () => {
    const p = await project(),
      other = await project();
    await expect(
      grants.access({ ...p.delegate, role: 'admin', instanceAdmin: true }, p.id),
    ).resolves.toMatchObject({ isAdmin: false, permissions: [] });
    await set(p.admin, p.delegate, ['flows.edit']);
    const context = await requireProjectPermission(fixture.db, p.delegate, p.id, 'flows.view');
    expect(context.actor.role).toBe('technical');
    expect(isProjectAdminContext(context.actor)).toBe(false);
    await expect(requireProjectAdmin(fixture.db, context.actor, p.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(grants.access(p.delegate, other.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      grants.update(p.admin, p.id, {
        userId: other.target.id,
        permissions: [],
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(await grants.access(p.target, p.id))).not.toMatch(
      /password_hash|email|ciphertext/,
    );
  });

  it('requires management and effective delegable capabilities, preserving grants it cannot change', async () => {
    const p = await project();
    await set(p.admin, p.delegate, ['flows.edit']);
    await expect(set(p.delegate, p.target, ['flows.edit'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await set(p.admin, p.delegate, ['project.permissions.manage', 'flows.edit']);
    await set(p.admin, p.target, ['project.permissions.manage']);
    await expect(
      set(p.delegate, p.target, ['project.permissions.manage', 'flows.edit']),
    ).resolves.toBeDefined();
    await expect(set(p.delegate, p.target, ['flows.edit'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      set(p.delegate, p.target, ['project.permissions.manage', 'flows.edit', 'flows.activate']),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      set(p.delegate, p.delegate, ['project.permissions.manage', 'flows.edit', 'flows.activate']),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(set(p.delegate, p.admin, ['flows.view'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const root = await member(p.id, 'client', true);
    await expect(set(p.delegate, root, ['flows.view'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      grants.update(p.admin, p.id, {
        userId: p.target.id,
        expectedVersion: 3,
        permissions: ['flows.edit'],
        instanceAdmin: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      grants.update(p.admin, p.id, {
        userId: p.target.id,
        expectedVersion: 3,
        permissions: ['production.deploy'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('revokes immediately in the same actor context, keeps third-party grants and audits differences atomically', async () => {
    const p = await project();
    await set(p.admin, p.delegate, ['project.permissions.manage', 'flows.edit']);
    await set(p.delegate, p.target, ['flows.edit']);
    await set(p.admin, p.delegate, ['project.permissions.manage']);
    await expect(
      requireProjectPermission(fixture.db, p.delegate, p.id, 'flows.edit'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(set(p.delegate, p.target, [])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await grants.access(p.target, p.id)).permissions).toEqual(
      expect.arrayContaining(['flows.view', 'flows.edit']),
    );
    const before = (await grants.access(p.admin, p.id)).project.version;
    await set(p.admin, p.delegate, ['project.permissions.manage']);
    expect((await grants.access(p.admin, p.id)).project.version).toBe(before);
    const events = (
      await fixture.db.query<{
        actor_id: string;
        details: { projectId: string; userId: string; granted: string[]; revoked: string[] };
      }>(
        "SELECT actor_id,details FROM audit_events WHERE action='identity.project.permissions.changed'",
      )
    ).rows.filter((row) => row.details.projectId === p.id);
    expect(events).toHaveLength(3);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_id: p.delegate.id,
          details: expect.objectContaining({
            userId: p.target.id,
            granted: ['flows.edit'],
            revoked: [],
          }),
        }),
        expect.objectContaining({
          actor_id: p.admin.id,
          details: expect.objectContaining({
            userId: p.delegate.id,
            granted: [],
            revoked: ['flows.edit'],
          }),
        }),
      ]),
    );
    await set(p.admin, p.delegate, []);
    await expect(grants.list(p.delegate, p.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('serializes competing grant updates and rejects the stale revision without lost updates', async () => {
    const p = await project();
    const version = (await grants.access(p.admin, p.id)).project.version;
    const results = await Promise.allSettled([
      set(p.admin, p.target, ['flows.edit'], version),
      set(p.admin, p.target, ['flows.activate'], version),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toMatchObject({
      code: 'STALE_VERSION',
      status: 409,
    });
    expect(
      (await grants.list(p.admin, p.id)).members.find((row) => row.id === p.target.id)?.permissions,
    ).toHaveLength(1);
  });

  it('preserves administration without synthetic memberships and rejects disabled/archived access', async () => {
    const p = await project(),
      rootProject = await project();
    const root = await member(rootProject.id, 'client', true);
    await expect(grants.access(root, p.id)).resolves.toMatchObject({ isAdmin: true });
    await set(root, p.target, ['flows.edit']);
    expect(
      (
        await fixture.db.query(
          'SELECT user_id FROM project_memberships WHERE user_id=$1 AND project_id=$2',
          [root.id, p.id],
        )
      ).rowCount,
    ).toBe(0);
    await fixture.db.query(
      'UPDATE project_memberships SET disabled=true WHERE user_id=$1 AND project_id=$2',
      [p.target.id, p.id],
    );
    await expect(grants.access(p.target, p.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await fixture.db.query('UPDATE users SET disabled=true WHERE id=$1', [p.delegate.id]);
    await expect(grants.access(p.delegate, p.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await fixture.db.query('UPDATE projects SET archived=true WHERE id=$1', [p.id]);
    await expect(grants.access(p.admin, p.id)).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
  });

  it('supports migration replay, journal checksums and scoped foreign keys without data loss', async () => {
    const p = await project(),
      other = await project();
    await set(p.admin, p.target, ['flows.view']);
    const migration = new URL(
      '../../../../../sql/034_project_permission_grants.sql',
      import.meta.url,
    );
    const sql = await readFile(migration, 'utf8');
    await fixture.db.query(sql);
    await fixture.db.query(sql);
    await migrateDatabase(
      fixture.url,
      fileURLToPath(new URL('../../../../../sql/', import.meta.url)),
    );
    const journal = (
      await fixture.db.query<{ checksum: string }>(
        "SELECT checksum FROM zeroops_migrations WHERE name='034_project_permission_grants.sql'",
      )
    ).rows[0];
    expect(journal?.checksum).toBe(migrationChecksums(sql).checksum);
    await expect(
      fixture.db.query(
        'INSERT INTO project_permission_grants(user_id,project_id,permission,granted_by) VALUES($1,$2,$3,$4)',
        [other.target.id, p.id, 'flows.view', p.admin.id],
      ),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    expect((await grants.access(p.target, p.id)).permissions).toEqual(['flows.view']);
  });

  it('exposes scoped HTTP access/grants without opening administration and rechecks revocation with CSRF intact', async () => {
    const p = await project(),
      other = await project();
    const password = 'Synthetic-permissions-fixture-123!';
    await fixture.db.query('UPDATE users SET password_hash=$2,mfa_opt_out=true WHERE id=$1', [
      p.delegate.id,
      await hashPassword(password),
    ]);
    const key = randomBytes(32).toString('base64');
    const mail = { assertConfigured() {}, async enqueue() {} };
    const identity = new IdentityService(fixture.db, new IdentityCipher(key), mail);
    const session = await identity.login(p.delegate.email, password);
    await set(p.admin, p.delegate, ['project.permissions.manage', 'flows.edit']);
    const app = await createApplication(
      fixture.db,
      { publicUrl: 'http://127.0.0.1' },
      { encryptionKey: key, mail },
    );
    await app.listen(0, '127.0.0.1');
    const server: Server = app.getHttpServer();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP port.');
    const base = `http://127.0.0.1:${address.port}/api`;
    const headers = {
      Cookie: `zeroops_session=${session.token}`,
      Origin: 'http://127.0.0.1',
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken,
    };
    try {
      expect((await fetch(`${base}/projects/${p.id}/access`)).status).toBe(401);
      const access = await fetch(`${base}/projects/${p.id}/access`, { headers });
      expect(access.status).toBe(200);
      expect(await access.json()).toMatchObject({ isAdmin: false, project: { id: p.id } });
      expect((await fetch(`${base}/projects/${other.id}/access`, { headers })).status).toBe(403);
      expect((await fetch(`${base}/project-admin/${p.id}/users`, { headers })).status).toBe(403);
      const before = (await grants.list(p.admin, p.id)).version;
      const body = JSON.stringify({
        userId: p.target.id,
        expectedVersion: before,
        permissions: ['flows.edit'],
      });
      expect(
        (
          await fetch(`${base}/projects/${p.id}/permissions`, {
            method: 'POST',
            headers: {
              Cookie: headers.Cookie,
              Origin: headers.Origin,
              'Content-Type': 'application/json',
            },
            body,
          })
        ).status,
      ).toBe(403);
      expect(
        (await fetch(`${base}/projects/${p.id}/permissions`, { method: 'POST', headers, body }))
          .status,
      ).toBe(201);
      expect(
        (await fetch(`${base}/projects/${p.id}/permissions`, { method: 'POST', headers, body }))
          .status,
      ).toBe(409);
      await set(p.admin, p.delegate, []);
      expect((await fetch(`${base}/projects/${p.id}/permissions`, { headers })).status).toBe(403);
      expect(
        (
          await fetch(`${base}/project-admin/${p.id}/flows`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: 'Revogado', template: 'blank' }),
          })
        ).status,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('P01 functional gates', () => {
  it('prevents read/edit-only bootstrap, activation and alert associations; routing edits stay in the draft', async () => {
    const p = await project();
    await set(p.admin, p.delegate, ['flows.edit']);
    expect(await flows.list(p.delegate, p.id)).toEqual([]);
    expect(await profiles.list(p.delegate, p.id)).toEqual([]);
    await expect(
      flows.create(p.delegate, p.id, { name: 'Primeiro', template: 'blank' }),
    ).rejects.toMatchObject({ code: 'FLOW_INITIALIZATION_REQUIRED' });
    await expect(
      flows.createAlertFlow(p.delegate, p.id, { alertKey: 'prometheus:EspacoDiscoBaixo' }),
    ).rejects.toMatchObject({ code: 'FLOW_INITIALIZATION_REQUIRED' });
    expect(
      (await fixture.db.query('SELECT id FROM flow_versions WHERE project_id=$1', [p.id])).rowCount,
    ).toBe(0);
    const list = await flows.list(p.admin, p.id);
    // P02: a inicialização pelo administrador cria apenas rascunhos.
    expect(list.every((flow) => flow.published === null && flow.active === null)).toBe(true);
    expect(
      (await fixture.db.query('SELECT id FROM flow_versions WHERE project_id=$1', [p.id])).rowCount,
    ).toBe(0);
    const detail = await flows.get(p.delegate, p.id, list[0]!.id);
    await flows.saveSettings(p.delegate, p.id, detail.id, {
      name: 'Nome atualizado',
      description: 'Metadados',
      priority: detail.priority,
      isDefault: detail.isDefault,
      match: detail.match,
    });
    const routed = await flows.saveSettings(p.delegate, p.id, detail.id, {
      name: 'Nome atualizado',
      description: 'Metadados',
      priority: 500,
      isDefault: detail.isDefault,
      match: detail.match,
    });
    expect(routed.priority).toBe(500);
    expect(routed.active).toBeNull();
    expect(routed.draftVersion).toBe(detail.draftVersion + 1);
    const alertDraft = await flows.createAlertFlow(p.delegate, p.id, {
      alertKey: 'prometheus:EspacoDiscoBaixo',
    });
    expect(alertDraft.published).toBeNull();
    expect(alertDraft.pendingAlertKeys).toEqual(['prometheus:EspacoDiscoBaixo']);
    expect(
      (await fixture.db.query('SELECT 1 FROM health_alert_flows WHERE project_id=$1', [p.id]))
        .rowCount,
    ).toBe(0);
    await expect(
      flows.linkAlertFlow(p.delegate, p.id, {
        alertKey: 'prometheus:EspacoDiscoBaixo',
        flowId: detail.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      flows.publish(p.delegate, p.id, detail.id, { expectedDraftVersion: routed.draftVersion }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(flows.simulationTickets(p.delegate, p.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await set(p.admin, p.delegate, ['flows.simulate']);
    expect(await flows.simulationTickets(p.delegate, p.id)).toEqual([]);
    await expect(
      flows.saveDraft(p.delegate, p.id, detail.id, {
        expectedDraftVersion: routed.draftVersion,
        definition: detail.draft,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await set(p.admin, p.delegate, ['flows.activate']);
    await expect(
      flows.create(p.delegate, p.id, { name: 'Sem edição', template: 'blank' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      flows.linkAlertFlow(p.delegate, p.id, {
        alertKey: 'prometheus:EspacoDiscoBaixo',
        flowId: detail.id,
      }),
    ).rejects.toMatchObject({ code: 'FLOW_NOT_PUBLISHED' });
    const activated = await flows.publish(p.delegate, p.id, detail.id, {
      expectedDraftVersion: routed.draftVersion,
    });
    expect(activated.active?.priority).toBe(500);
    await expect(
      flows.linkAlertFlow(p.delegate, p.id, {
        alertKey: 'prometheus:EspacoDiscoBaixo',
        flowId: detail.id,
      }),
    ).resolves.toBeDefined();
  });

  it('limits profile seeding and mutation to managers without granting flow edit', async () => {
    const p = await project();
    await set(p.admin, p.delegate, ['flows.view']);
    expect(await profiles.list(p.delegate, p.id)).toEqual([]);
    await set(p.admin, p.delegate, ['agents.manage']);
    const seeded = await profiles.list(p.delegate, p.id);
    expect(seeded.length).toBeGreaterThan(0);
    const definition = { ...seeded[0]!.versions[0]!.definition, name: `Perfil ${randomUUID()}` };
    const created = await profiles.create(p.delegate, p.id, definition);
    await set(p.admin, p.delegate, ['flows.edit']);
    await expect(
      profiles.create(p.delegate, p.id, { ...definition, name: 'Negado' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      profiles.addVersion(p.delegate, p.id, created.id, { expectedVersion: 1, definition }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(profiles.archive(p.delegate, p.id, created.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(profiles.list(p.delegate, p.id)).resolves.toHaveLength(seeded.length + 1);
  });

  it('rejects queued authorship after revocation and rejects applying an earlier proposal', async () => {
    const p = await project();
    await fixture.db.query(
      "INSERT INTO integration_settings(id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by) VALUES($1,$2,'quality','copilot',1,'verified','test-cipher','{}',1,$3)",
      [randomUUID(), p.id, p.admin.id],
    );
    const detail = await flows.get(p.admin, p.id, (await flows.list(p.admin, p.id))[0]!.id);
    await set(p.admin, p.delegate, ['flows.edit']);
    const queued = await flows.requestFlowAssistant(p.delegate, p.id, detail.id, {
      message: 'Alterar etapa',
    });
    await set(p.admin, p.delegate, []);
    expect(await new FlowAssistantQueue(fixture.db).claimNext()).toBeNull();
    expect(
      (await flows.flowAssistantHistory(p.admin, p.id, detail.id)).find(
        (row) => row.id === queued.id,
      ),
    ).toMatchObject({ status: 'failed', errorCode: 'authorization_revoked' });
    await expect(
      flows.resolveFlowAssistant(p.delegate, p.id, detail.id, queued.id, {
        resolution: 'discarded',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const queue = new FlowAssistantQueue(fixture.db);
    await set(p.admin, p.delegate, ['flows.edit']);
    const running = await flows.requestFlowAssistant(p.delegate, p.id, detail.id, {
      message: 'Propor outro nome',
    });
    const claimed = await queue.claimNext();
    expect(claimed?.id).toBe(running.id);
    await queue.complete(
      claimed!.lease,
      JSON.stringify({
        reply: 'Nome proposto',
        operations: [
          { type: 'update_node', id: detail.draft.start, changes: { label: 'Nome proposto' } },
        ],
      }),
    );
    expect(
      (await flows.flowAssistantHistory(p.admin, p.id, detail.id)).find(
        (row) => row.id === running.id,
      ),
    ).toMatchObject({ status: 'succeeded', resolution: 'pending' });
    await set(p.admin, p.delegate, []);
    await expect(
      flows.resolveFlowAssistant(p.delegate, p.id, detail.id, running.id, {
        resolution: 'accepted',
        expectedDraftVersion: detail.draftVersion,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await flows.get(p.admin, p.id, detail.id)).draftVersion).toBe(detail.draftVersion);
    const context = await projectPermissionContext(fixture.db, p.delegate, p.id);
    expect(context.permissions).toEqual([]);
  });
});
