import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PIPELINE_SIGNATURE_HEADER,
  PIPELINE_TIMESTAMP_HEADER,
  type FlowDefinition,
  type FlowNode,
  type ProjectPermission,
  type Role,
  type User,
} from '../../../packages/contracts/src/index.js';
import { startTestDatabase } from '../../../tests/helpers/test-database.js';
import { leaseJob } from '../../../tests/helpers/job-lease.js';
import { AgentRunsService } from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import {
  CapabilityDevelopmentService,
  capabilityTicketCreated,
} from '../../../packages/backend/src/modules/capabilities/capability-development.service.js';
import {
  DeliveryStore,
  type DeliveryRow,
} from '../../../packages/backend/src/modules/delivery/delivery.store.js';
import { verifyPipelineSignature } from '../../../packages/backend/src/modules/delivery/pipeline-signature.js';
import { PipelinesService } from '../../../packages/backend/src/modules/delivery/pipelines.service.js';
import { DevelopmentStore } from '../../../packages/backend/src/modules/development/development.store.js';
import { GitRepositoriesService } from '../../../packages/backend/src/modules/development/git-repositories.service.js';
import { runGit } from '../../../packages/backend/src/modules/development/git.js';
import { FlowEngine } from '../../../packages/backend/src/modules/flows/flow-engine.js';
import { FlowsService } from '../../../packages/backend/src/modules/flows/flows.service.js';
import { IdentityCipher } from '../../../packages/backend/src/modules/identity/identity-security.js';
import { createFlowActionRegistry } from '../../../packages/backend/src/modules/incidents/incident.module.js';
import { TicketsService } from '../../../packages/backend/src/modules/tickets/tickets.service.js';
import { DeliveryRunner, type PipelineTransport } from './delivery-runner.js';
import { DevelopmentRunner } from './development-runner.js';
import { RuntimeDrainWatcher } from './runtime-drain.js';
import { WorkspaceManager } from './workspace-manager.js';

/**
 * P10 de ponta a ponta: pedido de capacidade → ticket no fluxo de desenvolvimento (P08) → review
 * → entrega pela pipeline de capacidades (P09) → versão confirmada no runtime → associação ao
 * rascunho. BD, Git (`file://`), motor, stores e runners reais; só o fornecedor de pipeline (o
 * operador de rollout) é simulado e o runtime ativo é uma variável do teste.
 */
let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let root: string;
const cipher = new IdentityCipher(randomBytes(32).toString('base64'));
const PIPELINE_ORIGIN = 'https://rollout.test';
const SECRET = 'segredo-de-teste-do-operador-com-32+chars';
/** Versão ativa do ZeroOps, como o executor a vê em `ZEROOPS_VERSION`. */
let runtime = 'versao-anterior';

class FakeOperator {
  readonly posts: Record<string, unknown>[] = [];
  readonly runs = new Map<string, { sha: string; digest: string; status: string }>();
  readonly transport: PipelineTransport = async ({ method, url, headers, body }) => {
    const verified = verifyPipelineSignature({
      secret: SECRET,
      timestamp: headers[PIPELINE_TIMESTAMP_HEADER],
      signature: headers[PIPELINE_SIGNATURE_HEADER],
      body: Buffer.from(body ?? ''),
    });
    if (!verified.ok) return { status: 401, body: null };
    const path = new URL(url).pathname;
    if (method === 'POST' && path.endsWith('/deliveries')) {
      const payload = JSON.parse(body!) as Record<string, unknown>;
      this.posts.push(payload);
      const key = String(payload.idempotencyKey);
      if (!this.runs.has(key))
        this.runs.set(key, {
          sha: String(payload.sha),
          digest: String(payload.artifactDigest),
          status: 'accepted',
        });
      return { status: 202, body: { externalId: `rollout-${key}` } };
    }
    const match = /\/deliveries\/([0-9a-f-]{36})$/.exec(path);
    if (method === 'GET' && match) {
      const run = this.runs.get(match[1]!);
      if (!run) return { status: 404, body: null };
      return {
        status: 200,
        body: {
          eventId: `rollout-${match[1]}:${run.status}`,
          idempotencyKey: match[1],
          externalId: `rollout-${match[1]}`,
          sequence: run.status === 'succeeded' ? 2 : 1,
          status: run.status,
          sha: run.sha,
          artifactDigest: run.digest,
          checks: [{ name: 'rollout', status: run.status === 'succeeded' ? 'passed' : 'running' }],
        },
      };
    }
    return { status: 404, body: null };
  };
}

