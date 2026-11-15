import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FlowDefinition, Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { leaseJob } from '../../../../../tests/helpers/job-lease.js';
import { AgentRunsService } from '../agents/agent-runs.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { FlowAssistantQueue } from './flow-assistant.js';
import { FlowEngine } from './flow-engine.js';
import { logicHash } from './flow-store.js';
import { FlowsService } from './flows.service.js';
import { createFlowActionRegistry } from '../incidents/incident.module.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
const now = new Date('2030-01-01T10:00:00Z');
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

async function member(role: Role, projectId: string, name = `Pessoa ${role}`): Promise<User> {
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

async function project() {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [id, `Fluxos ${id}`]);
  const admin = await member('admin', id, 'Ana Admin');
  await fixture.db.query(
    `INSERT INTO integration_settings
       (id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by)
     VALUES ($1,$2,'quality','copilot',1,'verified','cifrado','{}',1,$3)`,
    [randomUUID(), id, admin.id],
  );
  const people = {
    id,
    admin,
    client: await member('client', id, 'Carla Cliente'),
    technical: await member('technical', id, 'Tiago Técnico'),
    qa: await member('qa', id, 'Quintino QA'),
    release: await member('release', id, 'Rita Release'),
  };
  // P02: os modelos nascem em rascunho; o projeto de teste ativa explicitamente o geral e a Saúde.
  for (const template of ['general', 'health']) await activate(admin, id, template);
  return people;
}

/** «Ativar esta versão» do rascunho atual de um fluxo (por id ou por modelo). */
async function activate(admin: User, projectId: string, flowIdOrTemplate: string) {
  const list = await app.flows.list(admin, projectId);
  const flow = list.find(
    (item) => item.id === flowIdOrTemplate || item.template === flowIdOrTemplate,
  );
  expect(flow).toBeDefined();
  return app.flows.publish(admin, projectId, flow!.id, {
    expectedDraftVersion: flow!.draftVersion,
  });
}

/** Termina o run do Copilot pedido pela etapa atual do ticket (como o executor faria). */
async function finishRun(
  ticketId: string,
  result: { summary: string; patch?: string; proposedTests?: string[] } | 'fail',
) {
  const run = (
    await fixture.db.query<{ id: string; instructions: string }>(
      "SELECT id,instructions FROM agent_runs WHERE ticket_id=$1 AND status='queued' AND run_trigger='flow'",
      [ticketId],
    )
  ).rows[0];
  expect(run, 'run do Copilot em fila').toBeDefined();
  const lease = await leaseJob(fixture.db, run!.id);
  if (result === 'fail') await app.runs.fail(lease, 'copilot_error');
  else await app.runs.complete(lease, { replyDraft: null, evidence: [], ...result });
  return run!.instructions;
}

async function view(actor: User, ticketId: string) {
  const flow = await app.flows.ticketFlow(actor, ticketId);
  expect(flow).not.toBeNull();
  return flow!;
}

async function decide(actor: User, ticketId: string, port: string, comment?: string) {
  const flow = await view(actor, ticketId);
  return app.flows.decide(actor, ticketId, {
    stepId: flow.next!.stepId,
    port,
    ...(comment ? { comment } : {}),
    idempotencyKey: randomUUID(),
  });
}

async function flowByTemplate(admin: User, projectId: string, template: string) {
  const list = await app.flows.list(admin, projectId);
  const found = list.find((flow) => flow.template === template);
  expect(found).toBeDefined();
  return app.flows.get(admin, projectId, found!.id);
}

