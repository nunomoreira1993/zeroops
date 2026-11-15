import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  CopilotClient,
  RuntimeConnection,
  defineTool,
  type SessionConfig,
  type SessionEvent,
} from '@github/copilot-sdk';
import { z } from 'zod';
import { expect, it } from 'vitest';
import type { CapabilityRunManifest, RunAgent } from '../../../packages/contracts/src/index.js';
import {
  CapabilityToolGuard,
  compileSessionCapabilities,
  materializeCapabilities,
} from './capability-bundle.js';

/**
 * Opt-in real: apenas fixtures sintéticas; nunca arranca o executor/fila operacional.
 * O mesmo teste pode usar o wrapper Docker através de ZEROOPS_COPILOT_SMOKE_CLI_PATH.
 */
it.skipIf(process.env.ZEROOPS_COPILOT_SMOKE !== '1')(
  'certifies the installed runtime with native skills, delegation, hooks and session resume',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeroops-copilot-smoke-'));
    const skills = join(directory, 'skills');
    const skill = join(skills, 'compatibility-smoke');
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      [
        '---',
        'name: compatibility-smoke',
        'description: Synthetic fixture for the explicit SDK compatibility smoke.',
        '---',
        'When asked to run the smoke, read fixture.txt in this skill directory and return its token.',
        '',
      ].join('\n'),
    );
    await writeFile(join(skill, 'fixture.txt'), 'ZEROOPS_NATIVE_SMOKE_OK\n');
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({
        ...(process.env.ZEROOPS_COPILOT_SMOKE_CLI_PATH
          ? { path: process.env.ZEROOPS_COPILOT_SMOKE_CLI_PATH }
          : {}),
      }),
      workingDirectory: directory,
      logLevel: 'error',
    });
    let sessionId: string | undefined;
    const events: SessionEvent[] = [];
    const hooks: { name: string; sessionId: string; toolCallId?: string }[] = [];
    const allowed = new Set(['task', 'skill', 'smoke_echo', 'view']);
    const config = {
      workingDirectory: directory,
      enableConfigDiscovery: false,
      enableSkills: true,
      skipCustomInstructions: true,
      availableTools: [...allowed],
      tools: [
        defineTool('smoke_echo', {
          description: 'Return the supplied synthetic smoke token, without I/O.',
          parameters: z.object({ token: z.literal('ZEROOPS_NATIVE_SMOKE_OK') }),
          handler: (args) => args.token,
        }),
      ],
      skillDirectories: [skills],
      disabledSkills: [],
      includeSubAgentStreamingEvents: true,
      customAgents: [
        {
          name: 'compatibility-smoke-reader',
          description: 'Read-only synthetic SDK smoke worker. Use when explicitly requested.',
          prompt:
            'Run the compatibility-smoke skill. Read its fixture, call smoke_echo with its token, and return the token. Do not access other files.',
          skills: ['compatibility-smoke'],
          tools: ['skill', 'view', 'smoke_echo'],
        },
      ],
      onPermissionRequest: () => ({
        kind: 'reject' as const,
        feedback: 'No additional host permissions in this isolated smoke.',
      }),
      hooks: {
        onPreToolUse: (input, invocation) => {
          hooks.push({
            name: input.toolName,
            sessionId: invocation.sessionId,
            toolCallId: input.toolCallId,
          });
          let permitted = allowed.has(input.toolName);
          if (input.toolName === 'view') {
            const args = z.object({ path: z.string() }).safeParse(input.toolArgs);
            const path = args.success
              ? relative(directory, resolve(directory, args.data.path))
              : '..';
            permitted =
              args.success &&
              !isAbsolute(path) &&
              path !== '..' &&
              !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
          }
          return { permissionDecision: permitted ? 'allow' : 'deny' };
        },
        onUserPromptSubmitted: (_input, invocation) => {
          hooks.push({ name: 'prompt', sessionId: invocation.sessionId });
        },
        onPostToolUse: (input, invocation) => {
          hooks.push({
            name: `post:${input.toolName}`,
            sessionId: invocation.sessionId,
            toolCallId: input.toolCallId,
          });
        },
        onSubagentStart: (input, invocation) => {
          hooks.push({ name: `subagent:${input.agentName}`, sessionId: invocation.sessionId });
        },
      },
    } satisfies SessionConfig;
    try {
      await client.start();
      const status = await client.getStatus();
      expect(status).toMatchObject({ version: '1.0.108', protocolVersion: 3 });
      expect((await client.getAuthStatus()).isAuthenticated).toBe(true);
      const session = await client.createSession(config);
      sessionId = session.sessionId;
      session.on((event) => events.push(event));
      const response = await session.sendAndWait(
        {
          prompt:
            'Delegate this task using the task tool to compatibility-smoke-reader. It must run compatibility-smoke, read its fixture.txt and call smoke_echo. Return only the worker token.',
        },
        120000,
      );
      expect(response?.data.content.trim()).toBe('ZEROOPS_NATIVE_SMOKE_OK');
      expect(events.some((event) => event.type === 'subagent.started')).toBe(true);
      expect(events.some((event) => event.type === 'subagent.completed')).toBe(true);
      expect(events.some((event) => event.type === 'skill.invoked')).toBe(true);
      const parent = events.find(
        (event) => event.type === 'tool.execution_start' && event.data.toolName === 'task',
      );
      const child = events.find((event) => event.type === 'subagent.started');
      const completed = events.find((event) => event.type === 'subagent.completed');
      expect(parent?.type === 'tool.execution_start' && parent.data.toolCallId).toBeTruthy();
      expect(child?.type === 'subagent.started' && child.data.toolCallId).toBe(
        parent?.type === 'tool.execution_start' && parent.data.toolCallId,
      );
      expect(completed?.type === 'subagent.completed' && completed.data.toolCallId).toBe(
        child?.type === 'subagent.started' && child.data.toolCallId,
      );
      expect(hooks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'prompt', sessionId }),
          expect.objectContaining({ name: 'smoke_echo' }),
          expect.objectContaining({ name: 'post:smoke_echo' }),
        ]),
      );
      expect(hooks.some((hook) => hook.name.startsWith('subagent:'))).toBe(true);
      await session.disconnect();
      const resumed = await client.resumeSession(sessionId, config);
      expect(resumed.sessionId).toBe(sessionId);
      const result = await resumed.sendAndWait(
        'Do not use tools. Reply with exactly ZEROOPS_RESUMED_OK.',
        60000,
      );
      expect(result?.data.content.trim()).toBe('ZEROOPS_RESUMED_OK');
      await resumed.send('Explain in detail what cancellation means. Do not use tools.');
      await resumed.abort();
      const afterAbort = await resumed.sendAndWait(
        'Do not use tools. Reply with exactly ZEROOPS_ABORT_RECOVERED_OK.',
        60000,
      );
      expect(afterAbort?.data.content.trim()).toBe('ZEROOPS_ABORT_RECOVERED_OK');
      await resumed.disconnect();
      expect(await readFile(join(skill, 'fixture.txt'), 'utf8')).toBe('ZEROOPS_NATIVE_SMOKE_OK\n');
    } finally {
      if (sessionId) await client.deleteSession(sessionId);
      await client.stop();
      await rm(directory, { recursive: true });
    }
  },
  240000,
);

