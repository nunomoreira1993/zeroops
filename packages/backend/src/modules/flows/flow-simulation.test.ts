import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  simulateFlow,
  type FlowDefinition,
  type FlowScenarioSpecInput,
  type Role,
  type User,
} from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { leaseJob } from '../../../../../tests/helpers/job-lease.js';
import { AgentRunsService } from '../agents/agent-runs.service.js';
import { createFlowActionRegistry } from '../incidents/incident.module.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { FlowEngine } from './flow-engine.js';
import { FlowSimulationQueue } from './flow-simulation-queue.js';
import { FlowSimulationService } from './flow-simulation.service.js';
import { applyRoutingReply } from './flow-simulator.js';
import { FlowsService } from './flows.service.js';

/**
 * P07 — simulador partilhado com o runtime. Testes determinísticos (fixtures e respostas
 * gravadas); a avaliação com o Copilot real é validada à parte (QA), não aqui.
 */

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let app: ReturnType<typeof services>;

function services() {
  const engine = new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db));
  return {
    engine,
    tickets: new TicketsService(fixture.db, [engine.onPublicComment], [engine.onTicketCreated]),
    runs: new AgentRunsService(fixture.db, [engine.onRunFinished]),
    flows: new FlowsService(fixture.db, engine),
    sim: new FlowSimulationService(fixture.db, (key) => engine.supportsAction(key)),
    queue: new FlowSimulationQueue(fixture.db),
  };
}

beforeAll(async () => {
  fixture = await startTestDatabase();
  app = services();
});
afterAll(async () => fixture?.stop());

const worker = { workerId: 'simulation-test', leaseSeconds: 60 };

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

async function activate(admin: User, projectId: string, flowId: string) {
  const current = await app.flows.get(admin, projectId, flowId);
  return app.flows.publish(admin, projectId, flowId, {
    expectedDraftVersion: current.draftVersion,
  });
}

async function project(copilot = true) {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [id, `P07 ${id}`]);
  const admin = await member(id, 'admin');
  if (copilot)
    await fixture.db.query(
      `INSERT INTO integration_settings
         (id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by)
       VALUES ($1,$2,'quality','copilot',1,'verified','cifrado','{}',1,$3)`,
      [randomUUID(), id, admin.id],
    );
  const client = await member(id, 'client');
  const technical = await member(id, 'technical');
  const general = (await app.flows.list(admin, id)).find((flow) => flow.template === 'general')!;
  await activate(admin, id, general.id);
  return { id, admin, client, technical, general };
}

/** Fluxo em branco com a definição dada (rascunho gravado, não ativado). */
async function draftFlow(
  p: Awaited<ReturnType<typeof project>>,
  name: string,
  definition: FlowDefinition,
) {
  const created = await app.flows.create(p.admin, p.id, { name, template: 'blank' });
  const current = await app.flows.get(p.admin, p.id, created.id);
  await app.flows.saveDraft(p.admin, p.id, created.id, {
    expectedDraftVersion: current.draftVersion,
    definition,
  });
  return created.id;
}

const end = (id: string, outcome = 'resolved') => ({
  id,
  op: 'end' as const,
  label: id,
  config: { outcome },
});

/** Mensagem ao cliente → nota interna → verificação da Saúde (30 min) → fim. */
const messagingFlow: FlowDefinition = {
  start: 'aviso',
  nodes: [
    {
      id: 'aviso',
      op: 'action',
      label: 'Aviso ao cliente',
      config: { action: 'client_message', source: 'text', body: 'Estamos a tratar do pedido.' },
    },
    {
      id: 'nota',
      op: 'action',
      label: 'Nota interna',
      config: { action: 'internal_note', source: 'text', body: 'Registo para a equipa.' },
    },
    {
      id: 'verificar',
      op: 'action',
      label: 'Verificar recuperação',
      config: { action: 'verify_health_recovery', timeoutMinutes: 30 },
    },
    end('ok'),
    end('escala', 'escalated'),
  ],
  edges: [
    { id: 'e1', source: 'aviso', port: 'success', target: 'nota' },
    { id: 'e2', source: 'aviso', port: 'failure', target: 'escala' },
    { id: 'e3', source: 'nota', port: 'success', target: 'verificar' },
    { id: 'e4', source: 'nota', port: 'failure', target: 'escala' },
    { id: 'e5', source: 'verificar', port: 'success', target: 'ok' },
    { id: 'e6', source: 'verificar', port: 'failure', target: 'escala' },
  ],
  layout: {},
};

