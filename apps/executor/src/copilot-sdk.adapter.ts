import {
  CopilotClient,
  RuntimeConnection,
  type ExitPlanModeRequest,
  type ExitPlanModeResult,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type Tool,
  type ToolResultObject,
} from '@github/copilot-sdk';
import { isAbsolute } from 'node:path';
import {
  AGENT_MODEL_AUTO,
  isFusionModel,
  type AgentModelOption,
  type AgentRoutingTier,
} from '../../../packages/contracts/src/index.js';
import {
  prepareWorkspace,
  readAgentReport,
  REPORT_FILE,
  reportInstruction,
  validateExecutionInput,
  validateShell,
} from './agent-report.js';
import type { CopilotAgent, CopilotExecuteInput } from './copilot.adapter.js';
import { CapabilityToolGuard, compileSessionCapabilities } from './capability-bundle.js';
import { agentEnvironment, type AgentIdentity } from './copilot-process.js';
import { PermissionPolicy, type PermissionRequestLike } from './permission-policy.js';
import {
  clip,
  createRedactor,
  mapQuota,
  mapSessionEvent,
  type SessionEventLike,
} from './session-event-mapper.js';

type UserInputHandler = NonNullable<SessionConfig['onUserInputRequest']>;
type UserInputRequest = Parameters<UserInputHandler>[0];
type UserInputResponse = Awaited<ReturnType<UserInputHandler>>;

/** Sessão do SDK reduzida ao que o adapter usa (permite testar sem o runtime real). */
export interface AgentSession {
  on(handler: (event: SessionEventLike) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface AgentClient {
  start(): Promise<void>;
  createSession(config: SessionConfig): Promise<AgentSession>;
  stop(): Promise<unknown>;
  /** Modelos disponíveis na conta (catálogo do chat da equipa). */
  listModels?(): Promise<ModelInfoLike[]>;
  /** RPC do servidor do SDK para catálogo e quota (experimental). */
  rpc?: {
    account?: { getQuota?(params: object): Promise<unknown> };
    models?: { list(params: object): Promise<AgentModelList> };
  };
}

export interface AgentModelList {
  models: ModelInfoLike[];
  auto?: {
    tiers: {
      id: string;
      displayName: string;
      description: string;
      fusionTier?: string;
      status: { enabled: boolean; pickerVisible?: boolean; reason?: string; message?: string };
      billing?: { promo?: AgentRoutingTier['promo'] };
    }[];
  };
}

export function toRoutingTiers(catalog: AgentModelList): AgentRoutingTier[] {
  return (catalog.auto?.tiers ?? []).map((tier) => ({
    id: tier.id,
    name: tier.displayName,
    description: tier.description,
    fusionTier:
      tier.fusionTier === 'standard' || tier.fusionTier === 'high' || tier.fusionTier === 'max'
        ? tier.fusionTier
        : null,
    enabled: tier.status.enabled,
    visible: tier.status.pickerVisible !== false,
    reason: tier.status.message ?? tier.status.reason ?? null,
    ...(tier.billing?.promo ? { promo: tier.billing.promo } : {}),
  }));
}

export class FusionUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Fusion indisponível ou recusado. Escolha explicitamente outro modelo.', options);
    this.name = 'FusionUnavailableError';
  }
}

