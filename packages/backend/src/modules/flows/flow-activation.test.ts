import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateConditionNode,
  flowDefinitionSchema,
  simulateFlow,
  validateFlowDefinition,
  type FlowDefinition,
  type Role,
  type User,
} from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { migrationChecksums, migrateDatabase } from '../../database/migrate.js';
import { createFlowActionRegistry } from '../incidents/incident.module.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { FlowEngine } from './flow-engine.js';
import { buildFlowManifest, manifestHash, normalizedRouting } from './flow-manifest.js';
import { FlowsService } from './flows.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let flows: FlowsService;
let tickets: TicketsService;

beforeAll(async () => {
  fixture = await startTestDatabase();
  const engine = new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db));
  flows = new FlowsService(fixture.db, engine);
  tickets = new TicketsService(fixture.db, [engine.onPublicComment], [engine.onTicketCreated]);
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

async function project() {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [id, `P02 ${id}`]);
  const admin = await member(id, 'admin');
  return { id, admin, client: await member(id, 'client') };
}

async function activate(admin: User, projectId: string, flowId: string) {
  const current = await flows.get(admin, projectId, flowId);
  return flows.publish(admin, projectId, flowId, { expectedDraftVersion: current.draftVersion });
}

async function byTemplate(admin: User, projectId: string, template: string) {
  const found = (await flows.list(admin, projectId)).find((flow) => flow.template === template);
  expect(found).toBeDefined();
  return found!;
}

async function routing(
  admin: User,
  projectId: string,
  flowId: string,
  change: { priority?: number; isDefault?: boolean; categories?: string[] },
) {
  const current = await flows.get(admin, projectId, flowId);
  return flows.saveSettings(admin, projectId, flowId, {
    name: current.name,
    description: current.description,
    priority: change.priority ?? current.priority,
    isDefault: change.isDefault ?? current.isDefault,
    match: { ...current.match, categories: change.categories ?? current.match.categories },
  });
}

async function ticket(actor: User, category: 'bug' | 'question', priority = 'medium') {
  return tickets.create(actor, {
    title: `Pedido ${category} ${randomUUID().slice(0, 6)}`,
    description: 'Pedido de teste P02.',
    category,
    environment: 'production',
    priority,
  } as Parameters<TicketsService['create']>[1]);
}

async function entered(actor: User, ticketId: string) {
  const view = await flows.ticketFlow(actor, ticketId);
  return view
    ? { flowId: view.execution.flow.id, version: view.execution.version.number, view }
    : null;
}

const count = async (sql: string, params: unknown[]) =>
  Number((await fixture.db.query<{ total: number }>(sql, params)).rows[0]?.total ?? 0);

/** Fluxo V2 mínimo: condição sobre a prioridade do ticket e dois fins distintos. */
function conditionDefinition(): FlowDefinition {
  return {
    schemaVersion: 2,
    start: 'triagem',
    nodes: [
      {
        id: 'triagem',
        op: 'condition',
        label: 'Triagem',
        config: {
          branches: [
            {
              port: 'critico',
              conditions: [{ field: 'ticket.priority', operator: 'equals', value: 'critical' }],
            },
          ],
        },
      },
      { id: 'escalar', op: 'end', label: 'Escalar', config: { outcome: 'escalated' } },
      { id: 'resolver', op: 'end', label: 'Resolver', config: { outcome: 'resolved' } },
    ],
    edges: [
      { id: 'e1', source: 'triagem', port: 'critico', target: 'escalar' },
      { id: 'e2', source: 'triagem', port: 'otherwise', target: 'resolver' },
    ],
    layout: {},
  };
}

