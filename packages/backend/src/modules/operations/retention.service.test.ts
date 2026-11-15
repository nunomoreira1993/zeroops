import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { createFlowActionRegistry } from '../incidents/incident.module.js';
import { FlowEngine } from '../flows/flow-engine.js';
import { FlowsService } from '../flows/flows.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { RetentionService, retentionPolicyFromEnv } from './retention.service.js';

/** P11 — retenção: dry-run com hash, nada de trabalho ativo, de outros projetos ou de gates. */

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let flows: FlowsService;
let tickets: TicketsService;
let retention: RetentionService;

beforeAll(async () => {
  fixture = await startTestDatabase();
  flows = new FlowsService(
    fixture.db,
    new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db)),
  );
  tickets = new TicketsService(fixture.db);
  retention = new RetentionService(fixture.db, {
    jobEventsDays: 30,
    simulationsDays: 30,
    outboxDays: 30,
    runDeltasDays: 30,
  });
});
afterAll(async () => fixture?.stop());

async function member(projectId: string, role: Role): Promise<User> {
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    email: `${randomUUID()}@example.test`,
    displayName: `Pessoa ${role}`,
  };
  await fixture.db.query(
    'INSERT INTO users(id,project_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, 'unusable-test-hash'],
  );
  return actor;
}

const count = async (sql: string, params: unknown[]) =>
  Number((await fixture.db.query<{ total: number }>(sql, params)).rows[0]?.total ?? 0);

async function seeded() {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [id, `P11r ${id}`]);
  const admin = await member(id, 'admin');
  const technical = await member(id, 'technical');
  const ticket = await tickets.create(admin, {
    title: 'Pedido para retenção',
    description: 'Pedido usado para semear dados antigos.',
    category: 'bug',
    environment: 'quality',
    priority: 'low',
  });
  const run = async (status: string) => {
    const runId = randomUUID();
    await fixture.db.query(
      `INSERT INTO agent_runs(id,ticket_id,project_id,requested_by,status,ticket_version,created_at,finished_at)
       VALUES($1,$2,$3,$4,$5,1,NOW(3) - INTERVAL 90 DAY,
         IF($5 IN ('queued','running'),NULL,NOW(3) - INTERVAL 90 DAY))`,
      [runId, ticket.id, id, admin.id, status],
    );
    await fixture.db.query(
      `INSERT INTO agent_job_events(job_kind,job_id,project_id,ticket_id,event_type,created_at)
       VALUES('agent_run',$1,$2,$3,'claimed',NOW(3) - INTERVAL 90 DAY)`,
      [runId, id, ticket.id],
    );
    const event = (type: string, payload: unknown) =>
      fixture.db.query(
        'INSERT INTO agent_run_events(run_id,type,payload,created_at) VALUES($1,$2,$3,NOW(3) - INTERVAL 90 DAY)',
        [runId, type, JSON.stringify(payload)],
      );
    await event('assistant.delta', { messageId: 'm1', text: 'Ol' });
    await event('assistant.delta', { messageId: 'm1', text: 'á' });
    await event('assistant.message', { messageId: 'm1', text: 'Olá' });
    // Mensagem interrompida: os fragmentos são o único registo e ficam.
    await event('assistant.delta', { messageId: 'm2', text: 'parcial' });
    return runId;
  };
  const done = await run('succeeded');
  const active = await run('running');

  const general = (await flows.list(admin, id)).find((flow) => flow.template === 'general')!;
  const simulation = async (manifestHash: string, ago: number, status = 'completed') => {
    const simId = randomUUID();
    await fixture.db.query(
      `INSERT INTO flow_simulation_runs(id,project_id,flow_id,scenario_name,scenario_spec,level,status,
        definition_hash,routing_hash,manifest_hash,scenario_hash,run_input,idempotency_key,created_at)
       VALUES($1,$2,$3,'Cenário','{}','structural',$4,$5,$5,$6,$5,'{}',$7,NOW(3) - INTERVAL $8 DAY)`,
      [simId, id, general.id, status, 'a'.repeat(64), manifestHash, randomUUID(), ago],
    );
    return simId;
  };
  const oldSim = await simulation('b'.repeat(64), 90);
  const runningSim = await simulation('c'.repeat(64), 80, 'running');
  const latestSim = await simulation('d'.repeat(64), 60);

  const outbox = async (state: 'sent' | 'failed') => {
    const outboxId = randomUUID();
    await fixture.db.query(
      `INSERT INTO notification_outbox(id,topic,payload,status,created_at)
       VALUES($1,'ticket.updated',$2,$3,NOW(3) - INTERVAL 90 DAY)`,
      [outboxId, JSON.stringify({ ticketId: ticket.id }), state],
    );
    await fixture.db.query(
      `INSERT INTO notification_delivery_state(outbox_id,state) VALUES($1,$2)
       ON DUPLICATE KEY UPDATE state=VALUES(state)`,
      [outboxId, state],
    );
    return outboxId;
  };
  const sent = await outbox('sent');
  const failed = await outbox('failed');
  return { id, admin, technical, done, active, oldSim, runningSim, latestSim, sent, failed };
}

