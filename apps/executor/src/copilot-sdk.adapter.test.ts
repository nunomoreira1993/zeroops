import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionConfig } from '@github/copilot-sdk';
import type { AgentRunEventPayload } from '../../../packages/contracts/src/index.js';
import type { ClaimedInput } from '../../../packages/backend/src/modules/agents/agent-run-events.service.js';
import {
  CopilotSdkAdapter,
  toModelOptions,
  toRoutingTiers,
  FusionUnavailableError,
  type AgentClientFactory,
  type AgentSession,
} from './copilot-sdk.adapter.js';
import { PermissionPolicy } from './permission-policy.js';
import { CopilotCliAdapter } from './copilot.adapter.js';
import { AgentRunConversation, type ConversationStore } from './run-conversation.js';
import {
  createRedactor,
  mapQuota,
  mapSessionEvent,
  type SessionEventLike,
} from './session-event-mapper.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'zeroops-sdk-test-'));
  directories.push(directory);
  return directory;
}

/** Store em memória: a equipa responde a cada pergunta publicada com `answers`. */
class MemoryStore implements ConversationStore {
  readonly events: AgentRunEventPayload[] = [];
  readonly inputs: ClaimedInput[] = [];
  constructor(private readonly answers: string[] = []) {}
  async append(_runId: string, events: AgentRunEventPayload[]) {
    for (const event of events) {
      this.events.push(structuredClone(event));
      const answer = event.type === 'question' ? this.answers.shift() : undefined;
      if (event.type === 'question' && answer !== undefined)
        this.inputs.push({ kind: 'answer', questionId: event.questionId, text: answer });
    }
  }
  async claimInputs() {
    return this.inputs.splice(0);
  }
}

type Turn = (
  config: SessionConfig,
  emit: (event: SessionEventLike) => void,
  prompt: string,
) => Promise<void>;

/** Cliente SDK falso: cada `send` executa o próximo turno e termina com `session.idle`. */
function fakeFactory(turns: Turn[]) {
  const seen: { env?: Record<string, string>; config?: SessionConfig; prompts: string[] } = {
    prompts: [],
  };
  const factory: AgentClientFactory = ({ env }) => {
    seen.env = env;
    return {
      async start() {},
      async stop() {},
      rpc: {
        account: {
          async getQuota() {
            return {
              quotaSnapshots: {
                premium_interactions: {
                  isUnlimitedEntitlement: false,
                  entitlementRequests: 300,
                  usedRequests: 12,
                  remainingPercentage: 96,
                  overage: 0,
                  resetDate: '2026-12-01T00:00:00Z',
                },
              },
            };
          },
        },
      },
      async createSession(config) {
        seen.config = config;
        const handlers = new Set<(event: SessionEventLike) => void>();
        const emit = (event: SessionEventLike) => handlers.forEach((handler) => handler(event));
        const session: AgentSession = {
          on(handler) {
            handlers.add(handler);
            return () => handlers.delete(handler);
          },
          async send({ prompt }) {
            seen.prompts.push(prompt);
            const turn = turns.shift();
            setTimeout(() => {
              void (turn ? turn(config, emit, prompt) : Promise.resolve()).then(() =>
                emit({ type: 'session.idle', data: {} }),
              );
            }, 0);
            return 'message-id';
          },
          async abort() {},
          async disconnect() {},
        };
        return session;
      },
    };
  };
  return { factory, seen };
}

const report = (directory: string, summary: string) =>
  writeFile(
    join(directory, '.zeroops-result.json'),
    JSON.stringify({ summary, files: [], proposedTests: [], replyDraft: 'Rascunho' }),
  );

const base = {
  mode: 'investigate' as const,
  prompt: 'Investigar o pedido.',
  timeoutMs: 10000,
  outputLimitBytes: 100000,
};

