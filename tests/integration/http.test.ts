import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../../apps/api/src/application.js';
import { IdentityService } from '../../packages/backend/src/modules/identity/identity.service.js';
import { startTestDatabase } from '../helpers/test-database.js';
import { randomBytes } from 'node:crypto';
import { authenticator } from '../../packages/backend/src/modules/identity/identity-security.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRun, AgentRunEvent, Ticket } from '../../packages/contracts/src/index.js';
import { AgentRunEventsService } from '../../packages/backend/src/modules/agents/agent-run-events.service.js';
import { AgentRunsService } from '../../packages/backend/src/modules/agents/agent-runs.service.js';
import {
  CopilotSdkAdapter,
  type AgentClientFactory,
} from '../../apps/executor/src/copilot-sdk.adapter.js';
import { AgentRunConversation } from '../../apps/executor/src/run-conversation.js';
import type { SessionEventLike } from '../../apps/executor/src/session-event-mapper.js';

describe('HTTP, sessao e CSRF', () => {
  let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
  let app: INestApplication;
  let base: string;
  let cookie: string;
  let csrf: string;
  const origin = 'http://127.0.0.1';
  const password = 'Fixture-http-only-password-123!';
  beforeAll(async () => {
    fixture = await startTestDatabase();
    await new IdentityService(fixture.db).createInitialAdmin({
      email: 'http@example.test',
      displayName: 'Teste HTTP',
      password,
    });
    app = await createApplication(
      fixture.db,
      { publicUrl: origin },
      { encryptionKey: randomBytes(32).toString('base64') },
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'http@example.test', password }),
    });
    expect(login.ok).toBe(true);
    const challengeCookie =
      login.headers
        .getSetCookie()
        .find((c) => c.startsWith('zeroops_challenge='))
        ?.split(';')[0] ?? '';
    const challenge = (await login.json()) as { status: string; csrfToken: string };
    expect(challenge.status).toBe('enrollment_required');
    const challengeHeaders = {
      Origin: origin,
      'Content-Type': 'application/json',
      Cookie: challengeCookie,
      'X-CSRF-Token': challenge.csrfToken,
    };
    const enrolled = await fetch(`${base}/api/auth/enrollment`, {
      method: 'POST',
      headers: challengeHeaders,
      body: '{}',
    });
    const enrollment = (await enrolled.json()) as { secret: string };
    const complete = await fetch(`${base}/api/auth/enrollment/confirm`, {
      method: 'POST',
      headers: challengeHeaders,
      body: JSON.stringify({ code: authenticator(enrollment.secret).generate() }),
    });
    expect(complete.status).toBe(201);
    cookie =
      complete.headers
        .getSetCookie()
        .find((c) => c.startsWith('zeroops_session='))
        ?.split(';')[0] ?? '';
    expect(cookie).toContain('zeroops_session=');
    const session = (await complete.json()) as { csrfToken: string };
    csrf = session.csrfToken;
  });
  afterAll(async () => {
    if (app) await app.close();
    if (fixture) await fixture.stop();
  });
  it('health nao revela credenciais, tickets exigem login e refresh devolve CSRF', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/tickets`)).status).toBe(401);
    expect((await fetch(`${base}/API/tickets`)).status).toBe(401);
    const response = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { csrfToken: string }).csrfToken).toBe(csrf);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).not.toContain(
      'upgrade-insecure-requests',
    );
  });
  it('recusa pedidos cross-origin e sem CSRF antes de escrever', async () => {
    const body = JSON.stringify({
      title: 'Ticket de HTTP',
      description: 'Teste de criacao protegido por CSRF.',
      category: 'bug',
      environment: 'quality',
      priority: 'low',
    });
    const invalidOrigin = await fetch(`${base}/api/tickets`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://outside.example',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body,
    });
    expect(invalidOrigin.status).toBe(403);
    const mixedCase = await fetch(`${base}/API/tickets`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://outside.example',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body,
    });
    expect(mixedCase.status).toBe(403);
    const missingCsrf = await fetch(`${base}/api/tickets`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body,
    });
    expect(missingCsrf.status).toBe(403);
    const valid = await fetch(`${base}/api/tickets`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body,
    });
    expect(valid.status).toBe(201);
    expect(((await valid.json()) as { title: string }).title).toBe('Ticket de HTTP');
  });
  it('indisponibilidade real do executor fica visivel', async () => {
    const response = await fetch(`${base}/api/capabilities`, { headers: { Cookie: cookie } });
    const result = (await response.json()) as {
      implementation: boolean;
      deployment: boolean;
      blockers: string[];
    };
    expect(result.implementation).toBe(false);
    expect(result.deployment).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
  });
  it('JSON invalido e pedidos demasiado grandes nao sao falhas internas', async () => {
    const headers = {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    };
    const malformed = await fetch(`${base}/api/tickets`, {
      method: 'POST',
      headers,
      body: '{',
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(`${base}/api/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ description: 'x'.repeat(70000) }),
    });
    expect(oversized.status).toBe(413);
  });
  it('transporta streaming, MCP, pergunta, plano e seguimento entre SDK simulado e HTTP real', async () => {
    const headers = {
      Cookie: cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    };
    const created = await fetch(`${base}/api/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Conversa sintetica de validacao',
        description: 'Validar o canal interativo sem credenciais nem fontes externas.',
        category: 'question',
        environment: 'quality',
        priority: 'low',
      }),
    });
    expect(created.status).toBe(201);
    const ticket = (await created.json()) as Ticket;
    const queued = await fetch(`${base}/api/tickets/${ticket.id}/agent-runs`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(queued.status).toBe(201);
    const run = (await queued.json()) as AgentRun;
    const runs = new AgentRunsService(fixture.db);
    const claimed = await runs.claimNext();
    expect(claimed?.runId).toBe(run.id);
    const endpoint = `${base}/api/tickets/${ticket.id}/agent-runs/${run.id}`;
    expect((await fetch(`${endpoint}/events/stream`)).status).toBe(401);
    expect(
      (await fetch(`${endpoint}/inputs`, { method: 'POST', headers: { Cookie: cookie } })).status,
    ).toBe(403);

    const workspace = await mkdtemp(join(tmpdir(), 'zeroops-http-conversation-'));
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const conversation = new AgentRunConversation(run.id, new AgentRunEventsService(fixture.db), {
      pollMs: 10,
      flushMs: 10,
    });
    const prompts: string[] = [];
    let questionAnswer: unknown;
    let planAnswer: unknown;
    let simulatedFailure: unknown;
    const factory: AgentClientFactory = () => ({
      async start() {},
      async stop() {},
      async createSession(config) {
        const listeners = new Set<(event: SessionEventLike) => void>();
        const emit = (event: SessionEventLike) => listeners.forEach((listener) => listener(event));
        return {
          on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async send({ prompt }) {
            const turn = prompts.length;
            prompts.push(prompt);
            void (async () => {
              if (!turn) {
                emit({
                  type: 'assistant.message_delta',
                  data: { messageId: 'm1', deltaContent: 'A validar ' },
                });
                emit({
                  type: 'session.mcp_servers_loaded',
                  data: { servers: [{ name: 'fixture', status: 'connected' }] },
                });
                questionAnswer = await config.onUserInputRequest!(
                  { question: 'Qual ambiente?', choices: ['Qualidade'] },
                  { sessionId: 'synthetic' },
                );
                emit({
                  type: 'assistant.message_delta',
                  data: { messageId: 'm1', deltaContent: 'o ambiente de teste.' },
                });
                planAnswer = await config.onExitPlanModeRequest!(
                  {
                    summary: 'Consultar apenas dados sinteticos.',
                    actions: ['interactive'],
                    recommendedAction: 'interactive',
                  },
                  { sessionId: 'synthetic' },
                );
              } else {
                emit({
                  type: 'assistant.message',
                  data: { messageId: 'm2', content: 'Seguimento recebido.' },
                });
              }
              await writeFile(
                join(workspace, '.zeroops-result.json'),
                JSON.stringify({
                  summary: turn ? 'Conversa validada.' : 'Primeiro turno.',
                  files: [],
                  proposedTests: [],
                  replyDraft: null,
                }),
              );
            })().then(
              () => emit({ type: 'session.idle' }),
              (error: unknown) => {
                simulatedFailure = error;
                emit({ type: 'session.error', data: { message: String(error) } });
                emit({ type: 'session.idle' });
              },
            );
            return `message-${turn}`;
          },
          async abort() {},
          async disconnect() {},
        };
      },
    });
    let execution: ReturnType<CopilotSdkAdapter['execute']> | undefined;
    try {
      const stream = await fetch(`${endpoint}/events/stream`, {
        headers: { Cookie: cookie },
        signal,
      });
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const received: AgentRunEvent[] = [];
      const nextEvent = async (): Promise<AgentRunEvent> => {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!frame.includes('event: agent\n')) continue;
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            const event = JSON.parse(data!.slice(6)) as AgentRunEvent;
            received.push(event);
            return event;
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Stream terminou antes do evento esperado.');
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      };
      const nextQuestion = async () => {
        for (;;) {
          const event = await nextEvent();
          if (event.type === 'question') return event;
        }
      };
      const send = async (body: object) => {
        const response = await fetch(`${endpoint}/inputs`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
        expect(response.status).toBe(201);
      };
      conversation.start();
      execution = new CopilotSdkAdapter(factory, { followUpWindowMs: 100 }).execute({
        workspace,
        mode: 'investigate',
        prompt: 'Validacao sintetica do canal.',
        timeoutMs: 10000,
        outputLimitBytes: 100000,
        conversation,
        signal,
      });
      const first = await nextQuestion();
      expect(first.kind).toBe('ask_user');
      expect(received).toContainEqual(
        expect.objectContaining({ type: 'assistant.delta', text: 'A validar ' }),
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          type: 'mcp.servers',
          servers: [{ name: 'fixture', status: 'connected' }],
        }),
      );
      await send({ kind: 'answer', questionId: first.questionId, text: 'Qualidade' });
      const plan = await nextQuestion();
      expect(plan.kind).toBe('plan');
      expect(questionAnswer).toEqual({ answer: 'Qualidade', wasFreeform: false });
      expect(received).toContainEqual(
        expect.objectContaining({ type: 'assistant.delta', text: 'o ambiente de teste.' }),
      );
      await send({ kind: 'answer', questionId: plan.questionId, text: 'interactive' });
      await send({ kind: 'message', text: 'Confirme tambem a disponibilidade.' });
      const report = await execution;
      expect(simulatedFailure).toBeUndefined();
      expect(planAnswer).toEqual({ approved: true, selectedAction: 'interactive' });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Confirme tambem a disponibilidade.');
      expect(report.summary).toBe('Conversa validada.');
      await conversation.close();
      await runs.complete(claimed!.lease, report);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      expect(buffer).toContain('Seguimento recebido.');
      expect(buffer).toContain('event: end\ndata: {"status":"succeeded"}');

      const resumed = await fetch(`${endpoint}/events/stream?after=0`, {
        headers: { Cookie: cookie, 'Last-Event-ID': String(first.id) },
        signal,
      });
      const replay = await resumed.text();
      const ids = [...replay.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => id > first.id)).toBe(true);
      expect(replay).toContain('event: end');
    } finally {
      controller.abort();
      await conversation.close();
      if (execution) await Promise.allSettled([execution]);
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('challenges do not grant portal access and enforce origin/CSRF with malformed unicode rejected safely', async () => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'http@example.test', password }),
    });
    const step = (await login.json()) as { status: string; csrfToken: string };
    expect(step.status).toBe('mfa_required');
    const restricted = login.headers
      .getSetCookie()
      .find((c) => c.startsWith('zeroops_challenge='))!
      .split(';')[0]!;
    expect((await fetch(`${base}/api/session`, { headers: { Cookie: restricted } })).status).toBe(
      401,
    );
    const resume = await fetch(`${base}/api/auth/challenge`, { headers: { Cookie: restricted } });
    expect(resume.status).toBe(200);
    expect(((await resume.json()) as { csrfToken: string }).csrfToken).toBe(step.csrfToken);
    for (const csrfValue of ['', 'é'.repeat(64)]) {
      const invalid = await fetch(`${base}/api/auth/challenge`, {
        method: 'POST',
        headers: {
          Cookie: restricted,
          Origin: origin,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfValue,
        },
        body: JSON.stringify({ code: '000000' }),
      });
      expect(invalid.status).toBe(403);
    }
    expect(
      (
        await fetch(`${base}/api/auth/enrollment`, {
          method: 'POST',
          headers: {
            Cookie: restricted,
            Origin: 'https://outside.example',
            'Content-Type': 'application/json',
            'X-CSRF-Token': step.csrfToken,
          },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });
});
