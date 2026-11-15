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
  type PipelineCallback,
  type Role,
  type User,
} from '../../../packages/contracts/src/index.js';
import { startTestDatabase } from '../../../tests/helpers/test-database.js';
import { leaseJob } from '../../../tests/helpers/job-lease.js';
import { AgentRunsService } from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import {
  DeliveryStore,
  type DeliveryRow,
} from '../../../packages/backend/src/modules/delivery/delivery.store.js';
import { receivePipelineCallback } from '../../../packages/backend/src/modules/delivery/pipeline-callbacks.js';
import {
  signPipelinePayload,
  verifyPipelineSignature,
} from '../../../packages/backend/src/modules/delivery/pipeline-signature.js';
import { PipelinesService } from '../../../packages/backend/src/modules/delivery/pipelines.service.js';
import { DevelopmentStore } from '../../../packages/backend/src/modules/development/development.store.js';
import { GitRepositoriesService } from '../../../packages/backend/src/modules/development/git-repositories.service.js';
import { remoteBranchSha, runGit } from '../../../packages/backend/src/modules/development/git.js';
import { FlowEngine } from '../../../packages/backend/src/modules/flows/flow-engine.js';
import { FlowsService } from '../../../packages/backend/src/modules/flows/flows.service.js';
import { IdentityCipher } from '../../../packages/backend/src/modules/identity/identity-security.js';
import { createFlowActionRegistry } from '../../../packages/backend/src/modules/incidents/incident.module.js';
import { TicketsService } from '../../../packages/backend/src/modules/tickets/tickets.service.js';
import { WorkflowService } from '../../../packages/backend/src/modules/workflow/workflow.service.js';
import { DeliveryRunner, type PipelineTransport } from './delivery-runner.js';
import { DevelopmentRunner } from './development-runner.js';
import { WorkspaceManager, type AttemptCheckout, type CommandResult } from './workspace-manager.js';
import type { DevelopmentCommand } from '../../../packages/contracts/src/index.js';
import {
  canonicalEnvironmentKey,
  canonicalIntegrationKey,
  normalizeResourceUrl,
  renewResourceLock,
} from '../../../packages/backend/src/database/resource-locks.js';

/**
 * P09 de ponta a ponta: Git real (origens `file://`), BD de teste, motor de fluxos, stores e
 * runners reais. Só o fornecedor de pipeline é simulado (`FakeProvider`): verifica a assinatura
 * de cada pedido, regista os pedidos que lhe chegam e responde como um fornecedor real
 * (aceitação, estado por consulta, callbacks assinadas). O agente de desenvolvimento escreve
 * ficheiros no checkout, como nos testes do P08.
 */
let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let root: string;
const cipher = new IdentityCipher(randomBytes(32).toString('base64'));
const PIPELINE_ORIGIN = 'https://pipeline.test';
const SECRET = 'segredo-de-teste-da-pipeline-com-32+chars';

interface ProviderRun {
  externalId: string;
  sha: string;
  digest: string;
  status: PipelineCallback['status'];
  sequence: number;
}

/** Fornecedor de pipeline simulado (o que lhe chega fica registado em `posts`). */
class FakeProvider {
  readonly posts: Record<string, unknown>[] = [];
  readonly runs = new Map<string, ProviderRun>();
  /** O próximo POST chega ao fornecedor mas a resposta perde-se (timeout depois do envio). */
  dropNextResponse = false;
  /** O próximo POST perde-se antes de chegar ao fornecedor. */
  loseNextRequest = false;

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
      if (this.loseNextRequest) {
        this.loseNextRequest = false;
        throw new Error('ligação recusada');
      }
      const payload = JSON.parse(body!) as Record<string, unknown>;
      this.posts.push(payload);
      const key = String(payload.idempotencyKey);
      if (!this.runs.has(key))
        this.runs.set(key, {
          externalId: `run-${this.runs.size + 1}`,
          sha: String(payload.sha),
          digest: String(payload.artifactDigest),
          status: 'accepted',
          sequence: 0,
        });
      if (this.dropNextResponse) {
        this.dropNextResponse = false;
        throw new Error('timeout');
      }
      return { status: 202, body: { externalId: this.runs.get(key)!.externalId } };
    }
    const match = /\/deliveries\/([0-9a-f-]{36})$/.exec(path);
    if (method === 'GET' && match) {
      const run = this.runs.get(match[1]!);
      return run ? { status: 200, body: this.event(match[1]!, run) } : { status: 404, body: null };
    }
    return { status: 404, body: null };
  };

  /** Avança a execução externa e devolve o evento (callback) correspondente. */
  advance(key: string, status: PipelineCallback['status']): PipelineCallback {
    const run = this.runs.get(key)!;
    run.status = status;
    run.sequence += 1;
    return this.event(key, run);
  }

  event(key: string, run: ProviderRun): PipelineCallback {
    return {
      eventId: `${run.externalId}:${run.sequence}`,
      idempotencyKey: key,
      externalId: run.externalId,
      sequence: run.sequence,
      status: run.status,
      sha: run.sha,
      artifactDigest: run.digest,
      checks: [
        {
          name: 'deploy',
          status:
            run.status === 'succeeded' ? 'passed' : run.status === 'failed' ? 'failed' : 'running',
        },
      ],
    };
  }
}