describe('Copilot interativo via SDK', () => {
  it('passa Fusion e o nivel como flags reais no transporte CLI', async () => {
    const directory = await workspace();
    const adapter = new CopilotCliAdapter({
      async run(input) {
        expect(
          input.arguments.slice(
            input.arguments.indexOf('--model'),
            input.arguments.indexOf('--model') + 4,
          ),
        ).toEqual(['--model', 'fusion', '--fusion-tier', 'high']);
        expect(input.arguments).toContain('--deny-tool=shell');
        await report(input.workspace, 'CLI Fusion');
        return { exitCode: 0, interrupted: false };
      },
    });
    expect(
      await adapter.execute({
        ...base,
        workspace: directory,
        env: { COPILOT_MODEL: 'fusion', COPILOT_FUSION_TIER: 'high' },
      }),
    ).toMatchObject({ summary: 'CLI Fusion' });
  });
  it('ativa Fusion com o identificador opaco anunciado, sem confundir tier com reasoningEffort', async () => {
    const directory = await workspace();
    const fake = fakeFactory([
      async () => {
        await report(directory, 'Fusion final');
      },
    ]);
    const factory: AgentClientFactory = (options) => ({
      ...fake.factory(options),
      rpc: {
        models: {
          list: async () => ({
            models: [],
            auto: {
              tiers: [
                {
                  id: 'server-fusion-standard-v2',
                  displayName: 'Fusion Standard',
                  description: 'Routing',
                  fusionTier: 'standard',
                  status: { enabled: true },
                },
              ],
            },
          }),
        },
      },
    });
    await new CopilotSdkAdapter(factory).execute({
      ...base,
      workspace: directory,
      env: { COPILOT_MODEL: 'fusion', COPILOT_FUSION_TIER: 'standard' },
    });
    expect(fake.seen.config).toMatchObject({
      model: 'auto',
      autoTier: 'server-fusion-standard-v2',
    });
    expect(fake.seen.config?.reasoningEffort).toBeUndefined();
  });

  it('recusa Fusion nao autorizado sem criar sessao alternativa', async () => {
    const directory = await workspace();
    const fake = fakeFactory([]);
    const factory: AgentClientFactory = (options) => ({
      ...fake.factory(options),
      rpc: { models: { list: async () => ({ models: [], auto: { tiers: [] } }) } },
    });
    await expect(
      new CopilotSdkAdapter(factory).execute({
        ...base,
        workspace: directory,
        env: { COPILOT_MODEL: 'fusion', COPILOT_FUSION_TIER: 'high' },
      }),
    ).rejects.toBeInstanceOf(FusionUnavailableError);
    expect(fake.seen.config).toBeUndefined();
  });

  it('preserva disponibilidade e promocao anunciadas no catalogo de routing', () => {
    expect(
      toRoutingTiers({
        models: [],
        auto: {
          tiers: [
            {
              id: 'route-max',
              displayName: 'Fusion Max',
              description: 'Frontier',
              fusionTier: 'max',
              status: { enabled: false, message: 'Policy', pickerVisible: true },
              billing: { promo: { discountPercent: 30, endsAt: '2026-11-30T23:59:59Z' } },
            },
          ],
        },
      }),
    ).toMatchObject([
      {
        id: 'route-max',
        fusionTier: 'max',
        enabled: false,
        visible: true,
        reason: 'Policy',
        promo: { discountPercent: 30 },
      },
    ]);
  });
  it('publica streaming, ferramentas MCP e entrega a resposta da equipa ao agente', async () => {
    const directory = await workspace();
    const store = new MemoryStore(['Encomenda 123']);
    const conversation = new AgentRunConversation('run-1', store, { flushMs: 5, pollMs: 5 });
    let answer: string | undefined;
    const { factory, seen } = fakeFactory([
      async (config, emit) => {
        emit({
          type: 'assistant.message_delta',
          data: { messageId: 'm1', deltaContent: 'A ver ' },
        });
        emit({
          type: 'assistant.message_delta',
          data: { messageId: 'm1', deltaContent: 'token-secreto-123' },
        });
        emit({
          type: 'session.mcp_servers_loaded',
          data: { servers: [{ name: 'loki', status: 'connected' }] },
        });
        emit({
          type: 'tool.execution_start',
          data: {
            toolCallId: 't1',
            toolName: 'query',
            mcpServerName: 'loki',
            arguments: { q: 'x' },
          },
        });
        emit({ type: 'tool.execution_complete', data: { toolCallId: 't1', success: true } });
        const response = await config.onUserInputRequest!(
          { question: 'Qual encomenda?', choices: ['Encomenda 123'] },
          { sessionId: 's' },
        );
        answer = response.answer;
        await report(directory, 'Concluido');
      },
    ]);
    conversation.start();
    const result = await new CopilotSdkAdapter(factory).execute({
      ...base,
      workspace: directory,
      env: { ZEROOPS_RUN_TOKEN: 'token-secreto-123' },
      conversation,
    });
    await conversation.close();

    expect(result.summary).toBe('Concluido');
    expect(answer).toBe('Encomenda 123');
    expect(seen.env?.ZEROOPS_RUN_TOKEN).toBe('token-secreto-123');
    expect(seen.config?.streaming).toBe(true);
    expect(seen.prompts[0]).toContain('.zeroops-result.json');
    const delta = store.events.find((event) => event.type === 'assistant.delta');
    expect(delta).toMatchObject({ messageId: 'm1', text: 'A ver [redigido]' });
    expect(store.events).toContainEqual(
      expect.objectContaining({ type: 'tool.start', server: 'loki', tool: 'query' }),
    );
    expect(store.events).toContainEqual(
      expect.objectContaining({
        type: 'mcp.servers',
        servers: [{ name: 'loki', status: 'connected' }],
      }),
    );
    expect(store.events).toContainEqual(
      expect.objectContaining({ type: 'question', kind: 'ask_user', question: 'Qual encomenda?' }),
    );
    expect(store.events).toContainEqual(
      expect.objectContaining({ type: 'quota', used: 12, entitlement: 300, unlimited: false }),
    );
  });

  it('continua a mesma sessao com mensagens de seguimento e trata a aprovacao do plano', async () => {
    const directory = await workspace();
    const store = new MemoryStore(['Rever o passo 2']);
    const conversation = new AgentRunConversation('run-2', store, { flushMs: 5, pollMs: 5 });
    let plan: unknown;
    const { factory, seen } = fakeFactory([
      async (config) => {
        plan = await config.onExitPlanModeRequest!(
          {
            summary: 'Plano',
            actions: ['autopilot', 'interactive'],
            recommendedAction: 'autopilot',
          },
          { sessionId: 's' },
        );
        await report(directory, 'Primeira');
        store.inputs.push({ kind: 'message', questionId: null, text: 'Veja tambem o Shift4.' });
      },
      async () => report(directory, 'Atualizada'),
    ]);
    conversation.start();
    const result = await new CopilotSdkAdapter(factory, { followUpWindowMs: 50 }).execute({
      ...base,
      workspace: directory,
      conversation,
    });
    await conversation.close();

    expect(plan).toEqual({ approved: false, feedback: 'Rever o passo 2' });
    expect(seen.prompts).toHaveLength(2);
    expect(seen.prompts[1]).toContain('Veja tambem o Shift4.');
    expect(result.summary).toBe('Atualizada');
  });

  it('sem resposta da equipa o agente continua e o tempo de espera nao conta no timeout', async () => {
    const store = new MemoryStore();
    const conversation = new AgentRunConversation('run-3', store, {
      flushMs: 5,
      pollMs: 5,
      questionTimeoutMs: 30,
    });
    conversation.start();
    const answer = await conversation.ask({
      kind: 'ask_user',
      question: 'Confirma?',
      choices: [],
      allowFreeform: true,
    });
    await conversation.close();
    expect(answer).toBeNull();
    expect(conversation.waitedMs).toBeGreaterThanOrEqual(25);
    expect(store.events.at(-1)).toMatchObject({ type: 'status' });
  });

  it('passa o esforço escolhido e volta ao modelo por omissão se o runtime recusar auto', async () => {
    const directory = await workspace();
    const { factory, seen } = fakeFactory([async () => report(directory, 'Feito')]);
    const configs: SessionConfig[] = [];
    const strict: AgentClientFactory = (options) => {
      const client = factory(options);
      return {
        ...client,
        async createSession(config) {
          configs.push(config);
          if (config.model === 'auto') throw new Error('Modelo desconhecido.');
          return client.createSession(config);
        },
      };
    };
    const result = await new CopilotSdkAdapter(strict).execute({
      ...base,
      workspace: directory,
      env: { COPILOT_MODEL: 'auto', COPILOT_REASONING_EFFORT: 'high' },
    });
    expect(result.summary).toBe('Feito');
    expect(configs).toHaveLength(2);
    expect(seen.config?.model).toBeUndefined();
    expect(seen.config?.reasoningEffort).toBe('high');
  });
});