const count = async (sql: string, params: unknown[] = []) =>
  Number((await fixture.db.query<{ total: number }>(sql, params)).rows[0]?.total ?? 0);

/** Contagens das tabelas operacionais (uma simulação não pode alterar nenhuma). */
async function operational(projectId: string) {
  return {
    tickets: await count('SELECT COUNT(*) AS total FROM tickets WHERE project_id=$1', [projectId]),
    comments: await count(
      'SELECT COUNT(*) AS total FROM ticket_comments c JOIN tickets t ON t.id=c.ticket_id WHERE t.project_id=$1',
      [projectId],
    ),
    runs: await count('SELECT COUNT(*) AS total FROM agent_runs WHERE project_id=$1', [projectId]),
    executions: await count(
      'SELECT COUNT(*) AS total FROM flow_executions e JOIN tickets t ON t.id=e.ticket_id WHERE t.project_id=$1',
      [projectId],
    ),
    steps: await count(
      `SELECT COUNT(*) AS total FROM flow_execution_steps s JOIN flow_executions e ON e.id=s.execution_id
         JOIN tickets t ON t.id=e.ticket_id WHERE t.project_id=$1`,
      [projectId],
    ),
    outbox: await count('SELECT COUNT(*) AS total FROM notification_outbox'),
    incidents: await count('SELECT COUNT(*) AS total FROM health_incidents'),
    interventions: await count('SELECT COUNT(*) AS total FROM incident_interventions'),
  };
}

const run = (
  actor: User,
  projectId: string,
  flowId: string,
  body: {
    level: string;
    spec?: FlowScenarioSpecInput;
    scenarioId?: string;
    trialTargetId?: string;
  },
  idempotencyKey = randomUUID(),
) => app.sim.run(actor, projectId, flowId, { ...body, idempotencyKey });

async function finishRun(ticketId: string, summary: string) {
  const row = (
    await fixture.db.query<{ id: string }>(
      "SELECT id FROM agent_runs WHERE ticket_id=$1 AND status='queued' AND run_trigger='flow'",
      [ticketId],
    )
  ).rows[0];
  expect(row, 'run do Copilot em fila').toBeDefined();
  const lease = await leaseJob(fixture.db, row!.id);
  await app.runs.complete(lease, { replyDraft: null, evidence: [], summary });
}

async function decide(actor: User, ticketId: string, port: string, comment: string) {
  const view = await app.flows.ticketFlow(actor, ticketId);
  return app.flows.decide(actor, ticketId, {
    stepId: view!.next!.stepId,
    port,
    comment,
    idempotencyKey: randomUUID(),
  });
}

