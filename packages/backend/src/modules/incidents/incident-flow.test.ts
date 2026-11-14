import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IncidentPolicy, Role, User } from '../../../../contracts/src/index.js';
import { defaultIncidentPolicy } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { AgentRunsService } from '../agents/agent-runs.service.js';
import { FlowEngine } from '../flows/flow-engine.js';
import { FlowsService } from '../flows/flows.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { AlertmanagerReceiver } from '../health/alertmanager-receiver.js';
import { HealthIncidentLifecycle } from '../health/health-incident-lifecycle.js';
import { HealthIncidents } from '../health/health-incidents.js';
import { HealthTickets } from '../health/health-tickets.js';
import { incidentDemoPayload } from './incident-demo.js';
import { HealthRepository } from '../health/health.repository.js';
import { HealthSuspensions } from './health-suspension.js';
import { createFlowActionRegistry } from './incident.module.js';

/**
 * Critério de aceitação do fluxo «Incidente (Health)»: o mesmo fluxo trata disco cheio, pressão
 * de memória e falha de ligação à BD (com a causa num componente diferente do alerta), recusa
 * intervir num recurso não gerido (DB2) e usa o canal auditado do relay fora da demonstração.
 */

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let now = new Date('2031-03-01T08:00:00Z');
const clock = () => now;

function services() {
  const engine = new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db), clock);
  return {
    engine,
    tickets: new TicketsService(fixture.db, [engine.onPublicComment], [engine.onTicketCreated]),
    runs: new AgentRunsService(fixture.db, [engine.onRunFinished]),
    flows: new FlowsService(fixture.db, engine),
  };
}
let app: ReturnType<typeof services>;

beforeAll(async () => {
  fixture = await startTestDatabase();
  app = services();
});
afterAll(async () => {
  await fixture?.stop();
});

async function member(role: Role, projectId: string, name: string): Promise<User> {
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    email: `${randomUUID()}@example.test`,
    displayName: name,
  };
  await fixture.db.query(
    'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, 'unusable-test-hash'],
  );
  return actor;
}

const OPS_EMAIL = 'ops@example.test';

/** Projeto com Copilot verificado, destinatários da Saúde e política de intervenção. */
async function project(policy: Partial<IncidentPolicy> = {}) {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [id, `Incidentes ${id}`]);
  const admin = await member('admin', id, 'Ana Admin');
  await fixture.db.query(
    `INSERT INTO integration_settings
       (id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by)
     VALUES ($1,$2,'quality','copilot',1,'verified','cifrado','{}',1,$3)`,
    [randomUUID(), id, admin.id],
  );
  await fixture.db.query('INSERT INTO health_settings (project_id,config) VALUES ($1,$2)', [
    id,
    JSON.stringify({ recipients: { critica: [OPS_EMAIL] } }),
  ]);
  await fixture.db.query('INSERT INTO incident_policies (project_id,policy) VALUES ($1,$2)', [
    id,
    JSON.stringify({ ...defaultIncidentPolicy(), ...policy }),
  ]);
  return { id, admin, technical: await member('technical', id, 'Tiago Técnico') };
}

interface Scenario {
  alert: string;
  summary: string;
  labels: Record<string, string>;
  demo?: string;
}

/** Ticket de alerta da Saúde com o incidente aberto (como o recetor de alertas faria). */
async function incident(p: Awaited<ReturnType<typeof project>>, scenario: Scenario) {
  const ticket = await app.tickets.create(
    p.technical,
    {
      title: `Alerta: ${scenario.alert}`,
      description: scenario.summary,
      category: 'bug',
      environment: 'production',
      priority: 'high',
    },
    { origin: 'health' },
  );
  const alertId = randomUUID();
  await fixture.db.query(
    `INSERT INTO health_external_alerts
       (id,project_id,fingerprint,alert_name,criticality,state,summary,labels,starts_at,last_received_at,ticket_id)
     VALUES ($1,$2,$3,$4,'critica','firing',$5,$6,$7,$7,$8)`,
    [
      alertId,
      p.id,
      randomUUID().replace(/-/g, ''),
      scenario.alert,
      scenario.summary,
      JSON.stringify(scenario.labels),
      now,
      ticket.id,
    ],
  );
  await fixture.db.query(
    `INSERT INTO health_incidents (ticket_id,project_id,environment,root_alert_id,root_title,opened_at,demo_scenario)
     VALUES ($1,$2,'production',$3,$4,$5,$6)`,
    [ticket.id, p.id, alertId, scenario.alert, now, scenario.demo ?? null],
  );
  await advance(1);
  return ticket;
}