describe('P02 — rascunho, ativação explícita e manifesto', () => {
  it('modelos e criação de fluxos não ativam nada; sem ativação os tickets não entram em fluxo', async () => {
    const p = await project();
    const list = await flows.list(p.admin, p.id);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((flow) => flow.published === null && flow.active === null)).toBe(true);
    await flows.create(p.admin, p.id, { name: 'Novo', template: 'blank' });
    expect(
      await count('SELECT COUNT(*) AS total FROM flow_versions WHERE project_id=$1', [p.id]),
    ).toBe(0);
    expect(
      await count('SELECT COUNT(*) AS total FROM flow_activations WHERE project_id=$1', [p.id]),
    ).toBe(0);
    const created = await ticket(p.client, 'question');
    expect(await entered(p.admin, created.id)).toBeNull();
  });

  it('criar fluxos com a prioridade 998 ocupada escolhe prioridades livres', async () => {
    const p = await project();
    const parked = await flows.create(p.admin, p.id, { name: 'Retirado', template: 'blank' });
    await routing(p.admin, p.id, parked.id, { priority: 998 });
    const first = await flows.create(p.admin, p.id, { name: 'Primeiro', template: 'blank' });
    const second = await flows.create(p.admin, p.id, { name: 'Segundo', template: 'blank' });
    expect(new Set([first.priority, second.priority, 998]).size).toBe(3);
    expect(Math.max(first.priority, second.priority)).toBeLessThan(998);
  });

  it('editar rascunho e regras não muda o ativo; ativar afeta só tickets novos', async () => {
    const p = await project();
    const general = await byTemplate(p.admin, p.id, 'general');
    await activate(p.admin, p.id, general.id);
    const bugs = await flows.create(p.admin, p.id, { name: 'Bugs', template: 'blank' });
    await routing(p.admin, p.id, bugs.id, { priority: 5, categories: ['bug'] });

    // Regra gravada mas não ativada: o bug continua a entrar no fluxo geral.
    const first = await ticket(p.client, 'bug');
    expect((await entered(p.admin, first.id))?.flowId).toBe(general.id);

    const activated = await activate(p.admin, p.id, bugs.id);
    expect(activated.published?.number).toBe(1);
    expect(activated.active).toMatchObject({ priority: 5, isDefault: false });
    expect(activated.pendingChanges).toEqual({
      definition: false,
      routing: false,
      alertKeys: false,
    });
    expect(activated.versions[0]).toMatchObject({ schemaVersion: 1, active: true });
    expect(activated.versions[0]?.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(activated.activations[0]).toMatchObject({ kind: 'activation', versionNumber: 1 });
    const second = await ticket(p.client, 'bug');
    expect(await entered(p.admin, second.id)).toMatchObject({ flowId: bugs.id, version: 1 });
    expect((await entered(p.admin, first.id))?.flowId).toBe(general.id);

    // Mudar a regra no rascunho fica pendente e não muda a seleção em serviço.
    const draft = await routing(p.admin, p.id, bugs.id, { categories: ['question'] });
    expect(draft.pendingChanges.routing).toBe(true);
    expect(draft.active?.match.categories).toEqual(['bug']);
    const third = await ticket(p.client, 'bug');
    expect(await entered(p.admin, third.id)).toMatchObject({ flowId: bugs.id, version: 1 });

    // Reativar com só o encaminhamento alterado cria a v2; os tickets anteriores mantêm a v1.
    const v2 = await activate(p.admin, p.id, bugs.id);
    expect(v2.published?.number).toBe(2);
    const question = await ticket(p.client, 'question');
    expect(await entered(p.admin, question.id)).toMatchObject({ flowId: bugs.id, version: 2 });
    const bug = await ticket(p.client, 'bug');
    expect((await entered(p.admin, bug.id))?.flowId).toBe(general.id);
    expect(await entered(p.admin, third.id)).toMatchObject({ flowId: bugs.id, version: 1 });
  });

  it('rejeita revisões desatualizadas, ativações sem alterações e dependências inválidas', async () => {
    const p = await project();
    const general = await byTemplate(p.admin, p.id, 'general');
    await expect(
      flows.publish(p.admin, p.id, general.id, { expectedDraftVersion: general.draftVersion + 1 }),
    ).rejects.toMatchObject({ code: 'FLOW_DRAFT_CHANGED', status: 409 });
    const first = await activate(p.admin, p.id, general.id);
    // Repetir a mesma revisão é idempotente: devolve a ativação existente sem nova versão.
    const replay = await activate(p.admin, p.id, general.id);
    expect(replay.published?.id).toBe(first.published?.id);
    // Uma nova revisão sem diferenças efetivas (regra alterada e reposta) é recusada.
    await routing(p.admin, p.id, general.id, { priority: replay.priority - 1 });
    await routing(p.admin, p.id, general.id, { priority: replay.priority });
    expect((await flows.get(p.admin, p.id, general.id)).draftVersion).toBeGreaterThan(
      replay.draftVersion,
    );
    await expect(activate(p.admin, p.id, general.id)).rejects.toMatchObject({
      code: 'FLOW_UNCHANGED',
    });

    const blank = await flows.create(p.admin, p.id, { name: 'Dependências', template: 'blank' });
    const save = async (definition: FlowDefinition) => {
      const current = await flows.get(p.admin, p.id, blank.id);
      return flows.saveDraft(p.admin, p.id, blank.id, {
        expectedDraftVersion: current.draftVersion,
        definition,
      });
    };
    const withNode = (node: FlowDefinition['nodes'][number]): FlowDefinition => ({
      start: node.id,
      nodes: [node, { id: 'fim', op: 'end', label: 'Fim', config: { outcome: 'resolved' } }],
      edges: [
        { id: 'ok', source: node.id, port: 'success', target: 'fim' },
        { id: 'ko', source: node.id, port: 'failure', target: 'fim' },
      ],
      layout: {},
    });

    await save(
      withNode({
        id: 'perfil',
        op: 'copilot_task',
        label: 'Análise',
        config: { mode: 'analysis', agentProfileId: randomUUID(), agentProfileVersion: 1 },
      }),
    );
    // Sem repositório técnico configurado no teste, a resolução do perfil falha antes (422).
    await expect(activate(p.admin, p.id, blank.id)).rejects.toMatchObject({
      code: expect.stringMatching(/^(AGENT_PROFILE_REFERENCE_INVALID|REPOSITORY_UNAVAILABLE)$/),
      status: 422,
    });
    await save(
      withNode({
        id: 'modelo',
        op: 'copilot_task',
        label: 'Análise',
        config: { mode: 'analysis', model: 'gpt-latest' },
      }),
    );
    await expect(activate(p.admin, p.id, blank.id)).rejects.toMatchObject({
      code: 'FLOW_DEPENDENCY_MUTABLE',
      status: 422,
    });

    // Um runtime sem executor para a ação recusa a ativação (não «promete» capacidades).
    const bare = new FlowsService(fixture.db, new FlowEngine(fixture.db));
    await save(
      withNode({
        id: 'rececao',
        op: 'action',
        label: 'Receber',
        config: { action: 'incident_intake' },
      }),
    );
    const current = await flows.get(p.admin, p.id, blank.id);
    await expect(
      bare.publish(p.admin, p.id, blank.id, { expectedDraftVersion: current.draftVersion }),
    ).rejects.toMatchObject({ code: 'FLOW_DEPENDENCY_MISSING', status: 422 });
    expect(
      await count('SELECT COUNT(*) AS total FROM flow_versions WHERE flow_id=$1', [blank.id]),
    ).toBe(0);
  });

  it('ativações concorrentes e repetidas da mesma revisão criam uma única versão', async () => {
    const p = await project();
    const general = await byTemplate(p.admin, p.id, 'general');
    const results = await Promise.allSettled(
      [0, 1, 2].map(() =>
        flows.publish(p.admin, p.id, general.id, { expectedDraftVersion: general.draftVersion }),
      ),
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(
      new Set(
        results.map((result) =>
          result.status === 'fulfilled' ? result.value.published?.number : null,
        ),
      ),
    ).toEqual(new Set([1]));
    expect(
      await count('SELECT COUNT(*) AS total FROM flow_versions WHERE flow_id=$1', [general.id]),
    ).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM flow_activations WHERE flow_id=$1 AND kind='activation'",
        [general.id],
      ),
    ).toBe(1);
  });

  it('transfere o fluxo por omissão só na ativação e respeita permissões e isolamento', async () => {
    const p = await project();
    const other = await project();
    const general = await byTemplate(p.admin, p.id, 'general');
    await activate(p.admin, p.id, general.id);
    const fallback = await flows.create(p.admin, p.id, { name: 'Nova omissão', template: 'blank' });
    await routing(p.admin, p.id, fallback.id, { isDefault: true });
    expect((await flows.get(p.admin, p.id, general.id)).isDefault).toBe(false);
    const before = await ticket(p.client, 'question');
    expect((await entered(p.admin, before.id))?.flowId).toBe(general.id);
    await expect(activate(p.admin, p.id, general.id)).rejects.toMatchObject({
      code: 'FLOW_DEFAULT_REQUIRED',
    });

    await expect(
      flows.publish(other.admin, p.id, fallback.id, { expectedDraftVersion: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      flows.publish(other.admin, other.id, fallback.id, { expectedDraftVersion: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      flows.publish(p.client, p.id, fallback.id, { expectedDraftVersion: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const activated = await activate(p.admin, p.id, fallback.id);
    expect(activated.active?.isDefault).toBe(true);
    const previous = await flows.get(p.admin, p.id, general.id);
    expect(previous.active).toBeNull();
    expect(previous.activations.map((item) => item.kind)).toContain('default_transfer');
    const after = await ticket(p.client, 'question');
    expect((await entered(p.admin, after.id))?.flowId).toBe(fallback.id);
    expect((await entered(p.admin, before.id))?.flowId).toBe(general.id);
  });

  it('executa condições V2 declarativas sem afetar a interpretação V1', async () => {
    const definition = conditionDefinition();
    expect(validateFlowDefinition(definition)).toEqual([]);
    expect(validateFlowDefinition({ ...definition, schemaVersion: undefined })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unsupported_operation' })]),
    );
    const injected = structuredClone(definition);
    injected.nodes[0]!.config = {
      branches: [
        { port: 'x', conditions: [{ field: 'process.exit', operator: 'equals', value: '1' }] },
      ],
    };
    expect(validateFlowDefinition(injected)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_condition' })]),
    );
    expect(
      evaluateConditionNode(definition.nodes[0]!.config, { ticket: { priority: 'critical' } }),
    ).toBe('critico');
    expect(evaluateConditionNode(definition.nodes[0]!.config, {})).toBe('otherwise');
    expect(simulateFlow(definition, {}, 80, { priority: 'low' }).endOutcome).toBe('resolved');

    const p = await project();
    const general = await byTemplate(p.admin, p.id, 'general');
    const current = await flows.get(p.admin, p.id, general.id);
    await flows.saveDraft(p.admin, p.id, general.id, {
      expectedDraftVersion: current.draftVersion,
      definition,
    });
    const activated = await activate(p.admin, p.id, general.id);
    expect(activated.versions[0]).toMatchObject({ schemaVersion: 2, runtimeContractVersion: 2 });
    const critical = await ticket(p.client, 'question', 'critical');
    const low = await ticket(p.client, 'question', 'low');
    const ended = async (id: string) =>
      (await entered(p.admin, id))?.view.steps.map((step) => step.nodeId);
    expect(await ended(critical.id)).toEqual(expect.arrayContaining(['triagem', 'escalar']));
    expect(await ended(low.id)).toEqual(expect.arrayContaining(['triagem', 'resolver']));
  });

  it('gera um manifesto determinístico sem credenciais', () => {
    const definition = flowDefinitionSchema.parse(conditionDefinition());
    const routingA = normalizedRouting({
      priority: 3,
      isDefault: false,
      match: { origins: [], categories: ['question', 'bug'], environments: [], priorities: [] },
      alertKeys: ['b', 'a', 'a'],
    });
    const routingB = normalizedRouting({
      priority: 3,
      isDefault: false,
      match: { origins: [], categories: ['bug', 'question'], environments: [], priorities: [] },
      alertKeys: ['a', 'b'],
    });
    const deps = { agentProfiles: [], repositoryResources: [], globalInstructions: [] };
    const a = buildFlowManifest(definition, routingA, deps, () => true);
    const b = buildFlowManifest(definition, routingB, deps, () => true);
    expect(manifestHash(a)).toBe(manifestHash(b));
    expect(a.routing.alertKeys).toEqual(['a', 'b']);
    expect(JSON.stringify(a)).not.toMatch(/secret|password|token|ciphertext/i);
  });

  it('a migração 035 preserva a configuração ativa e é reaplicável', async () => {
    const p = await project();
    const general = await byTemplate(p.admin, p.id, 'general');
    const active = await activate(p.admin, p.id, general.id);
    // Estado anterior ao P02: fluxo publicado sem colunas ativas preenchidas nem histórico.
    await fixture.db.query(
      'UPDATE flows SET active_priority=NULL,active_is_default=0,active_flow_match=NULL WHERE id=$1',
      [general.id],
    );
    await fixture.db.query('DELETE FROM flow_activations WHERE flow_id=$1', [general.id]);
    const file = new URL('../../../../../sql/035_flow_explicit_activation.sql', import.meta.url);
    const sql = await readFile(file, 'utf8');
    const directory = fileURLToPath(new URL('../../../../../sql/', import.meta.url));
    for (let attempt = 0; attempt < 2; attempt++) {
      await fixture.db.query(
        "DELETE FROM zeroops_migrations WHERE name='035_flow_explicit_activation.sql'",
      );
      await migrateDatabase(fixture.url, directory);
    }
    const restored = await flows.get(p.admin, p.id, general.id);
    expect(restored.active).toEqual(active.active);
    expect(restored.published?.number).toBe(active.published?.number);
    expect(restored.activations.map((item) => item.kind)).toEqual(['migration']);
    await migrateDatabase(fixture.url, directory);
    const journal = (
      await fixture.db.query<{ checksum: string }>(
        "SELECT checksum FROM zeroops_migrations WHERE name='035_flow_explicit_activation.sql'",
      )
    ).rows[0];
    expect(journal?.checksum).toBe(migrationChecksums(sql).checksum);
    const created = await ticket(p.client, 'question');
    expect((await entered(p.admin, created.id))?.flowId).toBe(general.id);
  });
});
