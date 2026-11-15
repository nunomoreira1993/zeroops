import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlowPatchOperation, Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { ProjectPermissionsService } from '../identity/project-permissions.service.js';
import { createFlowActionRegistry } from '../incidents/incident.module.js';
import { FlowAssistantQueue } from './flow-assistant.js';
import { FlowEngine } from './flow-engine.js';
import { FlowsService } from './flows.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let flows: FlowsService;
let grants: ProjectPermissionsService;
let queue: FlowAssistantQueue;

beforeAll(async () => {
  fixture = await startTestDatabase();
  flows = new FlowsService(
    fixture.db,
    new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db)),
  );
  grants = new ProjectPermissionsService(fixture.db);
  queue = new FlowAssistantQueue(fixture.db);
});
afterAll(async () => fixture?.stop());

async function member(role: Role, projectId: string): Promise<User> {
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    email: `${randomUUID()}@example.test`,
    displayName: `Pessoa ${role}`,
  };
  await fixture.db.query(
    'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, 'unusable-test-hash'],
  );
  return actor;
}

async function project() {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [id, `Autoria ${id}`]);
  const admin = await member('admin', id);
  await fixture.db.query(
    `INSERT INTO integration_settings
       (id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by)
     VALUES ($1,$2,'quality','copilot',1,'verified','cifrado','{}',1,$3)`,
    [randomUUID(), id, admin.id],
  );
  const flow = await flows.create(admin, id, { name: `Teste P06 ${id}`, template: 'blank' });
  return { id, admin, flowId: flow.id };
}

async function grant(admin: User, target: User, permissions: ('flows.edit' | 'flows.view')[]) {
  const access = await grants.access(admin, admin.projectId);
  await grants.update(admin, admin.projectId, {
    userId: target.id,
    permissions,
    expectedVersion: access.project.version,
  });
}

/** Simula um turno do executor: pede, reclama e devolve o lease para as ferramentas. */
async function turn(actor: User, projectId: string, flowId: string, mode?: 'assisted' | 'auto') {
  const request = await flows.requestFlowAssistant(actor, projectId, flowId, {
    message: 'Construir o fluxo de desenvolvimento',
    ...(mode ? { mode } : {}),
  });
  const claimed = await queue.claimNext();
  expect(claimed?.id).toBe(request.id);
  return { request, claimed: claimed! };
}

const addDev: FlowPatchOperation[] = [
  {
    type: 'add_node',
    node: { id: 'dev', op: 'copilot_task', label: 'Desenvolvimento', config: { mode: 'develop' } },
  },
];

async function flowRow(flowId: string) {
  return (
    await fixture.db.query<{ draft_version: number; published_version_id: string | null }>(
      'SELECT draft_version,published_version_id FROM flows WHERE id=$1',
      [flowId],
    )
  ).rows[0]!;
}

