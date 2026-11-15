import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClaimedAssistantRequest } from '../../../packages/backend/src/modules/flows/flow-assistant.js';
import type { CopilotAgent, CopilotExecuteInput } from './copilot.adapter.js';
import { AUTHORING_TOOL_SPECS, FlowAssistantRunner } from './flow-assistant-runner.js';
import type { JobIdentity } from './job-sandbox.js';

const EMPTY = {
  files: [],
  proposedTests: [],
  replyDraft: null,
  evidence: [],
  clientQuestions: [],
  verifiedTests: false as const,
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function claimed(authoring: boolean): ClaimedAssistantRequest {
  return {
    id: 'req-1',
    projectId: 'p1',
    scope: 'flow',
    prompt: 'Constrói o fluxo.',
    lease: { jobId: 'req-1', workerId: 'w', epoch: 1, leaseSeconds: 60 },
    ...(authoring ? { authoring: { mode: 'auto' as const } } : {}),
  } as ClaimedAssistantRequest;
}

async function runner(request: ClaimedAssistantRequest, agent: CopilotAgent, stopAt?: string) {
  const root = await mkdtemp(join(tmpdir(), 'zeroops-assistant-'));
  directories.push(root);
  const calls: string[] = [];
  const outcome: { completed?: string; failed?: string } = {};
  let pending: ClaimedAssistantRequest | null = request;
  const queue = {
    async claimNext() {
      const next = pending;
      pending = null;
      return next;
    },
    async complete(_lease: unknown, text: string) {
      outcome.completed = text;
      return 'accepted' as const;
    },
    async fail(_lease: unknown, code: string) {
      outcome.failed = code;
      return 'accepted' as const;
    },
    async authoringTool(_lease: unknown, name: string, toolCallId: string) {
      calls.push(`${name}:${toolCallId}`);
      return name === stopAt
        ? { ok: false, text: 'Sem posse.', stop: true }
        : { ok: true, text: 'ok' };
    },
  };
  const instance = new FlowAssistantRunner(
    queue,
    agent,
    { workspaceRoot: root, timeoutMs: 5000, outputLimitBytes: 10000 },
    () => undefined,
  );
  await instance.runOnce();
  return { calls, outcome };
}

describe('Runner do assistente de fluxos (P06)', () => {
  it('passa as ferramentas de autoria ao Copilot e liga-as à posse do pedido', async () => {
    let seen: CopilotExecuteInput | undefined;
    const agent: CopilotAgent = {
      async execute(input) {
        seen = input;
        const apply = input.tools!.find((tool) => tool.name === 'flow_apply_operations')!;
        await apply.handler({ operations: [] }, { toolCallId: 'c1' });
        return { summary: '{"reply":"Feito"}', ...EMPTY };
      },
    };
    const { calls, outcome } = await runner(claimed(true), agent);
    expect(seen?.tools?.map((tool) => tool.name)).toEqual(
      AUTHORING_TOOL_SPECS.map((spec) => spec.name),
    );
    expect(calls).toEqual(['flow_apply_operations:c1']);
    expect(outcome.completed).toBe('{"reply":"Feito"}');
  });

  it('pedidos sem autoria (tickets) continuam sem ferramentas', async () => {
    let seen: CopilotExecuteInput | undefined;
    const agent: CopilotAgent = {
      async execute(input) {
        seen = input;
        return { summary: '{}', ...EMPTY };
      },
    };
    await runner(claimed(false), agent);
    expect(seen?.tools).toBeUndefined();
  });

  it('para sem concluir quando uma ferramenta indica perda de posse', async () => {
    let activeAfter: boolean | undefined;
    const agent: CopilotAgent = {
      async execute(input) {
        const apply = input.tools!.find((tool) => tool.name === 'flow_apply_operations')!;
        await apply.handler({ operations: [] }, { toolCallId: 'c1' });
        activeAfter = input.isActive?.();
        return { summary: '{"reply":"tarde"}', ...EMPTY };
      },
    };
    const { outcome } = await runner(claimed(true), agent, 'flow_apply_operations');
    expect(activeAfter).toBe(false);
    expect(outcome.completed).toBeUndefined();
    expect(outcome.failed).toBeUndefined();
  });

  it('falha o pedido e liberta a identidade se não conseguir criar o workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'zeroops-assistant-failure-'));
    directories.push(parent);
    let identityReleased = false;
    let failed: string | undefined;
    const request = claimed(false);
    const identity: JobIdentity = {
      uid: 61_000,
      gid: 61_000,
      home: '/home/zeroops/jobs/61000',
      private: true,
      exclusive: true,
      async release() {
        identityReleased = true;
      },
    };
    const events: Record<string, unknown>[] = [];
    const instance = new FlowAssistantRunner(
      {
        async claimNext() {
          return request;
        },
        async complete() {
          return 'accepted';
        },
        async fail(_lease, code) {
          failed = code;
          return 'accepted';
        },
      },
      {
        async execute() {
          throw new Error('não devia correr');
        },
      },
      {
        workspaceRoot: join(parent, 'missing-parent'),
        timeoutMs: 5000,
        outputLimitBytes: 10000,
        identities: {
          async acquire() {
            return identity;
          },
        },
      },
      (event) => events.push(event),
    );

    expect(await instance.runOnce()).toBe(true);
    expect(failed).toBe('workspace_unavailable');
    expect(identityReleased).toBe(true);
    expect(events[0]).toMatchObject({
      event: 'flow_assistant.workspace_failed',
      requestId: 'req-1',
    });
  });
});
