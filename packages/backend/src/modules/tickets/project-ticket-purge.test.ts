import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  healthSettingsSchema,
  type User,
  type HealthStatus,
} from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import {
  ProjectTicketPurge,
  type TicketPurgeTarget,
  type TicketPurgeReport,
} from './project-ticket-purge.js';
import { ticketPurgeProtocol, type TicketPurgeReadiness } from './ticket-purge-readiness.js';
import { TicketsService } from './tickets.service.js';
import { healthOccurrenceSuppressed } from './ticket-purge-health.js';
import { FlowEngine } from '../flows/flow-engine.js';
import { HealthRepository } from '../health/health.repository.js';
import { HealthTickets } from '../health/health-tickets.js';
import { HealthMonitor } from '../health/health-monitor.js';
import { HealthIncidents } from '../health/health-incidents.js';
import { HealthIncidentLifecycle } from '../health/health-incident-lifecycle.js';
import { AgentRunsService } from '../agents/agent-runs.service.js';
import { FlowAssistantQueue } from '../flows/flow-assistant.js';
import { dispatchOutbox } from '../notifications/outbox.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let service: ProjectTicketPurge;
let tickets: TicketsService;
beforeAll(async () => {
  fixture = await startTestDatabase();
  service = new ProjectTicketPurge(fixture.db);
  tickets = new TicketsService(fixture.db);
});
afterAll(async () => fixture?.stop());

async function readiness(report: TicketPurgeReport): Promise<TicketPurgeReadiness> {
  const lease = await service.quiesce(report.target);
  const now = Date.now();
  const approvedRevision = 'a'.repeat(40);
  const validUntil = new Date(now + 240000).toISOString();
  return {
    protocol: ticketPurgeProtocol,
    target: report.target,
    scopeDigest: report.digest,
    runtimeFingerprint: report.runtimeFingerprint,
    approvedRevision,
    checkedAt: new Date(now).toISOString(),
    validUntil,
    deploymentAuthorized: true,
    processInventoryEvidenceSha256: 'b'.repeat(64),
    allRuntimeInstancesCovered: true,
    legacyRuntimeInstances: 0,
    runtimes: (['api', 'worker', 'executor'] as const).map((role) => ({
      role,
      instances: [
        {
          instanceId: `${role}-fixture`,
          revision: approvedRevision,
          runtimeFingerprint: report.runtimeFingerprint,
          deployedAt: new Date(now - 120000).toISOString(),
          startedAt: new Date(now - 60000).toISOString(),
        },
      ],
    })),
    quiescence: {
      leaseId: lease.leaseId,
      heldUntil: lease.heldUntil,
      ticketWritesBlocked: true,
      ticketExecutorsPaused: true,
      activeTicketProcesses: 0,
      healthCollectionContinuing: true,
      healthEmailDeliveryContinuing: true,
      evidenceSha256: 'c'.repeat(64),
    },
    artifacts: {
      inventoryComplete: true,
      exclusiveTicketArtifactsRemaining: 0,
      orphanTicketWorkspaces: 0,
      externalTicketQueueItemsRemaining: 0,
      evidenceSha256: 'd'.repeat(64),
    },
  };
}

async function scenario() {
  const projectId = randomUUID();
  await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [projectId, 'Pizza Hut']);
  const actor: User = {
    id: randomUUID(),
    projectId,
    displayName: 'Purge admin',
    role: 'admin',
    email: `${randomUUID()}@example.test`,
  };
  await fixture.db.query(
    "INSERT INTO users(id,project_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,'admin','invalid')",
    [actor.id, projectId, actor.email, actor.displayName],
  );
  const identity = (
    await fixture.db.query<{ name: string; host: string }>(
      'SELECT DATABASE() AS name,@@hostname AS host',
    )
  ).rows[0]!;
  const target: TicketPurgeTarget = {
    projectId,
    projectName: 'Pizza Hut',
    actorId: actor.id,
    databaseName: identity.name,
    databaseHost: identity.host,
  };
  const ticket = await tickets.create(actor, {
    title: 'Purge integration fixture',
    description: 'Specific ticket purge test fixture.',
    category: 'incident',
    priority: 'high',
    environment: 'quality',
  });
  const confirm = `DELETE ALL TICKETS Pizza Hut ${projectId}`;
  return { actor, target, ticket, confirm };
}

