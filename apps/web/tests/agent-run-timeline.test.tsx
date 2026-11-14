import { describe, expect, it } from 'vitest';
import type { AgentRunEvent, AgentRunEventPayload } from '@zeroops/contracts';
import {
  buildTimeline,
  sumUsage,
  toolEnvironment,
} from '../src/features/tickets/agent-run-timeline';

const events = (payloads: AgentRunEventPayload[]): AgentRunEvent[] =>
  payloads.map((payload, index) => ({
    ...payload,
    id: index + 1,
    createdAt: '2026-01-01T00:00:00Z',
  }));

describe('timeline da conversa com o Copilot', () => {
  it('junta deltas, associa ferramentas e respostas e mostra só a pergunta pendente', () => {
    const question = { kind: 'ask_user' as const, choices: [], allowFreeform: true };
    const timeline = buildTimeline(
      events([
        { type: 'assistant.delta', messageId: 'm1', text: 'A ' },
        { type: 'assistant.delta', messageId: 'm1', text: 'ver' },
        {
          type: 'tool.start',
          toolCallId: 't1',
          tool: 'query',
          title: null,
          server: 'loki',
          arguments: null,
        },
        { type: 'tool.complete', toolCallId: 't1', success: false, result: null, error: 'timeout' },
        { type: 'mcp.servers', servers: [{ name: 'loki', status: 'connected' }] },
        { type: 'question', questionId: 'q1', question: 'Primeira?', ...question },
        { type: 'answer', questionId: 'q1', answer: 'Sim', author: 'Ana' },
        { type: 'question', questionId: 'q2', question: 'Segunda?', ...question },
      ]),
    );
    expect(timeline.items[0]).toMatchObject({ kind: 'assistant', text: 'A ver', streaming: true });
    expect(timeline.items[1]).toMatchObject({
      kind: 'steps',
      steps: [{ kind: 'tool', state: 'failed', result: 'timeout' }],
    });
    expect(timeline.items[2]).toMatchObject({ kind: 'question', answer: 'Sim', author: 'Ana' });
    expect(timeline.servers).toEqual([{ name: 'loki', status: 'connected' }]);
    expect(timeline.pendingQuestion?.questionId).toBe('q2');
  });

  it('agrupa passos consecutivos e associa a permissão à ferramenta (por id ou comando)', () => {
    const shell = (id: string, command: string) =>
      ({
        type: 'tool.start',
        toolCallId: id,
        tool: 'bash',
        title: null,
        server: null,
        arguments: JSON.stringify({ command, description: `Passo ${id}` }),
      }) as const;
    const timeline = buildTimeline(
      events([
        { type: 'status', text: 'A consultar pagamentos' },
        shell('t1', 'zo-sql --env production "SELECT 1"'),
        { type: 'tool.complete', toolCallId: 't1', success: true, result: 'ok', error: null },
        {
          type: 'permission',
          kind: 'shell',
          decision: 'approved',
          detail: 'zo-sql --env production "SELECT 1"',
        },
        {
          type: 'permission',
          kind: 'shell',
          decision: 'approved',
          detail: 'zo-sql --env quality "SELECT 2"',
          toolCallId: 't2',
        },
        shell('t2', 'zo-sql --env quality "SELECT 2"'),
        { type: 'permission', kind: 'url', decision: 'denied', detail: 'acesso a URL negado' },
        { type: 'assistant.message', messageId: 'm1', text: 'Concluído.' },
      ]),
    );
    expect(timeline.items).toHaveLength(2);
    const [steps] = timeline.items;
    expect(steps).toMatchObject({ kind: 'steps' });
    if (steps?.kind !== 'steps') throw new Error('esperado bloco de passos');
    expect(steps.steps.map((step) => step.kind)).toEqual(['status', 'tool', 'tool', 'permission']);
    expect(steps.steps[1]).toMatchObject({ permission: { decision: 'approved' } });
    expect(steps.steps[2]).toMatchObject({ state: 'running', permission: { kind: 'shell' } });
    expect(toolEnvironment(steps.steps[1]?.kind === 'tool' ? steps.steps[1].arguments : null)).toBe(
      'production',
    );
  });

  it('soma o consumo por turno e no total e guarda a última quota', () => {
    const usage = (cost: number, initiator: string | null = null) =>
      ({
        type: 'usage',
        model: 'claude-sonnet-4.5',
        cost,
        initiator,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        durationMs: 900,
      }) as const;
    const quota = {
      unlimited: false,
      used: 10,
      entitlement: 300,
      remainingPercentage: 96.7,
      overage: 0,
      resetDate: null,
    };
    const timeline = buildTimeline(
      events([
        usage(1),
        usage(1),
        usage(1, 'sub-agent'),
        { type: 'assistant.message', messageId: 'm1', text: 'Primeiro.' },
        { type: 'quota', ...quota, used: 9 },
        { type: 'user.message', text: 'E agora?', author: 'Ana' },
        usage(1, 'sub-agent'),
        usage(1),
        { type: 'assistant.message', messageId: 'm2', text: 'Segundo.' },
        { type: 'quota', ...quota },
      ]),
    );
    expect(timeline.items.map((item) => item.kind)).toEqual([
      'assistant',
      'usage',
      'user',
      'assistant',
      'usage',
    ]);
    // Só o pedido do utilizador conta como premium; continuações e sub-agentes só gastam tokens.
    expect(timeline.items[1]).toMatchObject({
      usage: { premiumRequests: 1, modelCalls: 3, inputTokens: 3000 },
    });
    expect(timeline.items[4]).toMatchObject({ usage: { premiumRequests: 1, modelCalls: 2 } });
    expect(timeline.usage).toMatchObject({ premiumRequests: 2, modelCalls: 5 });
    expect(timeline.quota).toEqual(quota);
    expect(sumUsage([timeline.usage, null, timeline.usage])?.premiumRequests).toBe(4);
  });
});