function services(operator: FakeOperator) {
  const engine = new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db));
  const manager = new WorkspaceManager(join(root, 'workspaces'));
  const deliveries = new DeliveryStore(fixture.db, cipher);
  const tickets = new TicketsService(
    fixture.db,
    [engine.onPublicComment],
    [capabilityTicketCreated, engine.onTicketCreated],
  );
  return {
    engine,
    tickets,
    runs: new AgentRunsService(fixture.db, [engine.onRunFinished]),
    flows: new FlowsService(fixture.db, engine),
    deliveries,
    repositories: new GitRepositoriesService(fixture.db, cipher, {
      allowedRoots: [pathToFileURL(root).href],
    }),
    pipelines: new PipelinesService(fixture.db, cipher, {
      allowedOrigins: [PIPELINE_ORIGIN],
      publicUrl: 'https://zeroops.test',
    }),
    capabilities: new CapabilityDevelopmentService(fixture.db, {
      createTicket: (actor, input, options) => tickets.create(actor, input, options),
      runtimeVersion: () => runtime,
    }),
    development: new DevelopmentRunner(new DevelopmentStore(fixture.db, cipher), manager),
    runner: new DeliveryRunner(deliveries, manager, {
      workerId: 'executor-p10',
      allowedOrigins: [PIPELINE_ORIGIN],
      publicUrl: 'https://zeroops.test',
      transport: operator.transport,
      leaseSeconds: 60,
    }),
  };
}
let operator: FakeOperator;
let app: ReturnType<typeof services>;

const git = (cwd: string, ...args: string[]) => runGit(args, { cwd });

async function createOrigin() {
  const name = `zeroops-${randomUUID().slice(0, 8)}`;
  const dir = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  await runGit(['init', '--bare', '--quiet', '-b', 'main', dir]);
  await mkdir(seed, { recursive: true });
  await git(seed, 'init', '--quiet', '-b', 'main');
  await writeFile(join(seed, 'capability.js'), 'module.exports = [];\n');
  await writeFile(join(seed, 'test.js'), "require('./capability.js');\nconsole.log('ok');\n");
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '--quiet', '-m', 'inicial');
  await git(seed, 'push', '--quiet', dir, 'main');
  return pathToFileURL(dir).href;
}

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

const grant = (user: User, permission: ProjectPermission, by: User) =>
  fixture.db.query(
    'INSERT INTO project_permission_grants(user_id,project_id,permission,granted_by) VALUES($1,$2,$3,$4)',
    [user.id, user.projectId, permission, by.id],
  );
const revoke = (user: User, permission: ProjectPermission) =>
  fixture.db.query('DELETE FROM project_permission_grants WHERE user_id=$1 AND permission=$2', [
    user.id,
    permission,
  ]);

/**
 * Projeto de teste: repositório ZeroOps e pipeline de rollout atribuídos às capacidades, fluxo
 * de desenvolvimento «develop → review → deliver» ativo e um fluxo novo (o que pede a capacidade).
 */
