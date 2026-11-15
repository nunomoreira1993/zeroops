import { chown, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ClaimedAssistantRequest,
  FlowAuthoringToolName,
} from '../../../packages/backend/src/modules/flows/flow-assistant.js';
import type {
  FencedOutcome,
  HeartbeatState,
  JobLease,
} from '../../../packages/backend/src/modules/agents/job-leases.js';
import type { AgentTool, CopilotAgent } from './copilot.adapter.js';
import {
  JobIdentityExhausted,
  ownerOf,
  type JobIdentity,
  type JobIdentitySource,
} from './job-sandbox.js';

/** Fila do assistente de fluxos (permite testar sem base de dados). */
export interface FlowAssistantQueuePort {
  claimNext(): Promise<ClaimedAssistantRequest | null>;
  heartbeat?(lease: JobLease): Promise<HeartbeatState>;
  complete(lease: JobLease, text: string): Promise<FencedOutcome | void>;
  fail(lease: JobLease, code: string): Promise<FencedOutcome | void>;
  release?(lease: JobLease, reason: string): Promise<FencedOutcome | void>;
  /** P06: chamada de uma ferramenta de autoria (fencada e autorizada no backend). */
  authoringTool?(
    lease: JobLease,
    name: string,
    toolCallId: string,
    args: unknown,
  ): Promise<{ ok: boolean; text: string; stop?: boolean }>;
}
export interface FlowAssistantRunnerOptions {
  workspaceRoot: string;
  timeoutMs: number;
  outputLimitBytes: number;
  copilotCredentials?: (projectId: string) => Promise<{ token: string; model?: string } | null>;
  workspaceOwner?: { uid: number; gid: number };
  /** F02: identidade exclusiva por pedido (pool de uids); sem pool usa `workspaceOwner`. */
  identities?: JobIdentitySource;
  /** Intervalo do heartbeat do lease (por omissão, um quarto da duração do lease). */
  heartbeatMs?: number;
}

const OUTPUT_RULE =
  '\n\nColoca o objeto JSON da tua resposta, como texto, no campo summary do relatório (files, proposedTests, clientQuestions e evidence vazios; replyDraft null).';

const OPERATION_ITEM = {
  type: 'object',
  description:
    'Operação parcial: add_node {node}, update_node {id,changes}, remove_node {id}, connect {source,port,target}, disconnect {source,port}, set_start {id}.',
  properties: {
    type: {
      type: 'string',
      enum: ['add_node', 'update_node', 'remove_node', 'connect', 'disconnect', 'set_start'],
    },
  },
  required: ['type'],
  additionalProperties: true,
};

