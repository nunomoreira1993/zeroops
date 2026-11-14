import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { AgentRunsService } from '../agents/agent-runs.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { ConnectorGateway, type ConnectorTool } from './connector-gateway.js';
import { IntegrationToolProvider } from './integration-tool-provider.js';
import { assertReadOnlySql } from './read-only-sql.js';
import { redactText } from './redaction.js';
import { SiteDatabaseConnector } from './site-database.connector.js';

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
    [projectId, 'Connector test'],
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

const echo: ConnectorTool<{ text: string }> = {
  name: 'echo',
  input: z.strictObject({ text: z.string().max(50) }),
  describe: (input) => input.text,
  async run(input) {
    return { result: { text: input.text }, rowCount: 1 };
  },
};

describe('conectores de leitura', () => {
  it('aceita só uma consulta de leitura e mascara cartões', () => {
    expect(
      assertReadOnlySql("SELECT REPLACE(nome,'a','b') FROM t WHERE x='; DROP TABLE t';"),
    ).toContain('SELECT');
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE t')).toThrow('uma instrução');
    expect(() => assertReadOnlySql('DELETE FROM t')).toThrow('leitura');
    expect(() => assertReadOnlySql('SELECT * FROM t FOR UPDATE')).toThrow('FOR UPDATE');
    expect(() => assertReadOnlySql("SELECT LOAD_FILE('/etc/passwd')")).toThrow('LOAD_FILE');
    expect(redactText('cartão 4111 1111 1111 1111 pago; encomenda 1234567890123')).toBe(
      'cartão ****1111 pago; encomenda 1234567890123',
    );
  });

  it('limita linhas no servidor e redige colunas sensíveis', async () => {
    await member('client');
    await member('client');
    await member('client');
    const site = new SiteDatabaseConnector(fixture.url, { maxRows: 2, timeoutSeconds: 5 });
    try {
      const result = await site.query('SELECT email, password_hash FROM users');
      expect(result.columns).toEqual(['email', 'password_hash']);
      expect(result.rows).toHaveLength(2);
      expect(result.truncated).toBe(true);
      expect(result.rows[0]?.[1]).toBe('[redigido]');
      await expect(site.query('SELECT * FROM tabela_inexistente')).rejects.toMatchObject({
        code: 'SQL_FAILED',
      });
    } finally {
      await site.close();
    }
  });

  it('cria as ferramentas a partir das integrações verificadas e reage a rotação/revogação', async () => {
    const url = new URL(fixture.url);
    const database = {
      kind: 'database' as const,
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    let current: { id: string; version: number; values: typeof database } | null = {
      id: 'setting-1',
      version: 1,
      values: database,
    };
    const provider = new IntegrationToolProvider(
      {
        runtimeValues: (async (_project: string, _environment: string, kind: string) =>
          kind === 'database' ? current : null) as never,
      },
      'quality',
    );
    try {
      const [first] = await provider.toolsFor('p');
      expect(first?.name).toBe('sql');
      expect((await provider.toolsFor('p'))[0]).toBe(first);
      const result = (
        await (first as ConnectorTool<{ query: string }>).run(
          { query: 'SELECT 1 AS um' },
          { runId: 'r', projectId: 'p' },
        )
      ).result as { rows: unknown[][] };
      expect(result.rows).toEqual([[1]]);
      current = { ...current!, version: 2 };
      expect((await provider.toolsFor('p'))[0]).not.toBe(first);
      current = null;
      expect(await provider.toolsFor('p')).toEqual([]);
    } finally {
      await provider.close();
    }
  });

  it('só aceita o token de um run em execução e regista cada chamada', async () => {
    const runs = new AgentRunsService(fixture.db);
    const tickets = new TicketsService(fixture.db);
    const client = await member('client');
    const technical = await member('technical', client.projectId);
    const ticket = await tickets.create(client, {
      title: 'Pedido com consultas',
      description: 'Verificar uma situação.',
      category: 'question',
      environment: 'production',
      priority: 'medium',
    });
    const run = await runs.request(technical, ticket.id, {});
    const context = await runs.claimNext();
    const token = context?.connectorToken ?? '';
    const gateway = new ConnectorGateway(
      fixture.db,
      {
        toolsFor: async (projectId) =>
          projectId === client.projectId ? [echo as ConnectorTool<never>] : [],
      },
      2,
    );

    expect((await gateway.call('falso', 'echo', { text: 'x' })).status).toBe(401);
    expect(await gateway.toolsFor(token)).toEqual([
      { name: 'echo', environment: 'quality', hint: null },
    ]);
    expect(await gateway.toolsFor('falso')).toBeNull();
    expect(await gateway.call(token, 'echo', { text: 'olá' })).toEqual({
      status: 200,
      body: { text: 'olá' },
    });
    expect((await gateway.call(token, 'echo', { other: 1 })).status).toBe(400);
    expect((await gateway.call(token, 'echo', { text: 'excesso' })).status).toBe(429);

    await runs.complete(run.id, { summary: 'Feito.', replyDraft: null, evidence: [] });
    expect((await gateway.call(token, 'echo', { text: 'depois' })).status).toBe(401);
    const [done] = await runs.list(technical, ticket.id);
    const calls = done?.toolCalls.map((call) => [call.request, call.outcome, call.errorCode]);
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['olá', 'ok', null],
        ['{"other":1}', 'rejected', 'INPUT_INVALID'],
        ['excesso', 'rejected', 'CALL_LIMIT'],
      ]),
    );
  });

  it('encaminha pelo ambiente pedido e regista-o na evidência', async () => {
    const runs = new AgentRunsService(fixture.db);
    const client = await member('client');
    const technical = await member('technical', client.projectId);
    const ticket = await new TicketsService(fixture.db).create(client, {
      title: 'Pedido com dados reais',
      description: 'Verificar uma encomenda.',
      category: 'question',
      environment: 'production',
      priority: 'medium',
    });
    const run = await runs.request(technical, ticket.id, {});
    const token = (await runs.claimNext())?.connectorToken ?? '';
    const production: ConnectorTool<{ text: string }> = {
      ...echo,
      environment: 'production',
      async run(input, context) {
        return { result: { text: `prod:${input.text}:${context.runId === run.id}` }, rowCount: 1 };
      },
    };
    const gateway = new ConnectorGateway(fixture.db, {
      toolsFor: async () => [production as ConnectorTool<never>],
    });

    expect((await gateway.call(token, 'echo', { text: 'x' })).status).toBe(404);
    expect(await gateway.call(token, 'echo', { text: 'x' }, 'production')).toEqual({
      status: 200,
      body: { text: 'prod:x:true' },
    });
    const [listed] = await runs.list(technical, ticket.id);
    expect(listed?.toolCalls.map((call) => call.environment)).toEqual(['production']);
  });
});
