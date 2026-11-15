import { chown, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isSiteKey, siteProfiles } from '../../../packages/contracts/src/index.js';
import type {
  InvestigationContext,
  InvestigationResult,
} from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import type {
  FencedOutcome,
  HeartbeatState,
  JobLease,
} from '../../../packages/backend/src/modules/agents/job-leases.js';
import type { AgentCommand } from './agent-commands.js';
import type { CopilotAgent } from './copilot.adapter.js';
import type { AgentRunConversation } from './run-conversation.js';
import { investigationPrompt } from './investigation-prompt.js';
import {
  JobIdentityExhausted,
  ownerOf,
  type JobIdentity,
  type JobIdentitySource,
} from './job-sandbox.js';
import { FusionUnavailableError } from './copilot-sdk.adapter.js';
import { unifiedDiff } from './unified-diff.js';
import {
  CapabilityIntegrityError,
  materializeCapabilities,
  type CompiledCapabilities,
} from './capability-bundle.js';
import {
  DevelopmentFailure,
  DevelopmentStale,
  type DevelopmentRunner,
  type PreparedDevelopment,
} from './development-runner.js';

/** Tamanho máximo da proposta de alteração guardada no run. */
const PATCH_LIMIT = 400_000;

/** Operações do serviço de runs usadas pelo executor (permite testar sem base de dados). */
export interface AgentRunQueue {
  /** Reclama a próxima tentativa para este executor (o worker e os limites são do adaptador). */
  claimNext(): Promise<InvestigationContext | null>;
  /** Renova o lease; sem posse, o runner para sem novos efeitos. */
  heartbeat?(lease: JobLease): Promise<HeartbeatState>;
  reportProgress(lease: JobLease, progress: string): Promise<unknown>;
  recordEffectiveTools?(lease: JobLease, tools: string[]): Promise<unknown>;
  isCancelRequested(runId: string): Promise<boolean>;
  complete(lease: JobLease, result: InvestigationResult): Promise<FencedOutcome | void>;
  fail(lease: JobLease, errorCode: string): Promise<FencedOutcome | void>;
  /** Devolve a tentativa à fila (paragem ordenada do executor). */
  release?(lease: JobLease, reason: string): Promise<FencedOutcome | void>;
}

export interface InvestigationRunnerOptions {
  workspaceRoot: string;
  readOnlyDirectories: string[];
  sources: string[];
  /**
   * Pasta com o código de cada site (`<raiz>/<siteKey>`, só leitura). Quando existe a pasta do site
   * do projeto, substitui `readOnlyDirectories`/`sources` nesse run.
   */
  siteSourcesRoot?: string;
  timeoutMs: number;
  outputLimitBytes: number;
  cancelPollMs: number;
  /** Intervalo do heartbeat do lease (por omissão, um quarto da duração do lease). */
  heartbeatMs?: number;
  /** Conectores de leitura: URL interno e descoberta dos comandos disponíveis para o run. */
  connectors?: {
    url: string;
    shellTool: string;
    discover: (runToken: string) => Promise<AgentCommand[]>;
  };
  /**
   * Credencial do Copilot para o projeto do ticket (integração `copilot`). Quando definido e sem
   * credencial verificada, o run falha com `copilot_not_configured`.
   */
  copilotCredentials?: (projectId: string) => Promise<{ token: string; model?: string } | null>;
  /** Dono do workspace quando o Copilot corre com outro uid. */
  workspaceOwner?: { uid: number; gid: number };
  /** F02: identidade exclusiva por job (pool de uids); sem pool usa `workspaceOwner`. */
  identities?: JobIdentitySource;
  /** Conversa ao vivo do run (streaming, perguntas e mensagens da equipa). */
  conversation?: (runId: string, lease: JobLease) => AgentRunConversation;
  /** P08: desenvolvimento em checkout Git isolado (runs com `developmentWorkspaceId`). */
  development?: DevelopmentRunner;
}

export class InvestigationRunner {
  constructor(
    private readonly queue: AgentRunQueue,
    private readonly adapter: CopilotAgent,
    private readonly options: InvestigationRunnerOptions,
    private readonly log: (event: Record<string, unknown>) => void = (event) =>
      console.info(JSON.stringify(event)),
  ) {}