/** Campos do `ModelInfo` do SDK usados no catálogo (todos opcionais para tolerar versões). */
export interface ModelInfoLike {
  id: string;
  name?: string;
  billing?: { multiplier?: number };
  policy?: { state?: string };
  capabilities?: { supports?: { reasoningEffort?: boolean } };
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

/** Converte a lista do SDK nas opções do chat: sem modelos desativados, Fusion primeiro. */
export function toModelOptions(models: ModelInfoLike[]): AgentModelOption[] {
  return models
    .filter((model) => typeof model.id === 'string' && model.id && model.id !== AGENT_MODEL_AUTO)
    .filter((model) => model.policy?.state !== 'disabled')
    .map((model) => {
      const supportsEffort = model.capabilities?.supports?.reasoningEffort !== false;
      const efforts = supportsEffort
        ? (model.supportedReasoningEfforts ?? []).filter((item) => typeof item === 'string')
        : [];
      const multiplier = model.billing?.multiplier;
      return {
        id: model.id.slice(0, 100),
        name: (model.name || model.id).slice(0, 120),
        multiplier:
          typeof multiplier === 'number' && Number.isFinite(multiplier) ? multiplier : null,
        efforts,
        defaultEffort: efforts.length ? (model.defaultReasoningEffort ?? null) : null,
        fusion: isFusionModel(model.id),
      };
    })
    .sort((a, b) => Number(b.fusion) - Number(a.fusion) || a.name.localeCompare(b.name, 'en'));
}

export type AgentClientFactory = (options: {
  env: Record<string, string>;
  gitHubToken?: string;
  workingDirectory: string;
}) => AgentClient;

export interface CopilotSdkOptions {
  /** Executável do runtime (ex.: wrapper que baixa para o uid do agente); omisso usa o embutido. */
  cliPath?: string;
  baseEnv?: NodeJS.ProcessEnv;
  identity?: AgentIdentity;
  /** Espera por mensagens de seguimento depois de o agente ficar parado. */
  followUpWindowMs?: number;
}

const NO_ANSWER =
  'A equipa não respondeu. Continue com a melhor suposição e indique-a claramente no relatório.';

/** Cria clientes reais do SDK, ligados por stdio a um runtime com o ambiente controlado. */
export function sdkClientFactory(cliPath?: string): AgentClientFactory {
  return ({ env, gitHubToken, workingDirectory }) =>
    new CopilotClient({
      connection: RuntimeConnection.forStdio({ ...(cliPath ? { path: cliPath } : {}), env }),
      workingDirectory,
      logLevel: 'error',
      ...(gitHubToken ? { gitHubToken, useLoggedInUser: false } : {}),
    }) as unknown as AgentClient;
}

/**
 * Copilot interativo através do `@github/copilot-sdk`: o texto e as ferramentas (incluindo MCP)
 * são publicados na conversa do run, as perguntas (`ask_user` e aprovação de plano) esperam pela
 * equipa e as mensagens de seguimento continuam a mesma sessão. As permissões seguem a
 * `PermissionPolicy` e o relatório final é o mesmo do modo não interativo.
 */
export class CopilotSdkAdapter implements CopilotAgent {
  constructor(
    private readonly factory: AgentClientFactory,
    private readonly options: CopilotSdkOptions = {},
  ) {}

