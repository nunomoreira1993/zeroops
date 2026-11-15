import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { OperationsMetricsService } from './operations-metrics.service.js';

/** P11 — métricas operacionais: só valores registados, isolamento por projeto e só equipa. */

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let metrics: OperationsMetricsService;
let tickets: TicketsService;

beforeAll(async () => {
  fixture = await startTestDatabase();
  metrics = new OperationsMetricsService(fixture.db);
  tickets = new TicketsService(fixture.db);
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

async function seededProject() {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [id, `P11m ${id}`]);
  const admin = await member(id, 'admin');
  const client = await member(id, 'client');
  const technical = await member(id, 'technical');
  const ticket = await tickets.create(client, {
    title: 'Pedido para métricas',
    description: 'Pedido usado para semear métricas operacionais.',
    category: 'incident',
    environment: 'quality',
    priority: 'high',
  });
  const run = randomUUID();
  await fixture.db.query(
    `INSERT INTO agent_runs(id,ticket_id,project_id,requested_by,status,ticket_version,error_code,
      created_at,started_at,finished_at)
     VALUES($1,$2,$3,$4,'failed',1,'COPILOT_TIMEOUT',NOW(3) - INTERVAL 10 SECOND,
      NOW(3) - INTERVAL 6 SECOND,NOW(3))`,
    [run, ticket.id, id, admin.id],
  );
  const event = (type: string, payload: unknown) =>
    fixture.db.query('INSERT INTO agent_run_events(run_id,type,payload) VALUES($1,$2,$3)', [
      run,
      type,
      JSON.stringify(payload),
    ]);
  await event('usage', { model: 'gpt-x', inputTokens: 100, outputTokens: 10, aiCredits: null });
  await event('usage', { model: 'gpt-x', inputTokens: 50, outputTokens: 5 });
  await event('question', { id: 'q1', kind: 'ask_user', question: 'Qual ambiente?' });
  await fixture.db.query(
    `INSERT INTO agent_run_tool_calls(id,run_id,tool,request,outcome,duration_ms,error_code)
     VALUES($1,$2,'site_query','{}','error',40,'TIMEOUT'),($3,$2,'site_query','{}','ok',20,NULL)`,
    [randomUUID(), run, randomUUID()],
  );
  await fixture.db.query(
    `INSERT INTO agent_job_events(job_kind,job_id,project_id,ticket_id,attempt,lease_epoch,worker_id,event_type)
     VALUES('agent_run',$1,$2,$3,2,3,'w1','lease_lost'),('agent_run',$1,$2,$3,1,1,'w1','claimed')`,
    [run, id, ticket.id],
  );
  return { id, admin, client, technical, ticket, run, event };
}

async function incident(projectId: string, author: User, title: string, ago: string) {
  const ticket = await tickets.create(author, {
    title: `Alerta ${title}`,
    description: 'Incidente de saúde semeado para métricas.',
    category: 'incident',
    environment: 'quality',
    priority: 'high',
  });
  await fixture.db.query(
    `INSERT INTO health_incidents(ticket_id,project_id,environment,root_alert_id,root_title,state,
      opened_at,recovered_at)
     VALUES($1,$2,'quality',$3,$4,'recovered',NOW(3) - INTERVAL ${ago},
      NOW(3) - INTERVAL ${ago} + INTERVAL 120 SECOND)`,
    [ticket.id, projectId, randomUUID(), title],
  );
}

let flowPriority = 0;

async function validationStep(projectId: string, author: User, port: string, unknown: boolean) {
  const ticket = await tickets.create(author, {
    title: 'Validação de recuperação',
    description: 'Passo de validação Health semeado para métricas.',
    category: 'incident',
    environment: 'quality',
    priority: 'high',
  });
  const [flow, version, execution] = [randomUUID(), randomUUID(), randomUUID()];
  await fixture.db.query(
    `INSERT INTO flows(id,project_id,name,priority,flow_match,flow_definition)
     VALUES($1,$2,$3,$4,'{}','{}')`,
    [flow, projectId, `Saúde ${flow.slice(0, 8)}`, 100 + ++flowPriority],
  );
  await fixture.db.query(
    `INSERT INTO flow_versions(id,flow_id,project_id,number,flow_definition,logic_hash)
     VALUES($1,$2,$3,1,'{}',$4)`,
    [version, flow, projectId, '0'.repeat(64)],
  );
  await fixture.db.query(
    'INSERT INTO flow_executions(id,ticket_id,project_id,flow_id,version_id) VALUES($1,$2,$3,$4,$5)',
    [execution, ticket.id, projectId, flow, version],
  );
  const measurement = unknown
    ? { at: '2030-01-01T00:00:00Z', ok: false, unknown: true, detail: 'Sem telemetria' }
    : { at: '2030-01-01T00:00:00Z', ok: true, detail: 'ok' };
  await fixture.db.query(
    `INSERT INTO flow_execution_steps(id,execution_id,node_id,attempt,step_sequence,status,port,
      step_output,started_at,finished_at)
     VALUES($1,$2,'validar',1,1,'completed',$3,$4,NOW(3),NOW(3)),
       ($5,$2,'analise',1,0,'completed','failure','{"reason":"sem critério"}',NOW(3),NOW(3))`,
    [
      randomUUID(),
      execution,
      port,
      JSON.stringify({ incident: { criterion: 'service_active', measurements: [measurement] } }),
      randomUUID(),
    ],
  );
}

describe('métricas operacionais (P11)', () => {
  it('agrega apenas o que foi registado, sem inventar créditos, e correlaciona falhas', async () => {
    const p = await seededProject();
    const other = await seededProject();
    await incident(p.id, p.client, 'API lenta', '2 DAY');
    await incident(p.id, p.client, 'API lenta', '1 DAY');
    await validationStep(p.id, p.client, 'success', false);
    await validationStep(p.id, p.client, 'failure', true);
    await validationStep(other.id, other.client, 'success', false);

    await expect(metrics.summary(p.client, p.id)).rejects.toMatchObject({ status: 403 });
    await expect(metrics.summary(p.technical, other.id)).rejects.toMatchObject({ status: 403 });

    const summary = await metrics.summary(p.technical, p.id, 999);
    expect(summary.windowDays).toBe(90);
    expect(summary.queues.find((queue) => queue.kind === 'agent_run')).toMatchObject({
      failed: 1,
      started: 1,
      pending: 0,
    });
    expect(summary.queues.find((queue) => queue.kind === 'agent_run')!.meanWaitSeconds).toBeCloseTo(
      4,
      0,
    );
    expect(summary.copilot).toMatchObject({
      runsWithUsage: 1,
      modelCalls: 2,
      inputTokens: 150,
      outputTokens: 15,
      aiCredits: null,
      callsWithoutReportedCredits: 2,
      models: ['gpt-x'],
      quota: null,
    });
    expect(summary.human.agentQuestions).toBe(1);
    expect(summary.tools).toEqual([
      { tool: 'site_query', ok: 1, rejected: 0, error: 1, meanMs: 30 },
    ]);
    expect(summary.leases).toEqual([
      { eventType: 'claimed', total: 1 },
      { eventType: 'lease_lost', total: 1 },
    ]);
    expect(summary.health).toMatchObject({
      incidents: 2,
      recovered: 2,
      recurrences: 1,
      // O alerta recuperado não basta: só a validação com sucesso confirma; sem telemetria fica à parte.
      validationsConfirmed: 1,
      validationsNotConfirmed: 1,
      validationsUnknownTelemetry: 1,
    });
    expect(summary.health.meanRecoverySeconds).toBeCloseTo(120, 0);
    expect(summary.correlation.map((item) => item.kind).sort()).toEqual(
      ['job_lease', 'run_failed', 'tool_error'].sort(),
    );
    expect(summary.correlation.every((item) => item.projectId === p.id)).toBe(true);
    expect(summary.correlation.find((item) => item.kind === 'job_lease')).toMatchObject({
      ticketId: p.ticket.id,
      ticketKey: p.ticket.key,
      jobId: p.run,
      attempt: 2,
    });

    // Créditos e quota só aparecem quando o Copilot os reporta.
    await p.event('usage', { model: 'gpt-y', inputTokens: 1, outputTokens: 1, aiCredits: 0.5 });
    await p.event('quota', {
      unlimited: false,
      used: 12,
      entitlement: 300,
      remainingPercentage: 96,
      overage: 0,
      resetDate: null,
    });
    const reported = await metrics.summary(p.admin, p.id);
    expect(reported.copilot).toMatchObject({
      aiCredits: 0.5,
      callsWithoutReportedCredits: 2,
      models: ['gpt-x', 'gpt-y'],
      quota: { used: 12, entitlement: 300, remainingPercentage: 96 },
    });
    expect((await metrics.summary(other.admin, other.id)).copilot.aiCredits).toBeNull();
  });
});