  /**
   * Processa no máximo um run; devolve false quando a fila está vazia. `shutdown` interrompe o run
   * em curso e devolve-o à fila (paragem ordenada) em vez de o falhar.
   */
  async runOnce(shutdown?: AbortSignal): Promise<boolean> {
    if (shutdown?.aborted) return false;
    // F02: a identidade é obtida antes de reclamar o run (sem uid livre o run fica na fila).
    let identity: JobIdentity | null;
    try {
      identity = (await this.options.identities?.acquire()) ?? null;
    } catch (error) {
      if (error instanceof JobIdentityExhausted) return false;
      throw error;
    }
    const context = await this.queue.claimNext().catch(async (error: unknown) => {
      await identity?.release();
      throw error;
    });
    if (!context) {
      await identity?.release();
      return false;
    }
    const owner = identity ? ownerOf(identity) : this.options.workspaceOwner;
    const { runId, lease } = context;
    let workspace: string;
    try {
      workspace = await mkdtemp(join(this.options.workspaceRoot, 'run-'));
    } catch (error) {
      this.log({
        event: 'agent.run_workspace_failed',
        runId,
        type: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message.slice(0, 300) : undefined,
      });
      try {
        await this.queue.fail(lease, 'workspace_unavailable');
      } finally {
        await identity?.release().catch((releaseError: unknown) =>
          this.log({
            event: 'agent.identity_release_failed',
            runId,
            message: releaseError instanceof Error ? releaseError.message.slice(0, 300) : undefined,
          }),
        );
      }
      return true;
    }
    const abort = new AbortController();
    let leaseLost = false;
    let stopping = false;
    const onShutdown = () => {
      stopping = true;
      abort.abort();
    };
    shutdown?.addEventListener('abort', onShutdown, { once: true });
    const heartbeatMs = this.options.heartbeatMs ?? Math.max(1000, (lease.leaseSeconds * 1000) / 4);
    let lastHeartbeat = Date.now();
    let checking = false;
    const watcher = setInterval(() => {
      if (checking || abort.signal.aborted) return;
      checking = true;
      const due = this.queue.heartbeat && Date.now() - lastHeartbeat >= heartbeatMs;
      const check = due
        ? this.queue.heartbeat!(lease).then((state) => {
            lastHeartbeat = Date.now();
            if (!state.owned) leaseLost = true;
            return !state.owned || state.cancelRequested;
          })
        : this.queue.isCancelRequested(runId);
      void check
        .then(
          (stop) => {
            if (stop) abort.abort();
          },
          () => undefined,
        )
        .finally(() => {
          checking = false;
        });
    }, this.options.cancelPollMs);
    let failureCode: string | null = null;
    let cleanupCapabilities: (() => Promise<void>) | null = null;
    let compiled: CompiledCapabilities | null = null;
    let development: PreparedDevelopment | null = null;
    let developmentFailed = true;
    const conversation = this.options.conversation?.(runId, lease);
    conversation?.start();
    try {
      this.log({ event: 'agent.run_started', runId, attempt: context.attempt, epoch: lease.epoch });
      const credentials = await this.copilotEnv(context);
      if (!credentials) {
        failureCode = 'copilot_not_configured';
        throw new Error('Integração Copilot não verificada para o projeto.');
      }
      if (owner) await chown(workspace, owner.uid, owner.gid);
      const connectors = this.options.connectors;
      const discovered = connectors ? await connectors.discover(context.connectorToken) : [];
      const allowedTools = context.allowedTools;
      const commands = allowedTools
        ? discovered.filter((command) => allowedTools.includes(command.tool))
        : discovered;
      await this.queue.recordEffectiveTools?.(lease, [
        'view',
        'grep',
        'glob',
        ...(commands.length ? commands.map((command) => command.tool) : []),
        ...(context.capabilities?.manifest.skills.length ? ['skill'] : []),
        ...(context.capabilities?.manifest.delegates.length ? ['task'] : []),
        ...(context.developmentWorkspaceId ? ['zeroops_run_tests'] : []),
      ]);
      const implement = context.mode === 'implement';
      await this.queue.reportProgress(
        lease,
        implement ? 'Copilot a preparar a alteração' : 'Copilot a investigar',
      );
      const connectorEnv: Record<string, string> =
        connectors && commands.length
          ? { ZEROOPS_CONNECTOR_URL: connectors.url, ZEROOPS_RUN_TOKEN: context.connectorToken }
          : {};
      const env = { ...credentials, ...connectorEnv };
      const site = await this.siteSources(context.project?.siteKey ?? null);
      if (context.developmentWorkspaceId) {
        if (!this.options.development) {
          failureCode = 'development_unavailable';
          throw new Error('Executor sem workspaces Git configurados.');
        }
        await this.queue.reportProgress(lease, 'A preparar o checkout Git isolado');
        development = await this.options.development.prepare(runId, lease, owner);
      }
      if (context.capabilities) {
        const materialized = await materializeCapabilities(
          this.options.workspaceRoot,
          context.capabilities,
          owner,
        ).catch((error: unknown) => {
          if (error instanceof CapabilityIntegrityError) failureCode = 'capability_integrity';
          throw error;
        });
        cleanupCapabilities = materialized.cleanup;
        compiled = materialized.compiled;
        this.log({
          event: 'agent.capabilities_materialized',
          runId,
          agent: compiled.manifest.agent.name,
          skills: compiled.manifest.skills.map((skill) => `${skill.name}@${skill.version}`),
          specialists: compiled.manifest.delegates.map((agent) => `${agent.name}@${agent.version}`),
        });
      }
      const siteDirectories = development ? [] : site.readOnlyDirectories;
      const readOnlyDirectories = compiled?.skillDirectory
        ? [...siteDirectories, compiled.skillDirectory]
        : siteDirectories;
      const isActive = () => !abort.signal.aborted;
      const report = await this.adapter.execute({
        workspace: development ? development.checkout.path : workspace,
        mode: implement ? 'implement' : 'investigate',
        prompt: investigationPrompt(
          context,
          development ? this.options.development!.promptSources(development) : site.sources,
          commands,
        ),
        timeoutMs: this.options.timeoutMs,
        outputLimitBytes: this.options.outputLimitBytes,
        readOnlyDirectories,
        ...(compiled ? { capabilities: compiled } : {}),
        signal: abort.signal,
        isActive,
        ...(identity ? { identity } : {}),
        ...(development
          ? {
              gitWorkspace: true,
              tools: [this.options.development!.testTool(development, lease, isActive)],
            }
          : {}),
        // As ferramentas já estão limitadas pela política efetiva do run: um plano não precisa de
        // nova aprovação humana. As perguntas `ask_user` continuam a ir para a equipa.
        planApproval: 'auto',
        ...(connectors && commands.length
          ? {
              shell: {
                tool: connectors.shellTool,
                commands: commands.map((command) => command.command),
              },
            }
          : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(conversation ? { conversation } : {}),
      });
      if (abort.signal.aborted) throw new Error('Run interrompido.');
      if (development) {
        await this.queue.reportProgress(lease, 'A fazer commit e a executar os testes finais');
        const outcome = await this.options.development!.finalize(development, lease, isActive);
        developmentFailed = false;
        if (!outcome.testsPassed) {
          failureCode = 'development_tests_failed';
          throw new Error('Os testes finais falharam.');
        }
        conversation?.publish({
          type: 'status',
          text: `Commit ${outcome.headSha.slice(0, 12)} testado (${outcome.files.length} ficheiros)`,
        });
        await conversation?.close();
        const result = await this.queue.complete(lease, {
          summary: report.summary,
          replyDraft: report.replyDraft,
          evidence: report.evidence,
          clientQuestions: report.clientQuestions,
          patch:
            outcome.diff.length > PATCH_LIMIT
              ? `${outcome.diff.slice(0, PATCH_LIMIT)}\n# (diff truncado)\n`
              : outcome.diff || null,
          proposedTests: report.proposedTests,
        });
        this.log({
          event: result === 'stale' ? 'agent.run_stale_rejected' : 'agent.run_succeeded',
          runId,
          epoch: lease.epoch,
          headSha: outcome.headSha,
          publications: outcome.publications,
        });
        return true;
      }
      const patch = implement
        ? await this.patch(workspace, site.readOnlyDirectories, report.files)
        : null;
      conversation?.publish({
        type: 'status',
        text: implement ? 'Proposta de alteração concluída' : 'Investigação concluída',
      });
      await conversation?.close();
      const outcome = await this.queue.complete(lease, {
        summary: report.summary,
        replyDraft: report.replyDraft,
        evidence: report.evidence,
        clientQuestions: report.clientQuestions,
        ...(implement ? { patch, proposedTests: report.proposedTests } : {}),
      });
      this.log({
        event: outcome === 'stale' ? 'agent.run_stale_rejected' : 'agent.run_succeeded',
        runId,
        epoch: lease.epoch,
      });
    } catch (error) {
      if (error instanceof DevelopmentStale) leaseLost = true;
      if (error instanceof DevelopmentFailure) failureCode = error.code;
      if (leaseLost) {
        // Outro executor detém (ou vai deter) a tentativa: nenhuma escrita desta tentativa.
        this.log({ event: 'agent.run_lease_lost', runId, epoch: lease.epoch });
      } else if (stopping && this.queue.release) {
        await conversation?.close();
        await this.queue.release(lease, 'shutdown');
        this.log({ event: 'agent.run_released', runId, epoch: lease.epoch });
      } else {
        const code = abort.signal.aborted
          ? 'cancelled'
          : error instanceof FusionUnavailableError
            ? 'fusion_unavailable'
            : (failureCode ?? 'agent_failed');
        conversation?.publish({
          type: 'status',
          text: code === 'cancelled' ? 'Investigação cancelada' : 'Investigação falhou',
        });
        await conversation?.close();
        await this.queue.fail(lease, code);
        this.log({
          event: 'agent.run_failed',
          runId,
          code,
          type: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message.slice(0, 300) : undefined,
        });
      }
    } finally {
      clearInterval(watcher);
      shutdown?.removeEventListener('abort', onShutdown);
      await conversation?.close();
      await cleanupCapabilities?.().catch(() => undefined);
      await this.options.development
        ?.release(development, lease, developmentFailed)
        .catch((error: unknown) =>
          this.log({
            event: 'agent.development_release_failed',
            runId,
            message: error instanceof Error ? error.message.slice(0, 300) : undefined,
          }),
        );
      await rm(workspace, { recursive: true, force: true }).catch((error: unknown) =>
        this.log({
          event: 'agent.run_workspace_cleanup_failed',
          runId,
          message: error instanceof Error ? error.message.slice(0, 300) : undefined,
        }),
      );
      // Termina processos que o job tenha deixado e apaga home, temporários e worktrees do uid;
      // sem limpeza confirmada o uid fica em quarentena no pool (não é reutilizado).
      await identity?.release().catch((error: unknown) =>
        this.log({
          event: 'agent.identity_release_failed',
          runId,
          message: error instanceof Error ? error.message.slice(0, 300) : undefined,
        }),
      );
    }
    return true;
  }

  /**
   * Proposta de alteração (diff unificado) dos ficheiros que o Copilot alterou no workspace,
   * comparados com o original no código do site (só leitura). Não é aplicada nem publicada.
   */
  private async patch(workspace: string, sources: string[], files: { path: string }[]) {
    const root = await realpath(workspace);
    const parts: string[] = [];
    for (const file of files) {
      const after = await readFile(join(root, file.path), 'utf8');
      let before: string | null = null;
      for (const directory of sources) {
        before = await readFile(join(directory, file.path), 'utf8').catch(() => null);
        if (before !== null) break;
      }
      parts.push(unifiedDiff(file.path, before, after));
    }
    const patch = parts.join('');
    return patch.length > PATCH_LIMIT
      ? `${patch.slice(0, PATCH_LIMIT)}\n# (diff truncado)\n`
      : patch || null;
  }

  /** Variáveis do Copilot para o processo do agente (vazias quando a credencial vem do ambiente). */
  /** Token da integração; o modelo e o esforço escolhidos no run têm prioridade sobre os da integração. */
  private async copilotEnv(
    context: Pick<InvestigationContext, 'projectId' | 'model' | 'reasoningEffort' | 'fusionTier'>,
  ): Promise<Record<string, string> | null> {
    const choice: Record<string, string> = {
      ...(context.model ? { COPILOT_MODEL: context.model } : {}),
      ...(context.reasoningEffort ? { COPILOT_REASONING_EFFORT: context.reasoningEffort } : {}),
      ...(context.fusionTier ? { COPILOT_FUSION_TIER: context.fusionTier } : {}),
    };
    if (!this.options.copilotCredentials) return choice;
    const credentials = await this.options.copilotCredentials(context.projectId);
    if (!credentials?.token) return null;
    return {
      COPILOT_GITHUB_TOKEN: credentials.token,
      ...(credentials.model ? { COPILOT_MODEL: credentials.model } : {}),
      ...choice,
    };
  }

  /** Código-fonte do site do projeto quando montado em `siteSourcesRoot`; senão, o configurado. */
  private async siteSources(siteKey: string | null) {
    const fallback = {
      readOnlyDirectories: this.options.readOnlyDirectories,
      sources: this.options.sources,
    };
    const root = this.options.siteSourcesRoot;
    if (!root || !siteKey || !isSiteKey(siteKey)) return fallback;
    const directory = join(root, siteKey);
    const available = await stat(directory).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (!available) return fallback;
    return {
      readOnlyDirectories: [directory],
      sources: [
        `Código-fonte do site ${siteProfiles[siteKey].label} (PHP, só leitura) em ${directory}. Os ficheiros de credenciais estão ocultos.`,
      ],
    };
  }
}
