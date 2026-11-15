import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FlowDefinition,
  FlowNode,
  Role,
  User,
} from '../../../packages/contracts/src/index.js';
import { startTestDatabase } from '../../../tests/helpers/test-database.js';
import { leaseJob } from '../../../tests/helpers/job-lease.js';
import { AgentRunsService } from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import type { JobLease } from '../../../packages/backend/src/modules/agents/job-leases.js';
import { DevelopmentStore } from '../../../packages/backend/src/modules/development/development.store.js';
import { GitRepositoriesService } from '../../../packages/backend/src/modules/development/git-repositories.service.js';
import { remoteBranchSha, runGit } from '../../../packages/backend/src/modules/development/git.js';
import { FlowEngine } from '../../../packages/backend/src/modules/flows/flow-engine.js';
import { FlowsService } from '../../../packages/backend/src/modules/flows/flows.service.js';
import { IdentityCipher } from '../../../packages/backend/src/modules/identity/identity-security.js';
import { createFlowActionRegistry } from '../../../packages/backend/src/modules/incidents/incident.module.js';
import { TicketsService } from '../../../packages/backend/src/modules/tickets/tickets.service.js';
import { WorkflowService } from '../../../packages/backend/src/modules/workflow/workflow.service.js';
import {
  DevelopmentRunner,
  DevelopmentStale,
  type PreparedDevelopment,
} from './development-runner.js';
import { WorkspaceManager } from './workspace-manager.js';

/**
 * P08 de ponta a ponta com Git real (repositórios temporários `file://`), a BD de teste, o motor
 * de fluxos, a store e o runner reais. Só o agente é simulado: escreve ficheiros no checkout
 * entre `prepare` e `finalize`, como o Copilot faria.
 */
let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let root: string;
let originUrl: string;
let originDir: string;
const cipher = new IdentityCipher(randomBytes(32).toString('base64'));

function services() {
  const engine = new FlowEngine(fixture.db, createFlowActionRegistry(fixture.db));
  return {
    engine,
    tickets: new TicketsService(fixture.db, [engine.onPublicComment], [engine.onTicketCreated]),
    runs: new AgentRunsService(fixture.db, [engine.onRunFinished]),
    flows: new FlowsService(fixture.db, engine),
    store: new DevelopmentStore(fixture.db, cipher),
    repositories: new GitRepositoriesService(fixture.db, cipher, {
      allowedRoots: [pathToFileURL(root).href],
    }),
    workflow: new WorkflowService(fixture.db, {
      investigation: true,
      implementation: true,
      deployment: true,
      blockers: [],
    }),
  };
}
let app: ReturnType<typeof services>;
let runner: DevelopmentRunner;

const git = (cwd: string, ...args: string[]) => runGit(args, { cwd });

/** Origem bare com `main`: app.js, old.txt e um teste que falha se app.js contiver «broken». */
async function createOrigin(name: string) {
  const dir = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  await runGit(['init', '--bare', '--quiet', '-b', 'main', dir]);
  await mkdir(seed, { recursive: true });
  await git(seed, 'init', '--quiet', '-b', 'main');
  await writeFile(join(seed, 'app.js'), 'module.exports = "v0";\n');
  await writeFile(join(seed, 'old.txt'), 'obsoleto\n');
  await writeFile(
    join(seed, 'test.js'),
    "const fs = require('fs');\nif (fs.readFileSync('app.js', 'utf8').includes('broken')) process.exit(1);\nconsole.log('ok');\n",
  );
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '--quiet', '-m', 'inicial');
  await git(seed, 'push', '--quiet', dir, 'main');
  return { dir, seed, url: pathToFileURL(dir).href };
}

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

type Review = Record<string, unknown>;