async function project() {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [id, `P10 ${id}`]);
  const admin = await member('admin', id, 'Ana Admin');
  await fixture.db.query(
    `INSERT INTO integration_settings
       (id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by)
     VALUES ($1,$2,'quality','copilot',1,'verified','cifrado','{}',1,$3)`,
    [randomUUID(), id, admin.id],
  );
  const repository = await app.repositories.create(admin, id, {
    name: 'ZeroOps',
    url: await createOrigin(),
    baseBranch: 'main',
    allowedRefs: ['main'],
    testCommands: [{ name: 'unit', command: 'node test.js', timeoutSeconds: 60 }],
  });
  await app.repositories.verify(admin, id, repository.id);
  const pipeline = await app.pipelines.create(admin, id, {
    name: 'Rollout ZeroOps QA',
    repositoryId: repository.id,
    targetBranch: 'main',
    environment: 'quality',
    endpointUrl: `${PIPELINE_ORIGIN}/operator`,
    secret: SECRET,
    allowIntegration: true,
  });
  const list = await app.flows.list(admin, id);
  const general = list.find((flow) => flow.template === 'general')!;
  const current = await app.flows.get(admin, id, general.id);
  const end = current.draft.nodes.find((node) => node.op === 'end')!;
  const definition: FlowDefinition = {
    ...current.draft,
    start: 'dev',
    nodes: [
      {
        id: 'dev',
        op: 'copilot_task',
        label: 'Desenvolvimento',
        config: { mode: 'develop', repositoryId: repository.id, publish: 'pull_request' },
      } as FlowNode,
      {
        id: 'review',
        op: 'human_decision',
        label: 'Review',
        config: {
          options: [
            { port: 'success', label: 'Aprovar' },
            { port: 'failure', label: 'Rejeitar', requiresComment: true },
          ],
          review: { sourceNode: 'dev', reviewers: { roles: ['qa'] }, rule: 'any' },
        },
      } as FlowNode,
      {
        id: 'deliver',
        op: 'action',
        label: 'Rollout',
        config: { action: 'deliver', pipelineId: pipeline.id, reviewNode: 'review' },
      } as FlowNode,
      end,
    ],
    edges: [
      { id: 'e1', source: 'dev', port: 'success', target: 'review' },
      { id: 'e2', source: 'dev', port: 'failure', target: end.id },
      { id: 'e3', source: 'review', port: 'success', target: 'deliver' },
      { id: 'e4', source: 'review', port: 'failure', target: 'dev' },
      { id: 'e5', source: 'deliver', port: 'success', target: end.id },
      { id: 'e6', source: 'deliver', port: 'failure', target: 'dev' },
    ],
    layout: {},
  };
  const saved = await app.flows.saveDraft(admin, id, general.id, {
    expectedDraftVersion: current.draftVersion,
    definition,
  });
  await app.flows.publish(admin, id, general.id, { expectedDraftVersion: saved.draftVersion });
  const settings = await app.capabilities.saveSettings(admin, id, {
    repositoryId: repository.id,
    pipelineId: pipeline.id,
    developmentFlowId: general.id,
    expectedVersion: 0,
  });
  expect(settings.version).toBe(1);
  const requester = await app.flows.create(admin, id, {
    name: 'Fluxo que pede capacidade',
    template: 'general',
  });
  return {
    id,
    admin,
    repository,
    pipeline,
    developmentFlowId: general.id,
    flowId: requester.id,
    delegate: await member('technical', id, 'Dora Delegada'),
    outsider: await member('technical', id, 'Óscar Sem Permissão'),
    qa: await member('qa', id, 'Quintino QA'),
  };
}
type Project = Awaited<ReturnType<typeof project>>;

/** Pedido de capacidade em falta, como o assistente de autoria o regista (P06). */
async function capabilityRequest(p: Project, capability: string) {
  const id = randomUUID();
  await fixture.db.query(
    `INSERT INTO flow_capability_requests(id,project_id,flow_id,requested_by,capability_kind,capability,
       reason,idempotency_key) VALUES($1,$2,$3,$4,'tool',$5,$6,$7)`,
    [id, p.id, p.flowId, p.admin.id, capability, 'Falta no catálogo.', `teste:${id}`],
  );
  return id;
}

const startInput = (requestId: string, extra: Record<string, unknown> = {}) => ({
  capabilityRequestId: requestId,
  category: 'zeroops_change',
  title: 'Ação «tag_ticket» no motor',
  requirement: 'O motor deve permitir etiquetar o ticket a partir do fluxo.',
  acceptanceCriteria: ['A ação etiqueta o ticket', 'Testes unitários passam'],
  ...extra,
});

async function develop(ticketId: string) {
  const run = (
    await fixture.db.query<{ id: string }>(
      "SELECT id FROM agent_runs WHERE ticket_id=$1 AND status='queued' AND run_trigger='flow'",
      [ticketId],
    )
  ).rows[0]!;
  const lease = await leaseJob(fixture.db, run.id);
  const prepared = await app.development.prepare(run.id, lease);
  await writeFile(
    join(prepared.checkout.path, 'capability.js'),
    "module.exports = ['tag_ticket'];\n",
  );
  const outcome = await app.development.finalize(prepared, lease, () => true);
  expect(outcome.testsPassed).toBe(true);
  await app.runs.complete(lease, {
    summary: 'Capacidade implementada.',
    replyDraft: null,
    evidence: [],
    patch: outcome.diff,
  });
  await app.development.release(prepared, lease, false);
  return outcome.headSha;
}

async function approve(actor: User, ticketId: string, headSha: string) {
  const flow = (await app.flows.ticketFlow(actor, ticketId))!;
  return app.flows.decide(actor, ticketId, {
    stepId: flow.next!.stepId,
    port: 'success',
    idempotencyKey: randomUUID(),
    artifactSha: headSha,
  });
}