describe('P07 — simulador partilhado com o runtime', () => {
  it('com resultados externos idênticos, simulador e motor percorrem as mesmas transições', async () => {
    const p = await project();
    const ticket = await app.tickets.create(p.client, {
      title: 'Erro no checkout',
      description: 'Falha ao pagar.',
      category: 'bug',
      environment: 'production',
      priority: 'medium',
    } as Parameters<TicketsService['create']>[1]);
    await finishRun(ticket.id, 'Primeira análise.');
    await decide(p.technical, ticket.id, 'failure', 'Falta verificar o pagamento.');
    await finishRun(ticket.id, 'Segunda análise.');
    await decide(p.technical, ticket.id, 'success', 'Resolvido com a correção.');
    const engineSteps = (
      await fixture.db.query<{ node_id: string; port: string | null }>(
        `SELECT s.node_id,s.port FROM flow_execution_steps s JOIN flow_executions e ON e.id=s.execution_id
          WHERE e.ticket_id=$1 ORDER BY s.step_sequence`,
        [ticket.id],
      )
    ).rows.map((row) => [row.node_id, row.port ?? null]);
    expect(engineSteps.map(([node]) => node)).toEqual([
      'analise',
      'equipa',
      'analise',
      'equipa',
      'resolvido',
    ]);

    const before = await operational(p.id);
    const simulated = await run(p.admin, p.id, p.general.id, {
      level: 'behavior',
      spec: {
        steps: {
          analise: [{ summary: 'Primeira análise.' }, { summary: 'Segunda análise.' }],
          equipa: [
            { result: 'failure', comment: 'Falta verificar o pagamento.' },
            { result: 'success', comment: 'Resolvido com a correção.' },
          ],
        },
        expected: { outcome: 'ended', endOutcome: 'resolved' },
      },
    });
    expect(simulated.status).toBe('completed');
    expect(simulated.result?.steps.map((step) => [step.nodeId, step.port])).toEqual(engineSteps);
    expect(simulated.comparison?.verdict).toBe('passed');
    // Simular não cria tickets, comentários, runs, execuções nem notificações.
    expect(await operational(p.id)).toEqual(before);
  });

  it('a simulação regista mensagens e incidentes sem os executar; o ensaio entrega só no destino de teste', async () => {
    const p = await project();
    const flowId = await draftFlow(p, 'Mensagens', messagingFlow);
    const before = await operational(p.id);
    const simulated = await run(p.admin, p.id, flowId, {
      level: 'behavior',
      spec: { incident: { state: 'open', recoversAfterMinutes: 10 } },
    });
    expect(simulated.result?.outcome).toBe('ended');
    expect(simulated.result?.effects.map((item) => [item.kind, item.mode])).toEqual([
      ['comment_public', 'simulated'],
      ['comment_internal', 'simulated'],
      ['close_incident', 'simulated'],
    ]);
    expect(await operational(p.id)).toEqual(before);

    // O ensaio isolado exige um destino ativo do próprio projeto.
    await expect(
      run(p.admin, p.id, flowId, { level: 'isolated_trial', spec: {} }),
    ).rejects.toMatchObject({ code: 'TRIAL_TARGET_NOT_ALLOWED', status: 403 });
    const other = await project();
    const [foreign] = await app.sim.createTrialTarget(other.admin, other.id, { name: 'Outro' });
    await expect(
      run(p.admin, p.id, flowId, { level: 'isolated_trial', spec: {}, trialTargetId: foreign!.id }),
    ).rejects.toMatchObject({ code: 'TRIAL_TARGET_NOT_ALLOWED' });
    await expect(
      app.sim.createTrialTarget(p.technical, p.id, { name: 'Sem permissão' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [target] = await app.sim.createTrialTarget(p.admin, p.id, { name: 'Caixa de teste' });

    const key = randomUUID();
    const body = {
      level: 'isolated_trial',
      spec: { incident: { state: 'open' as const, recoversAfterMinutes: 5 } },
      trialTargetId: target!.id,
    };
    const trial = await run(p.admin, p.id, flowId, body, key);
    expect(trial.result?.effects.every((item) => item.mode === 'trial')).toBe(true);
    // Repetir o pedido (reconexão) devolve a mesma execução sem novas entregas.
    const replay = await run(p.admin, p.id, flowId, body, key);
    expect(replay.id).toBe(trial.id);
    const deliveries = await app.sim.trialDeliveries(p.admin, p.id, target!.id);
    expect(deliveries).toHaveLength(3);
    expect(await operational(p.id)).toEqual(before);

    await app.sim.deactivateTrialTarget(p.admin, p.id, target!.id);
    await expect(run(p.admin, p.id, flowId, body)).rejects.toMatchObject({
      code: 'TRIAL_TARGET_NOT_ALLOWED',
    });
  });

  it('relógio controlado: esperas, timeouts e retries limitados', async () => {
    const p = await project();
    const flowId = await draftFlow(p, 'Relógio', messagingFlow);
    const recovered = await run(p.admin, p.id, flowId, {
      level: 'behavior',
      spec: { incident: { state: 'open', recoversAfterMinutes: 12 } },
    });
    expect(recovered.result?.stoppedAt?.nodeId).toBe('ok');
    expect(recovered.result?.elapsedMinutes).toBeGreaterThanOrEqual(12);
    expect(recovered.result?.elapsedMinutes).toBeLessThan(30);

    const timeout = await run(p.admin, p.id, flowId, {
      level: 'behavior',
      spec: { incident: { state: 'open' } },
    });
    expect(timeout.result?.stoppedAt?.nodeId).toBe('escala');
    expect(timeout.result?.elapsedMinutes).toBe(30);

    const horizon = await run(p.admin, p.id, flowId, {
      level: 'behavior',
      spec: { incident: { state: 'open' }, horizonMinutes: 10 },
    });
    expect(horizon.result).toMatchObject({ outcome: 'waiting', waitingFor: 'clock' });

    // Retry limitado: a equipa pede sempre nova análise até ao limite de passagens.
    const loop = await run(p.admin, p.id, p.general.id, {
      level: 'behavior',
      spec: {
        steps: {
          analise: [{ summary: 'Análise.' }],
          equipa: [{ result: 'failure', comment: 'De novo.' }],
        },
      },
    });
    expect(loop.result?.outcome).toBe('failed');
    expect(loop.result?.message).toMatch(/limite de \d+ passagens/);

    // Tempo de resposta da pessoa.
    const slow = await run(p.admin, p.id, p.general.id, {
      level: 'behavior',
      spec: {
        steps: {
          analise: [{ summary: 'Análise.', afterMinutes: 5 }],
          equipa: [{ result: 'success', comment: 'Feito.', afterMinutes: 60 }],
        },
      },
    });
    expect(slow.result?.elapsedMinutes).toBe(65);
  });

  it('compara expectativas e marca resultados desatualizados depois de alterar o rascunho', async () => {
    const p = await project();
    const spec: FlowScenarioSpecInput = {
      steps: { analise: [{ summary: 'Ok.' }], equipa: [{ wait: true }] },
      expected: { outcome: 'waiting', stopsAt: 'equipa', path: ['analise', 'equipa'] },
    };
    const scenario = await app.sim.saveScenario(p.admin, p.id, p.general.id, null, {
      name: 'Espera pela equipa',
      spec,
    });
    const passed = await run(p.admin, p.id, p.general.id, {
      level: 'behavior',
      scenarioId: scenario.id,
    });
    expect(passed.comparison?.verdict).toBe('passed');
    expect(passed.stale).toBe(false);

    const failed = await run(p.admin, p.id, p.general.id, {
      level: 'behavior',
      spec: { ...spec, expected: { outcome: 'ended', stopsAt: 'resolvido' } },
    });
    expect(failed.comparison?.verdict).toBe('failed');
    expect(failed.comparison?.checks.filter((check) => !check.passed).map((c) => c.key)).toEqual([
      'outcome',
      'stopsAt',
    ]);

    // Alterar o cenário marca a execução como desatualizada (motivo «scenario»).
    await expect(
      app.sim.saveScenario(p.admin, p.id, p.general.id, scenario.id, {
        name: 'Espera',
        spec,
        version: scenario.version + 1,
      }),
    ).rejects.toMatchObject({ code: 'FLOW_SCENARIO_CHANGED', status: 409 });
    await app.sim.saveScenario(p.admin, p.id, p.general.id, scenario.id, {
      name: 'Espera',
      spec: { ...spec, horizonMinutes: 60 },
      version: scenario.version,
    });
    let runs = (await app.sim.list(p.admin, p.id, p.general.id)).runs;
    expect(runs.find((item) => item.id === passed.id)?.staleReasons).toEqual(['scenario']);

    // Alterar a lógica do rascunho desatualiza todas as execuções anteriores.
    const current = await app.flows.get(p.admin, p.id, p.general.id);
    const changed = structuredClone(current.draft);
    changed.nodes.find((node) => node.id === 'equipa')!.label = 'Decisão final';
    await app.flows.saveDraft(p.admin, p.id, p.general.id, {
      expectedDraftVersion: current.draftVersion,
      definition: changed,
    });
    runs = (await app.sim.list(p.admin, p.id, p.general.id)).runs;
    expect(runs.find((item) => item.id === failed.id)?.staleReasons).toContain('definition');
    expect(runs.find((item) => item.id === passed.id)?.staleReasons).toEqual(
      expect.arrayContaining(['definition', 'scenario']),
    );

    // A ativação regista apenas a evidência do hash ativado.
    const fresh = await run(p.admin, p.id, p.general.id, {
      level: 'behavior',
      spec: { ...spec, expected: {} },
    });
    expect(fresh.stale).toBe(false);
    const activated = await activate(p.admin, p.id, p.general.id);
    const record = (
      await fixture.db.query<{ details: unknown }>(
        "SELECT activation_details AS details FROM flow_activations WHERE flow_id=$1 AND kind='activation' AND version_id=$2",
        [p.general.id, activated.published?.id],
      )
    ).rows[0];
    const details = (
      typeof record?.details === 'string' ? JSON.parse(record.details) : record?.details
    ) as { tests?: { runId: string }[] } | undefined;
    expect(activated.published).toBeTruthy();
    expect(details?.tests?.map((item) => item.runId)).toEqual([fresh.id]);

    // Arquivar o cenário: execuções antigas ficam como histórico desatualizado.
    const saved = (await app.sim.list(p.admin, p.id, p.general.id)).scenarios[0]!;
    await app.sim.archiveScenario(p.admin, p.id, p.general.id, saved.id, {
      version: saved.version,
    });
    await expect(
      run(p.admin, p.id, p.general.id, { level: 'behavior', scenarioId: saved.id }),
    ).rejects.toMatchObject({ code: 'FLOW_SCENARIO_ARCHIVED' });
  });

  it('isolamento entre projetos, permissões e ticket histórico só de leitura', async () => {
    const p = await project();
    const other = await project();
    await expect(app.sim.list(p.client, p.id, p.general.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      run(p.client, p.id, p.general.id, { level: 'structural', spec: {} }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Fluxo de outro projeto: não existe para este projeto.
    await expect(app.sim.list(p.admin, p.id, other.general.id)).rejects.toMatchObject({
      code: 'FLOW_NOT_FOUND',
    });
    await expect(app.sim.list(p.admin, other.id, other.general.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const ticket = await app.tickets.create(p.client, {
      title: 'Pagamento recusado',
      description: 'O cliente não consegue pagar.',
      category: 'bug',
      environment: 'production',
      priority: 'high',
    } as Parameters<TicketsService['create']>[1]);
    const snapshot = async () =>
      (
        await fixture.db.query(
          'SELECT title,description,status,updated_at,(SELECT COUNT(*) FROM ticket_comments WHERE ticket_id=$1) AS comments FROM tickets WHERE id=$1',
          [ticket.id],
        )
      ).rows[0];
    const before = await snapshot();
    const scenario = await app.sim.scenarioFromTicket(p.admin, p.id, p.general.id, {
      ticketId: ticket.id,
    });
    expect(scenario.spec.ticket).toMatchObject({ title: 'Pagamento recusado', priority: 'high' });
    expect(scenario.spec.sourceTicket?.id).toBe(ticket.id);
    await run(p.admin, p.id, p.general.id, {
      level: 'behavior',
      scenarioId: scenario.id,
    });
    expect(await snapshot()).toEqual(before);
    // Um ticket de outro projeto não pode servir de cenário.
    await expect(
      app.sim.scenarioFromTicket(other.admin, other.id, other.general.id, { ticketId: ticket.id }),
    ).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
    await expect(
      app.sim.getRun(other.admin, other.id, other.general.id, scenario.id),
    ).rejects.toMatchObject({ code: 'FLOW_SIMULATION_NOT_FOUND' });
  });

  it('capacidades: ações sem executor ficam indisponíveis, sem sucesso fictício', async () => {
    const p = await project();
    const flowId = await draftFlow(p, 'Intervenção', {
      start: 'rececao',
      nodes: [
        { id: 'rececao', op: 'action', label: 'Receber', config: { action: 'incident_intake' } },
        end('fim'),
      ],
      edges: [
        { id: 'a', source: 'rececao', port: 'success', target: 'fim' },
        { id: 'b', source: 'rececao', port: 'failure', target: 'fim' },
      ],
      layout: {},
    });
    // Ação não portável sem fixture: indisponível (acede a recursos reais).
    const missing = await run(p.admin, p.id, flowId, { level: 'behavior', spec: {} });
    expect(missing.result).toMatchObject({ outcome: 'unavailable' });
    expect(missing.result?.unavailable[0]?.capability).toBe('action:incident_intake');
    // Com fixture, a simulação segue o resultado do cenário.
    const fixtured = await run(p.admin, p.id, flowId, {
      level: 'behavior',
      spec: { steps: { rececao: [{ result: 'success' }] } },
    });
    expect(fixtured.result?.outcome).toBe('ended');
    // Um runtime sem executor para a ação: nem a fixture a torna disponível.
    const bare = new FlowSimulationService(fixture.db);
    const absent = await bare.run(p.admin, p.id, flowId, {
      level: 'behavior',
      spec: { steps: { rececao: [{ result: 'success' }] } },
      idempotencyKey: randomUUID(),
    });
    expect(absent.result?.outcome).toBe('unavailable');
    const structural = await bare.run(p.admin, p.id, flowId, {
      level: 'structural',
      idempotencyKey: randomUUID(),
      spec: {},
    });
    expect(structural.result?.unavailable.map((item) => item.nodeId)).toEqual(['rececao']);
    // No ensaio isolado, uma ação não portável nunca é executada nem simulada.
    const [target] = await app.sim.createTrialTarget(p.admin, p.id, { name: 'Teste' });
    const trial = await run(p.admin, p.id, flowId, {
      level: 'isolated_trial',
      spec: { steps: { rececao: [{ result: 'success' }] } },
      trialTargetId: target!.id,
    });
    expect(trial.result?.outcome).toBe('unavailable');
  });

  it('encaminhamento: resposta gravada vs. Copilot real em fila, com leases e respostas tardias', async () => {
    const p = await project();
    const policy = async (flowId: string, priority: number, instructions: string) => {
      const current = await app.flows.get(p.admin, p.id, flowId);
      await app.flows.saveSettings(p.admin, p.id, flowId, {
        name: current.name,
        description: current.description,
        priority,
        isDefault: false,
        match: current.match,
        routingPolicy: {
          instructions,
          positiveExamples: [],
          negativeExamples: [],
          fallbackOnUnresolved: false,
        },
      });
    };
    const consulta = (
      await app.flows.create(p.admin, p.id, { name: 'Consulta', template: 'blank' })
    ).id;
    await policy(consulta, 110, 'Pedidos de informação sobre o estado de algo existente.');
    const desenvolvimento = (
      await app.flows.create(p.admin, p.id, { name: 'Desenvolvimento', template: 'blank' })
    ).id;
    await policy(desenvolvimento, 120, 'Pedidos para criar ou alterar funcionalidades.');
    await activate(p.admin, p.id, desenvolvimento);

    const ticket = { title: 'Qual é o estado do pagamento da encomenda 48213?' };
    const recorded = await run(p.admin, p.id, consulta, {
      level: 'behavior',
      spec: {
        ticket,
        routing: {
          recordedReply: JSON.stringify({
            decision: 'choose',
            candidate: 'C1',
            reason: 'Consulta.',
          }),
        },
        expected: { routing: 'this' },
      },
    });
    expect(recorded.result?.routing).toMatchObject({ source: 'recorded', decision: 'this' });
    expect(recorded.comparison?.verdict).toBe('passed');
    expect(recorded.result?.notVerified.join(' ')).toMatch(/resposta gravada/);
    // Identificadores inventados pelo modelo são inválidos, nunca uma escolha.
    const invented = await run(p.admin, p.id, consulta, {
      level: 'behavior',
      spec: {
        ticket,
        routing: { recordedReply: '{"decision":"choose","candidate":"C9","reason":"x"}' },
      },
    });
    expect(invented.result?.routing).toMatchObject({ decision: 'invalid', chosenFlowId: null });
    const pending = await run(p.admin, p.id, consulta, { level: 'behavior', spec: { ticket } });
    expect(pending.result?.routing?.decision).toBe('pending');

    // Copilot real: fica em fila; só a tentativa atual grava a resposta observada.
    await fixture.db.query(
      "UPDATE flow_simulation_runs SET status='cancelled' WHERE status IN ('queued','running')",
    );
    const queued = await run(p.admin, p.id, consulta, {
      level: 'routing_copilot',
      spec: { ticket, expected: { routing: 'this' } },
    });
    expect(queued).toMatchObject({ status: 'queued', comparison: expect.anything() });
    const stale = await app.queue.claimNext({ workerId: 'antigo', leaseSeconds: 30 });
    expect(stale?.prompt).toContain(ticket.title);
    expect(stale?.scope).toBe('simulation');
    await fixture.db.query(
      'UPDATE flow_simulation_runs SET lease_until=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id=$1',
      [queued.id],
    );
    expect(await app.queue.recoverExpired()).toEqual({ requeued: 1, failed: 0 });
    const claimed = await app.queue.claimNext(worker);
    expect(claimed?.lease.epoch).toBe(stale!.lease.epoch + 1);
    const answer = JSON.stringify({ decision: 'choose', candidate: 'C1', reason: 'Consulta.' });
    expect(await app.queue.complete(stale!.lease, answer)).toBe('stale');
    expect(await app.queue.complete(claimed!.lease, answer)).toBe('accepted');
    expect(await app.queue.complete(claimed!.lease, answer)).toBe('duplicate');
    const done = await app.sim.getRun(p.admin, p.id, consulta, queued.id);
    expect(done).toMatchObject({ status: 'completed' });
    expect(done.result?.routing).toMatchObject({ source: 'copilot', decision: 'this' });
    expect(done.comparison?.verdict).toBe('passed');
    expect(done.result?.notVerified.join(' ')).not.toMatch(/resposta gravada/);

    // Falha do Copilot: nunca produz escolha.
    const failing = await run(p.admin, p.id, consulta, {
      level: 'routing_copilot',
      spec: { ticket },
    });
    const lease = (await app.queue.claimNext(worker))!.lease;
    expect(await app.queue.fail(lease, 'copilot_unavailable')).toBe('accepted');
    const failedView = await app.sim.getRun(p.admin, p.id, consulta, failing.id);
    expect(failedView).toMatchObject({ status: 'failed', errorCode: 'copilot_unavailable' });
    expect(failedView.result?.routing?.chosenFlowId).toBeNull();

    // Cancelamento: o executor perde a posse e a resposta já não é aceite.
    const cancelled = await run(p.admin, p.id, consulta, {
      level: 'routing_copilot',
      spec: { ticket },
    });
    const owned = (await app.queue.claimNext(worker))!.lease;
    await app.sim.cancelRun(p.admin, p.id, consulta, cancelled.id);
    expect(await app.queue.heartbeat(owned)).toEqual({ owned: false, cancelRequested: true });
    expect(await app.queue.complete(owned, answer)).toBe('stale');
    expect((await app.sim.getRun(p.admin, p.id, consulta, cancelled.id)).status).toBe('cancelled');

    // Sem integração Copilot verificada, a avaliação real é recusada (não há sucesso fictício).
    const offline = await project(false);
    await expect(
      run(offline.admin, offline.id, offline.general.id, { level: 'routing_copilot', spec: {} }),
    ).rejects.toMatchObject({ code: 'COPILOT_NOT_READY' });
  });

  it('compatibilidade: o simulador legado continua a funcionar para fluxos anteriores', async () => {
    const p = await project();
    const detail = await app.flows.get(p.admin, p.id, p.general.id);
    const legacy = simulateFlow(detail.draft, { analise: ['success'], equipa: ['success'] });
    expect(legacy.steps.map((step) => step.nodeId)).toEqual(['analise', 'equipa', 'resolvido']);
    const structural = await run(p.admin, p.id, p.general.id, { level: 'structural', spec: {} });
    expect(structural.result).toMatchObject({ level: 'structural', outcome: null });
    expect(structural.result?.issues).toEqual([]);
    const listed = await app.sim.list(p.admin, p.id, p.general.id);
    expect(listed.examples.length).toBeGreaterThanOrEqual(5);
    // Os exemplos de biblioteca são cenários válidos que o simulador executa.
    for (const example of listed.examples) {
      const result = await run(p.admin, p.id, p.general.id, {
        level: 'behavior',
        spec: example.spec,
      });
      expect(result.status, example.name).toBe('completed');
    }
  });

  it('encaminhamento: o fallback não é escolhível pelo classificador, como no encaminhador real', () => {
    const view = {
      source: 'none',
      decision: 'pending',
      chosenFlowId: null,
      chosenName: null,
      candidates: [
        { key: 'C1', flowId: 'a', name: 'Consulta', draft: true },
        { key: 'C2', flowId: 'b', name: 'Desenvolvimento', draft: false },
        { key: 'F', flowId: 'f', name: 'Geral', draft: false },
      ],
      fallbackName: 'Geral',
      reason: null,
      question: null,
      observedReply: null,
    } as const satisfies Parameters<typeof applyRoutingReply>[0];
    const chooseF = applyRoutingReply(
      view,
      '{"decision":"choose","candidate":"F","reason":"x"}',
      'recorded',
    );
    expect(chooseF.decision).toBe('invalid');
    expect(chooseF.chosenFlowId).toBeNull();
    const none = applyRoutingReply(view, '{"decision":"none","reason":"nenhum"}', 'recorded');
    expect(none).toMatchObject({ decision: 'fallback', chosenFlowId: 'f' });
    const chosen = applyRoutingReply(
      view,
      '{"decision":"choose","candidate":"C2","reason":"novo método"}',
      'recorded',
    );
    expect(chosen).toMatchObject({ decision: 'other', chosenFlowId: 'b' });
  });
});
