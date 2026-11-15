import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { ConnectorGateway, type ConnectorTool } from '../connectors/connector-gateway.js';
import { AgentRunsService } from './agent-runs.service.js';
import { queueAgentRun } from './agent-auto-runs.js';
import type { WorkerIdentity } from './job-leases.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let runs: AgentRunsService;
let tickets: TicketsService;
beforeAll(async () => {
  fixture = await startTestDatabase();
  runs = new AgentRunsService(fixture.db);
  tickets = new TicketsService(fixture.db);
});
afterAll(async () => {
  await fixture?.stop();
});

const workerA: WorkerIdentity = { workerId: 'executor-a', leaseSeconds: 60 };
const workerB: WorkerIdentity = { workerId: 'executor-b', leaseSeconds: 60 };
const result = { summary: 'Concluído.', replyDraft: null, evidence: [] };

async function member(role: Role, projectId: string = randomUUID()): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects (id,name) VALUES ($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, 'Leases'],
  );
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    email: `${randomUUID()}@example.test`,
    displayName: `Test ${role}`,
  };
  await fixture.db.query(
    'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, 'unusable-test-hash'],
  );
  return actor;
}

/** Isola o teste: nenhum run em fila de testes anteriores interfere com os claims. */
async function clearQueue() {
  await fixture.db.query(
    "UPDATE agent_runs SET status='cancelled', lease_until=NULL WHERE status IN ('queued','running')",
  );
}

async function queuedRuns(count: number, projectId?: string) {
  const client = await member('client', projectId);
  const technical = await member('technical', client.projectId);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const ticket = await tickets.create(client, {
      title: `Pedido ${index}`,
      description: 'Pedido para os testes de leases.',
      category: 'question',
      environment: 'production',
      priority: 'medium',
    });
    ids.push((await runs.request(technical, ticket.id, {})).id);
  }
  return { client, technical, ids };
}

const expire = (id: string, table = 'agent_runs') =>
  fixture.db.query(
    `UPDATE ${table} SET lease_until=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id=$1`,
    [id],
  );

const state = async (id: string) =>
  (
    await fixture.db.query<{
      status: string;
      worker_id: string | null;
      lease_epoch: number;
      attempt: number;
      error_code: string | null;
      lease_until: Date | null;
    }>(
      'SELECT status,worker_id,lease_epoch,attempt,error_code,lease_until FROM agent_runs WHERE id=$1',
      [id],
    )
  ).rows[0]!;

const events = async (id: string) =>
  (
    await fixture.db.query<{ event_type: string; worker_id: string | null; lease_epoch: number }>(
      'SELECT event_type,worker_id,lease_epoch FROM agent_job_events WHERE job_id=$1 ORDER BY id',
      [id],
    )
  ).rows;