describe('retenção operacional (P11)', () => {
  it('seleciona só recursos terminados do projeto e exige o hash do dry-run', async () => {
    const p = await seeded();
    const other = await seeded();

    await expect(retention.plan(p.technical, p.id)).rejects.toMatchObject({ status: 403 });
    await expect(retention.plan(p.admin, other.id)).rejects.toMatchObject({ status: 403 });
    await expect(retention.plan(p.admin, null)).rejects.toMatchObject({ status: 403 });

    const plan = await retention.plan(p.admin, p.id);
    const item = (entity: string) => plan.items.find((entry) => entry.entity === entity)!;
    expect(item('agent_job_events').selected).toBe(1);
    expect(item('flow_simulation_runs').sample).toEqual([p.oldSim]);
    expect(item('notification_outbox').sample).toEqual([p.sent]);
    expect(item('run_deltas').selected).toBe(2);

    await expect(retention.apply(p.admin, { projectId: p.id, expect: 'x' })).rejects.toMatchObject({
      code: 'STALE_SELECTION',
    });

    const result = await retention.apply(p.admin, { projectId: p.id, expect: plan.digest });
    expect(result.removed).toEqual({
      agent_job_events: 1,
      flow_simulation_runs: 1,
      notification_outbox: 1,
      run_deltas: 2,
    });

    // Trabalho ativo, falhas por recuperar e a mensagem interrompida ficam.
    expect(
      await count('SELECT COUNT(*) AS total FROM agent_job_events WHERE job_id=$1', [p.active]),
    ).toBe(1);
    expect(
      await count('SELECT COUNT(*) AS total FROM flow_simulation_runs WHERE id IN ($1,$2)', [
        p.runningSim,
        p.latestSim,
      ]),
    ).toBe(2);
    expect(
      await count('SELECT COUNT(*) AS total FROM notification_outbox WHERE id=$1', [p.failed]),
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS total FROM agent_run_events WHERE run_id=$1 AND type<>'assistant.delta'`,
        [p.done],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS total FROM agent_run_events WHERE run_id=$1 AND type='assistant.delta'`,
        [p.done],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS total FROM agent_run_events WHERE run_id=$1 AND type='assistant.delta'`,
        [p.active],
      ),
    ).toBe(3);
    // O outro projeto não foi tocado.
    expect(
      await count('SELECT COUNT(*) AS total FROM agent_job_events WHERE project_id=$1', [other.id]),
    ).toBe(2);
    expect(
      await count('SELECT COUNT(*) AS total FROM notification_outbox WHERE id=$1', [other.sent]),
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS total FROM audit_events WHERE action='ops.retention' AND actor_id=$1`,
        [p.admin.id],
      ),
    ).toBe(1);

    // Repetir não remove mais nada.
    const again = await retention.plan(p.admin, p.id);
    expect(again.items.every((entry) => entry.selected === 0)).toBe(true);
  });

  it('protege evidência de versões publicadas e permite desativar cada política', async () => {
    const p = await seeded();
    const general = (await flows.list(p.admin, p.id)).find((flow) => flow.template === 'general')!;
    const current = await flows.get(p.admin, p.id, general.id);
    await flows.publish(p.admin, p.id, general.id, { expectedDraftVersion: current.draftVersion });
    const pinned = await fixture.db.query(
      `UPDATE flow_versions SET manifest_hash=$1 WHERE flow_id=$2`,
      ['b'.repeat(64), general.id],
    );
    expect(pinned.rowCount).toBeGreaterThan(0);
    const plan = await retention.plan(p.admin, p.id);
    expect(plan.items.find((entry) => entry.entity === 'flow_simulation_runs')!.selected).toBe(0);

    const disabled = new RetentionService(
      fixture.db,
      retentionPolicyFromEnv({ ZEROOPS_RETENTION_JOB_EVENTS_DAYS: '0' }),
    );
    const off = await disabled.plan(p.admin, p.id);
    expect(off.items.find((entry) => entry.entity === 'agent_job_events')).toMatchObject({
      disabled: true,
      selected: 0,
    });
    expect(() => retentionPolicyFromEnv({ ZEROOPS_RETENTION_OUTBOX_DAYS: '-1' })).toThrow();
  });
});