/** Avança o relógio minuto a minuto, acordando as etapas em espera. */
async function advance(minutes: number) {
  for (let index = 0; index < minutes; index += 1) {
    now = new Date(now.getTime() + 60_000);
    await app.engine.tick(100);
  }
}

/** Conclui a investigação do Copilot com o relatório estruturado. */
async function investigate(ticketId: string, text: string, report: Record<string, unknown>) {
  const run = (
    await fixture.db.query<{ id: string; instructions: string; model: string | null }>(
      "SELECT id,instructions,model FROM agent_runs WHERE ticket_id=$1 AND status='queued' AND run_trigger='flow'",
      [ticketId],
    )
  ).rows[0];
  expect(run, 'investigação do Copilot em fila').toBeDefined();
  await fixture.db.query("UPDATE agent_runs SET status='running' WHERE id=$1", [run!.id]);
  await app.runs.complete(run!.id, {
    summary: `${text}\n\n\`\`\`zeroops-incident\n${JSON.stringify(report)}\n\`\`\``,
    replyDraft: null,
    evidence: [],
  });
  return run!;
}

async function view(actor: User, ticketId: string) {
  const flow = await app.flows.ticketFlow(actor, ticketId);
  expect(flow).not.toBeNull();
  return flow!;
}

/** Percurso com o resultado detalhado de cada etapa; as saídas usadas são só sucesso ou erro. */
const path = async (actor: User, ticketId: string) => {
  const steps = (await view(actor, ticketId)).steps;
  for (const step of steps) expect([null, 'success', 'failure']).toContain(step.port);
  return steps.map((step) => [step.nodeId, step.output.result ?? step.port]);
};

async function emails(projectId: string) {
  return (
    await fixture.db.query<{ subject: string; body: string; recipients: string }>(
      'SELECT subject,body,recipients FROM health_notifications WHERE project_id=$1 ORDER BY subject',
      [projectId],
    )
  ).rows;
}

async function interventions(ticketId: string) {
  return (
    await fixture.db.query<{
      action: string;
      target: string;
      status: string;
      decision: string;
      previous_value: string | null;
      new_value: string | null;
      rollback_hint: string | null;
    }>(
      'SELECT action,target,status,decision,previous_value,new_value,rollback_hint FROM incident_interventions WHERE ticket_id=$1 ORDER BY created_at',
      [ticketId],
    )
  ).rows;
}

const services_ = (units: string[]) =>
  units.map((unit) => ({ unit, engine: null, environment: 'any' as const }));