describe('leases de runs do agente', () => {
  it('dois consumidores concorrentes nunca reclamam a mesma tentativa', async () => {
    await clearQueue();
    const { ids } = await queuedRuns(1);
    const claims = await Promise.all([
      runs.claimNext(workerA, { perProject: 5 }),
      runs.claimNext(workerB, { perProject: 5 }),
      runs.claimNext({ workerId: 'executor-c', leaseSeconds: 60 }, { perProject: 5 }),
    ]);
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]?.runId).toBe(ids[0]);
    expect(won[0]?.attempt).toBe(1);
    expect((await events(ids[0]!)).filter((e) => e.event_type === 'claimed')).toHaveLength(1);

    const two = await queuedRuns(2);
    const pair = await Promise.all([
      runs.claimNext(workerA, { perProject: 5 }),
      runs.claimNext(workerB, { perProject: 5 }),
    ]);
    const claimed = pair.filter(Boolean).map((context) => context!.runId);
    expect(new Set(claimed).size).toBe(claimed.length);
    // O perdedor de uma corrida tenta o candidato seguinte; no máximo uma tentativa por run.
    for (const id of two.ids)
      expect(
        (await events(id)).filter((e) => e.event_type === 'claimed').length,
      ).toBeLessThanOrEqual(1);
  });

  it('respeita o limite de runs simultâneos por projeto', async () => {
    await clearQueue();
    const first = await queuedRuns(2);
    const other = await queuedRuns(1);
    const a = await runs.claimNext(workerA, { perProject: 1 });
    expect(a?.projectId).toBe(first.client.projectId);
    // O segundo run do mesmo projeto espera; o de outro projeto avança.
    const b = await runs.claimNext(workerB, { perProject: 1 });
    expect(b?.projectId).toBe(other.client.projectId);
    expect(await runs.claimNext(workerB, { perProject: 1 })).toBeNull();
  });

  it('enfileira runs automáticos com ferramentas e recursos em JSON', async () => {
    await clearQueue();
    const client = await member('client');
    const technical = await member('technical', client.projectId);
    await fixture.db.query(
      "INSERT INTO integration_settings(id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by) VALUES($1,$2,'quality','copilot',1,'verified','test-cipher','{}',1,$3)",
      [randomUUID(), client.projectId, technical.id],
    );
    const ticket = await tickets.create(client, {
      title: 'Run automático',
      description: 'Run automático com perfil.',
      category: 'question',
      environment: 'production',
      priority: 'medium',
    });
    const resources = [{ id: 'r1', path: 'docs/a.md', sha256: 'a'.repeat(64) }];
    const runId = await fixture.db.transaction((tx) =>
      queueAgentRun(tx, {
        ticketId: ticket.id,
        projectId: client.projectId,
        requestedBy: technical.id,
        instructions: 'Analisar.',
        trigger: 'flow',
        ticketVersion: ticket.version,
        allowedTools: ['sql', 'log', 'prom'],
        repositoryResources: resources as never,
      }),
    );
    expect(runId).toBeTruthy();
    const row = await fixture.db.query<{ allowed_tools: string[]; repository_resources: unknown }>(
      'SELECT allowed_tools,repository_resources FROM agent_runs WHERE id=$1',
      [runId],
    );
    expect(row.rows[0]).toEqual({
      allowed_tools: ['sql', 'log', 'prom'],
      repository_resources: resources,
    });
  });

  it('o arranque de outro executor não falha jobs vivos; o heartbeat mantém a posse', async () => {
    await clearQueue();
    const { ids } = await queuedRuns(1);
    const context = await runs.claimNext(workerA);
    // Lease prestes a expirar: o heartbeat renova-o.
    await fixture.db.query(
      'UPDATE agent_runs SET lease_until=DATE_ADD(NOW(3),INTERVAL 1 SECOND) WHERE id=$1',
      [ids[0]],
    );
    expect(await runs.heartbeat(context!.lease)).toEqual({ owned: true, cancelRequested: false });
    // Várias ferramentas: o array é gravado como JSON, não expandido numa lista SQL.
    expect(await runs.recordEffectiveTools(context!.lease, ['view', 'grep', 'sql', 'sql'])).toBe(
      true,
    );
    const tools = await fixture.db.query<{ effective_tools: string[] }>(
      'SELECT effective_tools FROM agent_runs WHERE id=$1',
      [ids[0]],
    );
    expect(tools.rows[0]?.effective_tools).toEqual(['view', 'grep', 'sql']);
    const renewed = await state(ids[0]!);
    expect(renewed.lease_until!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Outro executor arranca e reconcilia: o job vivo fica intacto.
    expect(await runs.recoverExpired()).toEqual({ requeued: 0, failed: 0, cancelled: 0 });
    expect(await state(ids[0]!)).toMatchObject({ status: 'running', worker_id: 'executor-a' });
    expect(await runs.complete(context!.lease, result)).toBe('accepted');
  });

  it('lease expirado: recuperação controlada e o worker antigo não produz efeitos', async () => {
    await clearQueue();
    const { technical, ids } = await queuedRuns(1);
    const runId = ids[0]!;
    const old = await runs.claimNext(workerA);
    await expire(runId);
    expect(await runs.recoverExpired()).toEqual({ requeued: 1, failed: 0, cancelled: 0 });
    expect(await state(runId)).toMatchObject({ status: 'queued', worker_id: null, attempt: 1 });
    const fresh = await runs.claimNext(workerB);
    expect(fresh?.runId).toBe(runId);
    expect(fresh?.attempt).toBe(2);
    expect(fresh!.lease.epoch).toBe(old!.lease.epoch + 1);

    // O worker antigo não renova, não reporta, não conclui nem falha.
    expect((await runs.heartbeat(old!.lease)).owned).toBe(false);
    expect(await runs.reportProgress(old!.lease, 'tarde demais')).toBe(false);
    expect(await runs.recordEffectiveTools(old!.lease, ['sql'])).toBe(false);
    expect(await runs.complete(old!.lease, { ...result, summary: 'Resultado antigo.' })).toBe(
      'stale',
    );
    expect(await runs.fail(old!.lease, 'agent_failed')).toBe('stale');
    expect(await state(runId)).toMatchObject({ status: 'running', worker_id: 'executor-b' });

    // Conclusão pela tentativa atual; a repetição não duplica a nota nem o resultado.
    expect(await runs.complete(fresh!.lease, result)).toBe('accepted');
    expect(await runs.complete(fresh!.lease, result)).toBe('duplicate');
    const notes = await fixture.db.query(
      'SELECT id FROM ticket_comments WHERE agent_run_id=$1 AND automated',
      [runId],
    );
    expect(notes.rowCount).toBe(1);
    const [run] = await runs.list(
      technical,
      (
        await fixture.db.query<{ ticket_id: string }>(
          'SELECT ticket_id FROM agent_runs WHERE id=$1',
          [runId],
        )
      ).rows[0]!.ticket_id,
    );
    expect(run).toMatchObject({ status: 'succeeded', summary: 'Concluído.', attempt: 2 });
    const types = (await events(runId)).map((event) => event.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        'claimed',
        'lease_expired_requeued',
        'lease_lost',
        'stale_attempt_rejected',
        'completed',
      ]),
    );

    // Esgotadas as tentativas, a recuperação falha o run em vez de o repetir indefinidamente.
    const again = await queuedRuns(1);
    await runs.claimNext(workerA);
    await expire(again.ids[0]!);
    expect(await runs.recoverExpired(1)).toEqual({ requeued: 0, failed: 1, cancelled: 0 });
    expect(await state(again.ids[0]!)).toMatchObject({
      status: 'failed',
      error_code: 'lease_expired',
    });
  });

  it('paragem ordenada e cancelamento preservam a consistência após reinício', async () => {
    await clearQueue();
    const { technical, ids } = await queuedRuns(1);
    const runId = ids[0]!;
    const first = await runs.claimNext(workerA);
    expect(await runs.release(first!.lease, 'shutdown')).toBe('accepted');
    // Devolvido à fila sem consumir a tentativa; o lease antigo deixa de valer.
    expect(await state(runId)).toMatchObject({ status: 'queued', attempt: 0 });
    expect(await runs.complete(first!.lease, result)).toBe('stale');
    const second = await runs.claimNext(workerB);
    expect(second?.attempt).toBe(1);
    const ticketId = (
      await fixture.db.query<{ ticket_id: string }>(
        'SELECT ticket_id FROM agent_runs WHERE id=$1',
        [runId],
      )
    ).rows[0]!.ticket_id;
    await runs.cancel(technical, ticketId, runId);
    expect(await runs.heartbeat(second!.lease)).toEqual({ owned: true, cancelRequested: true });
    // Executor reinicia antes de terminar: a recuperação cancela, não volta a pôr em fila.
    await expire(runId);
    expect(await runs.recoverExpired()).toEqual({ requeued: 0, failed: 0, cancelled: 1 });
    expect(await state(runId)).toMatchObject({ status: 'cancelled' });
    expect(await runs.complete(second!.lease, result)).toBe('stale');
    expect((await events(runId)).map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['released', 'cancel_requested', 'lease_expired_cancelled']),
    );
  });
});

