import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentRunEventPayload } from '@zeroops/contracts';
import { AgentRunLive } from '../src/features/tickets/AgentRunLive';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/session', () => ({
  useSession: () => ({ request }),
}));

class EventSourceFixture extends EventTarget {
  static instances: EventSourceFixture[] = [];
  closed = false;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    EventSourceFixture.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(id: number, event: AgentRunEventPayload) {
    this.dispatchEvent(
      new MessageEvent('agent', {
        data: JSON.stringify({ ...event, id, createdAt: '2026-01-01T10:00:00Z' }),
      }),
    );
  }
}

const run: AgentRun = {
  id: 'run-1',
  ticketId: 'ticket-1',
  status: 'running',
  instructions: null,
  progress: null,
  summary: null,
  replyDraft: null,
  evidence: [],
  toolCalls: [],
  errorCode: null,
  cancelRequested: false,
  pendingQuestion: null,
  usage: null,
  quota: null,
  model: null,
  reasoningEffort: null,
  requestedBy: { id: 'operator-1', displayName: 'Operador' },
  trigger: 'manual',
  clientQuestions: [],
  clientMessageId: null,
  createdAt: '2026-01-01T10:00:00Z',
  startedAt: '2026-01-01T10:00:00Z',
  finishedAt: null,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  request.mockReset();
  EventSourceFixture.instances = [];
});

describe('conversa interativa na interface', () => {
  it('mostra texto incremental e MCP, responde ao agente e ao plano e envia seguimento', async () => {
    request.mockResolvedValue({ events: [], status: 'running' });
    vi.stubGlobal('EventSource', EventSourceFixture);
    render(<AgentRunLive ticketId="ticket-1" run={run} />);
    await waitFor(() => expect(EventSourceFixture.instances).toHaveLength(1));
    const source = EventSourceFixture.instances[0]!;
    expect(source.url).toBe('/api/tickets/ticket-1/agent-runs/run-1/events/stream?after=0');
    act(() => {
      source.dispatchEvent(new Event('open'));
      source.emit(1, { type: 'assistant.delta', messageId: 'm1', text: 'A validar' });
    });
    expect(screen.getByText('Ao vivo')).toBeTruthy();
    expect(screen.getByText('A validar', { exact: true })).toBeTruthy();
    act(() => {
      source.emit(2, { type: 'assistant.delta', messageId: 'm1', text: ' o ambiente.' });
      source.emit(3, { type: 'mcp.servers', servers: [{ name: 'dados', status: 'connected' }] });
      source.emit(4, {
        type: 'tool.start',
        toolCallId: 'tool-1',
        tool: 'consulta',
        title: null,
        server: 'dados',
        arguments: '{"consulta":"sintetica"}',
      });
      source.emit(5, {
        type: 'tool.complete',
        toolCallId: 'tool-1',
        success: true,
        result: 'Resultado sintetico',
        error: null,
      });
      source.emit(6, {
        type: 'question',
        questionId: 'q1',
        kind: 'ask_user',
        question: 'Qual ambiente?',
        choices: ['Qualidade'],
        allowFreeform: true,
      });
    });
    expect(screen.getByText('A validar o ambiente.', { exact: true })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Servidores MCP' }).textContent).toContain(
      'dados · connected',
    );
    expect(screen.getByText('Resultado sintetico')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Qualidade' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/tickets/ticket-1/agent-runs/run-1/inputs', {
        method: 'POST',
        body: { kind: 'answer', questionId: 'q1', text: 'Qualidade' },
      }),
    );
    act(() => {
      source.emit(7, { type: 'answer', questionId: 'q1', answer: 'Qualidade', author: 'Operador' });
      source.emit(8, {
        type: 'question',
        questionId: 'q2',
        kind: 'plan',
        question: 'Consultar apenas dados sinteticos.',
        choices: ['interactive'],
        allowFreeform: true,
      });
    });
    expect(screen.getByText('O Copilot aguarda a aprovação do plano')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'interactive' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/tickets/ticket-1/agent-runs/run-1/inputs', {
        method: 'POST',
        body: { kind: 'answer', questionId: 'q2', text: 'interactive' },
      }),
    );
    act(() =>
      source.emit(9, {
        type: 'answer',
        questionId: 'q2',
        answer: 'interactive',
        author: 'Operador',
      }),
    );
    expect(screen.queryByText('O Copilot aguarda a aprovação do plano')).toBeNull();
    fireEvent.change(screen.getByLabelText('Mensagem para o Copilot'), {
      target: { value: 'Confirme tambem a disponibilidade.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/tickets/ticket-1/agent-runs/run-1/inputs', {
        method: 'POST',
        body: { kind: 'message', text: 'Confirme tambem a disponibilidade.' },
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Mensagem para o Copilot') as HTMLTextAreaElement).value).toBe(
        '',
      ),
    );
  });

  it('recupera eventos por polling a partir do ultimo id quando SSE nao esta disponivel', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', undefined);
    request
      .mockResolvedValueOnce({
        status: 'running',
        events: [
          {
            id: 12,
            createdAt: run.createdAt,
            type: 'assistant.delta',
            messageId: 'm1',
            text: 'Primeiro',
          },
        ],
      })
      .mockResolvedValueOnce({
        status: 'succeeded',
        events: [
          {
            id: 13,
            createdAt: run.createdAt,
            type: 'assistant.message',
            messageId: 'm1',
            text: 'Concluido.',
          },
        ],
      });
    render(<AgentRunLive ticketId="ticket-1" run={run} />);
    await act(async () => {});
    expect(screen.getByText('Primeiro', { exact: true })).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(request).toHaveBeenLastCalledWith(
      '/tickets/ticket-1/agent-runs/run-1/events?after=12',
      expect.any(Object),
    );
    expect(screen.getByText('Concluido.', { exact: true })).toBeTruthy();
    expect(screen.queryByText('Primeiro', { exact: true })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