describe('Fluxo «Incidente (Health)»', () => {
  it('o modelo de saúde é o fluxo genérico, com a investigação pelo Copilot Fusion high', async () => {
    const p = await project();
    const ticket = await incident(p, {
      alert: 'HostDiskFull',
      summary: 'Disco / a 97% em web01.',
      labels: { instance: 'web01:9100', mountpoint: '/' },
    });
    const flow = await view(p.technical, ticket.id);
    expect(flow.execution.flow.name).toBe('Incidente (Health)');
    expect(flow.next).toMatchObject({ nodeId: 'analise' });
    const run = (
      await fixture.db.query<{ instructions: string }>(
        "SELECT instructions FROM agent_runs WHERE ticket_id=$1 AND run_trigger='flow'",
        [ticket.id],
      )
    ).rows[0];
    expect(run?.instructions).toMatch(/zo-db2/);
    expect(run?.instructions).toMatch(/zeroops-incident/);
    // A etapa pede Fusion high; sem tier Fusion ativo nesta base, segue com o modelo da integração e regista porquê.
    const fallback = await fixture.db.query<{ event_details: unknown }>(
      `SELECT e.event_details FROM flow_execution_events e JOIN flow_executions x ON x.id=e.execution_id
        WHERE x.ticket_id=$1 AND e.kind='copilot_model_fallback'`,
      [ticket.id],
    );
    expect(JSON.stringify(fallback.rows[0]?.event_details)).toMatch(
      /"model":"fusion".*"fusionTier":"high"/,
    );
  });

  it('disco cheio: sem ação permitida (apagar ficheiros nunca é autorizado), escala com e-mail e atribui à equipa', async () => {
    const p = await project();
    const ticket = await incident(p, {
      alert: 'HostDiskFull',
      summary: 'Disco / a 97% em web01.',
      labels: { instance: 'web01:9100', mountpoint: '/', component: 'web01:/' },
    });
    await investigate(ticket.id, 'O /var/log/php ocupa 40 GB: rotação parada desde ontem.', {
      observations: ['/var/log/php com 40 GB', 'logrotate falhou às 03:00'],
      impact: 'Escritas de sessões PHP a falhar no site.',
      alertComponent: 'web01:/',
      causeComponent: 'logrotate em web01',
      causeConfirmed: true,
      proposedAction: null,
      nextStep: 'Corrigir a configuração do logrotate e comprimir os logs manualmente.',
    });
    // Sem intervenção: valida pelo estado do alerta, que continua ativo até ao prazo (30 min).
    expect((await view(p.technical, ticket.id)).next?.nodeId).toBe('validar');
    await advance(31);
    expect(await path(p.technical, ticket.id)).toEqual([
      ['intake', 'done'],
      ['analise', 'done'],
      ['autorizar', 'no_action'],
      ['aprovacao', 'skipped'],
      ['intervir', 'no_action'],
      ['validar', 'not_recovered'],
      ['email_escala', 'done'],
      ['atribuir', 'done'],
      ['escalado', null],
    ]);
    expect(await interventions(ticket.id)).toEqual([]);
    const [mail] = await emails(p.id);
    expect(mail?.subject).toMatch(/\[Escalado\]/);
    expect(mail?.recipients).toBe(OPS_EMAIL);
    expect(mail?.body).toMatch(/Impacto atual:\n- Escritas de sessões PHP/);
    expect(mail?.body).toMatch(/O que foi tentado:\n- Nenhuma intervenção automática/);
    expect(mail?.body).toMatch(
      /Próximo passo recomendado:\n- Corrigir a configuração do logrotate/,
    );
    const assigned = await fixture.db.query<{ user_id: string }>(
      "SELECT user_id FROM ticket_assignments WHERE ticket_id=$1 AND stage='technical'",
      [ticket.id],
    );
    expect(assigned.rows.map((row) => row.user_id)).toContain(p.technical.id);
    const state = await fixture.db.query<{ status: string }>(
      'SELECT status FROM tickets WHERE id=$1',
      [ticket.id],
    );
    expect(state.rows[0]?.status).not.toBe('resolved');
  });

  it('pressão de memória: alterar parâmetro precisa de aprovação, guarda o valor anterior e fecha com e-mail', async () => {
    const p = await project({
      services: services_(['php-fpm.service']),
      parameters: [{ unit: 'php-fpm.service', property: 'MemoryMax', allowed: ['1G', '2G'] }],
    });
    const ticket = await incident(p, {
      alert: 'HostMemoryPressure',
      summary: 'Memória disponível a 4% em web01.',
      labels: { instance: 'web01:9100', unit: 'php-fpm.service' },
      demo: 'memory',
    });
    await investigate(ticket.id, 'O php-fpm cresce sem limite e esgota a memória.', {
      observations: ['php-fpm com 7,2 GB RSS'],
      impact: 'Pedidos lentos no site.',
      alertComponent: 'web01',
      causeComponent: 'php-fpm.service',
      causeConfirmed: true,
      proposedAction: {
        action: 'set_parameter',
        target: 'php-fpm.service',
        parameter: 'MemoryMax',
        value: '2G',
        reason: 'Limitar a memória do pool.',
      },
    });
    let flow = await view(p.technical, ticket.id);
    expect(flow.next).toMatchObject({ nodeId: 'aprovacao', waitingFor: 'person', canAct: true });
    await app.flows.decide(p.technical, ticket.id, {
      stepId: flow.next!.stepId,
      port: 'success',
      idempotencyKey: randomUUID(),
    });
    await advance(3);
    expect(await path(p.technical, ticket.id)).toEqual([
      ['intake', 'done'],
      ['analise', 'done'],
      ['autorizar', 'needs_approval'],
      ['aprovacao', 'success'],
      ['intervir', 'done'],
      ['validar', 'recovered'],
      ['email_fecho', 'done'],
      ['resolvido', null],
    ]);
    expect(await interventions(ticket.id)).toEqual([
      expect.objectContaining({
        action: 'set_parameter',
        target: 'php-fpm.service',
        status: 'simulated',
        decision: 'approval',
        previous_value: 'infinity',
        new_value: '2G',
        rollback_hint: 'systemctl set-property php-fpm.service MemoryMax=infinity',
      }),
    ]);
    const [mail] = await emails(p.id);
    expect(mail?.subject).toMatch(/\[Resolvido\]/);
    expect(mail?.body).toMatch(/Causa confirmada em php-fpm\.service/);
    expect(mail?.body).toMatch(/Alterar parâmetro em php-fpm\.service MemoryMax: infinity → 2G/);
    flow = await view(p.technical, ticket.id);
    expect(flow.execution.status).toBe('completed');
  });

  it('falha na BD: o alerta vem da aplicação, a causa está no MySQL e o reinício automático recupera', async () => {
    const p = await project({ services: services_(['mariadb.service']) });
    const ticket = await incident(p, {
      alert: 'SiteDatabaseConnectionFailed',
      summary: 'O site devolve 500: SQLSTATE[HY000] [1040] Too many connections.',
      labels: { instance: 'web01', component: 'site pizzahut (web01)' },
      demo: 'mysql',
    });
    await investigate(ticket.id, 'O MySQL em db01 atingiu max_connections com ligações presas.', {
      observations: ['SHOW PROCESSLIST: 500 ligações em Sleep', 'zo-log: erro 1040 no PHP'],
      impact: 'Encomendas online indisponíveis.',
      alertComponent: 'site pizzahut (web01)',
      causeComponent: 'MySQL em db01',
      causeConfirmed: true,
      proposedAction: {
        action: 'service_restart',
        target: 'mariadb.service',
        reason: 'Libertar as ligações presas.',
      },
    });
    await advance(3);
    expect(await path(p.technical, ticket.id)).toEqual([
      ['intake', 'done'],
      ['analise', 'done'],
      ['autorizar', 'auto'],
      ['aprovacao', 'skipped'],
      ['intervir', 'done'],
      ['validar', 'recovered'],
      ['email_fecho', 'done'],
      ['resolvido', null],
    ]);
    const [mail] = await emails(p.id);
    expect(mail?.body).toMatch(
      /O alerta veio de site pizzahut \(web01\), mas a causa está em MySQL em db01\./,
    );
    expect(mail?.body).toMatch(/Reiniciar serviço em mariadb\.service: simulada/);
    const row = await fixture.db.query<{ alert_component: string; cause_component: string }>(
      'SELECT alert_component,cause_component FROM health_incidents WHERE ticket_id=$1',
      [ticket.id],
    );
    expect(row.rows[0]).toEqual({
      alert_component: 'site pizzahut (web01)',
      cause_component: 'MySQL em db01',
    });

    const summary = (await view(p.technical, ticket.id)).incident;
    expect(summary).toMatchObject({
      alertComponent: 'site pizzahut (web01)',
      causeComponent: 'MySQL em db01',
      causeConfirmed: true,
      demoScenario: 'mysql',
    });
    expect(summary?.interventions).toEqual([
      expect.objectContaining({
        action: 'service_restart',
        target: 'mariadb.service',
        decision: 'auto',
        actor: 'agent',
      }),
    ]);
    const client = await member('client', p.id, 'Carla Cliente');
    const clientFlow = await app.flows.ticketFlow(client, ticket.id).catch(() => null);
    expect(clientFlow?.incident ?? null).toBeNull();
  });

  it('falha na BD com a causa no DB2 (não gerido): a intervenção é proibida e escala', async () => {
    const p = await project({ services: services_(['php-fpm.service']) });
    const ticket = await incident(p, {
      alert: 'SiteDatabaseConnectionFailed',
      summary: 'Pagamentos falham: SQL30081N ligação ao DB2 recusada.',
      labels: { instance: 'web01', component: 'site pizzahut (web01)' },
      demo: 'db2',
    });
    await investigate(ticket.id, 'zo-db2 confirma o DB2 sem aceitar ligações.', {
      impact: 'Pagamentos indisponíveis.',
      alertComponent: 'site pizzahut (web01)',
      causeComponent: 'DB2 do ERP',
      causeConfirmed: false,
      causeManaged: false,
      proposedAction: {
        action: 'service_restart',
        target: 'php-fpm.service',
        reason: 'Tentar repor as ligações.',
      },
      nextStep: 'Contactar a equipa do DB2.',
    });
    await advance(2);
    expect(await path(p.technical, ticket.id)).toEqual([
      ['intake', 'done'],
      ['analise', 'done'],
      ['autorizar', 'forbidden'],
      ['email_escala', 'done'],
      ['atribuir', 'done'],
      ['escalado', null],
    ]);
    expect(await interventions(ticket.id)).toEqual([]);
    const [mail] = await emails(p.id);
    expect(mail?.body).toMatch(/Causa por apurar \(suspeita: DB2 do ERP\)/);
    expect(mail?.body).toMatch(/Contactar a equipa do DB2/);
  });

  it('demonstração: o alerta sintético segue pelo recetor real, abre incidentes separados e o fecho resolve o alerta', async () => {
    const p = await project({ services: services_(['mariadb.service']) });
    const receiver = new AlertmanagerReceiver(
      fixture.db,
      new HealthRepository(fixture.db),
      new HealthIncidents(
        fixture.db,
        new HealthRepository(fixture.db),
        new HealthTickets(fixture.db, app.tickets),
        new HealthIncidentLifecycle(fixture.db),
      ),
    );
    expect(await receiver.receive(p.id, incidentDemoPayload('mysql', now))).toMatchObject({
      opened: 1,
    });
    expect(await receiver.receive(p.id, incidentDemoPayload('disk', now))).toMatchObject({
      opened: 1,
    });
    const incidents = (
      await fixture.db.query<{ ticket_id: string; environment: string; demo_scenario: string }>(
        'SELECT ticket_id,environment,demo_scenario FROM health_incidents WHERE project_id=$1 ORDER BY demo_scenario DESC',
        [p.id],
      )
    ).rows;
    expect(incidents.map((row) => [row.environment, row.demo_scenario])).toEqual([
      ['quality', 'mysql'],
      ['quality', 'disk'],
    ]);
    const ticketId = incidents[0]!.ticket_id;
    await advance(1);
    await investigate(ticketId, 'Demonstração: MySQL sem ligações livres.', {
      alertComponent: 'site pizzahut (web01)',
      causeComponent: 'MySQL em db01',
      causeConfirmed: true,
      proposedAction: {
        action: 'service_restart',
        target: 'mariadb.service',
        reason: 'Libertar ligações.',
      },
    });
    await advance(3);
    expect((await path(p.technical, ticketId)).at(-1)).toEqual(['resolvido', null]);
    expect((await interventions(ticketId)).map((row) => row.status)).toEqual(['simulated']);
    const alerts = await fixture.db.query<{ state: string }>(
      'SELECT state FROM health_external_alerts WHERE ticket_id=$1',
      [ticketId],
    );
    expect(alerts.rows.map((row) => row.state)).toEqual(['resolved']);
  });

  it('fora da demonstração a intervenção segue pelo relay e regista antes/depois e a reposição', async () => {
    const p = await project({
      services: services_(['php-fpm.service']),
      parameters: [{ unit: 'php-fpm.service', property: 'MemoryHigh', allowed: ['1G'] }],
      rules: [
        {
          environment: 'any',
          kind: 'any',
          engine: 'any',
          action: 'set_parameter',
          decision: 'auto',
        },
      ],
    });
    await fixture.db.query(
      "INSERT INTO connector_relays (project_id,token_hash,last_seen_at,tools) VALUES ($1,$2,$3,'sql,log,param')",
      [p.id, randomUUID().replace(/-/g, '').padEnd(64, '0'), now],
    );
    const ticket = await incident(p, {
      alert: 'HostMemoryPressure',
      summary: 'Memória disponível a 6% em web01.',
      labels: { instance: 'web01:9100', unit: 'php-fpm.service' },
    });
    await fixture.db.query('UPDATE connector_relays SET last_seen_at=$2 WHERE project_id=$1', [
      p.id,
      now,
    ]);
    await investigate(ticket.id, 'Pool php-fpm sem limite de memória.', {
      alertComponent: 'web01',
      causeComponent: 'php-fpm.service',
      causeConfirmed: true,
      proposedAction: {
        action: 'set_parameter',
        target: 'php-fpm.service',
        parameter: 'MemoryHigh',
        value: '1G',
      },
    });
    const request = (
      await fixture.db.query<{ id: string; tool: string; payload: unknown }>(
        "SELECT id,tool,payload FROM connector_relay_requests WHERE project_id=$1 AND status='pending'",
        [p.id],
      )
    ).rows[0];
    expect(request?.tool).toBe('param');
    const payload =
      typeof request!.payload === 'string' ? JSON.parse(request!.payload) : request!.payload;
    expect(payload).toMatchObject({
      environment: 'production',
      unit: 'php-fpm.service',
      property: 'MemoryHigh',
      value: '1G',
    });
    await fixture.db.query(
      "UPDATE connector_relay_requests SET status='done',result=$2,finished_at=$3 WHERE id=$1",
      [
        request!.id,
        JSON.stringify({
          previous: 'infinity',
          current: '1073741824',
          message: 'MemoryHigh aplicado.',
        }),
        now,
      ],
    );
    await advance(1);
    expect((await view(p.technical, ticket.id)).next?.nodeId).toBe('validar');
    expect(await interventions(ticket.id)).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        decision: 'auto',
        previous_value: 'infinity',
        new_value: '1073741824',
        rollback_hint: 'systemctl set-property php-fpm.service MemoryHigh=infinity',
      }),
    ]);
  });
});