describe('política efetiva no gateway de conectores', () => {
  const echo: ConnectorTool<{ text: string }> = {
    name: 'sql',
    input: z.object({ text: z.string() }).strict(),
    describe: (input) => input.text,
    run: async (input) => ({ result: { text: input.text }, rowCount: 1 }),
  };
  const logs: ConnectorTool<{ text: string }> = { ...echo, name: 'log' };

  async function profiled(allowedTools: string[]) {
    await clearQueue();
    const { client, technical, ids } = await queuedRuns(1);
    const profileId = randomUUID();
    await fixture.db.query(
      'INSERT INTO zeroops_agent_profiles(id,project_id,name,current_version) VALUES($1,$2,$3,1)',
      [profileId, client.projectId, `Perfil ${profileId.slice(0, 8)}`],
    );
    const definition = (tools: string[]) => JSON.stringify({ name: 'Perfil', allowedTools: tools });
    await fixture.db.query(
      'INSERT INTO zeroops_agent_profile_versions(id,profile_id,project_id,version,definition) VALUES($1,$2,$3,1,$4)',
      [randomUUID(), profileId, client.projectId, definition(allowedTools)],
    );
    await fixture.db.query(
      'UPDATE agent_runs SET agent_profile_id=$2, agent_profile_version=1, allowed_tools=$3 WHERE id=$1',
      [ids[0], profileId, JSON.stringify(allowedTools)],
    );
    const context = await runs.claimNext(workerA);
    const gateway = new ConnectorGateway(
      fixture.db,
      {
        toolsFor: async (projectId) =>
          projectId === client.projectId
            ? [echo as ConnectorTool<never>, logs as ConnectorTool<never>]
            : [],
      },
      3,
    );
    const revoke = async (tools: string[]) => {
      await fixture.db.query(
        'INSERT INTO zeroops_agent_profile_versions(id,profile_id,project_id,version,definition) VALUES($1,$2,$3,2,$4)',
        [randomUUID(), profileId, client.projectId, definition(tools)],
      );
      await fixture.db.query('UPDATE zeroops_agent_profiles SET current_version=2 WHERE id=$1', [
        profileId,
      ]);
    };
    return { context: context!, gateway, revoke, technical, runId: ids[0]! };
  }

  it('chamadas diretas fora da política são recusadas e auditadas', async () => {
    const { context, gateway } = await profiled(['sql']);
    const token = context.connectorToken;
    expect((await gateway.toolsFor(token))?.map((tool) => tool.name)).toEqual(['sql']);
    expect((await gateway.call(token, 'sql', { text: 'ok' })).status).toBe(200);
    const denied = await gateway.call(token, 'log', { text: 'fora' });
    expect(denied).toMatchObject({ status: 403, body: { code: 'TOOL_NOT_ALLOWED' } });
    const audit = await fixture.db.query<{
      tool: string;
      error_code: string | null;
      lease_epoch: number;
    }>(
      'SELECT tool,error_code,lease_epoch FROM agent_run_tool_calls WHERE run_id=$1 ORDER BY created_at',
      [context.runId],
    );
    expect(audit.rows.map((row) => [row.tool, row.error_code, Number(row.lease_epoch)])).toEqual(
      expect.arrayContaining([
        ['sql', null, context.lease.epoch],
        ['log', 'TOOL_NOT_ALLOWED', context.lease.epoch],
      ]),
    );
  });

  it('a revogação no perfil tem efeito na chamada seguinte do mesmo run', async () => {
    const { context, gateway, revoke } = await profiled(['sql', 'log']);
    const token = context.connectorToken;
    expect((await gateway.call(token, 'log', { text: 'antes' })).status).toBe(200);
    await revoke(['sql']);
    expect((await gateway.call(token, 'log', { text: 'depois' })).status).toBe(403);
    expect((await gateway.toolsFor(token))?.map((tool) => tool.name)).toEqual(['sql']);
    // Arquivar o perfil revoga todas as ferramentas.
    await fixture.db.query(
      'UPDATE zeroops_agent_profiles SET archived_at=NOW(3) WHERE id=(SELECT agent_profile_id FROM agent_runs WHERE id=$1)',
      [context.runId],
    );
    expect((await gateway.call(token, 'sql', { text: 'arquivado' })).status).toBe(403);
  });

  it('lease perdido ou cancelamento bloqueiam chamadas; o limite é atómico', async () => {
    const { context, gateway, technical, runId } = await profiled(['sql']);
    const token = context.connectorToken;
    // Chamadas concorrentes não ultrapassam o limite (3).
    const statuses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => gateway.call(token, 'sql', { text: `c${index}` })),
    );
    expect(statuses.filter((response) => response.status === 200)).toHaveLength(3);
    expect(statuses.filter((response) => response.status === 429)).toHaveLength(3);

    const ticketId = (
      await fixture.db.query<{ ticket_id: string }>(
        'SELECT ticket_id FROM agent_runs WHERE id=$1',
        [runId],
      )
    ).rows[0]!.ticket_id;
    await runs.cancel(technical, ticketId, runId);
    expect(await gateway.call(token, 'sql', { text: 'cancelado' })).toMatchObject({
      status: 409,
      body: { code: 'RUN_CANCELLED' },
    });
    await fixture.db.query('UPDATE agent_runs SET cancel_requested=0 WHERE id=$1', [runId]);
    await expire(runId);
    expect(await gateway.call(token, 'sql', { text: 'expirado' })).toMatchObject({
      status: 401,
      body: { code: 'LEASE_LOST' },
    });
    expect(await gateway.toolsFor(token)).toBeNull();
  });
});