const deliveryOf = async (ticketId: string) =>
  (
    await fixture.db.query<DeliveryRow>(
      'SELECT * FROM delivery_runs WHERE ticket_id=$1 ORDER BY created_at DESC LIMIT 1',
      [ticketId],
    )
  ).rows[0];

async function drive(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await fixture.db.query('UPDATE delivery_runs SET next_check_at=NULL WHERE finished_at IS NULL');
    await fixture.db.query(
      "UPDATE flow_executions SET wake_at=NOW(3) WHERE status IN ('running','waiting') AND wake_at IS NOT NULL",
    );
    await app.engine.tick(50);
    for (let index = 0; index < 20 && (await app.runner.runOnce()); index += 1);
  }
  await app.engine.tick(50);
}

const ticketCount = async (projectId: string) =>
  Number(
    (
      await fixture.db.query<{ total: number }>(
        'SELECT COUNT(*) AS total FROM tickets WHERE project_id=$1',
        [projectId],
      )
    ).rows[0]!.total,
  );

beforeAll(async () => {
  fixture = await startTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'zeroops-p10-'));
  operator = new FakeOperator();
  app = services(operator);
});
afterAll(async () => {
  await fixture?.stop();
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('P10 — desenvolvimento de capacidades pelo fluxo', { timeout: 180_000 }, () => {
  it('delegado inicia sem duplicar; publicação só com autorização separada e vigente; rascunho associado sem ativação', async () => {
    const p = await project();
    const requestId = await capabilityRequest(p, 'tag_ticket');
    await grant(p.delegate, 'capabilities.develop', p.admin);

    // Sem permissão: nem iniciar nem autorizar publicação.
    await expect(
      app.capabilities.start(p.outsider, p.id, p.flowId, startInput(requestId)),
    ).rejects.toMatchObject({ status: 403 });
    // Pedir já a autorização de publicação exige `capabilities.publish`.
    await expect(
      app.capabilities.start(
        p.delegate,
        p.id,
        p.flowId,
        startInput(requestId, { authorizePublish: true }),
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Repetição e concorrência (mensagem repetida/reconexão): um só processo e um só ticket.
    const before = await ticketCount(p.id);
    const [first, second] = await Promise.all([
      app.capabilities.start(p.delegate, p.id, p.flowId, startInput(requestId)),
      app.capabilities.start(p.delegate, p.id, p.flowId, startInput(requestId)),
    ]);
    const again = await app.capabilities.start(p.delegate, p.id, p.flowId, startInput(requestId));
    expect(second.id).toBe(first.id);
    expect(again.id).toBe(first.id);
    expect(await ticketCount(p.id)).toBe(before + 1);
    expect(again).toMatchObject({ state: 'developing', sourceDraftVersion: 1, required: true });
    const ticketId = again.ticket!.id;
    // O ticket corre no fluxo de desenvolvimento atribuído, não no encaminhamento normal.
    const execution = (await app.flows.ticketFlow(p.admin, ticketId))!;
    expect(execution.execution.flow.id).toBe(p.developmentFlowId);

    // A dependência obrigatória bloqueia a ativação, mas não a edição do rascunho.
    const draft = await app.flows.get(p.admin, p.id, p.flowId);
    const edited = await app.flows.saveDraft(p.admin, p.id, p.flowId, {
      expectedDraftVersion: draft.draftVersion,
      definition: {
        ...draft.draft,
        nodes: draft.draft.nodes.map((node) =>
          node.op === 'end' ? { ...node, label: 'Fim (editado)' } : node,
        ),
      },
    });
    expect(edited.draftVersion).toBe(draft.draftVersion + 1);
    await expect(
      app.flows.publish(p.admin, p.id, p.flowId, { expectedDraftVersion: edited.draftVersion }),
    ).rejects.toMatchObject({ code: 'FLOW_CAPABILITY_PENDING' });

    // Desenvolvimento e testes reais no checkout isolado; review humano pelo revisor configurado.
    const head = await develop(ticketId);
    await app.capabilities.sync(first.id);
    expect((await app.capabilities.list(p.delegate, p.id, p.flowId)).developments[0]).toMatchObject(
      {
        state: 'review',
        development: expect.objectContaining({ headSha: head, testsPassed: true }),
      },
    );
    await approve(p.qa, ticketId, head);
    // Sem autorização de publicação, a entrega espera (nada chega ao operador).
    await drive();
    expect(await deliveryOf(ticketId)).toBeUndefined();
    expect(operator.posts).toEqual([]);
    await app.capabilities.sync(first.id);
    expect((await app.capabilities.list(p.delegate, p.id, p.flowId)).developments[0]).toMatchObject(
      { state: 'review', stateReason: expect.stringContaining('autorização') },
    );

    // Autorização separada por um delegado com `capabilities.publish`.
    const publisher = await member('technical', p.id, 'Paulo Publicador');
    await grant(publisher, 'capabilities.publish', p.admin);
    const current = (await app.capabilities.list(p.admin, p.id, p.flowId)).developments[0]!;
    await expect(
      app.capabilities.authorizePublish(p.delegate, p.id, p.flowId, first.id, {
        expectedVersion: current.version,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const authorized = await app.capabilities.authorizePublish(
      publisher,
      p.id,
      p.flowId,
      first.id,
      {
        expectedVersion: current.version,
      },
    );
    expect(authorized.publishAuthorizedBy).toBe(publisher.displayName);

    // A revogação antes do rollout volta a impedir a publicação (sem pedido ao operador).
    await fixture.db.query(
      'UPDATE delivery_runs SET next_check_at=TIMESTAMPADD(HOUR,1,NOW(3)) WHERE project_id<>$1 AND finished_at IS NULL',
      [p.id],
    );
    await app.engine.tick(50);
    expect((await deliveryOf(ticketId))?.state).toBe('queued');
    await revoke(publisher, 'capabilities.publish');
    await drive();
    const blocked = (await deliveryOf(ticketId))!;
    expect(blocked.state).toBe('blocked');
    expect(blocked.state_reason).toMatch(/capabilities\.publish/);
    expect(operator.posts).toEqual([]);
    await app.capabilities.sync(first.id);
    expect((await app.capabilities.list(p.admin, p.id, p.flowId)).developments[0]!.state).toBe(
      'failed',
    );
  });

  it('rollout confirmado pela versão do runtime; associação auditada sem ativação automática', async () => {
    const p = await project();
    const requestId = await capabilityRequest(p, 'tag_ticket');
    runtime = 'versao-anterior';
    const started = await app.capabilities.start(
      p.admin,
      p.id,
      p.flowId,
      startInput(requestId, { authorizePublish: true }),
    );
    const ticketId = started.ticket!.id;
    const head = await develop(ticketId);
    await approve(p.qa, ticketId, head);
    await drive();
    const delivery = (await deliveryOf(ticketId))!;
    expect(delivery.state).toBe('publishing');
    expect(operator.posts.filter((post) => post.deliveryId === delivery.id)).toEqual([
      expect.objectContaining({ sha: delivery.integrated_sha, environment: 'quality' }),
    ]);
    // «Aceite» pelo operador não é publicação.
    await app.capabilities.sync(started.id);
    let view = (await app.capabilities.list(p.admin, p.id, p.flowId)).developments[0]!;
    expect(view.state).toBe('publishing');

    // O operador confirma o rollout; a capacidade só fica disponível com a versão no runtime.
    operator.runs.get(delivery.idempotency_key)!.status = 'succeeded';
    await drive();
    expect((await deliveryOf(ticketId))!.state).toBe('published');
    await app.capabilities.sync(started.id);
    view = (await app.capabilities.list(p.admin, p.id, p.flowId)).developments[0]!;
    expect(view.state).toBe('published');
    const draft = await app.flows.get(p.admin, p.id, p.flowId);
    await expect(
      app.capabilities.link(p.admin, p.id, p.flowId, started.id, {
        expectedVersion: view.version,
        expectedDraftVersion: draft.draftVersion,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_AVAILABLE' });

    runtime = delivery.integrated_sha!;
    await app.capabilities.sync(started.id);
    view = (await app.capabilities.list(p.admin, p.id, p.flowId)).developments[0]!;
    expect(view).toMatchObject({
      state: 'available',
      publishedSha: delivery.integrated_sha,
      publishedDigest: delivery.artifact_digest,
      runtimeVersion: delivery.integrated_sha,
    });

    // A ativação continua bloqueada até à associação explícita.
    await expect(
      app.flows.publish(p.admin, p.id, p.flowId, { expectedDraftVersion: draft.draftVersion }),
    ).rejects.toMatchObject({ code: 'FLOW_CAPABILITY_PENDING' });
    const linked = await app.capabilities.link(p.admin, p.id, p.flowId, started.id, {
      expectedVersion: view.version,
      expectedDraftVersion: draft.draftVersion,
    });
    expect(linked).toMatchObject({ state: 'linked', linkedDraftVersion: draft.draftVersion + 1 });
    // Associar não ativa: o fluxo continua sem versão publicada até ativação explícita.
    const after = await app.flows.get(p.admin, p.id, p.flowId);
    expect(after.draftVersion).toBe(draft.draftVersion + 1);
    expect(after.published).toBeNull();
    const audit = await fixture.db.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'capability.%' AND JSON_UNQUOTE(JSON_EXTRACT(details,'$.developmentId'))=$1",
      [started.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['capability.development_requested', 'capability.linked']),
    );
    const activated = await app.flows.publish(p.admin, p.id, p.flowId, {
      expectedDraftVersion: after.draftVersion,
    });
    expect(activated.published).toBeTruthy();
    // O ticket de desenvolvimento (já existente) mantém a versão do fluxo em que começou.
    expect((await app.flows.ticketFlow(p.admin, ticketId))!.execution.status).toBe('completed');
  });

  it('rascunho alterado exige confirmação; cancelamento preserva o ticket e veda a publicação', async () => {
    const p = await project();
    const requestId = await capabilityRequest(p, 'tag_ticket');
    runtime = 'versao-anterior';
    const started = await app.capabilities.start(p.admin, p.id, p.flowId, startInput(requestId));
    const ticketId = started.ticket!.id;
    const cancelled = await app.capabilities.cancel(p.admin, p.id, p.flowId, started.id, {
      expectedVersion: started.version,
    });
    expect(cancelled.state).toBe('cancelled');
    // O ticket e o histórico ficam; a ativação deixa de estar bloqueada por este pedido.
    expect((await app.tickets.get(p.admin, ticketId)).id).toBe(ticketId);
    const events = await fixture.db.query<{ kind: string }>(
      'SELECT kind FROM capability_development_events WHERE development_id=$1 ORDER BY id',
      [started.id],
    );
    expect(events.rows.map((row) => row.kind)).toEqual(
      expect.arrayContaining(['requested', 'ticket_created', 'cancelled']),
    );
    // Depois de cancelado, a entrega do ticket nunca chega ao operador.
    const head = await develop(ticketId);
    await approve(p.qa, ticketId, head);
    await drive();
    const delivery = await deliveryOf(ticketId);
    expect(delivery === undefined || delivery.state === 'blocked').toBe(true);
    expect(operator.posts.filter((post) => post.deliveryId === delivery?.id)).toEqual([]);

    // Um segundo pedido com o rascunho alterado: a associação exige confirmação explícita.
    const second = await capabilityRequest(p, 'outra_capacidade');
    const config = await app.capabilities.start(
      p.admin,
      p.id,
      p.flowId,
      startInput(second, { category: 'agent_skill', title: 'Skill de triagem' }),
    );
    expect(config.ticket).toBeNull();
    const now = await app.flows.get(p.admin, p.id, p.flowId);
    const changed = now.draft.nodes.map((node) =>
      node.op === 'end' ? { ...node, label: `${node.label} (alterado)` } : node,
    );
    const saved = await app.flows.saveDraft(p.admin, p.id, p.flowId, {
      expectedDraftVersion: now.draftVersion,
      definition: { ...now.draft, nodes: changed },
    });
    await expect(
      app.capabilities.link(p.admin, p.id, p.flowId, config.id, {
        expectedVersion: config.version,
        expectedDraftVersion: saved.draftVersion,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DRAFT_CHANGED' });
    const linked = await app.capabilities.link(p.admin, p.id, p.flowId, config.id, {
      expectedVersion: config.version,
      expectedDraftVersion: saved.draftVersion,
      acknowledgeDraftChanged: true,
    });
    expect(linked.state).toBe('linked');
  });

  it('drenagem de rollout: o executor deixa de reclamar jobs enquanto houver uma drenagem ativa', async () => {
    const watcher = new RuntimeDrainWatcher(fixture.db, { intervalMs: 60_000 });
    await watcher.refresh();
    expect(watcher.active).toBe(false);
    const id = randomUUID();
    await fixture.db.query(
      `INSERT INTO zeroops_runtime_drains(id,reason,requested_by,expires_at)
       VALUES($1,'rollout:teste','teste',TIMESTAMPADD(MINUTE,5,NOW(3)))`,
      [id],
    );
    await watcher.refresh();
    expect(watcher.active).toBe(true);
    await fixture.db.query('UPDATE zeroops_runtime_drains SET released_at=NOW(3) WHERE id=$1', [
      id,
    ]);
    await watcher.refresh();
    expect(watcher.active).toBe(false);
  });
});
