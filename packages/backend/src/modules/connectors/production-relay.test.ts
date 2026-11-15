import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import {
  AgentInstructionsService,
  currentAgentInstructions,
  DEFAULT_AGENT_INSTRUCTIONS,
} from '../agents/agent-instructions.service.js';
import { defaultInstructionsForSite } from '../agents/site-instructions.js';
import { ProductionRelayQueue } from './production-relay.queue.js';
import { ProductionRelayService } from './production-relay.service.js';
import { ProductionRelayToolProvider, relaySqlTool } from './production-relay.tools.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => {
  fixture = await startTestDatabase();
});
afterAll(async () => {
  await fixture?.stop();
});

async function member(role: Role, projectId: string = randomUUID()): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects (id,name) VALUES ($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, 'Relay test'],
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

describe('relay de Produção', () => {
  it('entrega pedidos ao relay autenticado e devolve o resultado ao conector', async () => {
    const admin = await member('admin');
    const technical = await member('technical', admin.projectId);
    const service = new ProductionRelayService(fixture.db, {
      pollWaitMs: 2000,
      pollIntervalMs: 50,
    });
    const queue = new ProductionRelayQueue(fixture.db, { timeoutMs: 3000, pollMs: 50 });

    await expect(service.rotateToken(technical)).rejects.toMatchObject({ status: 403 });
    const { token } = await service.rotateToken(admin);
    const auth = `Bearer ${token}`;
    await expect(service.poll('Bearer zor_falso', {})).rejects.toMatchObject({ status: 401 });
    expect(await queue.isOnline(admin.projectId)).toBe(false);

    const pending = queue.execute(admin.projectId, null, 'sql', { query: 'SELECT 1' });
    const { requests } = await service.poll(auth, { hostname: 'prod-db', version: '1.0.0' });
    expect(requests).toEqual([
      { id: expect.any(String), tool: 'sql', payload: { query: 'SELECT 1' } },
    ]);
    await service.complete(auth, requests[0]!.id, {
      ok: true,
      result: { columns: ['um'], rows: [[1]], truncated: false },
    });
    expect(await pending).toEqual({ columns: ['um'], rows: [[1]], truncated: false });
    // P09: repetir o mesmo resultado (resposta perdida pelo relay) é idempotente; um resultado
    // contraditório continua a ser recusado.
    await expect(
      service.complete(auth, requests[0]!.id, { ok: true, result: null }),
    ).resolves.toEqual({ status: 'accepted', duplicate: true });
    await expect(
      service.complete(auth, requests[0]!.id, { ok: false, code: 'X', message: 'Contraditório.' }),
    ).rejects.toMatchObject({ status: 409 });

    const failing = queue.execute(admin.projectId, null, 'log', { type: 'api' });
    const [next] = (await service.poll(auth, {})).requests;
    await service.complete(auth, next!.id, {
      ok: false,
      code: 'LOG_MISSING',
      message: 'Sem ficheiro.',
    });
    await expect(failing).rejects.toMatchObject({ code: 'LOG_MISSING' });

    expect(await queue.isOnline(admin.projectId)).toBe(true);
    expect(
      (await new ProductionRelayToolProvider(queue).toolsFor(admin.projectId)).map((t) => t.name),
    ).toEqual(['sql', 'log']);
    expect(await service.status(technical)).toMatchObject({
      configured: true,
      online: true,
      hostname: 'prod-db',
      canManage: false,
      lastDay: { done: 1, failed: 1 },
    });
  });

  it('valida a consulta antes de a enviar e redige o resultado vindo de Produção', async () => {
    const sent: unknown[] = [];
    const queue = {
      execute: async (_project: string, _run: string | null, _tool: string, payload: unknown) => {
        sent.push(payload);
        return {
          columns: ['nota', 'pan'],
          rows: [['cartão 4111 1111 1111 1111', '4111111111111111']],
          truncated: false,
        };
      },
    } as unknown as ProductionRelayQueue;
    const tool = relaySqlTool(queue, 'p');
    await expect(
      tool.run({ query: 'DELETE FROM encomendas' }, { runId: 'r', projectId: 'p' }),
    ).rejects.toThrow('leitura');
    expect(sent).toEqual([]);
    const { result } = await tool.run(
      { query: 'SELECT nota, pan FROM t' },
      { runId: 'r', projectId: 'p' },
    );
    expect(JSON.stringify(result)).not.toContain('4111 1111 1111 1111');
    expect(JSON.stringify(result)).not.toContain('4111111111111111');
  });
});

describe('instruções do agente', () => {
  it('versiona as instruções, deteta conflitos e restringe a gravação à administração', async () => {
    const admin = await member('admin');
    const technical = await member('technical', admin.projectId);
    const client = await member('client', admin.projectId);
    const service = new AgentInstructionsService(fixture.db);

    expect(await service.get(technical)).toMatchObject({
      version: 0,
      isDefault: true,
      canManage: false,
    });
    expect(await currentAgentInstructions(fixture.db, admin.projectId)).toBe(
      defaultInstructionsForSite(null),
    );
    await expect(service.get(client)).rejects.toMatchObject({ status: 403 });
    await expect(
      service.save(technical, { body: 'Dados reais estão em Produção.', expectedVersion: 0 }),
    ).rejects.toMatchObject({ status: 403 });

    const saved = await service.save(admin, {
      body: 'Dados reais estão em Produção.',
      expectedVersion: 0,
    });
    expect(saved).toMatchObject({ version: 1, isDefault: false, updatedBy: 'Test admin' });
    await expect(
      service.save(admin, { body: 'Outra versão concorrente do texto.', expectedVersion: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await currentAgentInstructions(fixture.db, admin.projectId)).toBe(
      'Dados reais estão em Produção.',
    );
  });

  it('usa por omissão as instruções do site do projeto', async () => {
    const admin = await member('admin');
    await fixture.db.query('UPDATE projects SET site_key=$1 WHERE id=$2', [
      'pizzamovil',
      admin.projectId,
    ]);
    const instructions = await currentAgentInstructions(fixture.db, admin.projectId);
    expect(instructions).toBe(defaultInstructionsForSite('pizzamovil'));
    expect(instructions).not.toBe(DEFAULT_AGENT_INSTRUCTIONS);
  });
});