describe('catálogo de modelos', () => {
  it('exclui modelos desativados, mostra o Fusion primeiro e ignora esforços não suportados', () => {
    expect(
      toModelOptions([
        { id: 'gpt-5', name: 'GPT-5', billing: { multiplier: 1 } },
        {
          id: 'claude-x',
          name: 'Claude X',
          billing: { multiplier: 3 },
          capabilities: { supports: { reasoningEffort: true } },
          supportedReasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'low',
        },
        { id: 'hydrafusion', name: 'Copilot Fusion' },
        { id: 'old', name: 'Old', policy: { state: 'disabled' } },
        {
          id: 'mini',
          name: 'Mini',
          capabilities: { supports: { reasoningEffort: false } },
          supportedReasoningEfforts: ['high'],
          defaultReasoningEffort: 'high',
        },
      ]),
    ).toEqual([
      {
        id: 'hydrafusion',
        name: 'Copilot Fusion',
        multiplier: null,
        efforts: [],
        defaultEffort: null,
        fusion: true,
      },
      {
        id: 'claude-x',
        name: 'Claude X',
        multiplier: 3,
        efforts: ['low', 'high'],
        defaultEffort: 'low',
        fusion: false,
      },
      {
        id: 'gpt-5',
        name: 'GPT-5',
        multiplier: 1,
        efforts: [],
        defaultEffort: null,
        fusion: false,
      },
      {
        id: 'mini',
        name: 'Mini',
        multiplier: null,
        efforts: [],
        defaultEffort: null,
        fusion: false,
      },
    ]);
  });
});