function services(provider: FakeProvider) {
  const engine = new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db));
  const manager = new WorkspaceManager(join(root, 'workspaces'));
  const deliveries = new DeliveryStore(fixture.db, cipher);
  return {
    engine,
    tickets: new TicketsService(fixture.db, [engine.onPublicComment], [engine.onTicketCreated]),
    runs: new AgentRunsService(fixture.db, [engine.onRunFinished]),
    flows: new FlowsService(fixture.db, engine),
    store: new DevelopmentStore(fixture.db, cipher),
    deliveries,
    repositories: new GitRepositoriesService(fixture.db, cipher, {
      allowedRoots: [pathToFileURL(root).href],
    }),
    pipelines: new PipelinesService(fixture.db, cipher, {
      allowedOrigins: [PIPELINE_ORIGIN],
      publicUrl: 'https://zeroops.test',
    }),
    workflow: new WorkflowService(fixture.db, {
      investigation: true,
      implementation: true,
      deployment: true,
      blockers: [],
    }),
    manager,
    development: new DevelopmentRunner(new DevelopmentStore(fixture.db, cipher), manager),
    runner: new DeliveryRunner(deliveries, manager, {
      workerId: 'executor-p09',
      allowedOrigins: [PIPELINE_ORIGIN],
      publicUrl: 'https://zeroops.test',
      transport: provider.transport,
      leaseSeconds: 60,
    }),
  };
}
let provider: FakeProvider;
let app: ReturnType<typeof services>;

const git = (cwd: string, ...args: string[]) => runGit(args, { cwd });

/** Origem bare com `main`: app.js e um teste que falha se app.js contiver «broken». */
async function createOrigin() {
  const name = `origin-${randomUUID().slice(0, 8)}`;
  const dir = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  await runGit(['init', '--bare', '--quiet', '-b', 'main', dir]);
  await mkdir(seed, { recursive: true });
  await git(seed, 'init', '--quiet', '-b', 'main');
  await writeFile(join(seed, 'app.js'), 'module.exports = "v0";\n');
  await writeFile(
    join(seed, 'test.js'),
    "const fs = require('fs');\nif (fs.readFileSync('app.js', 'utf8').includes('broken')) process.exit(1);\nconsole.log('ok');\n",
  );
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '--quiet', '-m', 'inicial');
  await git(seed, 'push', '--quiet', dir, 'main');
  return { dir, url: pathToFileURL(dir).href };
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

/** Projeto com repositório, pipeline e fluxo «develop → review → deliver» ativo. */
async function project(rule: 'any' | 'all' = 'any') {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [id, `P09 ${id}`]);
  const admin = await member('admin', id, 'Ana Admin');
  await fixture.db.query(
    `INSERT INTO integration_settings
       (id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by)
     VALUES ($1,$2,'quality','copilot',1,'verified','cifrado','{}',1,$3)`,
    [randomUUID(), id, admin.id],
  );
  const origin = await createOrigin();
  const people = {
    id,
    admin,
    origin,
    client: await member('client', id, 'Carla Cliente'),
    technical: await member('technical', id, 'Tiago Técnico'),
    qa: await member('qa', id, 'Quintino QA'),
    qa2: await member('qa', id, 'Quitéria QA'),
  };
  const repository = await app.repositories.create(admin, id, {
    name: 'Sandbox',
    url: origin.url,
    baseBranch: 'main',
    allowedRefs: ['main'],
    testCommands: [{ name: 'unit', command: 'node test.js', timeoutSeconds: 60 }],
  });
  await app.repositories.verify(admin, id, repository.id);
  // Um técnico não gere pipelines (exige `repositories.manage`).
  const pipelineInput = {
    name: 'QA',
    repositoryId: repository.id,
    targetBranch: 'main',
    environment: 'quality',
    endpointUrl: `${PIPELINE_ORIGIN}/hooks`,
    secret: SECRET,
    allowIntegration: true,
  };
  await expect(app.pipelines.create(people.technical, id, pipelineInput)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    app.pipelines.create(admin, id, { ...pipelineInput, endpointUrl: 'https://outro.test/x' }),
  ).rejects.toBeTruthy();
  const pipeline = await app.pipelines.create(admin, id, pipelineInput);
  expect(JSON.stringify(pipeline)).not.toContain(SECRET);
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
          review: { sourceNode: 'dev', reviewers: { roles: ['qa'] }, rule },
        },
      } as FlowNode,
      {
        id: 'deliver',
        op: 'action',
        label: 'Entrega QA',
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
  return { ...people, repository, pipeline };
}

async function ticket(author: User, title: string) {
  return app.tickets.create(author, {
    title,
    description: 'Pedido de alteração.',
    category: 'improvement',
    environment: 'quality',
    priority: 'medium',
  });
}

