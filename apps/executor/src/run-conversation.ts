import { randomUUID } from 'node:crypto';
import type { AgentQuestion, AgentRunEventPayload } from '../../../packages/contracts/src/index.js';
import type { ClaimedInput } from '../../../packages/backend/src/modules/agents/agent-run-events.service.js';

/** Persistência da conversa (implementada pelo `AgentRunEventsService`). */
export interface ConversationStore {
  append(runId: string, events: AgentRunEventPayload[]): Promise<void>;
  claimInputs(runId: string): Promise<ClaimedInput[]>;
}

export interface ConversationOptions {
  /** Intervalo de escrita dos eventos acumulados (texto em streaming). */
  flushMs?: number;
  /** Intervalo de leitura das respostas e mensagens da equipa. */
  pollMs?: number;
  /** Tempo máximo à espera de uma resposta antes de o agente continuar sozinho. */
  questionTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

type Waiter<T> = { resolve: (value: T) => void };

/**
 * Canal da conversa ao vivo de um run. Os eventos são acumulados e escritos em lote (os deltas
 * consecutivos da mesma mensagem são fundidos) e as entradas da equipa são lidas periodicamente.
 * O tempo passado à espera da equipa fica em `waitedMs`, para não contar no timeout do agente.
 */
export class AgentRunConversation {
  private buffer: AgentRunEventPayload[] = [];
  private writing: Promise<void> = Promise.resolve();
  private readonly messages: string[] = [];
  private question: (Waiter<string | null> & { questionId: string }) | null = null;
  private messageWaiter: Waiter<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private waited = 0;
  private readonly flushMs: number;
  private readonly pollMs: number;
  private readonly questionTimeoutMs: number;

  constructor(
    private readonly runId: string,
    private readonly store: ConversationStore,
    private readonly options: ConversationOptions = {},
  ) {
    this.flushMs = options.flushMs ?? 500;
    this.pollMs = options.pollMs ?? 1000;
    this.questionTimeoutMs = options.questionTimeoutMs ?? 10 * 60 * 1000;
  }

  /** Tempo total (ms) à espera de respostas ou mensagens da equipa. */
  get waitedMs() {
    return this.waited;
  }

  start() {
    this.flushTimer ??= setInterval(() => void this.flush(), this.flushMs);
    this.pollTimer ??= setInterval(() => void this.poll(), this.pollMs);
  }

  publish(event: AgentRunEventPayload) {
    const last = this.buffer.at(-1);
    if (
      event.type === 'assistant.delta' &&
      last?.type === 'assistant.delta' &&
      last.messageId === event.messageId
    ) {
      last.text += event.text;
      return;
    }
    this.buffer.push(event.type === 'assistant.delta' ? { ...event } : event);
  }

  /** Escreve os eventos acumulados, mantendo a ordem entre escritas. */
  flush(): Promise<void> {
    if (!this.buffer.length) return this.writing;
    const batch = this.buffer;
    this.buffer = [];
    this.writing = this.writing
      .then(() => this.store.append(this.runId, batch))
      .catch((error) => this.options.onError?.(error));
    return this.writing;
  }

  /**
   * Publica uma pergunta e espera pela resposta da equipa. Devolve `null` se não houver resposta
   * dentro do limite ou se o run for cancelado.
   */
  async ask(question: Omit<AgentQuestion, 'questionId'>, signal?: AbortSignal) {
    const questionId = randomUUID();
    this.publish({ type: 'question', questionId, ...question });
    await this.flush();
    const started = Date.now();
    const answer = await new Promise<string | null>((resolve) => {
      const finish = (value: string | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.question = null;
        resolve(value);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), this.questionTimeoutMs);
      this.question = { questionId, resolve: finish };
      if (signal?.aborted) finish(null);
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    this.waited += Date.now() - started;
    if (answer === null && !signal?.aborted)
      this.publish({ type: 'status', text: 'Sem resposta da equipa; o agente continua sozinho.' });
    return answer;
  }

  /** Mensagens de seguimento recebidas e ainda não entregues ao agente. */
  takeMessages() {
    return this.messages.splice(0);
  }

  /** Espera até `ms` por mensagens de seguimento; devolve as recebidas (pode ser vazio). */
  async waitForMessages(ms: number, signal?: AbortSignal) {
    if (!this.messages.length && ms > 0 && !signal?.aborted) {
      const started = Date.now();
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          this.messageWaiter = null;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        this.messageWaiter = { resolve: finish };
        signal?.addEventListener('abort', finish, { once: true });
      });
      this.waited += Date.now() - started;
    }
    return this.takeMessages();
  }

  async close() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.flushTimer = this.pollTimer = null;
    this.question?.resolve(null);
    this.messageWaiter?.resolve();
    await this.flush();
  }

  /** Lê as entradas da equipa: respostas à pergunta ativa e mensagens de seguimento. */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const input of await this.store.claimInputs(this.runId)) {
        if (input.kind === 'answer') {
          if (this.question && input.questionId === this.question.questionId)
            this.question.resolve(input.text);
        } else {
          this.messages.push(input.text);
          this.messageWaiter?.resolve();
        }
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.polling = false;
    }
  }
}