  async execute(input: CopilotExecuteInput) {
    validateExecutionInput(input);
    const { root, resultPath } = await prepareWorkspace(input.workspace);
    const shell = validateShell(input.shell);
    const readOnly = input.readOnlyDirectories ?? [];
    if (readOnly.some((directory) => !isAbsolute(directory)))
      throw new Error('Diretorio adicional invalido.');
    const conversation = input.conversation;
    const capabilities = input.capabilities
      ? compileSessionCapabilities(input.capabilities, shell?.tool ?? null)
      : null;
    const guard = new CapabilityToolGuard(
      input.capabilities?.manifest ?? null,
      input.isActive ?? (() => true),
    );
    const policy = new PermissionPolicy({
      root,
      mode: input.mode,
      readOnlyDirectories: readOnly,
      shell,
      ...(input.isActive ? { isActive: input.isActive } : {}),
      ...(input.tools?.length ? { customTools: input.tools.map((tool) => tool.name) } : {}),
    });
    const isActive = input.isActive ?? (() => true);
    const customTools = (input.tools ?? []).map((tool): Tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      defer: 'never',
      handler: async (args, invocation): Promise<ToolResultObject> => {
        if (!isActive())
          return {
            textResultForLlm:
              'Tentativa sem posse (cancelada ou expirada). Termina sem mais alterações.',
            resultType: 'denied',
          };
        try {
          const result = await tool.handler(args, { toolCallId: invocation.toolCallId });
          return {
            textResultForLlm: result.text,
            resultType: result.ok ? 'success' : 'failure',
            ...(result.ok ? {} : { error: clip(result.text, 300) }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'erro';
          return {
            textResultForLlm: `Falha interna da ferramenta: ${clip(message, 200)}. Não houve alterações.`,
            resultType: 'failure',
            error: clip(message, 300),
          };
        }
      },
    }));
    const runEnv = input.env ?? {};
    const redact = createRedactor(Object.values(runEnv));
    const identity = input.identity ?? this.options.identity;
    const identityEnv: Record<string, string> = identity
      ? {
          ZEROOPS_AGENT_UID: String(identity.uid),
          ZEROOPS_AGENT_GID: String(identity.gid),
        }
      : {};
    const env = agentEnvironment(this.options.baseEnv ?? process.env, identity, {
      ...runEnv,
      ...identityEnv,
    });
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();
    let outputBytes = 0;
    const watchdog = setInterval(() => {
      const waited = conversation?.waitedMs ?? 0;
      if (Date.now() - started - waited > input.timeoutMs) stop.abort();
    }, 1000);

    const client = this.factory({
      env,
      ...(runEnv.COPILOT_GITHUB_TOKEN ? { gitHubToken: runEnv.COPILOT_GITHUB_TOKEN } : {}),
      workingDirectory: root,
    });
    try {
      await client.start();
      const publishQuota = async () => {
        if (!conversation) return;
        try {
          const getQuota = client.rpc?.account?.getQuota;
          if (!getQuota) return;
          const quota = mapQuota(await getQuota.call(client.rpc?.account, {}));
          if (quota) conversation.publish(quota);
        } catch {
          // A quota é informativa: uma falha não deve afetar a investigação.
        }
      };
      await publishQuota();
      const fusion = runEnv.COPILOT_MODEL === 'fusion';
      let autoTier: string | undefined;
      if (fusion) {
        if (!client.rpc?.models) throw new FusionUnavailableError();
        const catalog = await client.rpc.models.list({}).catch((error: unknown) => {
          throw new FusionUnavailableError({ cause: error });
        });
        autoTier = toRoutingTiers(catalog).find(
          (tier) => tier.enabled && tier.visible && tier.fusionTier === runEnv.COPILOT_FUSION_TIER,
        )?.id;
        if (!autoTier) throw new FusionUnavailableError();
      }
      const sessionConfig = {
        ...(runEnv.COPILOT_MODEL
          ? { model: fusion ? AGENT_MODEL_AUTO : runEnv.COPILOT_MODEL }
          : {}),
        ...(autoTier ? { autoTier } : {}),
        ...(!fusion && runEnv.COPILOT_REASONING_EFFORT
          ? { reasoningEffort: runEnv.COPILOT_REASONING_EFFORT }
          : {}),
        workingDirectory: root,
        additionalDirectories: readOnly,
        availableTools: [
          'view',
          'grep',
          'glob',
          'create',
          'edit',
          // Os modelos GPT editam com `apply_patch`; sem ele não conseguem gravar o relatório.
          'apply_patch',
          'ask_user',
          'exit_plan_mode',
          'report_intent',
          ...(shell ? [shell.tool] : []),
          ...(capabilities?.tools ?? []),
          ...customTools.map((tool) => tool.name),
        ],
        ...(customTools.length ? { tools: customTools } : {}),
        ...(capabilities
          ? {
              ...capabilities.config,
              hooks: {
                // Sem posse, fora do conjunto fixado ou acima do limite: recusado. Nunca aprova; a
                // decisão final das restantes chamadas continua na PermissionPolicy.
                onPreToolUse: (hook: {
                  toolName: string;
                  toolArgs: unknown;
                  toolCallId?: string;
                }) => {
                  const denied = guard.check(hook);
                  if (denied)
                    conversation?.publish({
                      type: 'permission',
                      kind: hook.toolName,
                      decision: 'denied',
                      detail: clip(denied.permissionDecisionReason, 300),
                      ...(hook.toolCallId ? { toolCallId: hook.toolCallId } : {}),
                    });
                  return denied;
                },
              },
            }
          : {}),
        streaming: true,
        onPermissionRequest: (request: PermissionRequest): PermissionRequestResult => {
          const decision = policy.decide(request as unknown as PermissionRequestLike);
          const toolCallId = (request as { toolCallId?: unknown }).toolCallId;
          if (!decision.approved || request.kind === 'shell' || request.kind === 'mcp')
            conversation?.publish({
              type: 'permission',
              kind: request.kind,
              decision: decision.approved ? 'approved' : 'denied',
              detail: clip(redact(decision.detail), 300),
              ...(typeof toolCallId === 'string' && toolCallId ? { toolCallId } : {}),
            });
          return decision.approved
            ? { kind: 'approve-once' }
            : { kind: 'reject', feedback: decision.detail };
        },
        onUserInputRequest: async (request: UserInputRequest): Promise<UserInputResponse> => {
          const choices = request.choices ?? [];
          const answer = conversation
            ? await conversation.ask(
                {
                  kind: 'ask_user',
                  question: clip(redact(request.question), 4000),
                  choices,
                  allowFreeform: request.allowFreeform ?? true,
                },
                stop.signal,
              )
            : null;
          return answer === null
            ? { answer: NO_ANSWER, wasFreeform: true }
            : { answer, wasFreeform: !choices.includes(answer) };
        },
        onExitPlanModeRequest: async (
          request: ExitPlanModeRequest,
        ): Promise<ExitPlanModeResult> => {
          const plan = [request.summary, request.planContent].filter(Boolean).join('\n\n');
          if (input.planApproval === 'auto' && request.recommendedAction) {
            conversation?.publish({
              type: 'status',
              text: `Plano aprovado automaticamente (${request.recommendedAction}); ferramentas limitadas pela política do run.`,
            });
            return { approved: true, selectedAction: request.recommendedAction };
          }
          const answer = conversation
            ? await conversation.ask(
                {
                  kind: 'plan',
                  question: clip(redact(plan), 8000),
                  choices: request.actions,
                  allowFreeform: true,
                },
                stop.signal,
              )
            : null;
          // Sem resposta (timeout, cancelamento ou sem conversa) não há aprovação humana.
          if (answer === null)
            return {
              approved: false,
              feedback:
                'Sem aprovação humana do plano. Continua sem executar o plano e conclui o relatório com o que foi apurado.',
            };
          return request.actions.includes(answer)
            ? { approved: true, selectedAction: answer }
            : { approved: false, feedback: answer };
        },
      } as SessionConfig;
      const session = await client.createSession(sessionConfig).catch(async (error: unknown) => {
        // Se o runtime não aceitar `auto`, usa o modelo por omissão da conta.
        if (fusion) throw new FusionUnavailableError({ cause: error });
        if (sessionConfig.model !== AGENT_MODEL_AUTO) throw error;
        const fallback = { ...sessionConfig };
        delete fallback.model;
        return client.createSession(fallback);
      });

      let idle: (() => void) | null = null;
      let failure = null as string | null;
      const off = session.on((event) => {
        if (event.type === 'session.idle') idle?.();
        if (
          event.type === 'subagent.completed' ||
          event.type === 'subagent.failed' ||
          event.type === 'tool.execution_complete'
        ) {
          const toolCallId = (event.data as { toolCallId?: unknown } | undefined)?.toolCallId;
          guard.release(typeof toolCallId === 'string' ? toolCallId : undefined);
        }
        const payload = mapSessionEvent(event, redact);
        if (!payload) return;
        if (payload.type === 'error') failure = payload.message;
        if ('text' in payload) {
          outputBytes += Buffer.byteLength(payload.text);
          if (outputBytes > input.outputLimitBytes) stop.abort();
        }
        conversation?.publish(payload);
      });
      const turn = async (prompt: string) => {
        const done = new Promise<void>((resolve) => {
          idle = resolve;
        });
        const aborted = new Promise<never>((_resolve, reject) => {
          const fail = () => reject(new Error('Copilot interrompido; requer reconciliacao.'));
          if (stop.signal.aborted) fail();
          else stop.signal.addEventListener('abort', fail, { once: true });
        });
        aborted.catch(() => undefined);
        await Promise.race([session.send({ prompt }).then(() => done), aborted]);
        await Promise.race([done, aborted]);
        idle = null;
        await publishQuota();
      };

      try {
        conversation?.publish({ type: 'status', text: 'Copilot a investigar' });
        await turn(input.prompt + reportInstruction(input.mode, shell, input.gitWorkspace));
        while (conversation && !stop.signal.aborted) {
          await conversation.flush();
          const messages = conversation.takeMessages();
          const next = messages.length
            ? messages
            : await conversation.waitForMessages(this.options.followUpWindowMs ?? 0, stop.signal);
          if (!next.length) break;
          await turn(
            `${next.join('\n\n')}\n\nSe a conclusao mudar, atualize ${REPORT_FILE} no mesmo formato.`,
          );
        }
      } catch (error) {
        await session.abort().catch(() => undefined);
        throw error;
      } finally {
        off();
        await session.disconnect().catch(() => undefined);
      }
      if (stop.signal.aborted) throw new Error('Copilot interrompido; requer reconciliacao.');
      try {
        return await readAgentReport(root, resultPath, input.mode, {
          gitWorkspace: input.gitWorkspace,
        });
      } catch (error) {
        if (failure) throw new Error(`Copilot falhou: ${failure}`, { cause: error });
        throw error;
      }
    } finally {
      clearInterval(watchdog);
      input.signal?.removeEventListener('abort', onAbort);
      await client.stop().catch(() => undefined);
    }
  }
}
