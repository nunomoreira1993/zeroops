import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  InvestigationContext,
  InvestigationResult,
} from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import type { CopilotAgent } from './copilot.adapter.js';
import { InvestigationRunner, type AgentRunQueue } from './investigation-runner.js';
import { FusionUnavailableError } from './copilot-sdk.adapter.js';

const context: InvestigationContext = {
  runId: 'run-1',
  mode: 'investigate',
  projectId: 'project-1',
  project: { name: 'Pizza Hut', siteKey: 'pizzahut' },
  connectorToken: 'token-do-run',
  ticket: {
    key: 'ZO-7',
    title: 'Pedido genérico',
    description: 'Descrição do pedido do cliente.',
    category: 'question',
    environment: 'production',
    priority: 'medium',
    status: 'investigating',
  },
  instructions: 'Verificar a encomenda.',
  projectInstructions: 'Dados reais estão em Produção.',
  model: null,
  reasoningEffort: null,
  conversation: [
    {
      author: 'Ana',
      role: 'client',
      visibility: 'public',
      automated: false,
      body: 'Mais detalhe.',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      author: 'ZeroOps',
      role: 'agent',
      visibility: 'internal',
      automated: true,
      body: 'Consultado em QA.',
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  ],
};

function queue(cancel = false) {
  const calls: { completed?: InvestigationResult; failed?: string } = {};
  let pending: InvestigationContext | null = context;
  const value: AgentRunQueue = {
    async claimNext() {
      const next = pending;
      pending = null;
      return next;
    },
    async reportProgress() {},
    async isCancelRequested() {
      return cancel;
    },
    async complete(_id, result) {
      calls.completed = result;
    },
    async fail(_id, code) {
      calls.failed = code;
    },
  };
  return { value, calls };
}

async function options() {
  return {
    workspaceRoot: await mkdtemp(join(tmpdir(), 'zeroops-runner-test-')),
    readOnlyDirectories: [],
    sources: ['Base de dados do site (só leitura)'],
    timeoutMs: 5000,
    outputLimitBytes: 10000,
    cancelPollMs: 10,
  };
}

describe('InvestigationRunner', () => {
  it('envia contexto genérico e guarda nota e rascunho', async () => {
    const { value, calls } = queue();
    const opts = await options();
    let prompt = '';
    const runner = new InvestigationRunner(
      value,
      {
        async execute(input) {
          prompt = input.prompt;
          return {
            summary: 'Nota',
            files: [],
            proposedTests: [],
            replyDraft: 'Bom dia',
            evidence: [{ source: 'db', detail: 'linha' }],
            clientQuestions: ['Qual é o número da encomenda?'],
            verifiedTests: false,
          };
        },
      },
      opts,
      () => undefined,
    );
    expect(await runner.runOnce()).toBe(true);
    expect(prompt).toContain('ZO-7');
    expect(prompt).toContain('Mais detalhe.');
    expect(prompt).toContain('Verificar a encomenda.');
    expect(prompt).toContain('Base de dados do site');
    expect(prompt).toContain('agente — investigação anterior, não é evidência deste run');
    expect(prompt).toContain(
      'Notas de investigações anteriores na conversa são pistas, não factos',
    );
    expect(prompt).toContain('clientQuestions: perguntas enviadas automaticamente ao cliente');
    expect(calls.completed).toEqual({
      summary: 'Nota',
      replyDraft: 'Bom dia',
      evidence: [{ source: 'db', detail: 'linha' }],
      clientQuestions: ['Qual é o número da encomenda?'],
    });
    expect(await readdir(opts.workspaceRoot)).toEqual([]);
    expect(await runner.runOnce()).toBe(false);
    await rm(opts.workspaceRoot, { recursive: true });
  });

  it('usa o código-fonte do site do projeto quando está montado', async () => {
    const opts = await options();
    const sitesRoot = await mkdtemp(join(tmpdir(), 'zeroops-sites-test-'));
    await mkdir(join(sitesRoot, 'pizzamovil'));
    const received: { prompt: string; readOnlyDirectories?: string[] | undefined }[] = [];
    const adapter: CopilotAgent = {
      async execute(input) {
        received.push({ prompt: input.prompt, readOnlyDirectories: input.readOnlyDirectories });
        return {
          summary: 'Nota',
          files: [],
          proposedTests: [],
          replyDraft: '',
          evidence: [],
          clientQuestions: [],
          verifiedTests: false,
        };
      },
    };
    for (const siteKey of ['pizzamovil', 'pizzahut'] as const) {
      const { value } = queue();
      const project = { name: siteKey, siteKey };
      const runner = new InvestigationRunner(
        {
          ...value,
          async claimNext() {
            const next = await value.claimNext();
            return next ? { ...next, project } : null;
          },
        },
        adapter,
        { ...opts, siteSourcesRoot: sitesRoot },
        () => undefined,
      );
      expect(await runner.runOnce()).toBe(true);
    }
    expect(received[0]?.readOnlyDirectories).toEqual([join(sitesRoot, 'pizzamovil')]);
    expect(received[0]?.prompt).toContain('Código-fonte do site Pizza Movil');
    expect(received[0]?.prompt).toContain('projeto pizzamovil');
    expect(received[1]?.readOnlyDirectories).toEqual([]);
    expect(received[1]?.prompt).toContain('Base de dados do site');
    await rm(sitesRoot, { recursive: true });
    await rm(opts.workspaceRoot, { recursive: true });
  });

  it('descreve os conectores disponiveis e entrega o token apenas ao run', async () => {
    const { value } = queue();
    const opts = await options();
    let received: { prompt: string; shell?: unknown; env?: unknown } | undefined;
    const runner = new InvestigationRunner(
      value,
      {
        async execute(input) {
          received = input;
          return {
            summary: 'Nota',
            files: [],
            proposedTests: [],
            replyDraft: null,
            evidence: [],
            clientQuestions: [],
            verifiedTests: false,
          };
        },
      },
      {
        ...opts,
        connectors: {
          url: 'http://127.0.0.1:4312',
          shellTool: 'bash',
          discover: async (runToken) =>
            runToken === 'token-do-run'
              ? [
                  {
                    tool: 'sql',
                    command: 'zo-sql',
                    usage: 'zo-sql "SELECT 1"',
                    description: 'BD',
                    environments: ['production', 'quality'],
                  },
                ]
              : [],
        },
        copilotCredentials: async (projectId) =>
          projectId === 'project-1' ? { token: 'gh-token', model: 'gpt-5' } : null,
      },
      () => undefined,
    );
    await runner.runOnce();
    expect(received?.prompt).toContain('zo-sql "SELECT 1"');
    expect(received?.prompt).toContain(
      '## Instruções do projeto\n\nDados reais estão em Produção.',
    );
    expect(received?.prompt).toContain('Ambientes: Produção (dados reais), QA (dados de teste).');
    expect(received?.prompt).toContain('use `--env production`');
    expect(received?.prompt).toContain('Não combines estes comandos com outros (`| head`');
    expect(received?.shell).toEqual({ tool: 'bash', commands: ['zo-sql'] });
    expect(received?.env).toEqual({
      COPILOT_GITHUB_TOKEN: 'gh-token',
      COPILOT_MODEL: 'gpt-5',
      ZEROOPS_CONNECTOR_URL: 'http://127.0.0.1:4312',
      ZEROOPS_RUN_TOKEN: 'token-do-run',
    });
    expect(received?.prompt).not.toContain('token-do-run');
    expect(received?.prompt).not.toContain('gh-token');
    await rm(opts.workspaceRoot, { recursive: true });
  });

  it('usa o modelo e o esforço escolhidos no run em vez dos da integração', async () => {
    const { value } = queue();
    const opts = await options();
    let env: unknown;
    const runner = new InvestigationRunner(
      {
        ...value,
        async claimNext() {
          const next = await value.claimNext();
          return next ? { ...next, model: 'hydrafusion', reasoningEffort: 'high' } : null;
        },
      },
      {
        async execute(input) {
          env = input.env;
          return {
            summary: 'Nota',
            files: [],
            proposedTests: [],
            replyDraft: null,
            evidence: [],
            clientQuestions: [],
            verifiedTests: false,
          };
        },
      },
      { ...opts, copilotCredentials: async () => ({ token: 'gh-token', model: 'gpt-5' }) },
      () => undefined,
    );
    await runner.runOnce();
    expect(env).toEqual({
      COPILOT_GITHUB_TOKEN: 'gh-token',
      COPILOT_MODEL: 'hydrafusion',
      COPILOT_REASONING_EFFORT: 'high',
    });
    await rm(opts.workspaceRoot, { recursive: true });
  });

  it.each([false, true])('preserva o tier Fusion e a recusa explícita (%s)', async (refused) => {
    const { value, calls } = queue();
    const opts = await options();
    let env: unknown;
    const runner = new InvestigationRunner(
      {
        ...value,
        async claimNext() {
          const next = await value.claimNext();
          return next ? { ...next, model: 'fusion', fusionTier: 'high' as const } : null;
        },
      },
      {
        async execute(input) {
          env = input.env;
          if (refused) throw new FusionUnavailableError();
          return {
            summary: 'Nota',
            files: [],
            proposedTests: [],
            replyDraft: null,
            evidence: [],
            clientQuestions: [],
            verifiedTests: false,
          };
        },
      },
      { ...opts, copilotCredentials: async () => ({ token: 'gh-token', model: 'gpt-5' }) },
      () => undefined,
    );
    await runner.runOnce();
    expect(env).toEqual({
      COPILOT_GITHUB_TOKEN: 'gh-token',
      COPILOT_MODEL: 'fusion',
      COPILOT_FUSION_TIER: 'high',
    });
    expect(calls.failed).toBe(refused ? 'fusion_unavailable' : undefined);
    expect(Boolean(calls.completed)).toBe(!refused);
    await rm(opts.workspaceRoot, { recursive: true });
  });

  it('falha sem chamar o Copilot quando o projeto não tem integração Copilot verificada', async () => {
    const { value, calls } = queue();
    const opts = await options();
    let executed = false;
    const runner = new InvestigationRunner(
      value,
      {
        async execute() {
          executed = true;
          throw new Error('não devia correr');
        },
      },
      { ...opts, copilotCredentials: async () => null },
      () => undefined,
    );
    await runner.runOnce();
    expect(executed).toBe(false);
    expect(calls.failed).toBe('copilot_not_configured');
    await rm(opts.workspaceRoot, { recursive: true });
  });

  it('cancela o processo quando a equipa pede cancelamento', async () => {
    const { value, calls } = queue(true);
    const opts = await options();
    const runner = new InvestigationRunner(
      value,
      {
        execute: (input) =>
          new Promise((_resolve, reject) =>
            input.signal?.addEventListener('abort', () => reject(new Error('interrompido'))),
          ),
      },
      opts,
      () => undefined,
    );
    await runner.runOnce();
    expect(calls.failed).toBe('cancelled');
    expect(calls.completed).toBeUndefined();
    await rm(opts.workspaceRoot, { recursive: true });
  });
});
