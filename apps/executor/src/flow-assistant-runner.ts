import { chown, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaimedAssistantRequest } from '../../../packages/backend/src/modules/flows/flow-assistant.js';
import type { CopilotAgent } from './copilot.adapter.js';

/** Fila do assistente de fluxos (permite testar sem base de dados). */
export interface FlowAssistantQueuePort {
  claimNext(): Promise<ClaimedAssistantRequest | null>;
  complete(requestId: string, text: string): Promise<void>;
  fail(requestId: string, code: string): Promise<void>;
}

export interface FlowAssistantRunnerOptions {
  workspaceRoot: string;
  timeoutMs: number;
  outputLimitBytes: number;
  copilotCredentials?: (projectId: string) => Promise<{ token: string; model?: string } | null>;
  workspaceOwner?: { uid: number; gid: number };
}

const OUTPUT_RULE =
  '\n\nColoca o objeto JSON da tua resposta, como texto, no campo summary do relatório (files, proposedTests, clientQuestions e evidence vazios; replyDraft null).';

/**
 * Assistente de fluxos/tickets: corre o Copilot em modo de leitura sem pastas, conectores nem
 * shell (todo o contexto vem no prompt) e devolve o texto da resposta para validação no backend.
 */
export class FlowAssistantRunner {
  constructor(
    private readonly queue: FlowAssistantQueuePort,
    private readonly adapter: CopilotAgent,
    private readonly options: FlowAssistantRunnerOptions,
    private readonly log: (event: Record<string, unknown>) => void = (event) =>
      console.info(JSON.stringify(event)),
  ) {}

  /** Processa no máximo um pedido; devolve false quando a fila está vazia. */
  async runOnce(): Promise<boolean> {
    const request = await this.queue.claimNext();
    if (!request) return false;
    const workspace = await mkdtemp(join(this.options.workspaceRoot, 'assistant-'));
    try {
      let env: Record<string, string> | undefined;
      if (this.options.copilotCredentials) {
        const credentials = await this.options.copilotCredentials(request.projectId);
        if (!credentials?.token) {
          await this.queue.fail(request.id, 'copilot_not_configured');
          return true;
        }
        env = {
          COPILOT_GITHUB_TOKEN: credentials.token,
          ...(credentials.model ? { COPILOT_MODEL: credentials.model } : {}),
        };
      }
      if (this.options.workspaceOwner)
        await chown(workspace, this.options.workspaceOwner.uid, this.options.workspaceOwner.gid);
      const report = await this.adapter.execute({
        workspace,
        mode: 'investigate',
        prompt: request.prompt + OUTPUT_RULE,
        timeoutMs: this.options.timeoutMs,
        outputLimitBytes: this.options.outputLimitBytes,
        readOnlyDirectories: [],
        ...(env ? { env } : {}),
      });
      await this.queue.complete(request.id, report.summary);
      this.log({ event: 'flow_assistant.succeeded', requestId: request.id, scope: request.scope });
    } catch (error) {
      await this.queue.fail(request.id, 'agent_failed');
      this.log({
        event: 'flow_assistant.failed',
        requestId: request.id,
        type: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message.slice(0, 300) : undefined,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
    return true;
  }
}