/** Projeto com repositório verificado e fluxo «develop → review» ativo como fluxo por omissão. */
async function project(review: Review = { reviewers: { roles: ['qa'] }, rule: 'any' }) {
  const id = randomUUID();
  await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [id, `P08 ${id}`]);
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
    qa2: await member('qa', id, 'Quitéria QA'),
  };
  const repository = await app.repositories.create(admin, id, {
    name: 'Sandbox',
    url: originUrl,
    baseBranch: 'main',
    allowedRefs: ['main'],
    testCommands: [{ name: 'unit', command: 'node test.js', timeoutSeconds: 60 }],
  });
  const verified = await app.repositories.verify(admin, id, repository.id);
  expect(verified.verifiedBaseSha).toMatch(/^[a-f0-9]{40}$/);
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
          review: { sourceNode: 'dev', ...review },
        },
      } as FlowNode,
      end,
    ],
    edges: [
      { id: 'e1', source: 'dev', port: 'success', target: 'review' },
      { id: 'e2', source: 'dev', port: 'failure', target: end.id },
      { id: 'e3', source: 'review', port: 'success', target: end.id },
      { id: 'e4', source: 'review', port: 'failure', target: 'dev' },
    ],
    layout: {},
  };
  const saved = await app.flows.saveDraft(admin, id, general.id, {
    expectedDraftVersion: current.draftVersion,
    definition,
  });
  await app.flows.publish(admin, id, general.id, { expectedDraftVersion: saved.draftVersion });
  return { ...people, repository };
}

async function ticket(author: User, title = 'Alterar a app') {
  return app.tickets.create(author, {
    title,
    description: 'Pedido de alteração.',
    category: 'improvement',
    environment: 'quality',
    priority: 'medium',
  });
}

async function queuedRun(ticketId: string) {
  const row = (
    await fixture.db.query<{ id: string; development_workspace_id: string | null }>(
      "SELECT id,development_workspace_id FROM agent_runs WHERE ticket_id=$1 AND status='queued' AND run_trigger='flow'",
      [ticketId],
    )
  ).rows[0];
  expect(row, 'run do Copilot em fila').toBeDefined();
  return row!;
}

/** Simula o agente: prepara o checkout, aplica `edit`, faz commit/testes/publicação e termina. */
async function develop(
  ticketId: string,
  edit: (dir: string) => Promise<void>,
  options: { finish?: boolean } = {},
) {
  const run = await queuedRun(ticketId);
  const lease = await leaseJob(fixture.db, run.id);
  const prepared = await runner.prepare(run.id, lease);
  await edit(prepared.checkout.path);
  const outcome = await runner.finalize(prepared, lease, () => true);
  if (options.finish !== false) await finish(prepared, lease, outcome);
  return { run, lease, prepared, outcome };
}

async function finish(
  prepared: PreparedDevelopment,
  lease: JobLease,
  outcome: { testsPassed: boolean; diff: string },
) {
  if (outcome.testsPassed)
    await app.runs.complete(lease, {
      summary: 'Alteração feita.',
      replyDraft: null,
      evidence: [],
      patch: outcome.diff,
    });
  else await app.runs.fail(lease, 'development_tests_failed');
  await runner.release(prepared, lease, !outcome.testsPassed);
}

async function view(actor: User, ticketId: string) {
  const flow = await app.flows.ticketFlow(actor, ticketId);
  expect(flow).not.toBeNull();
  return flow!;
}

async function review(
  actor: User,
  ticketId: string,
  port: string,
  artifactSha?: string,
  comment?: string,
) {
  const flow = await view(actor, ticketId);
  return app.flows.decide(actor, ticketId, {
    stepId: flow.next!.stepId,
    port,
    idempotencyKey: randomUUID(),
    ...(comment ? { comment } : {}),
    ...(artifactSha ? { artifactSha } : {}),
  });
}

const show = async (ref: string, path: string) =>
  (await runGit(['--git-dir', originDir, 'show', `${ref}:${path}`])).stdout;