/** Simula o agente sobre o checkout isolado e termina a run com os testes reais. */
async function develop(ticketId: string, edit: (dir: string) => Promise<void>) {
  const run = (
    await fixture.db.query<{ id: string }>(
      "SELECT id FROM agent_runs WHERE ticket_id=$1 AND status='queued' AND run_trigger='flow'",
      [ticketId],
    )
  ).rows[0]!;
  const lease = await leaseJob(fixture.db, run.id);
  const prepared = await app.development.prepare(run.id, lease);
  await edit(prepared.checkout.path);
  const outcome = await app.development.finalize(prepared, lease, () => true);
  expect(outcome.testsPassed).toBe(true);
  await app.runs.complete(lease, {
    summary: 'Alteração feita.',
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

/** Corre o executor até a fila parar (as esperas por relógio da BD são antecipadas). */
async function drive(rounds = 4) {
  for (let round = 0; round < rounds; round += 1) {
    await fixture.db.query('UPDATE delivery_runs SET next_check_at=NULL WHERE finished_at IS NULL');
    for (let index = 0; index < 20 && (await app.runner.runOnce()); index += 1);
  }
  await app.engine.tick(50);
}

/** Envia uma callback assinada como o fornecedor faria. */
async function callback(pipelineId: string, event: PipelineCallback, secret = SECRET) {
  const body = Buffer.from(JSON.stringify(event));
  const timestamp = String(Math.floor(Date.now() / 1000));
  return receivePipelineCallback(app.deliveries, pipelineId, {
    timestamp,
    signature: signPipelinePayload(secret, timestamp, body),
    body,
  });
}

const isAncestor = async (originDir: string, ancestor: string, sha: string) =>
  runGit(['--git-dir', originDir, 'merge-base', '--is-ancestor', ancestor, sha]).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  fixture = await startTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'zeroops-p09-'));
  provider = new FakeProvider();
  app = services(provider);
});
afterAll(async () => {
  await fixture?.stop();
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('P09 — entrega por pipeline controlada pelo fluxo', { timeout: 180_000 }, () => {
  it('sem o review exigido não há entrega; antes de integrar as aprovações e o candidato são revalidados', async () => {
    const p = await project('all');
    const t = await ticket(p.client, 'Pedido com quórum');
    const head = await develop(t.id, (dir) =>
      writeFile(join(dir, 'app.js'), 'module.exports = "quorum";\n'),
    );
    const mainBefore = await remoteBranchSha(p.origin.url, 'main');

    // 1/2 aprovações: a etapa de entrega nem é alcançada.
    await approve(p.qa, t.id, head);
    expect(await deliveryOf(t.id)).toBeUndefined();
    expect((await app.flows.ticketFlow(p.technical, t.id))!.next?.nodeId).toBe('review');
    // Rotas legadas não publicam tickets geridos por fluxo.
    const legacy = await app.tickets.get(p.admin, t.id);
    await expect(
      app.workflow.transition(p.admin, t.id, {
        expectedVersion: legacy.version,
        action: 'cancel',
        notes: 'Saltar o review e publicar',
      }),
    ).rejects.toMatchObject({ code: 'FLOW_MANAGED' });

    await approve(p.qa2, t.id, head);
    const queued = (await deliveryOf(t.id))!;
    expect(queued).toMatchObject({ state: 'queued', candidate_head_sha: head });

    // Os revisores deixam de estar ativos antes da integração: as aprovações deixam de valer.
    await fixture.db.query('UPDATE users SET disabled=1 WHERE id IN ($1,$2)', [p.qa.id, p.qa2.id]);
    await drive();
    const blocked = (await deliveryOf(t.id))!;
    expect(blocked.state).toBe('blocked');
    expect(blocked.state_reason).toMatch(/Faltam aprovações válidas/);
    expect(provider.posts.filter((post) => post.deliveryId === blocked.id)).toEqual([]);
    expect(await remoteBranchSha(p.origin.url, 'main')).toBe(mainBefore);
    await fixture.db.query('UPDATE users SET disabled=0 WHERE id IN ($1,$2)', [p.qa.id, p.qa2.id]);

    // Alteração material depois da aprovação: volta ao desenvolvimento sem integrar.
    const t2 = await ticket(p.client, 'Pedido alterado depois do review');
    const head2 = await develop(t2.id, (dir) =>
      writeFile(join(dir, 'app.js'), 'module.exports = "material";\n'),
    );
    await approve(p.qa, t2.id, head2);
    await approve(p.qa2, t2.id, head2);
    expect((await deliveryOf(t2.id))?.state).toBe('queued');
    await fixture.db.query('UPDATE development_workspaces SET head_sha=$2 WHERE ticket_id=$1', [
      t2.id,
      'f'.repeat(40),
    ]);
    await drive();
    const rework = (await deliveryOf(t2.id))!;
    expect(rework.state).toBe('rework');
    expect(rework.state_reason).toMatch(/mudou depois da aprovação/);
    expect(await remoteBranchSha(p.origin.url, 'main')).toBe(mainBefore);
    expect((await app.flows.ticketFlow(p.technical, t2.id))!.next?.nodeId).toBe('dev');
  });

  it('A entra antes de B; B é revalidado sobre a base atual; o ambiente é exclusivo; callbacks idempotentes', async () => {
    const p = await project();
    const a = await ticket(p.client, 'Pedido A');
    const b = await ticket(p.client, 'Pedido B');
    const c = await ticket(p.client, 'Pedido C');
    const base = (await remoteBranchSha(p.origin.url, 'main'))!;
    const headA = await develop(a.id, async (dir) => {
      await writeFile(join(dir, 'app.js'), 'module.exports = "A";\n');
      await writeFile(join(dir, 'a.txt'), 'A\n');
    });
    const headB = await develop(b.id, (dir) => writeFile(join(dir, 'b.txt'), 'B\n'));
    const headC = await develop(c.id, (dir) =>
      writeFile(join(dir, 'app.js'), 'module.exports = "C";\n'),
    );
    await approve(p.qa, a.id, headA);
    await approve(p.qa, b.id, headB);
    await approve(p.qa, c.id, headC);
    const queuePositions = await app.deliveries.ticketDeliveries(fixture.db, b.id);
    expect(queuePositions[0]?.queuePosition).toBe(2);

    await drive();
    const dA = (await deliveryOf(a.id))!;
    const dB = (await deliveryOf(b.id))!;
    const dC = (await deliveryOf(c.id))!;
    // A: fast-forward sobre a base, publicado com o SHA/digest exatos.
    expect(dA).toMatchObject({
      state: 'publishing',
      target_sha: base,
      integrated_sha: headA,
      revalidated: false,
    });
    expect(dA.artifact_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const postsA = provider.posts.filter((post) => post.deliveryId === dA.id);
    expect(postsA).toEqual([
      expect.objectContaining({
        sha: headA,
        artifactDigest: dA.artifact_digest,
        environment: 'quality',
        idempotencyKey: dA.idempotency_key,
        callbackUrl: `https://zeroops.test/api/pipelines/${p.pipeline.id}/callbacks`,
      }),
    ]);
    // B: partiu da mesma base; integrado por merge sobre A e com os testes repetidos na combinação.
    expect(dB.target_sha).toBe(headA);
    expect(dB.revalidated).toBe(true);
    expect(dB.integrated_sha).not.toBe(headB);
    expect(await isAncestor(p.origin.dir, headA, dB.integrated_sha!)).toBe(true);
    expect(await isAncestor(p.origin.dir, headB, dB.integrated_sha!)).toBe(true);
    const evidenceB = (typeof dB.evidence === 'string' ? JSON.parse(dB.evidence) : dB.evidence) as {
      mode: string;
      revalidation: { sha: string; commands: { name: string; exitCode: number }[] };
    };
    expect(evidenceB.mode).toBe('merge');
    expect(evidenceB.revalidation.sha).toBe(dB.integrated_sha);
    expect(evidenceB.revalidation.commands).toEqual([
      expect.objectContaining({ name: 'unit', exitCode: 0 }),
    ]);
    // O ambiente de QA está reservado por A: B espera, sem pedido ao fornecedor.
    expect(dB.state).toBe('starting');
    expect(dB.state_reason).toMatch(/À espera do ambiente quality/);
    expect(provider.posts.filter((post) => post.deliveryId === dB.id)).toEqual([]);
    // C altera a mesma linha que A: conflito, regressa ao desenvolvimento com o motivo.
    expect(dC.state).toBe('conflict');
    expect(dC.state_reason).toMatch(/Conflito ao integrar.*app\.js/);
    const flowC = (await app.flows.ticketFlow(p.technical, c.id))!;
    expect(flowC.next?.nodeId).toBe('dev');

    // Callbacks: duplicada, fora de ordem, assinatura inválida e mensagens tardias.
    const keyA = dA.idempotency_key;
    const running = provider.advance(keyA, 'running');
    expect((await callback(p.pipeline.id, running)).outcome).toBe('applied');
    expect((await callback(p.pipeline.id, running)).outcome).toBe('duplicate');
    const running2 = provider.advance(keyA, 'running');
    expect((await callback(p.pipeline.id, running2)).outcome).toBe('applied');
    expect(
      (await callback(p.pipeline.id, { ...running, eventId: 'reenvio-antigo:1' })).outcome,
    ).toBe('out_of_order');
    await expect(
      callback(
        p.pipeline.id,
        provider.advance(keyA, 'running'),
        'segredo-errado-com-32-chars-xxxxx',
      ),
    ).rejects.toMatchObject({ status: 401 });
    // «Aceite»/«a correr» não é publicação.
    expect((await deliveryOf(a.id))!.state).toBe('publishing');
    const done = provider.advance(keyA, 'succeeded');
    expect((await callback(p.pipeline.id, done)).outcome).toBe('applied');
    expect(
      (await callback(p.pipeline.id, { ...running2, eventId: 'tardia:9', sequence: 99 })).outcome,
    ).toBe('ignored_terminal');
    expect((await deliveryOf(a.id))!).toMatchObject({
      state: 'published',
      pipeline_status: 'succeeded',
    });
    await app.engine.tick(50);
    expect((await app.flows.ticketFlow(p.technical, a.id))!.execution.status).toBe('completed');

    // Com o ambiente livre, B é publicado com a combinação validada (A + B).
    await drive();
    const startedB = (await deliveryOf(b.id))!;
    expect(startedB.state).toBe('publishing');
    expect(provider.posts.filter((post) => post.deliveryId === dB.id)).toEqual([
      expect.objectContaining({ sha: dB.integrated_sha, artifactDigest: dB.artifact_digest }),
    ]);
    // Reconciliação por consulta (sem callback) conclui a publicação.
    provider.advance(startedB.idempotency_key, 'succeeded');
    await drive();
    expect((await deliveryOf(b.id))!.state).toBe('published');
    expect(await remoteBranchSha(p.origin.url, 'main')).toBe(dB.integrated_sha);
    const view = await app.deliveries.ticketDeliveries(fixture.db, a.id);
    const events = view[0]!.events;
    expect(events.map((event) => event.outcome)).toEqual(
      expect.arrayContaining(['applied', 'out_of_order', 'ignored_terminal']),
    );
    // A callback duplicada não cria um segundo registo nem um segundo efeito.
    expect(events.filter((event) => event.eventId === running.eventId)).toHaveLength(1);
    const locks = await fixture.db.query(
      'SELECT lock_key FROM resource_locks WHERE holder_id IN ($1,$2)',
      [dA.id, dB.id],
    );
    expect(locks.rows).toEqual([]);
  });

  it('perda de posse sem efeitos da tentativa antiga; timeout reconciliado sem pedido duplicado', async () => {
    const p = await project();
    const d = await ticket(p.client, 'Pedido D');
    const headD = await develop(d.id, (dir) => writeFile(join(dir, 'd.txt'), 'D\n'));
    await approve(p.qa, d.id, headD);

    // A tentativa antiga perde o lease; uma nova assume (época seguinte).
    const deliveryD = (await deliveryOf(d.id))!;
    await fixture.db.query(
      'UPDATE delivery_runs SET next_check_at=TIMESTAMPADD(HOUR,1,NOW(3)) WHERE finished_at IS NULL AND id<>$1',
      [deliveryD.id],
    );
    const old = (await app.deliveries.claimNext('executor-antigo', 60))!;
    expect(old.delivery.id).toBe(deliveryD.id);
    await fixture.db.query(
      'UPDATE delivery_runs SET lease_until=TIMESTAMPADD(SECOND,-1,NOW(3)) WHERE id=$1',
      [old.delivery.id],
    );
    // A resposta ao pedido de publicação perde-se depois de chegar ao fornecedor.
    provider.dropNextResponse = true;
    await drive(3);
    const uncertain = (await deliveryOf(d.id))!;
    expect(uncertain.lease_epoch).toBeGreaterThan(old.lease.epoch);
    expect(['uncertain', 'publishing']).toContain(uncertain.state);
    expect(
      await app.deliveries.update(
        old.lease,
        ['queued', 'integrating', 'starting', 'uncertain', 'publishing'],
        { state: 'published' },
      ),
    ).toBe('stale');
    expect(await app.deliveries.acquireLock(old.lease, 'env:test', 60)).toBe('stale');
    expect(await app.deliveries.recordRunnerEvent(old.lease, 'start_sent', {})).toBe('stale');

    // A reconciliação consulta o fornecedor antes de repetir: um só pedido chegou.
    await drive(3);
    expect((await deliveryOf(d.id))!.state).toBe('publishing');
    expect(provider.posts.filter((post) => post.deliveryId === uncertain.id)).toHaveLength(1);
    provider.advance(uncertain.idempotency_key, 'succeeded');
    await drive(3);
    expect((await deliveryOf(d.id))!.state).toBe('published');
    expect(provider.posts.filter((post) => post.deliveryId === uncertain.id)).toHaveLength(1);

    // Pedido perdido antes de chegar: a consulta (404) confirma que nada começou e só então repete.
    const e = await ticket(p.client, 'Pedido E');
    const headE = await develop(e.id, (dir) => writeFile(join(dir, 'e.txt'), 'E\n'));
    await approve(p.qa, e.id, headE);
    provider.loseNextRequest = true;
    await drive(6);
    const dE = (await deliveryOf(e.id))!;
    expect(dE.state).toBe('publishing');
    expect(provider.posts.filter((post) => post.deliveryId === dE.id)).toHaveLength(1);
    const events = await fixture.db.query<{ status: string }>(
      "SELECT status FROM delivery_events WHERE delivery_id=$1 AND source='runner' ORDER BY received_at",
      [dE.id],
    );
    expect(events.rows.map((row) => row.status)).toEqual(
      expect.arrayContaining(['start_sent', 'start_retry']),
    );

    // Fornecedor reiniciado reutiliza o identificador da entrega D: o evento final de E tem o
    // mesmo eventId do de D, mas pertence a outra entrega e tem de ser aplicado.
    const runE = provider.runs.get(dE.idempotency_key)!;
    runE.externalId = provider.runs.get(uncertain.idempotency_key)!.externalId;
    runE.sequence = 0;
    provider.advance(dE.idempotency_key, 'succeeded');
    await drive(3);
    expect((await deliveryOf(e.id))!.state).toBe('published');
  });
});

type CommandHook = (
  checkout: AttemptCheckout,
  command: DevelopmentCommand,
  signal: AbortSignal | undefined,
  run: (command: DevelopmentCommand) => Promise<CommandResult>,
) => Promise<CommandResult>;

/** Gestor real com um ponto de interceção nos comandos configurados (testes da combinação). */
class HookedManager extends WorkspaceManager {
  hook: CommandHook | null = null;

  override runConfigured(
    checkout: AttemptCheckout,
    command: DevelopmentCommand,
    signal?: AbortSignal,
  ) {
    const run = (next: DevelopmentCommand) => super.runConfigured(checkout, next, signal);
    return this.hook ? this.hook(checkout, command, signal, run) : run(command);
  }
}

const sleepCommand = (ms: number): DevelopmentCommand => ({
  name: 'sleep',
  command: `node -e "setTimeout(() => {}, ${ms})"`,
  timeoutSeconds: 120,
});

/** Termina a publicação em curso de um ticket (liberta o ambiente partilhado). */
async function finishPublishing(ticketId: string) {
  const current = (await deliveryOf(ticketId))!;
  if (current.state !== 'publishing') return;
  provider.advance(current.idempotency_key, 'succeeded');
  await drive(2);
  expect((await deliveryOf(ticketId))!.state).toBe('published');
}

const runnerEvents = async (deliveryId: string) =>
  (
    await fixture.db.query<{ status: string; payload: unknown }>(
      "SELECT status,payload FROM delivery_events WHERE delivery_id=$1 AND source='runner' ORDER BY received_at",
      [deliveryId],
    )
  ).rows;

describe('Entrega A — integridade da execução', { timeout: 240_000 }, () => {
  it('F03: chaves canónicas identificam o recurso real, seja qual for a configuração', () => {
    expect(normalizeResourceUrl('HTTPS://user:pw@GitHub.com/org/Repo.git/')).toBe(
      'https://github.com/org/Repo',
    );
    expect(canonicalIntegrationKey('https://github.com/org/repo.git', 'main')).toBe(
      canonicalIntegrationKey('https://GITHUB.com/org/repo/', 'main'),
    );
    expect(canonicalIntegrationKey('https://github.com/org/repo', 'main')).not.toBe(
      canonicalIntegrationKey('https://github.com/org/repo', 'qa'),
    );
    const endpoint = { endpointUrl: 'https://ci.test/hooks', environment: 'quality' };
    expect(canonicalEnvironmentKey(endpoint)).toBe(
      canonicalEnvironmentKey({ ...endpoint, endpointUrl: 'https://CI.test/hooks/' }),
    );
    expect(canonicalEnvironmentKey(endpoint)).toBe(
      canonicalEnvironmentKey({ ...endpoint, environment: ' QUALITY ' }),
    );
    expect(canonicalEnvironmentKey(endpoint)).not.toBe(
      canonicalEnvironmentKey({ ...endpoint, environment: 'production' }),
    );
    // Um alvo explícito comum une pipelines com endpoints diferentes.
    expect(canonicalEnvironmentKey({ ...endpoint, targetKey: 'QA.pizzahut.pt' })).toBe(
      canonicalEnvironmentKey({
        endpointUrl: 'https://outro.test/x',
        environment: 'production',
        targetKey: 'qa.pizzahut.pt',
      }),
    );
  });

  it('F03 + F01: projetos diferentes no mesmo ambiente real esperam; a revogação durante a espera impede o pedido', async () => {
    const p1 = await project();
    const p2 = await project();
    const a = await ticket(p1.client, 'Projeto 1');
    const b = await ticket(p2.client, 'Projeto 2');
    const headA = await develop(a.id, (dir) => writeFile(join(dir, 'p1.txt'), '1\n'));
    const headB = await develop(b.id, (dir) => writeFile(join(dir, 'p2.txt'), '2\n'));
    await approve(p1.qa, a.id, headA);
    await approve(p2.qa, b.id, headB);
    await drive();
    const dA = (await deliveryOf(a.id))!;
    const dB = (await deliveryOf(b.id))!;
    expect(dA.state).toBe('publishing');
    // Pipelines distintas (projetos distintos) com o mesmo endpoint: o ambiente real é um só.
    expect(dB.state).toBe('starting');
    expect(dB.state_reason).toMatch(/À espera do ambiente quality/);
    expect(provider.posts.filter((post) => post.deliveryId === dB.id)).toEqual([]);
    const envKey = canonicalEnvironmentKey({
      endpointUrl: `${PIPELINE_ORIGIN}/hooks`,
      environment: 'quality',
    });
    const holder = await fixture.db.query<{ holder_id: string }>(
      'SELECT holder_id FROM resource_locks WHERE lock_key=$1',
      [envKey],
    );
    expect(holder.rows[0]?.holder_id).toBe(dA.id);

    // O revisor de B é desativado enquanto B espera: com o ambiente livre, nada é pedido.
    await fixture.db.query('UPDATE users SET disabled=1 WHERE id=$1', [p2.qa.id]);
    await finishPublishing(a.id);
    await drive();
    const blocked = (await deliveryOf(b.id))!;
    expect(blocked.state).toBe('blocked');
    expect(blocked.state_reason).toMatch(/Faltam aprovações válidas/);
    expect(provider.posts.filter((post) => post.deliveryId === dB.id)).toEqual([]);
    expect(
      (await runnerEvents(dB.id)).filter((event) => event.status === 'effect_blocked'),
    ).toHaveLength(1);
    const left = await fixture.db.query('SELECT 1 FROM resource_locks WHERE holder_id=$1', [dB.id]);
    expect(left.rows).toEqual([]);
  });

  it('F01: o retry depois de 404 (estado incerto) volta a validar os gates antes do novo pedido', async () => {
    const p = await project();
    const t = await ticket(p.client, 'Retry incerto');
    const head = await develop(t.id, (dir) => writeFile(join(dir, 'retry.txt'), 'R\n'));
    await approve(p.qa, t.id, head);
    provider.loseNextRequest = true;
    await drive(1);
    const uncertain = (await deliveryOf(t.id))!;
    expect(uncertain.state).toBe('uncertain');
    await fixture.db.query('UPDATE users SET disabled=1 WHERE id=$1', [p.qa.id]);
    await drive(1);
    const blocked = (await deliveryOf(t.id))!;
    expect(blocked.state).toBe('blocked');
    expect(provider.posts.filter((post) => post.deliveryId === blocked.id)).toEqual([]);
    const statuses = (await runnerEvents(blocked.id)).map((event) => event.status);
    expect(statuses).toEqual(expect.arrayContaining(['start_retry', 'effect_blocked']));
    expect(statuses.filter((status) => status === 'start_sent')).toHaveLength(1);
  });

  it('F01: revogação durante os testes da combinação impede o push', async () => {
    const p = await project();
    const a = await ticket(p.client, 'Base A');
    const b = await ticket(p.client, 'Combinação B');
    const headA = await develop(a.id, (dir) => writeFile(join(dir, 'a1.txt'), 'A\n'));
    const headB = await develop(b.id, (dir) => writeFile(join(dir, 'b1.txt'), 'B\n'));
    await approve(p.qa, a.id, headA);
    await approve(p.qa2, b.id, headB);
    const manager = new HookedManager(join(root, 'workspaces'));
    let revoked = false;
    // Só B corre os testes (merge sobre A); a revogação acontece durante esses testes.
    manager.hook = async (_checkout, command, _signal, run) => {
      if (!revoked) {
        revoked = true;
        await fixture.db.query('UPDATE users SET disabled=1 WHERE id=$1', [p.qa2.id]);
      }
      return run(command);
    };
    const runner = new DeliveryRunner(app.deliveries, manager, {
      workerId: 'executor-f01',
      allowedOrigins: [PIPELINE_ORIGIN],
      publicUrl: 'https://zeroops.test',
      transport: provider.transport,
      leaseSeconds: 60,
    });
    for (let round = 0; round < 3; round += 1) {
      await fixture.db.query(
        'UPDATE delivery_runs SET next_check_at=NULL WHERE finished_at IS NULL',
      );
      for (let index = 0; index < 20 && (await runner.runOnce()); index += 1);
    }
    expect(revoked).toBe(true);
    const dB = (await deliveryOf(b.id))!;
    expect(dB.state).toBe('blocked');
    expect(dB.state_reason).toMatch(/Faltam aprovações válidas/);
    // A foi integrado (fast-forward, antes da revogação); a combinação com B nunca chegou ao remoto.
    expect(await remoteBranchSha(p.origin.url, 'main')).toBe(headA);
    const events = await runnerEvents(dB.id);
    expect(events.map((event) => event.status)).not.toContain('pushed');
    expect(events.find((event) => event.status === 'effect_blocked')?.payload).toMatchObject({
      effect: 'push',
    });
    await finishPublishing(a.id);
  });

  it('F04: o heartbeat mantém lease e lock durante comandos longos; perder o lock aborta sem push', async () => {
    const p = await project();
    const a = await ticket(p.client, 'Base F04');
    const b = await ticket(p.client, 'Longa F04');
    const headA = await develop(a.id, (dir) => writeFile(join(dir, 'a2.txt'), 'A\n'));
    const headB = await develop(b.id, (dir) => writeFile(join(dir, 'b2.txt'), 'B\n'));
    await approve(p.qa, a.id, headA);
    await approve(p.qa2, b.id, headB);
    const dB = (await deliveryOf(b.id))!;
    const integrationKey = canonicalIntegrationKey(p.origin.url, 'main');
    const lockState = async () =>
      (
        await fixture.db.query<{ expires_at: Date; epoch: number }>(
          "SELECT expires_at,epoch FROM resource_locks WHERE lock_key=$1 AND holder_kind='delivery' AND holder_id=$2",
          [integrationKey, dB.id],
        )
      ).rows[0];
    const leaseUntil = async () =>
      new Date(
        (
          await fixture.db.query<{ lease_until: Date }>(
            'SELECT lease_until FROM delivery_runs WHERE id=$1',
            [dB.id],
          )
        ).rows[0]!.lease_until,
      ).getTime();

    const manager = new HookedManager(join(root, 'workspaces'));
    let renewed = false;
    let renewAfterSteal: boolean | null = null;
    let aborted: CommandResult | null = null;
    let abortedIn = Number.POSITIVE_INFINITY;
    let sawSignal = false;
    manager.hook = async (_checkout, command, signal, run) => {
      if (aborted) return run(command);
      const lockBefore = (await lockState())!;
      const leaseBefore = await leaseUntil();
      await run(sleepCommand(2500));
      const lockAfter = (await lockState())!;
      renewed =
        new Date(lockAfter.expires_at).getTime() > new Date(lockBefore.expires_at).getTime() &&
        (await leaseUntil()) > leaseBefore;
      // Outro executor toma o lock (expirado do seu ponto de vista): esta tentativa tem de parar.
      await fixture.db.query(
        "UPDATE resource_locks SET holder_id=$2,epoch=epoch+1 WHERE lock_key=$1 AND holder_kind='delivery'",
        [integrationKey, randomUUID()],
      );
      renewAfterSteal = await renewResourceLock(
        fixture.db,
        integrationKey,
        { kind: 'delivery', id: dB.id },
        lockAfter.epoch,
        60,
      );
      const started = Date.now();
      aborted = await run(sleepCommand(60_000));
      abortedIn = Date.now() - started;
      sawSignal = signal?.aborted === true;
      return aborted;
    };
    const runner = new DeliveryRunner(app.deliveries, manager, {
      workerId: 'executor-f04',
      allowedOrigins: [PIPELINE_ORIGIN],
      publicUrl: 'https://zeroops.test',
      transport: provider.transport,
      leaseSeconds: 60,
      heartbeatMs: 100,
    });
    for (let round = 0; round < 2; round += 1) {
      await fixture.db.query(
        'UPDATE delivery_runs SET next_check_at=NULL WHERE finished_at IS NULL',
      );
      for (let index = 0; index < 20 && !aborted && (await runner.runOnce()); index += 1);
    }
    expect(renewed).toBe(true);
    expect(renewAfterSteal).toBe(false);
    expect(aborted).toMatchObject({ aborted: true });
    expect(sawSignal).toBe(true);
    expect(abortedIn).toBeLessThan(20_000);
    // Só A (fast-forward) chegou ao remoto; a tentativa que perdeu o lock não fez push.
    expect(await remoteBranchSha(p.origin.url, 'main')).toBe(headA);
    expect((await deliveryOf(b.id))!.state).toBe('integrating');
    expect((await runnerEvents(dB.id)).map((event) => event.status)).not.toContain('pushed');

    // O lock alheio expira; a entrega retoma noutro executor e integra a combinação.
    await fixture.db.query('DELETE FROM resource_locks WHERE lock_key=$1', [integrationKey]);
    await fixture.db.query(
      'UPDATE delivery_runs SET lease_until=TIMESTAMPADD(SECOND,-1,NOW(3)) WHERE id=$1',
      [dB.id],
    );
    await finishPublishing(a.id);
    await drive();
    const resumed = (await deliveryOf(b.id))!;
    expect(resumed.state).toBe('publishing');
    expect(await isAncestor(p.origin.dir, headA, resumed.integrated_sha!)).toBe(true);
    expect(await isAncestor(p.origin.dir, headB, resumed.integrated_sha!)).toBe(true);
    await finishPublishing(b.id);
  });
  it('F03: mudar o URL do repositório depois de criada a entrega bloqueia a integração', async () => {
    const p = await project();
    const t = await ticket(p.client, 'URL alterado');
    const head = await develop(t.id, (dir) => writeFile(join(dir, 'url.txt'), 'U\n'));
    await approve(p.qa, t.id, head);
    const queued = (await deliveryOf(t.id))!;
    expect(queued.integration_key).toBe(canonicalIntegrationKey(p.origin.url, 'main'));
    const other = await createOrigin();
    await fixture.db.query('UPDATE project_git_repositories SET url=$2 WHERE id=$1', [
      p.repository.id,
      other.url,
    ]);
    const mainBefore = await remoteBranchSha(other.url, 'main');
    await drive();
    const blocked = (await deliveryOf(t.id))!;
    expect(blocked.state).toBe('blocked');
    expect(blocked.state_reason).toMatch(/repositório de destino da entrega mudou/);
    expect(await remoteBranchSha(other.url, 'main')).toBe(mainBefore);
  });
});