describe('Construção de fluxos por conversa (P06)', () => {
  it('modo automático: aplica operações validadas uma a uma, emite eventos e nunca ativa', async () => {
    const p = await project();
    const before = await flowRow(p.flowId);
    const { claimed } = await turn(p.admin, p.id, p.flowId, 'auto');
    expect(claimed.authoring).toEqual({ mode: 'auto' });

    const read = await queue.authoringTool(claimed.lease, 'flow_get_draft', 'c0', {});
    expect(read.ok).toBe(true);
    expect(JSON.parse(read.text).revision).toBe(Number(before.draft_version));

    const first = await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'c1', {
      operations: addDev,
      summary: 'Etapa de desenvolvimento',
    });
    expect(first).toMatchObject({ ok: true });
    // Cada lote aplicado fica logo visível (antes do fim do turno).
    let detail = await flows.get(p.admin, p.id, p.flowId);
    expect(detail.draft.nodes.map((n) => n.id)).toContain('dev');
    expect(detail.draftVersion).toBe(Number(before.draft_version) + 1);
    const end = detail.draft.nodes.find((n) => n.op === 'end')!.id;

    const second = await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'c2', {
      operations: [{ type: 'connect', source: 'dev', port: 'success', target: end }],
    });
    expect(second.ok).toBe(true);
    detail = await flows.get(p.admin, p.id, p.flowId);
    expect(detail.draft.edges.some((e) => e.source === 'dev' && e.target === end)).toBe(true);

    // Repetição da mesma chamada (replay do SDK/rede): sem duplicar nem nova revisão.
    const again = await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'c2', {
      operations: [{ type: 'connect', source: 'dev', port: 'success', target: end }],
    });
    expect(again).toMatchObject({ ok: true });
    expect((await flowRow(p.flowId)).draft_version).toBe(detail.draftVersion);

    expect(await queue.complete(claimed.lease, '{"reply":"Feito.","question":null}')).toBe(
      'accepted',
    );
    const events = await flows.authoringEvents(p.admin, p.id, p.flowId, 0);
    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'turn_queued',
        'turn_started',
        'draft_read',
        'operation_applied',
        'turn_completed',
      ]),
    );
    expect(types.filter((t) => t === 'operation_applied')).toHaveLength(2);
    const applied = events.find((e) => e.type === 'operation_applied')!;
    expect(applied.payload).toMatchObject({ added: ['dev'], kind: 'definition' });
    // Cursor: replay a partir de um evento não devolve os anteriores (sem duplicação).
    const after = await flows.authoringEvents(p.admin, p.id, p.flowId, applied.id);
    expect(after.every((e) => e.id > applied.id)).toBe(true);
    expect(after.filter((e) => e.type === 'operation_applied')).toHaveLength(1);

    const row = await flowRow(p.flowId);
    expect(row.published_version_id).toBe(before.published_version_id);
    const activations = await fixture.db.query('SELECT id FROM flow_activations WHERE flow_id=$1', [
      p.flowId,
    ]);
    expect(activations.rows).toHaveLength(0);
    const history = await flows.flowAssistantHistory(p.admin, p.id, p.flowId);
    expect(history[0]).toMatchObject({ status: 'succeeded', authoringMode: 'auto' });
  });

  it('operação inválida é rejeitada sem corromper o rascunho', async () => {
    const p = await project();
    const before = await flows.get(p.admin, p.id, p.flowId);
    const { claimed } = await turn(p.admin, p.id, p.flowId, 'auto');
    const bad = await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'x1', {
      operations: [
        ...addDev,
        { type: 'connect', source: 'dev', port: 'success', target: 'fantasma' },
      ],
    });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/rejeitada/);
    const schema = await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'x2', {
      operations: [{ type: 'activate_flow' }],
    });
    expect(schema.ok).toBe(false);
    const unknown = await queue.authoringTool(claimed.lease, 'flow_publish', 'x3', {});
    expect(unknown.ok).toBe(false);
    const after = await flows.get(p.admin, p.id, p.flowId);
    expect(after.draft).toEqual(before.draft);
    expect(after.draftVersion).toBe(before.draftVersion);
    const state = await flows.authoringState(p.admin, p.id, p.flowId);
    expect(state.operations.filter((o) => o.status === 'rejected').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('modo assistido: propostas aparecem como eventos e só entram no rascunho ao aceitar', async () => {
    const p = await project();
    const before = await flows.get(p.admin, p.id, p.flowId);
    const { request, claimed } = await turn(p.admin, p.id, p.flowId, 'assisted');
    await queue.authoringTool(claimed.lease, 'flow_get_draft', 'a0', {});
    expect(
      (
        await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'a1', {
          operations: addDev,
        })
      ).ok,
    ).toBe(true);
    expect((await flows.get(p.admin, p.id, p.flowId)).draftVersion).toBe(before.draftVersion);
    const events = await flows.authoringEvents(p.admin, p.id, p.flowId, 0);
    expect(events.find((e) => e.type === 'operation_proposed')?.payload).toMatchObject({
      added: ['dev'],
    });
    await queue.complete(claimed.lease, '{"reply":"Proposta.","question":null}');
    const pending = (await flows.flowAssistantHistory(p.admin, p.id, p.flowId)).find(
      (r) => r.id === request.id,
    )!;
    expect(pending.resolution).toBe('pending');
    await flows.resolveFlowAssistant(p.admin, p.id, p.flowId, request.id, {
      resolution: 'accepted',
      expectedDraftVersion: before.draftVersion,
    });
    const after = await flows.get(p.admin, p.id, p.flowId);
    expect(after.draft.nodes.map((n) => n.id)).toContain('dev');
    expect(after.draftVersion).toBe(before.draftVersion + 1);
  });

  it('pedido antigo sem modo e resposta final com operações mantém a compatibilidade', async () => {
    const p = await project();
    const before = await flows.get(p.admin, p.id, p.flowId);
    const { request, claimed } = await turn(p.admin, p.id, p.flowId);
    expect(claimed.authoring).toEqual({ mode: 'assisted' });
    await queue.complete(
      claimed.lease,
      JSON.stringify({ reply: 'Proponho dev.', question: null, operations: addDev }),
    );
    const done = (await flows.flowAssistantHistory(p.admin, p.id, p.flowId)).find(
      (r) => r.id === request.id,
    )!;
    expect(done.resolution).toBe('pending');
    expect(done.response?.operations).toEqual(addDev);
    expect((await flows.get(p.admin, p.id, p.flowId)).draftVersion).toBe(before.draftVersion);
  });

  it('edição manual concorrente gera conflito sem sobrescrever; reler permite reformular', async () => {
    const p = await project();
    const { claimed } = await turn(p.admin, p.id, p.flowId, 'auto');
    await queue.authoringTool(claimed.lease, 'flow_get_draft', 'r0', {});
    const manual = await flows.get(p.admin, p.id, p.flowId);
    const renamed = {
      ...manual.draft,
      nodes: manual.draft.nodes.map((n) => (n.op === 'end' ? { ...n, label: 'Fim manual' } : n)),
    };
    await flows.saveDraft(p.admin, p.id, p.flowId, {
      definition: renamed,
      expectedDraftVersion: manual.draftVersion,
    });
    const conflict = await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'r1', {
      operations: addDev,
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.text).toMatch(/flow_get_draft/);
    let detail = await flows.get(p.admin, p.id, p.flowId);
    expect(detail.draft.nodes.find((n) => n.op === 'end')?.label).toBe('Fim manual');
    expect(detail.draft.nodes.some((n) => n.id === 'dev')).toBe(false);
    const state = await flows.authoringState(p.admin, p.id, p.flowId);
    expect(state.operations.find((o) => o.status === 'conflict')?.operations).toEqual(addDev);

    await queue.authoringTool(claimed.lease, 'flow_get_draft', 'r2', {});
    expect(
      (
        await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'r3', {
          operations: addDev,
        })
      ).ok,
    ).toBe(true);
    detail = await flows.get(p.admin, p.id, p.flowId);
    expect(detail.draft.nodes.find((n) => n.op === 'end')?.label).toBe('Fim manual');
    expect(detail.draft.nodes.some((n) => n.id === 'dev')).toBe(true);
  });

  it('desfazer cria uma nova revisão auditada e preserva o histórico', async () => {
    const p = await project();
    const before = await flows.get(p.admin, p.id, p.flowId);
    const { claimed } = await turn(p.admin, p.id, p.flowId, 'auto');
    await queue.authoringTool(claimed.lease, 'flow_get_draft', 'u0', {});
    await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'u1', { operations: addDev });
    await queue.complete(claimed.lease, '{"reply":"ok"}');
    const state = await flows.authoringState(p.admin, p.id, p.flowId);
    const applied = state.operations.find(
      (o) => o.status === 'applied' && o.source === 'assistant',
    )!;
    expect(applied.undoable).toBe(true);
    await expect(
      flows.undoAuthoringOperation(p.admin, p.id, p.flowId, applied.id, {
        expectedDraftVersion: before.draftVersion,
      }),
    ).rejects.toMatchObject({ code: 'FLOW_DRAFT_CHANGED' });
    const undone = await flows.undoAuthoringOperation(p.admin, p.id, p.flowId, applied.id, {
      expectedDraftVersion: state.draftVersion,
    });
    expect(undone.draft.nodes.some((n) => n.id === 'dev')).toBe(false);
    expect(undone.draftVersion).toBe(state.draftVersion + 1);
    const after = await flows.authoringState(p.admin, p.id, p.flowId);
    const original = after.operations.find((o) => o.id === applied.id)!;
    expect(original.undoneBy).toBeTruthy();
    expect(original.undoable).toBe(false);
    expect(after.operations.find((o) => o.undoOf === applied.id)?.source).toBe('undo');
    await expect(
      flows.undoAuthoringOperation(p.admin, p.id, p.flowId, applied.id, {
        expectedDraftVersion: after.draftVersion,
      }),
    ).rejects.toMatchObject({ code: 'FLOW_UNDO_UNAVAILABLE' });
  });

  it('cancelamento e perda de posse param o executor sem mais escritas', async () => {
    const p = await project();
    const { request, claimed } = await turn(p.admin, p.id, p.flowId, 'auto');
    await queue.authoringTool(claimed.lease, 'flow_get_draft', 'k0', {});
    await flows.cancelFlowAssistant(p.admin, p.id, p.flowId, request.id);
    const before = await flowRow(p.flowId);
    const result = await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'k1', {
      operations: addDev,
    });
    expect(result).toMatchObject({ ok: false, stop: true });
    expect((await queue.heartbeat(claimed.lease)).owned).toBe(false);
    expect(await queue.complete(claimed.lease, '{"reply":"tarde"}')).not.toBe('accepted');
    expect((await flowRow(p.flowId)).draft_version).toBe(before.draft_version);
    const events = await flows.authoringEvents(p.admin, p.id, p.flowId, 0);
    expect(events.some((e) => e.type === 'turn_cancelled')).toBe(true);
    const history = await flows.flowAssistantHistory(p.admin, p.id, p.flowId);
    expect(history.find((r) => r.id === request.id)).toMatchObject({
      status: 'failed',
      errorCode: 'cancelled',
    });
  });

  it('revogação de flows.edit interrompe a construção e o isolamento entre projetos é respeitado', async () => {
    const p = await project();
    const other = await project();
    const editor = await member('technical', p.id);
    await grant(p.admin, editor, ['flows.edit']);
    const { request, claimed } = await turn(editor, p.id, p.flowId, 'auto');
    await queue.authoringTool(claimed.lease, 'flow_get_draft', 'v0', {});
    // Outro projeto não vê nem altera esta construção.
    await expect(flows.authoringEvents(other.admin, p.id, p.flowId, 0)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      flows.cancelFlowAssistant(other.admin, other.id, p.flowId, request.id),
    ).rejects.toBeTruthy();
    await expect(flows.authoringState(other.admin, other.id, p.flowId)).rejects.toBeTruthy();

    await grant(p.admin, editor, []);
    const before = await flowRow(p.flowId);
    const denied = await queue.authoringTool(claimed.lease, 'flow_apply_operations', 'v1', {
      operations: addDev,
    });
    expect(denied).toMatchObject({ ok: false, stop: true });
    expect((await flowRow(p.flowId)).draft_version).toBe(before.draft_version);
    expect(
      (await flows.flowAssistantHistory(p.admin, p.id, p.flowId)).find((r) => r.id === request.id),
    ).toMatchObject({ status: 'failed', errorCode: 'authorization_revoked' });
    await expect(
      flows.requestFlowAssistant(editor, p.id, p.flowId, { message: 'Mais uma etapa' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('capacidade em falta fica registada e visível sem ser simulada', async () => {
    const p = await project();
    const { claimed } = await turn(p.admin, p.id, p.flowId, 'auto');
    const args = {
      kind: 'tool',
      capability: 'Consulta ao ERP',
      reason: 'Validar stock antes de aprovar',
    };
    expect(
      (await queue.authoringTool(claimed.lease, 'flow_report_missing_capability', 'm1', args)).ok,
    ).toBe(true);
    await queue.authoringTool(claimed.lease, 'flow_report_missing_capability', 'm1', args);
    const state = await flows.authoringState(p.admin, p.id, p.flowId);
    expect(state.capabilities).toHaveLength(1);
    expect(state.capabilities[0]).toMatchObject({ capability: 'Consulta ao ERP', status: 'open' });
    const events = await flows.authoringEvents(p.admin, p.id, p.flowId, 0);
    expect(events.filter((e) => e.type === 'capability_missing')).toHaveLength(1);
  });

  it('mudar de modo afeta só os próximos turnos e é por utilizador', async () => {
    const p = await project();
    await flows.setAuthoringMode(p.admin, p.id, p.flowId, { mode: 'auto' });
    const { claimed } = await turn(p.admin, p.id, p.flowId);
    expect(claimed.authoring).toEqual({ mode: 'auto' });
    await flows.setAuthoringMode(p.admin, p.id, p.flowId, { mode: 'assisted' });
    await queue.authoringTool(claimed.lease, 'flow_get_draft', 's0', {});
    const before = await flowRow(p.flowId);
    await queue.authoringTool(claimed.lease, 'flow_apply_operations', 's1', { operations: addDev });
    expect(Number((await flowRow(p.flowId)).draft_version)).toBe(Number(before.draft_version) + 1);
    expect((await flows.authoringState(p.admin, p.id, p.flowId)).session?.mode).toBe('assisted');
  });
});