/**
 * Opt-in real P04: o mesmo caminho do executor (bundle fixado verificado por hash, compilador e
 * guarda), com uma skill de referência relativa e um especialista só de leitura.
 */
it.skipIf(process.env.ZEROOPS_COPILOT_SMOKE !== '1')(
  'runs a pinned specialist with a pinned skill compiled by the ZeroOps capability compiler',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zeroops-capability-smoke-'));
    const files = [
      {
        path: 'SKILL.md',
        content: [
          '---',
          'name: capability-smoke',
          'description: Synthetic fixture that returns the token stored in references/token.md.',
          '---',
          'Read references/token.md in this skill directory and return only the token it contains.',
          '',
        ].join('\n'),
      },
      { path: 'references/token.md', content: 'ZEROOPS_CAPABILITY_SMOKE_OK\n' },
    ].map((file) => ({
      ...file,
      sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'),
    }));
    const agent = (name: string, prompt: string): RunAgent => ({
      name,
      displayName: name,
      description: `Synthetic ${name} for the capability smoke. Use when explicitly requested.`,
      profileId: '00000000-0000-4000-8000-000000000001',
      version: 1,
      definitionHash: 'a'.repeat(64),
      prompt,
      connectorTools: [],
      model: null,
    });
    const manifest: CapabilityRunManifest = {
      format: 1,
      agent: agent('smoke-main', 'Delegate when asked. Reply only with the requested token.'),
      skills: [
        {
          skillId: 's1',
          versionId: 'v1',
          version: 1,
          name: 'capability-smoke',
          description: 'Synthetic fixture.',
          bundleHash: 'b'.repeat(64),
          files: files.map(({ path, sha256, content }) => ({
            path,
            sha256,
            size: Buffer.byteLength(content),
          })),
          requiredTools: [],
        },
      ],
      delegates: [
        agent(
          'smoke-reader',
          'Use the capability-smoke skill, read its reference file and return only the token.',
        ),
      ],
      delegation: { maxConcurrency: 1, maxDepth: 1 },
    };
    const { compiled, cleanup } = await materializeCapabilities(directory, {
      manifest,
      files: { v1: files },
    });
    const native = compileSessionCapabilities(compiled, null);
    const guard = new CapabilityToolGuard(manifest);
    const denied: string[] = [];
    const events: SessionEvent[] = [];
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({
        ...(process.env.ZEROOPS_COPILOT_SMOKE_CLI_PATH
          ? { path: process.env.ZEROOPS_COPILOT_SMOKE_CLI_PATH }
          : {}),
      }),
      workingDirectory: directory,
      logLevel: 'error',
    });
    let sessionId: string | undefined;
    try {
      await client.start();
      const session = await client.createSession({
        ...native.config,
        workingDirectory: directory,
        skipCustomInstructions: true,
        additionalDirectories: [compiled.skillDirectory!],
        availableTools: ['view', 'grep', 'glob', 'report_intent', ...native.tools],
        hooks: {
          onPreToolUse: (input) => {
            const decision = guard.check(input);
            if (decision) denied.push(input.toolName);
            return decision;
          },
        },
        onPermissionRequest: (request) =>
          request.kind === 'read'
            ? { kind: 'approve-once' as const }
            : { kind: 'reject' as const, feedback: 'Read-only smoke.' },
      });
      sessionId = session.sessionId;
      session.on((event) => {
        events.push(event);
        if (event.type === 'tool.execution_complete') guard.release(event.data.toolCallId);
      });
      const response = await session.sendAndWait(
        {
          prompt: 'Delegate to smoke-reader with the task tool. Return only the token it reports.',
        },
        180000,
      );
      expect(response?.data.content).toContain('ZEROOPS_CAPABILITY_SMOKE_OK');
      const started = events.find((event) => event.type === 'subagent.started');
      expect(started?.type === 'subagent.started' && started.data.agentName).toBe('smoke-reader');
      expect(events.some((event) => event.type === 'subagent.completed')).toBe(true);
      expect(
        events.some(
          (event) => event.type === 'skill.invoked' && event.data.name === 'capability-smoke',
        ),
      ).toBe(true);
      expect(denied).toEqual([]);
      expect(guard.active).toBe(0);
      await session.disconnect();
    } finally {
      if (sessionId) await client.deleteSession(sessionId);
      await client.stop();
      await cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  },
  300000,
);