beforeAll(async () => {
  fixture = await startTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'zeroops-p08-'));
  const origin = await createOrigin('origin');
  originUrl = origin.url;
  originDir = origin.dir;
  app = services();
  runner = new DevelopmentRunner(app.store, new WorkspaceManager(join(root, 'workspaces')));
});
afterAll(async () => {
  await fixture?.stop();
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('P08 — desenvolvimento em workspace Git e review', { timeout: 120_000 }, () => {
  it('ciclo completo: base fixa, diff A/M/D, testes reais, PR idempotente, rejeição, correção e aprovação', async () => {
    const p = await project();
    const a = await ticket(p.client, 'Pedido A');
    const b = await ticket(p.client, 'Pedido B');
    const baseAtStart = (await remoteBranchSha(originUrl, 'main'))!;

    // Dois tickets alteram o mesmo ficheiro em workspaces e branches próprias.
    const devA = await develop(a.id, async (dir) => {
      await writeFile(join(dir, 'app.js'), 'module.exports = "A";\n');
      await rm(join(dir, 'old.txt'));
      await writeFile(join(dir, 'new.txt'), 'novo\n');
    });
    const devB = await develop(b.id, async (dir) => {
      await writeFile(join(dir, 'app.js'), 'module.exports = "B";\n');
    });
    expect(devA.prepared.baseSha).toBe(baseAtStart);
    expect(devA.prepared.checkout.path).not.toBe(devB.prepared.checkout.path);
    const wsA = devA.prepared.context.workspace;
    const wsB = devB.prepared.context.workspace;
    expect(wsA.branch).toMatch(/^zeroops\//);
    expect(wsA.branch).not.toBe(wsB.branch);
    expect(await show(wsA.branch, 'app.js')).toContain('"A"');
    expect(await show(wsB.branch, 'app.js')).toContain('"B"');
    expect(await show('main', 'app.js')).toContain('"v0"');

    // Diff completo do Git (não da lista do modelo) e testes finais sobre o commit exato.
    const headA = devA.outcome.headSha;
    expect(devA.outcome.files).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'app.js' },
        { status: 'D', path: 'old.txt' },
        { status: 'A', path: 'new.txt' },
      ]),
    );
    expect(devA.outcome.testsPassed).toBe(true);
    const tests = await fixture.db.query<{ phase: string; exit_code: number; tested_sha: string }>(
      'SELECT phase,exit_code,tested_sha FROM development_test_runs WHERE workspace_id=$1',
      [wsA.id],
    );
    expect(tests.rows).toEqual([{ phase: 'final', exit_code: 0, tested_sha: headA }]);
    const prA = (await app.store.publication(wsA.id, 'pull_request'))!;
    const prB = (await app.store.publication(wsB.id, 'pull_request'))!;
    expect(prA).toMatchObject({ state: 'published', head_sha: headA });
    expect(new Set([prA.number, prB.number])).toEqual(new Set([1, 2]));

    // Um commit novo na origem não muda a base fixada do workspace.
    await writeFile(join(root, 'origin-seed', 'other.txt'), 'outro\n');
    await git(join(root, 'origin-seed'), 'add', '-A');
    await git(join(root, 'origin-seed'), 'commit', '--quiet', '-m', 'avanço da main');
    await git(join(root, 'origin-seed'), 'push', '--quiet', originDir, 'main');
    expect(await remoteBranchSha(originUrl, 'main')).not.toBe(baseAtStart);

    // Review: só os revisores configurados; o admin sem override é recusado; commit exato.
    let flow = await view(p.qa, a.id);
    expect(flow.next).toMatchObject({ nodeId: 'review', canAct: true });
    expect(flow.next?.review).toEqual({ headSha: headA, testsPassed: true });
    expect((await view(p.technical, a.id)).next?.canAct).toBe(false);
    await expect(review(p.technical, a.id, 'success', headA)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(review(p.admin, a.id, 'success', headA)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(review(p.qa, a.id, 'success', baseAtStart)).rejects.toMatchObject({
      code: 'REVIEW_ARTIFACT_CHANGED',
    });
    await expect(review(p.qa, a.id, 'success')).rejects.toMatchObject({
      code: 'REVIEW_ARTIFACT_CHANGED',
    });

    // Rotas legadas não saltam as etapas do fluxo.
    const legacy = await app.tickets.get(p.admin, a.id);
    await expect(
      app.workflow.transition(p.admin, a.id, {
        expectedVersion: legacy.version,
        action: 'cancel',
        notes: 'Saltar o review',
      }),
    ).rejects.toMatchObject({ code: 'FLOW_MANAGED' });
    await expect(
      app.workflow.decide(p.qa, a.id, {
        expectedVersion: legacy.version,
        artifactHash: 'a'.repeat(64),
        decision: 'approve',
        notes: '',
      }),
    ).rejects.toMatchObject({ code: 'FLOW_MANAGED' });

    // Rejeição volta ao desenvolvimento com o feedback, no mesmo workspace e base.
    await review(p.qa, a.id, 'failure', headA, 'Falta tratar o caso vazio.');
    const fix = await develop(a.id, async (dir) => {
      expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('novo\n');
      await writeFile(join(dir, 'app.js'), 'module.exports = "A2";\n');
    });
    expect(fix.prepared.context.workspace.id).toBe(wsA.id);
    expect(fix.prepared.previousHead).toBe(headA);
    expect(fix.prepared.baseSha).toBe(baseAtStart);
    expect(fix.prepared.context.feedback.join(' ')).toMatch(/caso vazio/);
    const headA2 = fix.outcome.headSha;
    const parent = (
      await runGit(['--git-dir', originDir, 'rev-parse', `${headA2}^`])
    ).stdout.trim();
    expect(parent).toBe(headA);
    expect(await remoteBranchSha(originUrl, wsA.branch)).toBe(headA2);
    expect((await app.store.publication(wsA.id, 'pull_request'))!.number).toBe(prA.number);

    // A decisão sobre o commit anterior fica no histórico, invalidada.
    const decisions = await fixture.db.query<{
      head_sha: string;
      invalidation_reason: string | null;
    }>(
      'SELECT head_sha,invalidation_reason FROM development_review_decisions WHERE workspace_id=$1',
      [wsA.id],
    );
    expect(decisions.rows).toEqual([{ head_sha: headA, invalidation_reason: 'head_changed' }]);
    await expect(review(p.qa, a.id, 'success', headA)).rejects.toMatchObject({
      code: 'REVIEW_ARTIFACT_CHANGED',
    });
    await review(p.qa, a.id, 'success', headA2);
    flow = await view(p.technical, a.id);
    expect(flow.execution.status).toBe('completed');

    // Vista interna: revisões, testes, publicações e decisões; cliente sem acesso.
    const detail = await app.store.ticketDevelopment(p.technical, a.id);
    const ws = detail.workspaces[0]!;
    expect(ws).toMatchObject({ headSha: headA2, baseSha: baseAtStart, branch: wsA.branch });
    expect(ws.revisions.map((item) => item.headSha)).toEqual(
      expect.arrayContaining([headA, headA2]),
    );
    expect(ws.tests.filter((item) => item.phase === 'final').map((item) => item.testedSha)).toEqual(
      expect.arrayContaining([headA, headA2]),
    );
    expect(ws.reviews.find((item) => item.headSha === headA)?.invalidatedAt).not.toBeNull();
    expect(ws.reviews.find((item) => item.headSha === headA2)?.invalidatedAt).toBeNull();
    expect(ws.pipeline.available).toBe(false);
    await expect(app.store.ticketDevelopment(p.client, a.id)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('publicação idempotente, remoto divergente e resultado incerto reconciliado', async () => {
    const p = await project();
    const t = await ticket(p.client);
    const dev = await develop(
      t.id,
      async (dir) => writeFile(join(dir, 'app.js'), 'module.exports = "pub";\n'),
      { finish: false },
    );
    const ws = dev.prepared.context.workspace;
    const head = dev.outcome.headSha;
    const publish = (prepared: PreparedDevelopment) =>
      (
        runner as unknown as {
          publish(
            prepared: PreparedDevelopment,
            lease: JobLease,
            head: string,
            active: () => boolean,
          ): Promise<{ kind: string; state: string }[]>;
        }
      ).publish(prepared, dev.lease, head, () => true);
    const first = (await app.store.publication(ws.id, 'pull_request'))!;

    // Repetir não duplica a branch nem o PR (o número mantém-se).
    expect(await publish(dev.prepared)).toEqual([
      { kind: 'branch', state: 'published' },
      { kind: 'pull_request', state: 'published' },
    ]);
    const rows = await fixture.db.query<{ kind: string; number: number | null; attempts: number }>(
      'SELECT kind,number,attempts FROM development_publications WHERE workspace_id=$1 ORDER BY kind',
      [ws.id],
    );
    expect(rows.rows).toEqual([
      { kind: 'branch', number: null, attempts: 2 },
      { kind: 'pull_request', number: first.number, attempts: 2 },
    ]);

    // Remoto inacessível: o estado fica incerto (não falso sucesso nem nova tentativa cega).
    const hidden = `${originDir}-offline`;
    await rename(originDir, hidden);
    try {
      expect((await publish(dev.prepared))[0]).toEqual({ kind: 'branch', state: 'uncertain' });
    } finally {
      await rename(hidden, originDir);
    }
    expect((await app.store.publication(ws.id, 'branch'))!.state).toBe('uncertain');
    // Reconciliação: o remoto já tem o head → publicado sem novo push.
    expect((await publish(dev.prepared))[0]).toEqual({ kind: 'branch', state: 'published' });

    // Alguém reescreveu a branch remota: sem force push, fica em conflito.
    const intruder = join(root, `intruder-${randomUUID().slice(0, 8)}`);
    await mkdir(intruder);
    await git(intruder, 'init', '--quiet', '-b', 'x');
    await writeFile(join(intruder, 'z.txt'), 'outro histórico\n');
    await git(intruder, 'add', '-A');
    await git(intruder, 'commit', '--quiet', '-m', 'divergente');
    await git(intruder, 'push', '--quiet', '--force', originDir, `x:refs/heads/${ws.branch}`);
    expect((await publish(dev.prepared))[0]).toEqual({ kind: 'branch', state: 'conflict' });
    expect(await remoteBranchSha(originUrl, ws.branch)).not.toBe(head);
    await finish(dev.prepared, dev.lease, dev.outcome);
  });

  it('tentativa antiga sem posse não escreve no workspace da nova tentativa', async () => {
    const p = await project();
    const t = await ticket(p.client);
    const run = await queuedRun(t.id);
    const oldLease = await leaseJob(fixture.db, run.id);
    const old = await runner.prepare(run.id, oldLease);
    const newLease = await leaseJob(fixture.db, run.id);
    const current = await runner.prepare(run.id, newLease);
    expect(current.checkout.path).not.toBe(old.checkout.path);
    expect(current.context.workspace.id).toBe(old.context.workspace.id);

    await writeFile(join(old.checkout.path, 'app.js'), 'module.exports = "antigo";\n');
    await writeFile(join(current.checkout.path, 'app.js'), 'module.exports = "novo";\n');
    await expect(runner.finalize(old, oldLease, () => true)).rejects.toBeInstanceOf(
      DevelopmentStale,
    );
    await expect(runner.prepare(run.id, oldLease)).rejects.toBeInstanceOf(DevelopmentStale);
    const outcome = await runner.finalize(current, newLease, () => true);
    expect(outcome.testsPassed).toBe(true);
    const ws = current.context.workspace;
    expect(await show(ws.branch, 'app.js')).toContain('"novo"');
    const revisions = await fixture.db.query<{ run_epoch: number }>(
      'SELECT run_epoch FROM development_revisions WHERE workspace_id=$1',
      [ws.id],
    );
    expect(revisions.rows).toEqual([{ run_epoch: newLease.epoch }]);
    // O fim da tentativa antiga não liberta o workspace da nova.
    await runner.release(old, oldLease, true);
    const state = await fixture.db.query<{ state: string; owner_epoch: number }>(
      'SELECT state,owner_epoch FROM development_workspaces WHERE id=$1',
      [ws.id],
    );
    expect(state.rows[0]).toEqual({ state: 'active', owner_epoch: newLease.epoch });
    await finish(current, newLease, outcome);
    expect(await stat(current.checkout.path).catch(() => null)).toBeNull();
  });

  it('testes finais falhados: revisão registada, sem publicação nem review', async () => {
    const p = await project();
    const t = await ticket(p.client);
    const dev = await develop(t.id, async (dir) =>
      writeFile(join(dir, 'app.js'), 'module.exports = "broken";\n'),
    );
    expect(dev.outcome.testsPassed).toBe(false);
    expect(dev.outcome.publications).toEqual([]);
    const ws = dev.prepared.context.workspace;
    expect(await remoteBranchSha(originUrl, ws.branch)).toBeNull();
    const revision = await fixture.db.query<{ tests_passed: boolean; manifest: unknown }>(
      'SELECT tests_passed,manifest FROM development_revisions WHERE workspace_id=$1',
      [ws.id],
    );
    expect(revision.rows).toEqual([{ tests_passed: false, manifest: null }]);
    const flow = await view(p.technical, t.id);
    expect(flow.steps.find((step) => step.nodeId === 'dev')?.port).toBe('failure');
    expect(flow.steps.some((step) => step.nodeId === 'review')).toBe(false);
  });

  it('quórum, separação de funções, override do admin e decisão repetida', async () => {
    const p = await project({
      reviewers: { roles: ['qa', 'technical'] },
      rule: 'quorum',
      quorum: 2,
      adminOverride: true,
    });
    const t = await ticket(p.technical, 'Pedido do técnico');
    const dev = await develop(t.id, async (dir) =>
      writeFile(join(dir, 'app.js'), 'module.exports = "q";\n'),
    );
    const head = dev.outcome.headSha;
    // O autor do pedido não revê a própria alteração.
    await expect(review(p.technical, t.id, 'success', head)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await review(p.qa, t.id, 'success', head);
    await expect(review(p.qa, t.id, 'success', head)).rejects.toMatchObject({
      code: 'REVIEW_ALREADY_DECIDED',
    });
    let flow = await view(p.qa2, t.id);
    expect(flow.next?.nodeId).toBe('review');
    await review(p.admin, t.id, 'success', head);
    flow = await view(p.qa2, t.id);
    expect(flow.execution.status).toBe('completed');
    const decisions = await fixture.db.query<{ actor_id: string; override_used: boolean }>(
      'SELECT actor_id,override_used FROM development_review_decisions WHERE ticket_id=$1 ORDER BY created_at',
      [t.id],
    );
    expect(decisions.rows).toEqual([
      { actor_id: p.qa.id, override_used: false },
      { actor_id: p.admin.id, override_used: true },
    ]);
  });

  it('isolamento entre projetos, origens autorizadas e investigação sem workspace', async () => {
    const one = await project();
    const other = await project();
    const t = await ticket(one.client);
    await develop(t.id, async (dir) => writeFile(join(dir, 'app.js'), 'module.exports = 1;\n'));
    await expect(app.repositories.list(other.admin, one.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(app.store.ticketDevelopment(other.technical, t.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      app.repositories.create(one.admin, one.id, {
        name: 'Fora',
        url: pathToFileURL(join(tmpdir(), 'fora.git')).href,
        baseBranch: 'main',
        allowedRefs: ['main'],
        testCommands: [{ name: 'unit', command: 'node test.js' }],
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_ALLOWED' });
    await expect(
      app.repositories.create(one.technical, one.id, {
        name: 'Sem permissão',
        url: originUrl,
        baseBranch: 'main',
        allowedRefs: ['main'],
        testCommands: [{ name: 'unit', command: 'node test.js' }],
      }),
    ).rejects.toMatchObject({ status: 403 });

    // Um fluxo não pode usar o repositório de outro projeto.
    const list = await app.flows.list(other.admin, other.id);
    const flow = await app.flows.get(
      other.admin,
      other.id,
      list.find((f) => f.template === 'general')!.id,
    );
    const borrowed = structuredClone(flow.draft);
    borrowed.nodes = borrowed.nodes.map((node) =>
      node.id === 'dev'
        ? { ...node, config: { ...node.config, repositoryId: one.repository.id } }
        : node,
    );
    const saved = await app.flows.saveDraft(other.admin, other.id, flow.id, {
      expectedDraftVersion: flow.draftVersion,
      definition: borrowed,
    });
    await expect(
      app.flows.publish(other.admin, other.id, flow.id, {
        expectedDraftVersion: saved.draftVersion,
      }),
    ).rejects.toMatchObject({ code: 'FLOW_INVALID' });

    // Investigação simples (análise sem repositório): sem workspace, branch nem PR.
    const plain = randomUUID();
    await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [
      plain,
      `Simples ${plain}`,
    ]);
    const admin = await member('admin', plain);
    await fixture.db.query(
      `INSERT INTO integration_settings
         (id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by)
       VALUES ($1,$2,'quality','copilot',1,'verified','cifrado','{}',1,$3)`,
      [randomUUID(), plain, admin.id],
    );
    const general = (await app.flows.list(admin, plain)).find((f) => f.template === 'general')!;
    await app.flows.publish(admin, plain, general.id, {
      expectedDraftVersion: general.draftVersion,
    });
    const client = await member('client', plain);
    const question = await ticket(client, 'Só uma pergunta');
    const run = await queuedRun(question.id);
    expect(run.development_workspace_id).toBeNull();
    const workspaces = await fixture.db.query(
      'SELECT id FROM development_workspaces WHERE ticket_id=$1',
      [question.id],
    );
    expect(workspaces.rowCount).toBe(0);
  });
});