describe('Suspender e retomar a Saúde', () => {
  it('suspender cancela a investigação, congela o fluxo e só regista os alertas; retomar continua o incidente', async () => {
    const p = await project({ services: services_(['mariadb.service']) });
    const ticket = await incident(p, {
      alert: 'SiteDatabaseConnectionFailed',
      summary: 'O site devolve 500: Too many connections.',
      labels: { instance: 'web01', component: 'site pizzahut (web01)' },
      demo: 'mysql',
    });
    const suspensions = new HealthSuspensions(fixture.db);
    const result = await suspensions.suspend(
      p.id,
      'production',
      'Manutenção planeada do MySQL.',
      p.admin.id,
      now,
    );
    expect(result).toMatchObject({ cancelledRuns: 1, tickets: 1 });
    await expect(
      suspensions.suspend(p.id, 'production', 'Outra vez.', p.admin.id, now),
    ).rejects.toMatchObject({ code: 'HEALTH_SUSPENDED' });

    const runs = async () =>
      (
        await fixture.db.query<{ status: string; error_code: string | null }>(
          "SELECT status,error_code FROM agent_runs WHERE ticket_id=$1 AND run_trigger='flow' ORDER BY created_at",
          [ticket.id],
        )
      ).rows;
    expect(await runs()).toEqual([{ status: 'cancelled', error_code: 'health_suspended' }]);
    await advance(10);
    expect(await runs()).toHaveLength(1);
    expect((await view(p.technical, ticket.id)).next?.nodeId).toBe('analise');

    // Alerta novo durante a suspensão: fica registado, sem e-mail nem ticket.
    const receiver = new AlertmanagerReceiver(fixture.db, new HealthRepository(fixture.db), null);
    const fingerprint = randomUUID().replace(/-/g, '').slice(0, 16);
    const alert = {
      status: 'firing' as const,
      labels: {
        alertname: 'HostHighCpu',
        severity: 'critical',
        env: 'production',
        instance: 'web01',
      },
      annotations: { summary: 'CPU a 99% em web01.' },
      startsAt: now.toISOString(),
      fingerprint,
    };
    expect(await receiver.receive(p.id, { alerts: [alert] })).toMatchObject({
      notified: 0,
      opened: 0,
      muted: 1,
    });
    const stored = async () =>
      (
        await fixture.db.query<{ suspended: boolean; muted: boolean; ticket_id: string | null }>(
          'SELECT suspended,muted,ticket_id FROM health_external_alerts WHERE project_id=$1 AND fingerprint=$2',
          [p.id, fingerprint],
        )
      ).rows[0];
    expect(await stored()).toMatchObject({ suspended: true, muted: false, ticket_id: null });
    await receiver.releaseMuted(now);
    expect(await stored()).toMatchObject({ suspended: true, ticket_id: null });
    expect((await suspensions.state(p.id)).active.production?.reason).toBe(
      'Manutenção planeada do MySQL.',
    );

    await suspensions.resume(p.id, 'production', p.admin.id, now);
    expect((await suspensions.state(p.id)).active.production).toBeUndefined();
    expect(await stored()).toMatchObject({ suspended: false, muted: true });
    await advance(1);
    expect(await runs()).toEqual([
      { status: 'cancelled', error_code: 'health_suspended' },
      { status: 'queued', error_code: null },
    ]);
    await investigate(ticket.id, 'max_connections atingido em db01.', {
      alertComponent: 'site pizzahut (web01)',
      causeComponent: 'MySQL em db01',
      causeConfirmed: true,
      proposedAction: { action: 'service_restart', target: 'mariadb.service' },
    });
    await advance(3);
    expect((await path(p.technical, ticket.id)).at(-1)).toEqual(['resolvido', null]);
    // O alerta registado durante a suspensão e ainda ativo é notificado depois da retoma.
    await receiver.releaseMuted(now);
    expect(await stored()).toMatchObject({ suspended: false, muted: false });
    expect((await emails(p.id)).map((mail) => mail.body).join('\n')).toMatch(/CPU a 99% em web01/);
  });
});