/** Ferramentas de autoria (P06): os schemas orientam o modelo; a validação real é no backend. */
export const AUTHORING_TOOL_SPECS: {
  name: FlowAuthoringToolName;
  description: string;
  parameters: Record<string, unknown>;
}[] = [
  {
    name: 'flow_get_draft',
    description:
      'Lê o rascunho atual do fluxo (revisão, etapas, ligações, regras de seleção e propostas pendentes deste turno). Usa depois de um conflito.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flow_apply_operations',
    description:
      'Aplica (modo automático) ou propõe (modo assistido) um lote atómico e pequeno de operações ao rascunho. Lotes inválidos são rejeitados sem alterar nada.',
    parameters: {
      type: 'object',
      properties: {
        operations: { type: 'array', minItems: 1, maxItems: 20, items: OPERATION_ITEM },
        summary: { type: 'string', description: 'Resumo curto do lote, para o utilizador.' },
      },
      required: ['operations', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'flow_set_routing',
    description:
      'Altera as regras de seleção (match: origins/categories/environments/priorities) e/ou a política de encaminhamento do rascunho. Não altera prioridade, fluxo por omissão nem ativa nada.',
    parameters: {
      type: 'object',
      properties: {
        match: { type: 'object', additionalProperties: true },
        routingPolicy: { type: 'object', additionalProperties: true },
        summary: { type: 'string' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'flow_report_missing_capability',
    description:
      'Regista que o pedido exige uma ferramenta, integração, agente ou skill inexistente neste projeto. Não cria a capacidade.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tool', 'integration', 'agent', 'skill', 'other'] },
        capability: { type: 'string', description: 'Nome curto da capacidade em falta.' },
        reason: { type: 'string', description: 'Porque é necessária neste fluxo.' },
        nodeId: { type: 'string', description: 'Etapa afetada (opcional).' },
      },
      required: ['kind', 'capability', 'reason'],
      additionalProperties: false,
    },
  },
];

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

  /**
   * Processa no máximo um pedido; devolve false quando a fila está vazia. Renova o lease durante a
   * execução; sem posse, para sem escrever. `shutdown` devolve o pedido à fila.
   */
  async runOnce(shutdown?: AbortSignal): Promise<boolean> {
    if (shutdown?.aborted) return false;
    let identity: JobIdentity | null;
    try {
      identity = (await this.options.identities?.acquire()) ?? null;
    } catch (error) {
      if (error instanceof JobIdentityExhausted) return false;
      throw error;
    }
    const request = await this.queue.claimNext().catch(async (error: unknown) => {
      await identity?.release();
      throw error;
    });
    if (!request) {
      await identity?.release();
      return false;
    }
    const owner = identity ? ownerOf(identity) : this.options.workspaceOwner;
    const { lease } = request;
    const workspace = await mkdtemp(join(this.options.workspaceRoot, 'assistant-'));
    const abort = new AbortController();
    let leaseLost = false;
    let stopping = false;
    const onShutdown = () => {
      stopping = true;
      abort.abort();
    };
    shutdown?.addEventListener('abort', onShutdown, { once: true });
    const heartbeat = this.queue.heartbeat?.bind(this.queue);
    const timer = heartbeat
      ? setInterval(
          () =>
            void heartbeat(lease).then(
              (state) => {
                if (!state.owned) {
                  leaseLost = true;
                  abort.abort();
                }
              },
              () => undefined,
            ),
          this.options.heartbeatMs ?? Math.max(1000, (lease.leaseSeconds * 1000) / 4),
        )
      : null;
    try {
      let env: Record<string, string> | undefined;
      if (this.options.copilotCredentials) {
        const credentials = await this.options.copilotCredentials(request.projectId);
        if (!credentials?.token) {
          await this.queue.fail(lease, 'copilot_not_configured');
          return true;
        }
        env = {
          COPILOT_GITHUB_TOKEN: credentials.token,
          ...(credentials.model ? { COPILOT_MODEL: credentials.model } : {}),
        };
      }
      if (owner) await chown(workspace, owner.uid, owner.gid);
      const tools = request.authoring
        ? this.authoringTools(lease, () => {
            leaseLost = true;
            abort.abort();
          })
        : undefined;
      const report = await this.adapter.execute({
        workspace,
        mode: 'investigate',
        prompt: request.prompt + OUTPUT_RULE,
        timeoutMs: this.options.timeoutMs,
        outputLimitBytes: this.options.outputLimitBytes,
        readOnlyDirectories: [],
        signal: abort.signal,
        isActive: () => !abort.signal.aborted,
        ...(identity ? { identity } : {}),
        ...(env ? { env } : {}),
        ...(tools ? { tools } : {}),
      });
      if (abort.signal.aborted) throw new Error('Pedido interrompido.');
      const outcome = await this.queue.complete(lease, report.summary);
      this.log({
        event: outcome === 'stale' ? 'flow_assistant.stale_rejected' : 'flow_assistant.succeeded',
        requestId: request.id,
        scope: request.scope,
      });
    } catch (error) {
      if (leaseLost) this.log({ event: 'flow_assistant.lease_lost', requestId: request.id });
      else if (stopping && this.queue.release) {
        await this.queue.release(lease, 'shutdown');
        this.log({ event: 'flow_assistant.released', requestId: request.id });
      } else {
        await this.queue.fail(lease, 'agent_failed');
        this.log({
          event: 'flow_assistant.failed',
          requestId: request.id,
          type: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message.slice(0, 300) : undefined,
        });
      }
    } finally {
      if (timer) clearInterval(timer);
      shutdown?.removeEventListener('abort', onShutdown);
      await rm(workspace, { recursive: true, force: true });
      await identity?.release().catch((error: unknown) =>
        this.log({
          event: 'flow_assistant.identity_release_failed',
          requestId: request.id,
          message: error instanceof Error ? error.message.slice(0, 300) : undefined,
        }),
      );
    }
    return true;
  }

  /**
   * Ferramentas de autoria ligadas à posse deste pedido. Uma resposta que indique perda de posse
   * (cancelamento, lease expirado, permissão revogada) aborta a sessão sem mais escritas.
   */
  private authoringTools(lease: JobLease, onStop: () => void): AgentTool[] {
    const call = this.queue.authoringTool?.bind(this.queue);
    if (!call) throw new Error('Fila sem ferramentas de autoria.');
    return AUTHORING_TOOL_SPECS.map((spec) => ({
      ...spec,
      handler: async (args, context) => {
        const result = await call(lease, spec.name, context.toolCallId, args);
        if (result.stop) onStop();
        return result;
      },
    }));
  }
}