/** Modelo «Saúde» v2 publicado antes do fluxo «Incidente (Health)» (cópia fixa para o teste de upgrade). */
function legacyHealthDefinition(): FlowDefinition {
  const file = new URL('./__fixtures__/health-template-v2.json', import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as FlowDefinition;
}

describe('FlowEngine', () => {
  it.each([-60_000, 60_000])(
    'usa o relógio da BD para despertar ações, com o relógio da aplicação desviado %i ms',
    async (offset) => {
      const p = await project();
      const general = await flowByTemplate(p.admin, p.id, 'general');
      const end = general.draft.nodes.find((node) => node.op === 'end')!;
      const saved = await app.flows.saveDraft(p.admin, p.id, general.id, {
        expectedDraftVersion: general.draftVersion,
        definition: {
          ...general.draft,
          start: 'wait',
          nodes: [
            {
              id: 'wait',
              op: 'action',
              label: 'Espera controlada',
              config: { action: 'internal_note', body: 'Ensaio do relógio da BD.' },
            },
            end,
          ],
          edges: [
            { id: 'done', source: 'wait', port: 'success', target: end.id },
            { id: 'failed', source: 'wait', port: 'failure', target: end.id },
          ],
          layout: {},
        },
      });
      await app.flows.publish(p.admin, p.id, general.id, {
        expectedDraftVersion: saved.draftVersion,
      });
      let evaluations = 0;
      const engine = new FlowEngine(fixture.db, {
        ...createFlowActionRegistry(fixture.db),
        internal_note: async (context) => {
          evaluations += 1;
          return evaluations === 1
            ? { wait: new Date(context.now.getTime() + 30_000) }
            : { port: 'done' };
        },
      });
      const tickets = new TicketsService(
        fixture.db,
        [engine.onPublicComment],
        [engine.onTicketCreated],
      );
      const ticket = await tickets.create(p.client, {
        title: 'Despertar após efeito externo',
        description: 'O fim da entrega acorda a etapa usando NOW(3).',
        category: 'question',
        environment: 'quality',
        priority: 'medium',
      });
      const databaseNow = (await fixture.db.query<{ now: Date }>('SELECT NOW(3) AS now')).rows[0]!
        .now;
      try {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(databaseNow.getTime() + offset));
        await fixture.db.query(
          'UPDATE flow_executions SET wake_at=TIMESTAMPADD(SECOND,30,NOW(3)) WHERE ticket_id=$1',
          [ticket.id],
        );
        await engine.tick(100);
        expect(evaluations, 'uma etapa futura não pode correr cedo').toBe(1);
        await fixture.db.query('UPDATE flow_executions SET wake_at=NOW(3) WHERE ticket_id=$1', [
          ticket.id,
        ]);
        await engine.tick(100);
        expect(evaluations, 'uma etapa acordada pela BD não pode ficar para outro tick').toBe(2);
        expect((await app.flows.ticketFlow(p.technical, ticket.id))!.execution.status).toBe(
          'completed',
        );
      } finally {
        vi.useRealTimers();
        await fixture.db.query('UPDATE flow_executions SET wake_at=NULL WHERE ticket_id=$1', [
          ticket.id,
        ]);
      }
    },
  );

  it('Saúde: o modelo antigo não personalizado passa a «Incidente (Health)» sem mudar os tickets em curso', async () => {
    const p = await project();
    const health = await flowByTemplate(p.admin, p.id, 'health');
    const legacy = legacyHealthDefinition();
    expect(logicHash(legacy)).toBe(
      'f668cccc88ba841b2d4fafb9a928267c178c5cd8fc5f7b560dbc83b1738b70ce',
    );
    await fixture.db.query('UPDATE flows SET name=$2,flow_definition=$3 WHERE id=$1', [
      health.id,
      'Saúde',
      legacy,
    ]);
    await fixture.db.query(
      'UPDATE flow_versions SET flow_definition=$2,logic_hash=$3 WHERE flow_id=$1',
      [health.id, legacy, logicHash(legacy)],
    );
    const alert = {
      title: 'Alerta: fila parada',
      description: 'A Saúde detetou a fila sem consumo.',
      category: 'bug',
      environment: 'production',
      priority: 'high',
    } as const;
    const inFlight = await app.tickets.create(p.technical, alert, { origin: 'health' });

    expect(await app.engine.upgradeTemplates()).toBeGreaterThanOrEqual(1);
    expect(await app.engine.upgradeTemplates()).toBe(0);
    const upgraded = await app.flows.get(p.admin, p.id, health.id);
    expect(upgraded.name).toBe('Incidente (Health)');
    // P02: a atualização é uma proposta no rascunho; a versão ativa não muda.
    expect(upgraded.published?.number).toBe(1);
    expect(upgraded.pendingChanges.definition).toBe(true);
    expect(upgraded.draft.nodes.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'intake',
        'autorizar',
        'intervir',
        'validar',
        'email_fecho',
        'email_escala',
      ]),
    );

    // O ticket em curso continua na versão antiga; sem ativação, os novos também.
    const old = await view(p.technical, inFlight.id);
    expect(old.execution.version.number).toBe(1);
    expect(old.next?.nodeId).toBe('analise');
    const beforeActivation = await app.tickets.create(p.technical, alert, { origin: 'health' });
    expect((await view(p.technical, beforeActivation.id)).execution.version.number).toBe(1);

    await activate(p.admin, p.id, health.id);
    const newer = await app.tickets.create(p.technical, alert, { origin: 'health' });
    const fresh = await view(p.technical, newer.id);
    expect(fresh.execution.version.number).toBe(2);
    expect(fresh.execution.flow.name).toBe('Incidente (Health)');
    expect(fresh.steps[0]?.nodeId ?? fresh.next?.nodeId).toBe('intake');
    expect((await view(p.technical, inFlight.id)).execution.version.number).toBe(1);
  });
  it('Alertas: o ticket de um alerta com fluxo próprio entra nesse fluxo; os outros seguem a regra geral', async () => {
    const p = await project();
    const links = await app.flows.alertFlows(p.admin, p.id);
    const disk = 'prometheus:EspacoDiscoBaixo';
    expect(links.find((link) => link.key === disk)).toMatchObject({ flowId: null });
    const created = await app.flows.createAlertFlow(p.admin, p.id, { alertKey: disk });
    // P02: criar o fluxo do alerta só cria um rascunho; nada muda até à ativação.
    expect(created.published).toBeNull();
    expect(created.alertKeys).toEqual([]);
    expect(created.pendingAlertKeys).toEqual([disk]);
    expect(
      (await app.flows.alertFlows(p.admin, p.id)).find((link) => link.key === disk),
    ).toMatchObject({ flowId: null, pendingFlowId: created.id });
    const own = await activate(p.admin, p.id, created.id);
    expect(own.published).not.toBeNull();
    expect(own.alertKeys).toEqual([disk]);
    expect(own.pendingAlertKeys).toEqual([]);
    const alert = {
      title: '[Saúde][Produção] Disco quase cheio',
      description: 'Partição /var acima do limiar.',
      category: 'incident',
      environment: 'production',
      priority: 'high',
    } as const;

    const linked = await app.tickets.create(p.technical, alert, {
      origin: 'health',
      alertKey: disk,
    });
    expect((await view(p.technical, linked.id)).execution.flow.id).toBe(own.id);

    // Sem associação (ou sem alerta) nunca entra no fluxo reservado a outro alerta.
    for (const options of [
      { origin: 'health' as const, alertKey: 'prometheus:MysqlIndisponivel' },
      { origin: 'health' as const },
    ]) {
      const other = await app.tickets.create(p.technical, alert, options);
      expect((await view(p.technical, other.id)).execution.flow.id).not.toBe(own.id);
    }

    // Retirar a associação devolve o alerta à regra geral.
    const after = await app.flows.linkAlertFlow(p.admin, p.id, { alertKey: disk, flowId: null });
    expect(after.find((link) => link.key === disk)?.flowId).toBeNull();
    const unlinked = await app.tickets.create(p.technical, alert, {
      origin: 'health',
      alertKey: disk,
    });
    expect((await view(p.technical, unlinked.id)).execution.flow.id).not.toBe(own.id);
  });
  it('Alertas: regras Prometheus relacionadas usam o fluxo do check, que prevalece sobre a regra', async () => {
    const p = await project();
    const checkKey = 'check:disk-space';
    const lowDiskKey = 'prometheus:EspacoDiscoBaixo';
    const criticalDiskKey = 'prometheus:EspacoDiscoCritico';
    const links = await app.flows.alertFlows(p.admin, p.id);
    expect(links.find((link) => link.key === checkKey)).toMatchObject({
      title: 'Espaço livre em disco abaixo do limite',
      group: 'Servidores',
      flowId: null,
    });

    const ruleFlow = await app.flows.createAlertFlow(p.admin, p.id, { alertKey: lowDiskKey });
    const checkDraft = await app.flows.createAlertFlow(p.admin, p.id, { alertKey: checkKey });
    await activate(p.admin, p.id, ruleFlow.id);
    const checkFlow = await activate(p.admin, p.id, checkDraft.id);
    expect(checkFlow.alertKeys).toEqual([checkKey]);

    const alert = {
      title: '[Saúde][Produção] Espaço em disco baixo',
      description: 'Espaço livre abaixo do limiar.',
      category: 'incident',
      environment: 'production',
      priority: 'high',
    } as const;
    for (const alertKey of [lowDiskKey, criticalDiskKey]) {
      const ticket = await app.tickets.create(p.technical, alert, { origin: 'health', alertKey });
      expect((await view(p.technical, ticket.id)).execution.flow.id).toBe(checkFlow.id);
    }

    expect(ruleFlow.id).not.toBe(checkFlow.id);
  });
  it('Manutenção: QA reprova a primeira versão, aprova a segunda e a nova versão não muda o percurso', async () => {
    const p = await project();
    const maintenance = await flowByTemplate(p.admin, p.id, 'maintenance');
    await app.flows.publish(p.admin, p.id, maintenance.id, {
      expectedDraftVersion: maintenance.draftVersion,
    });
    const ticket = await app.tickets.create(p.client, {
      title: 'Botão de pagamento não responde',
      description: 'Ao carregar em pagar nada acontece.',
      category: 'bug',
      environment: 'production',
      priority: 'medium',
    });
    const thanks = await fixture.db.query<{ body: string; visibility: string }>(
      'SELECT body,visibility FROM ticket_comments WHERE ticket_id=$1',
      [ticket.id],
    );
    expect(thanks.rows).toEqual([
      expect.objectContaining({ visibility: 'public', body: expect.stringMatching(/Obrigado/) }),
    ]);
    await finishRun(ticket.id, { summary: 'Proposta: corrigir o handler do botão.' });
    let flow = await view(p.technical, ticket.id);
    expect(flow.next).toMatchObject({ nodeId: 'aprovacao', canAct: true });
    expect((await view(p.qa, ticket.id)).next?.canAct).toBe(false);
    await expect(decide(p.qa, ticket.id, 'success')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Duplo clique: a mesma chave só avança uma vez; uma etapa ultrapassada é recusada.
    const step = flow.next!.stepId;
    const key = randomUUID();
    await expect(
      app.engine.decide(p.technical, ticket.id, {
        stepId: step,
        port: 'success',
        idempotencyKey: key,
      }),
    ).resolves.toEqual({ applied: true });
    await expect(
      app.engine.decide(p.technical, ticket.id, {
        stepId: step,
        port: 'success',
        idempotencyKey: key,
      }),
    ).resolves.toEqual({ applied: false });
    await expect(
      app.engine.decide(p.technical, ticket.id, {
        stepId: step,
        port: 'success',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FLOW_STEP_NOT_ACTIVE' });

    await finishRun(ticket.id, {
      summary: 'Versão 1 do handler.',
      patch: '--- a/pay.js\n+++ b/pay.js\n@@ -1 +1 @@\n-old\n+v1\n',
      proposedTests: ['Carregar em pagar'],
    });

    // Uma nova versão publicada (QA reprovado volta à aprovação) não altera este ticket.
    const current = await app.flows.get(p.admin, p.id, maintenance.id);
    const changed: FlowDefinition = structuredClone(current.draft);
    changed.edges = changed.edges.map((edge) =>
      edge.source === 'qa' && edge.port === 'failure' ? { ...edge, target: 'aprovacao' } : edge,
    );
    const saved = await app.flows.saveDraft(p.admin, p.id, maintenance.id, {
      expectedDraftVersion: current.draftVersion,
      definition: changed,
    });
    expect(saved.changeKind).toBe('logic');
    await app.flows.publish(p.admin, p.id, maintenance.id, {
      expectedDraftVersion: saved.draftVersion,
    });

    // Reinício: novas instâncias dos serviços continuam a mesma aprovação pendente.
    app = services();
    await expect(decide(p.qa, ticket.id, 'failure')).rejects.toMatchObject({
      code: 'COMMENT_REQUIRED',
    });
    await decide(p.qa, ticket.id, 'failure', 'O botão continua sem resposta no Safari.');
    const second = await finishRun(ticket.id, {
      summary: 'Versão 2 compatível com Safari.',
      patch: '--- a/pay.js\n+++ b/pay.js\n@@ -1 +1 @@\n-old\n+v2\n',
    });
    expect(second).toMatch(/Quintino QA.*O botão continua sem resposta no Safari/);
    expect(second).toMatch(/Tentativa anterior \(#1\).*Versão 1/);

    await decide(p.qa, ticket.id, 'success');
    flow = await view(p.release, ticket.id);
    expect(flow.next).toMatchObject({ nodeId: 'confirmar_publicacao', canAct: true });
    expect(flow.steps.find((item) => item.nodeId === 'publicacao')?.output.external).toMatch(
      /manual/,
    );
    await decide(p.release, ticket.id, 'success');

    flow = await view(p.technical, ticket.id);
    expect(flow.execution).toMatchObject({ status: 'completed' });
    expect(flow.execution.version).toMatchObject({ number: 1, latestNumber: 2 });
    const attempts = flow.steps
      .filter((item) => ['desenvolvimento', 'qa'].includes(item.nodeId))
      .map((item) => [item.nodeId, item.attempt, item.port, item.actor?.displayName ?? null]);
    expect(attempts).toEqual([
      ['desenvolvimento', 1, 'success', null],
      ['qa', 1, 'failure', 'Quintino QA'],
      ['desenvolvimento', 2, 'success', null],
      ['qa', 2, 'success', 'Quintino QA'],
    ]);
    const qaFirst = flow.steps.find((item) => item.nodeId === 'qa' && item.attempt === 1);
    expect(qaFirst?.output).toMatchObject({
      comment: 'O botão continua sem resposta no Safari.',
      commentVisibility: 'internal',
    });
    const devSecond = flow.steps.find(
      (item) => item.nodeId === 'desenvolvimento' && item.attempt === 2,
    );
    expect(devSecond?.output.feedback).toMatch(/Quintino QA/);
    expect(devSecond?.output.patch).toMatch(/\+v2/);
    expect((await app.tickets.get(p.client, ticket.id)).status).toBe('resolved');

    // Um ticket novo entra na versão publicada agora.
    const newer = await app.tickets.create(p.client, {
      title: 'Outro pedido',
      description: 'Pedido de melhoria.',
      category: 'improvement',
      environment: 'production',
      priority: 'low',
    });
    expect((await view(p.technical, newer.id)).execution.version.number).toBe(2);
  });

  it('assistente: cria por escrito, edição manual e nova edição por conversa sobre o mesmo fluxo', async () => {
    const p = await project();
    const queue = new FlowAssistantQueue(fixture.db);
    const created = await app.flows.create(p.admin, p.id, {
      name: 'Pedidos urgentes',
      template: 'blank',
    });

    const ask = async (message: string, reply: object) => {
      const request = await app.flows.requestFlowAssistant(p.admin, p.id, created.id, { message });
      const claimed = await queue.claimNext();
      expect(claimed?.id).toBe(request.id);
      expect(claimed?.prompt).toContain(message);
      await queue.complete(
        claimed!.lease,
        `Proposta:\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``,
      );
      const history = await app.flows.flowAssistantHistory(p.admin, p.id, created.id);
      return history.find((item) => item.id === request.id)!;
    };

    // Falta informação que altera a execução: o assistente pergunta.
    const question = await ask('Antes de desenvolver, pede aprovação.', {
      reply: '',
      question: 'Quem deve aprovar neste projeto?',
      operations: [],
    });
    expect(question.response?.question).toBe('Quem deve aprovar neste projeto?');

    const draft = await app.flows.get(p.admin, p.id, created.id);
    const first = await ask('O Copilot desenvolve e depois o QA aprova ou reprova.', {
      reply: 'Proponho desenvolvimento seguido de QA.',
      operations: [
        {
          type: 'add_node',
          node: {
            id: 'dev',
            op: 'copilot_task',
            label: 'Desenvolvimento',
            config: { mode: 'develop' },
          },
        },
        {
          type: 'add_node',
          node: {
            id: 'qa',
            op: 'human_decision',
            label: 'QA',
            assignee: { kind: 'role', role: 'qa' },
            config: {
              options: [
                { port: 'success', label: 'Aprovar' },
                { port: 'failure', label: 'Reprovar', requiresComment: true },
              ],
            },
          },
        },
        { type: 'set_start', id: 'dev' },
        { type: 'connect', source: 'dev', port: 'success', target: 'qa' },
        { type: 'connect', source: 'dev', port: 'failure', target: 'qa' },
        {
          type: 'connect',
          source: 'qa',
          port: 'success',
          target: draft.draft.nodes.find((n) => n.op === 'end')!.id,
        },
        { type: 'connect', source: 'qa', port: 'failure', target: 'dev' },
      ],
    });
    expect(first.response?.operations).toHaveLength(7);
    // Propostas não alteram o rascunho até serem aceites.
    expect((await app.flows.get(p.admin, p.id, created.id)).draftVersion).toBe(draft.draftVersion);
    let detail = await app.flows.resolveFlowAssistant(p.admin, p.id, created.id, first.id, {
      resolution: 'accepted',
      expectedDraftVersion: draft.draftVersion,
    });
    expect(detail.draft.start).toBe('dev');

    // Edição manual de uma ligação (e só de disposição).
    const moved = structuredClone(detail.draft);
    moved.layout.qa = { x: 500, y: 300 };
    let saved = await app.flows.saveDraft(p.admin, p.id, created.id, {
      expectedDraftVersion: detail.draftVersion,
      definition: moved,
    });
    expect(saved.changeKind).toBe('layout');
    const relinked = structuredClone(moved);
    relinked.edges = relinked.edges.map((edge) =>
      edge.source === 'dev' && edge.port === 'failure' ? { ...edge, target: 'dev' } : edge,
    );
    saved = await app.flows.saveDraft(p.admin, p.id, created.id, {
      expectedDraftVersion: saved.draftVersion,
      definition: relinked,
    });
    expect(saved.changeKind).toBe('logic');

    // Nova edição por conversa sobre o mesmo rascunho: só a parte relevante muda.
    const second = await ask('Antes de desenvolver, pede aprovação ao responsável técnico.', {
      reply: 'Acrescento a aprovação técnica antes do desenvolvimento.',
      operations: [
        {
          type: 'add_node',
          node: {
            id: 'aprovacao',
            op: 'human_decision',
            label: 'Aprovação técnica',
            assignee: { kind: 'role', role: 'technical' },
            config: {
              options: [
                { port: 'success', label: 'Aprovar' },
                { port: 'failure', label: 'Recusar', requiresComment: true },
              ],
            },
          },
        },
        { type: 'set_start', id: 'aprovacao' },
        { type: 'connect', source: 'aprovacao', port: 'success', target: 'dev' },
        {
          type: 'connect',
          source: 'aprovacao',
          port: 'failure',
          target: draft.draft.nodes.find((n) => n.op === 'end')!.id,
        },
      ],
    });
    detail = await app.flows.resolveFlowAssistant(p.admin, p.id, created.id, second.id, {
      resolution: 'accepted',
      expectedDraftVersion: saved.draftVersion,
    });
    expect(detail.draft.start).toBe('aprovacao');
    expect(detail.draft.edges.find((e) => e.source === 'dev' && e.port === 'failure')?.target).toBe(
      'dev',
    );
    expect(detail.draft.layout.qa).toEqual({ x: 500, y: 300 });
    // A validação de publicação aponta a etapa inicial do modelo em branco que deixou de ser usada.
    expect(detail.issues).toEqual([
      expect.objectContaining({ code: 'unreachable', nodeId: 'analise' }),
    ]);

    // Descartar uma proposta não altera nada.
    const third = await ask('Remove o QA.', {
      operations: [{ type: 'remove_node', id: 'qa' }],
    });
    const discarded = await app.flows.resolveFlowAssistant(p.admin, p.id, created.id, third.id, {
      resolution: 'discarded',
    });
    expect(discarded.draft).toEqual(detail.draft);

    // Simulação sem efeitos com um ticket antigo do cliente.
    const old = await app.tickets.create(p.client, {
      title: 'Pedido antigo',
      description: 'Para simular.',
      category: 'question',
      environment: 'production',
      priority: 'low',
    });
    const comments = await fixture.db.query('SELECT id FROM ticket_comments WHERE ticket_id=$1', [
      old.id,
    ]);
    const simulation = await app.flows.simulate(p.admin, p.id, created.id, {
      ticketId: old.id,
      scenario: { qa: ['failure', 'failure', 'wait'] },
    });
    expect(simulation.result).toMatchObject({ outcome: 'waiting', stoppedAt: { nodeId: 'qa' } });
    expect(
      (await fixture.db.query('SELECT id FROM ticket_comments WHERE ticket_id=$1', [old.id]))
        .rowCount,
    ).toBe(comments.rowCount);
  });

  it('assistente do ticket: explica o estado e aplica a transição só com permissão', async () => {
    const p = await project();
    const queue = new FlowAssistantQueue(fixture.db);
    const maintenance = await flowByTemplate(p.admin, p.id, 'maintenance');
    await app.flows.publish(p.admin, p.id, maintenance.id, {
      expectedDraftVersion: maintenance.draftVersion,
    });
    const ticket = await app.tickets.create(p.client, {
      title: 'Erro no checkout',
      description: 'Falha intermitente.',
      category: 'bug',
      environment: 'production',
      priority: 'medium',
    });
    await finishRun(ticket.id, { summary: 'Análise inicial.' });
    await decide(p.technical, ticket.id, 'success');
    await finishRun(ticket.id, {
      summary: 'Correção v1.',
      patch: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
    });
    const flow = await view(p.qa, ticket.id);
    expect(flow.next?.nodeId).toBe('qa');

    await expect(
      app.flows.requestTicketAssistant(p.client, ticket.id, { message: 'Porque está parado?' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const request = await app.flows.requestTicketAssistant(p.technical, ticket.id, {
      message: 'Devolve ao desenvolvimento com este comentário: falta validar o IBAN.',
    });
    const stale = await queue.claimNext({ workerId: 'assistente-antigo', leaseSeconds: 30 });
    expect(stale?.prompt).toMatch(/QA/);
    // O executor antigo perde o lease: a recuperação devolve o pedido à fila uma única vez.
    await fixture.db.query(
      'UPDATE flow_assistant_requests SET lease_until=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id=$1',
      [request.id],
    );
    expect(await queue.recoverExpired()).toEqual({ requeued: 1, failed: 0 });
    const claimed = await queue.claimNext({ workerId: 'assistente-novo', leaseSeconds: 30 });
    expect(claimed?.lease.epoch).toBe(stale!.lease.epoch + 1);
    const answer = JSON.stringify({
      reply: 'Está à espera do QA (Quintino QA). Posso devolver ao desenvolvimento.',
      transition: {
        stepId: flow.next!.stepId,
        port: 'failure',
        comment: 'Falta validar o IBAN.',
      },
    });
    expect(await queue.complete(stale!.lease, 'resposta tardia')).toBe('stale');
    expect((await queue.heartbeat(stale!.lease)).owned).toBe(false);
    expect(await queue.complete(claimed!.lease, answer)).toBe('accepted');
    expect(await queue.complete(claimed!.lease, answer)).toBe('duplicate');
    const assistantEvents = await fixture.db.query<{ event_type: string; worker_id: string }>(
      'SELECT event_type,worker_id FROM agent_job_events WHERE job_id=$1 ORDER BY created_at,id',
      [request.id],
    );
    expect(assistantEvents.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        'claimed',
        'lease_expired_requeued',
        'stale_attempt_rejected',
        'lease_lost',
        'completed',
      ]),
    );
    expect(
      assistantEvents.rows.filter((row) => row.event_type === 'completed').map((r) => r.worker_id),
    ).toEqual(['assistente-novo']);
    // Quem pediu não tem o papel de QA: não pode aplicar.
    await expect(
      app.flows.applyTicketAssistant(p.technical, ticket.id, request.id, {
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const applied = await app.flows.applyTicketAssistant(p.qa, ticket.id, request.id, {
      idempotencyKey: randomUUID(),
    });
    expect(applied?.next?.nodeId).toBe('desenvolvimento');
    const instructions = (
      await fixture.db.query<{ instructions: string }>(
        "SELECT instructions FROM agent_runs WHERE ticket_id=$1 AND status='queued'",
        [ticket.id],
      )
    ).rows[0]?.instructions;
    expect(instructions).toMatch(/Falta validar o IBAN/);
  });
});
