import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { AgentRunEventsService } from './agent-run-events.service.js';
import { AgentRunsService } from './agent-runs.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let runs: AgentRunsService;
let events: AgentRunEventsService;
let tickets: TicketsService;
beforeAll(async () => {
  fixture = await startTestDatabase();
  runs = new AgentRunsService(fixture.db);
  events = new AgentRunEventsService(fixture.db);
  tickets = new TicketsService(fixture.db);
});
afterAll(async () => {
  await fixture?.stop();
});

async function member(role: Role, projectId: string = randomUUID()): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects (id,name) VALUES ($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, 'Conversation test'],
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

/** Pedido com um run já a correr no executor. */
async function runningRun() {
  const client = await member('client');
  const technical = await member('technical', client.projectId);
  const ticket = await tickets.create(client, {
    title: 'Pedido interativo',
    description: 'O cliente pede a análise de uma situação.',
    category: 'question',
    environment: 'production',
    priority: 'medium',
  });
  await fixture.db.query("UPDATE agent_runs SET status='cancelled' WHERE status='queued'");
  const run = await runs.request(technical, ticket.id, {});
  expect((await runs.claimNext())?.runId).toBe(run.id);
  return { client, technical, ticket, run };
}

describe('AgentRunEventsService', () => {
  it('agrega o consumo do modelo e a última quota no run listado', async () => {
    const { technical, ticket, run } = await runningRun();
    const call = {
      type: 'usage' as const,
      model: 'claude-sonnet-4.5',
      initiator: null,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 500,
      durationMs: 800,
    };
    const quota = {
      type: 'quota' as const,
      unlimited: false,
      entitlement: 300,
      remainingPercentage: 90,
      overage: 0,
      resetDate: null,
    };
    await events.append(run.id, [
      { ...quota, used: 29 },
      { ...call, cost: 1 },
      { ...call, cost: 1, model: 'gpt-5-mini', initiator: 'sub-agent' },
      { ...call, cost: 1 },
      { ...quota, used: 30 },
      { type: 'user.message', text: 'E agora?', author: 'Ana' },
      { ...call, cost: 1 },
    ]);
    const [listed] = await runs.list(technical, ticket.id);
    // Um premium por pedido do utilizador; continuações e sub-agentes só somam tokens.
    expect(listed?.usage).toMatchObject({
      premiumRequests: 2,
      aiCredits: null,
      aiCreditsStatus: 'unavailable',
      costUnit: 'premium_requests',
      costStatus: 'complete',
      modelCalls: 4,
      inputTokens: 4000,
      outputTokens: 400,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
      models: ['claude-sonnet-4.5', 'gpt-5-mini'],
    });
    expect(listed?.quota).toMatchObject({ used: 30, entitlement: 300 });
  });

  it('reconstrói créditos parciais de recibos únicos sem usar a quota ou zeros antigos como custo', async () => {
    const { technical, ticket, run } = await runningRun();
    const call = {
      type: 'usage' as const,
      model: 'gpt-5',
      cost: null,
      aiCredits: 0.000125,
      aiCreditsStatus: 'complete' as const,
      billingUnit: 'ai_credits' as const,
      accounting: { sourceSessionId: 'session', sequence: 1, usageId: 'receipt-1' },
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
      initiator: null,
      durationMs: 50,
    };
    await events.append(run.id, [
      call,
      { type: 'user.message', text: 'Mais detalhe', author: 'Ana' },
      call,
      {
        ...call,
        model: 'claude-sonnet-4.5',
        cost: 0,
        aiCredits: null,
        aiCreditsStatus: 'unavailable',
        accounting: { sourceSessionId: 'session', sequence: 2, usageId: 'receipt-2' },
      },
      {
        type: 'quota',
        unlimited: false,
        used: 100,
        entitlement: 300,
        remainingPercentage: 66,
        overage: 0,
        resetDate: null,
      },
    ]);
    const [listed] = await runs.list(technical, ticket.id);
    expect(listed?.usage).toMatchObject({
      premiumRequests: 0,
      aiCredits: 0.000125,
      aiCreditsStatus: 'partial',
      costStatus: 'partial',
      modelCalls: 2,
      inputTokens: 200,
      cacheWriteTokens: 60,
      models: ['gpt-5', 'claude-sonnet-4.5'],
    });
    // Preserva os eventos recebidos; só a reconstrução contabilística deduplica.
    expect(
      (await events.listSince(technical, ticket.id, run.id)).events.filter(
        (event) => event.type === 'usage',
      ),
    ).toHaveLength(3);
  });

  it('guarda a conversa por ordem e reserva-a à equipa', async () => {
    const { client, technical, ticket, run } = await runningRun();
    await events.append(run.id, [
      { type: 'status', text: 'A investigar' },
      { type: 'assistant.delta', messageId: 'm1', text: 'Olá' },
    ]);
    const first = await events.listSince(technical, ticket.id, run.id, 0);
    expect(first.status).toBe('running');
    expect(first.events.map((event) => event.type)).toEqual(['status', 'assistant.delta']);
    const after = await events.listSince(technical, ticket.id, run.id, first.events[0]!.id);
    expect(after.events).toHaveLength(1);
    await expect(events.listSince(client, ticket.id, run.id, 0)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('aceita só respostas à pergunta pendente e entrega cada entrada uma vez ao executor', async () => {
    const { technical, ticket, run } = await runningRun();
    await events.append(run.id, [
      {
        type: 'question',
        questionId: 'q1',
        kind: 'ask_user',
        question: 'Qual encomenda?',
        choices: ['123'],
        allowFreeform: true,
      },
    ]);
    const [listed] = await runs.list(technical, ticket.id);
    expect(listed?.pendingQuestion).toMatchObject({
      questionId: 'q1',
      question: 'Qual encomenda?',
    });

    await expect(
      events.submitInput(technical, ticket.id, run.id, {
        kind: 'answer',
        questionId: 'outra',
        text: '123',
      }),
    ).rejects.toThrow();
    await events.submitInput(technical, ticket.id, run.id, {
      kind: 'answer',
      questionId: 'q1',
      text: '123',
    });
    await events.submitInput(technical, ticket.id, run.id, {
      kind: 'message',
      text: 'Veja também o Shift4.',
    });

    const [answered] = await runs.list(technical, ticket.id);
    expect(answered?.pendingQuestion).toBeNull();
    expect(await events.claimInputs(run.id)).toEqual([
      { kind: 'answer', questionId: 'q1', text: '123' },
      { kind: 'message', questionId: null, text: 'Veja também o Shift4.' },
    ]);
    expect(await events.claimInputs(run.id)).toEqual([]);
    const conversation = await events.listSince(technical, ticket.id, run.id, 0);
    expect(conversation.events.map((event) => event.type)).toEqual([
      'question',
      'answer',
      'user.message',
    ]);
    const audit = await fixture.db.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action IN ('agent.run_answer','agent.run_message') AND actor_id=$1",
      [technical.id],
    );
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      'agent.run_answer',
      'agent.run_message',
    ]);
  });

  it('recusa entradas em runs terminados', async () => {
    const { technical, ticket, run } = await runningRun();
    await runs.complete(run.id, { summary: 'Feito.', replyDraft: null, evidence: [] });
    await expect(
      events.submitInput(technical, ticket.id, run.id, { kind: 'message', text: 'Mais?' }),
    ).rejects.toThrow();
  });
});