describe('politica de permissoes e redacao', () => {
  const policy = new PermissionPolicy({
    root: join(tmpdir(), 'ws'),
    mode: 'investigate',
    readOnlyDirectories: [join(tmpdir(), 'site')],
    shell: { tool: 'bash', commands: ['zo-sql'] },
  });

  it('so permite leitura das fontes, escrita do relatorio, conectores e MCP de leitura', () => {
    expect(policy.decide({ kind: 'read', path: join(tmpdir(), 'site', 'a.php') }).approved).toBe(
      true,
    );
    expect(policy.decide({ kind: 'read', path: join(tmpdir(), 'outro', 'a.php') }).approved).toBe(
      false,
    );
    expect(policy.decide({ kind: 'write', fileName: '.zeroops-result.json' }).approved).toBe(true);
    expect(policy.decide({ kind: 'write', fileName: 'index.php' }).approved).toBe(false);
    const shell = (identifier: string, extra = {}) =>
      policy.decide({
        kind: 'shell',
        fullCommandText: identifier,
        commands: [{ identifier }],
        ...extra,
      }).approved;
    expect(shell('zo-sql')).toBe(true);
    expect(shell('curl')).toBe(false);
    expect(shell('zo-sql', { hasWriteFileRedirection: true })).toBe(false);
    expect(
      policy.decide({ kind: 'mcp', serverName: 'loki', toolName: 'q', readOnly: true }).approved,
    ).toBe(true);
    expect(
      policy.decide({ kind: 'mcp', serverName: 'db', toolName: 'w', readOnly: false }).approved,
    ).toBe(false);
    expect(policy.decide({ kind: 'url', url: 'https://example.com' }).approved).toBe(false);
  });

  it('remove segredos e ignora mensagens de subagentes', () => {
    const redact = createRedactor(['segredo-do-run-1']);
    expect(redact('token=abc segredo-do-run-1 ghp_abcdefghijklmnopqrstuvwxyz')).toBe(
      'token=[redigido] [redigido] [redigido]',
    );
    expect(
      mapSessionEvent(
        { type: 'assistant.message_delta', data: { deltaContent: 'x', parentToolCallId: 'p' } },
        redact,
      ),
    ).toBeNull();
  });

  it('converte o uso do modelo em evento de consumo', () => {
    const redact = createRedactor([]);
    expect(
      mapSessionEvent(
        {
          type: 'assistant.usage',
          data: {
            model: 'claude-sonnet-4.5',
            cost: 1,
            inputTokens: 1200,
            outputTokens: 300,
            cacheReadTokens: 800,
            duration: 1500.4,
            initiator: 'sub-agent',
          },
        },
        redact,
      ),
    ).toEqual({
      type: 'usage',
      model: 'claude-sonnet-4.5',
      cost: 1,
      billingUnit: 'premium_requests',
      aiCredits: null,
      aiCreditsStatus: 'unavailable',
      initiator: 'sub-agent',
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      durationMs: 1500,
    });
    expect(mapSessionEvent({ type: 'assistant.usage', data: { cost: 1 } }, redact)).toBeNull();
    expect(mapQuota({ quotaSnapshots: {} })).toBeNull();
  });
});