describe('isolated project ticket purge', () => {
  it('never auto-migrates manual destructive SQL', async () => {
    expect(
      (
        await fixture.db.query(
          "SELECT name FROM zeroops_migrations WHERE name LIKE '%purge_project_tickets%'",
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await fixture.db.query(
          "SELECT name FROM zeroops_migrations WHERE name='031_ticket_purge_state.sql'",
        )
      ).rowCount,
    ).toBe(1);
  });
  it('dry-runs, deletes dependents, preserves Health evidence/mail and other projects, suppresses only current occurrences', async () => {
    const { actor, target, ticket, confirm } = await scenario();
    const other = await scenario();
    await tickets.comment(actor, ticket.id, {
      body: 'Private conversation',
      visibility: 'internal',
    });
    const runId = randomUUID();
    await fixture.db.query(
      "INSERT INTO agent_runs(id,ticket_id,project_id,requested_by,status,ticket_version) VALUES($1,$2,$3,$4,'succeeded',0)",
      [runId, ticket.id, actor.projectId, actor.id],
    );
    await fixture.db.query(
      'INSERT INTO agent_run_events(run_id,type,payload) VALUES($1,\'message\',\'{"text":"private"}\')',
      [runId],
    );
    const alertId = randomUUID();
    await fixture.db.query(
      `INSERT INTO health_alerts(id,project_id,check_id,criticality,severity,summary,opened_at,ticket_id)
       VALUES($1,$2,'scheduled-jobs','critica','critical','Failure','2026-11-11 12:00:00',$3)`,
      [alertId, actor.projectId, ticket.id],
    );
    await fixture.db.query(
      `INSERT INTO health_alert_events(project_id,alert_id,kind,detail)
       VALUES($1,$2,'ticket',$3)`,
      [actor.projectId, alertId, `Linked ${ticket.id} (${ticket.key}); unrelated ${ticket.key}0`],
    );
    await fixture.db.query(
      `INSERT INTO health_notifications(id,project_id,alert_id,kind,channel,recipients,subject,body)
       VALUES($1,$2,$3,'alert','email','[]','Health evidence','Keep this exact body')`,
      [randomUUID(), actor.projectId, alertId],
    );
    await fixture.db.query(
      "INSERT INTO health_samples(project_id,check_id,status,value) VALUES($1,'scheduled-jobs','critical',1)",
      [actor.projectId],
    );
    const before = await service.dryRun(target);
    expect(before).toMatchObject({ tickets: 1, applied: false, blockers: [] });
    expect(before.deleteCounts.agent_run_events).toBe(1);
    expect(await tickets.list(actor)).toHaveLength(1);
    await expect(
      service.apply({ ...target, projectName: 'Wrong' }, before.digest, confirm),
    ).rejects.toThrow();
    const applied = await service.apply(target, before.digest, confirm, await readiness(before));
    expect(applied.applied).toBe(true);
    expect(await tickets.list(actor)).toEqual([]);
    expect((await tickets.list(other.actor)).map((row) => row.id)).toEqual([other.ticket.id]);
    const health = (
      await fixture.db.query<{ ticket_id: string | null; summary: string }>(
        'SELECT ticket_id,summary FROM health_alerts WHERE id=$1',
        [alertId],
      )
    ).rows[0]!;
    expect(health).toEqual({ ticket_id: null, summary: 'Failure' });
    const event = (
      await fixture.db.query<{ detail: string }>(
        'SELECT detail FROM health_alert_events WHERE alert_id=$1',
        [alertId],
      )
    ).rows[0]!;
    expect(event.detail).not.toContain(ticket.id);
    expect(event.detail).not.toContain(`(${ticket.key})`);
    expect(event.detail).toContain(`unrelated ${ticket.key}0`);
    expect(
      (
        await fixture.db.query<{ body: string }>(
          'SELECT body FROM health_notifications WHERE alert_id=$1',
          [alertId],
        )
      ).rows[0]!.body,
    ).toBe('Keep this exact body');
    const occurrence = { source: 'internal' as const, alertId };
    expect(await healthOccurrenceSuppressed(fixture.db, actor.projectId, occurrence)).toBe(true);
    await expect(
      tickets.create(
        actor,
        {
          title: 'Do not recreate incident',
          description: 'The same occurrence must remain suppressed.',
          category: 'incident',
          priority: 'high',
          environment: 'quality',
        },
        { healthOccurrence: occurrence },
      ),
    ).rejects.toMatchObject({ code: 'HEALTH_TICKET_SUPPRESSED' });
    await fixture.db.query('UPDATE health_alerts SET resolved_at=NOW(3) WHERE id=$1', [alertId]);
    expect(await healthOccurrenceSuppressed(fixture.db, actor.projectId, occurrence)).toBe(false);
    await fixture.db.query(
      "UPDATE health_alerts SET resolved_at=NULL,opened_at='2026-11-11 13:00:00' WHERE id=$1",
      [alertId],
    );
    expect(await healthOccurrenceSuppressed(fixture.db, actor.projectId, occurrence)).toBe(false);
    expect((await service.dryRun(target)).tickets).toBe(0);
  });

  it('rejects active work and stale scope without deleting anything', async () => {
    const { actor, target, ticket, confirm } = await scenario();
    const runId = randomUUID();
    await fixture.db.query(
      "INSERT INTO agent_runs(id,ticket_id,project_id,requested_by,status,ticket_version) VALUES($1,$2,$3,$4,'running',0)",
      [runId, ticket.id, actor.projectId, actor.id],
    );
    const before = await service.dryRun(target);
    expect(before.blockers).toEqual(['agent_runs: 1 active/uncertain']);
    await expect(service.apply(target, before.digest, confirm)).rejects.toThrow('Unsafe work');
    await fixture.db.query("UPDATE agent_runs SET status='failed' WHERE id=$1", [runId]);
    await tickets.comment(actor, ticket.id, { body: 'Scope changed', visibility: 'internal' });
    await expect(service.apply(target, before.digest, confirm)).rejects.toThrow('Scope changed');
    expect(await tickets.list(actor)).toHaveLength(1);
  });

  it('fails closed when the actual database gains an unreviewed dependent table', async () => {
    const { target } = await scenario();
    await fixture.db.query(
      `CREATE TABLE purge_unknown_child(ticket_id CHAR(36) CHARACTER SET ascii,
       FOREIGN KEY(ticket_id) REFERENCES tickets(id)) ENGINE=InnoDB`,
    );
    try {
      await expect(service.dryRun(target)).rejects.toThrow(/Unreviewed .*dependency/);
    } finally {
      await fixture.db.query('DROP TABLE purge_unknown_child');
    }
  });

  it('cleans real flow execution history while retaining published flow configuration', async () => {
    const { actor, target, confirm } = await scenario();
    const engine = new FlowEngine(fixture.db);
    const flowTickets = new TicketsService(fixture.db, [], [engine.onTicketCreated]);
    await flowTickets.create(actor, {
      title: 'Flow ticket purge fixture',
      description: 'Exercise the actual default flow and all its dependent rows.',
      category: 'question',
      priority: 'medium',
      environment: 'quality',
    });
    const before = await service.dryRun(target);
    expect(before.deleteCounts.flow_executions).toBe(1);
    expect(before.deleteCounts.flow_execution_steps).toBeGreaterThan(0);
    const configuration = (
      await fixture.db.query('SELECT id FROM flows WHERE project_id=$1', [actor.projectId])
    ).rows;
    await service.apply(target, before.digest, confirm, await readiness(before));
    expect(
      (await fixture.db.query('SELECT id FROM flows WHERE project_id=$1', [actor.projectId])).rows,
    ).toEqual(configuration);
    expect((await service.dryRun(target)).deleteCounts.flow_execution_steps).toBe(0);
  });

  it('waits for a concurrent queue claim and rejects its committed running state', async () => {
    const { actor, target, ticket, confirm } = await scenario();
    const runId = randomUUID();
    await fixture.db.query(
      "INSERT INTO agent_runs(id,ticket_id,project_id,requested_by,status,ticket_version) VALUES($1,$2,$3,$4,'queued',0)",
      [runId, ticket.id, actor.projectId, actor.id],
    );
    const before = await service.dryRun(target);
    let release!: () => void;
    let locked!: () => void;
    const lockAcquired = new Promise<void>((done) => {
      locked = done;
    });
    const releaseClaim = new Promise<void>((done) => {
      release = done;
    });
    const claim = fixture.db.transaction(async (client) => {
      await client.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [runId]);
      await client.query("UPDATE agent_runs SET status='running' WHERE id=$1", [runId]);
      locked();
      await releaseClaim;
    });
    await lockAcquired;
    const applying = service.apply(target, before.digest, confirm);
    release();
    await claim;
    await expect(applying).rejects.toThrow('Unsafe work');
    expect(await tickets.list(actor)).toHaveLength(1);
  });

  it('keeps cron collection/notification alive without recreating a purged occurrence; a new incident creates a ticket', async () => {
    const { actor, target, confirm } = await scenario();
    const repository = new HealthRepository(fixture.db);
    const gateway = new HealthTickets(fixture.db, tickets);
    let status: HealthStatus = 'critical';
    const monitor = new HealthMonitor(
      repository,
      [
        {
          name: 'purge-cron',
          checks: ['scheduled-jobs'],
          collect: async () => [
            {
              checkId: 'scheduled-jobs',
              status,
              value: 1,
              unit: 'tasks',
              summary: 'Fixture cron observation',
            },
          ],
        },
      ],
      undefined,
      gateway,
    );
    await repository.saveSettings(
      actor.projectId,
      healthSettingsSchema.parse({
        enabled: true,
        sourceEnvironment: 'quality',
      }),
      actor.id,
    );
    const at = (hours: number) => new Date(Date.UTC(2026, 10, 11, 12 + hours));
    await monitor.runCycle(actor.projectId, at(0));
    const alert = await repository.openAlert(actor.projectId, 'scheduled-jobs');
    expect(alert?.ticketId).toBeTruthy();
    const before = await service.dryRun(target);
    await service.apply(target, before.digest, confirm, await readiness(before));
    const after = await monitor.runCycle(actor.projectId, at(1));
    expect(after.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'scheduled-jobs', status: 'critical' }),
      ]),
    );
    expect(await tickets.list(actor)).toEqual([]);
    expect((await repository.openAlert(actor.projectId, 'scheduled-jobs'))?.id).toBe(alert!.id);
    status = 'ok';
    await monitor.runCycle(actor.projectId, at(2));
    status = 'critical';
    await monitor.runCycle(actor.projectId, at(3));
    expect((await repository.openAlert(actor.projectId, 'scheduled-jobs'))?.ticketId).toBeTruthy();
    expect(await tickets.list(actor)).toHaveLength(1);
  });

  it('suppresses an active external fingerprint, but opens normally after its next start timestamp', async () => {
    const { actor, target, ticket, confirm } = await scenario();
    const alertId = randomUUID();
    await fixture.db.query(
      `INSERT INTO health_external_alerts(id,project_id,fingerprint,alert_name,criticality,state,
       summary,labels,starts_at,last_received_at,ticket_id)
       VALUES($1,$2,'purge-fixture','FixtureDown','critica','firing','External fixture','{}',
       '2026-11-11 12:00:00','2026-11-11 12:00:00',$3)`,
      [alertId, actor.projectId, ticket.id],
    );
    const before = await service.dryRun(target);
    await service.apply(target, before.digest, confirm, await readiness(before));
    const incidents = new HealthIncidents(
      fixture.db,
      new HealthRepository(fixture.db),
      new HealthTickets(fixture.db, tickets),
      new HealthIncidentLifecycle(fixture.db),
    );
    const input = {
      alertId,
      linkedTicketId: null,
      environment: 'quality' as const,
      name: 'FixtureDown',
      labels: {},
      title: 'External fixture alert',
      description: 'An external incident test fixture.',
      priority: 'high' as const,
    };
    expect(await incidents.fired(actor.projectId, input)).toBeNull();
    expect(await tickets.list(actor)).toEqual([]);
    await fixture.db.query(
      "UPDATE health_external_alerts SET starts_at='2026-11-11 13:00:00' WHERE id=$1",
      [alertId],
    );
    expect(await incidents.fired(actor.projectId, input)).toMatchObject({ opened: true });
    expect(await tickets.list(actor)).toHaveLength(1);
  });

  it('requires current deployed-runtime, artifact and matching live-lease evidence on every database', async () => {
    const { actor, target, confirm } = await scenario();
    const before = await service.dryRun(target);
    await expect(service.apply(target, before.digest, confirm)).rejects.toThrow(
      'attestation required',
    );
    const proof = await readiness(before);
    const invalidProofs = [
      { ...proof, runtimeFingerprint: '0'.repeat(64) },
      { ...proof, legacyRuntimeInstances: 1 },
      { ...proof, artifacts: { ...proof.artifacts, orphanTicketWorkspaces: 1 } },
      { ...proof, quiescence: { ...proof.quiescence, healthCollectionContinuing: false } },
      { ...proof, validUntil: new Date(Date.now() - 1000).toISOString() },
      { ...proof, runtimes: [proof.runtimes[0], proof.runtimes[0], proof.runtimes[2]] },
    ];
    for (const invalid of invalidProofs)
      await expect(service.apply(target, before.digest, confirm, invalid)).rejects.toThrow();
    expect(await tickets.list(actor)).toHaveLength(1);
    await service.resume(target, proof.quiescence.leaseId);
    await expect(service.apply(target, before.digest, confirm, proof)).rejects.toThrow(
      'lease is absent',
    );
    await service.apply(target, before.digest, confirm, await readiness(before));
    expect(await tickets.list(actor)).toEqual([]);
  });

  it('enforces project-only quiescence in creation/claims/delivery while Health continues; leases cannot be replaced or stolen', async () => {
    const { actor, target, ticket } = await scenario();
    const other = await scenario();
    const runId = randomUUID();
    await fixture.db.query(
      "INSERT INTO agent_runs(id,ticket_id,project_id,requested_by,status,ticket_version) VALUES($1,$2,$3,$4,'queued',0)",
      [runId, ticket.id, actor.projectId, actor.id],
    );
    await fixture.db.query(
      `INSERT INTO flow_assistant_requests(id,project_id,scope,ticket_id,requested_by,message)
       VALUES($1,$2,'ticket',$3,$4,'Help with this fixture')`,
      [randomUUID(), actor.projectId, ticket.id, actor.id],
    );
    const lease = await service.quiesce(target);
    await expect(service.quiesce(target)).rejects.toThrow('already exists');
    await expect(service.resume(target, randomUUID())).rejects.toThrow('does not belong');
    const input = {
      title: 'Maintenance creation fixture',
      description: 'Project-only maintenance should reject this.',
      category: 'question' as const,
      priority: 'medium' as const,
      environment: 'quality' as const,
    };
    await expect(tickets.create(actor, input)).rejects.toMatchObject({
      code: 'TICKET_WORK_PAUSED',
    });
    await expect(tickets.create(other.actor, input)).resolves.toMatchObject({
      projectId: other.actor.projectId,
    });
    expect(await new AgentRunsService(fixture.db).claimNext()).toBeNull();
    expect(await new FlowAssistantQueue(fixture.db).claimNext()).toBeNull();
    const deliveredProjects: unknown[] = [];
    await dispatchOutbox(
      fixture.db,
      {
        deliver: async (_id, _topic, payload) => {
          deliveredProjects.push(payload.projectId);
          return { status: 'blocked' };
        },
      },
      100,
    );
    expect(deliveredProjects).not.toContain(actor.projectId);
    expect(deliveredProjects).toContain(other.actor.projectId);
    const repository = new HealthRepository(fixture.db);
    await repository.saveSettings(
      actor.projectId,
      healthSettingsSchema.parse({
        enabled: true,
        sourceEnvironment: 'quality',
      }),
      actor.id,
    );
    const monitor = new HealthMonitor(
      repository,
      [
        {
          name: 'maintenance-health',
          checks: ['scheduled-jobs'],
          collect: async () => [
            {
              checkId: 'scheduled-jobs',
              status: 'critical',
              value: 1,
              unit: 'tasks',
              summary: 'Still monitoring',
            },
          ],
        },
      ],
      undefined,
      new HealthTickets(fixture.db, tickets),
    );
    await monitor.runCycle(actor.projectId, new Date('2026-11-11T12:00:00Z'));
    expect((await repository.openAlert(actor.projectId, 'scheduled-jobs'))?.ticketId).toBeNull();
    expect(
      (
        await fixture.db.query('SELECT id FROM health_samples WHERE project_id=$1', [
          actor.projectId,
        ])
      ).rowCount,
    ).toBeGreaterThan(0);
    await fixture.db.query(
      'UPDATE ticket_purge_maintenance SET lease_until=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE project_id=$1',
      [actor.projectId],
    );
    await expect(tickets.create(actor, input)).resolves.toMatchObject({
      projectId: actor.projectId,
    });
    await service.resume(target, lease.leaseId);
  });
});
