import { chown, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isSiteKey, siteProfiles } from '../../../packages/contracts/src/index.js';
import type {
  InvestigationContext,
  InvestigationResult,
} from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import type { AgentCommand } from './agent-commands.js';
import type { CopilotAgent } from './copilot.adapter.js';
import type { AgentRunConversation } from './run-conversation.js';
import { investigationPrompt } from './investigation-prompt.js';
import { FusionUnavailableError } from './copilot-sdk.adapter.js';
import { unifiedDiff } from './unified-diff.js';

/** Tamanho máximo da proposta de alteração guardada no run. */
const PATCH_LIMIT = 400_000;

/** Operações do serviço de runs usadas pelo executor (permite testar sem base de dados). */
export interface AgentRunQueue {
  claimNext(): Promise<InvestigationContext | null>;
  reportProgress(runId: string, progress: string): Promise<void>;
  recordEffectiveTools?(runId: string, tools: string[]): Promise<void>;
  isCancelRequested(runId: string): Promise<boolean>;
  complete(runId: string, result: InvestigationResult): Promise<void>;
  fail(runId: string, errorCode: string): Promise<void>;
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
  /** Conversa ao vivo do run (streaming, perguntas e mensagens da equipa). */
  conversation?: (runId: string) => AgentRunConversation;
}

export class InvestigationRunner {
  constructor(
    private readonly queue: AgentRunQueue,
    private readonly adapter: CopilotAgent,
    private readonly options: InvestigationRunnerOptions,
    private readonly log: (event: Record<string, unknown>) => void = (event) =>
      console.info(JSON.stringify(event)),
  ) {}

  /** Processa no máximo um run; devolve false quando a fila está vazia. */
  async runOnce(): Promise<boolean> {
    const context = await this.queue.claimNext();
    if (!context) return false;
    const { runId } = context;
    const workspace = await mkdtemp(join(this.options.workspaceRoot, 'run-'));
    const abort = new AbortController();
    const watcher = setInterval(() => {
      void this.queue.isCancelRequested(runId).then(
        (cancel) => {
          if (cancel) abort.abort();
        },
        () => undefined,
      );
    }, this.options.cancelPollMs);
    let failureCode: string | null = null;
    const conversation = this.options.conversation?.(runId);
    conversation?.start();
    try {
      this.log({ event: 'agent.run_started', runId });
      const credentials = await this.copilotEnv(context);
      if (!credentials) {
        failureCode = 'copilot_not_configured';
        throw new Error('Integração Copilot não verificada para o projeto.');
      }
      if (this.options.workspaceOwner)
        await chown(workspace, this.options.workspaceOwner.uid, this.options.workspaceOwner.gid);
      const connectors = this.options.connectors;
      const discovered = connectors ? await connectors.discover(context.connectorToken) : [];
      const allowedTools = context.allowedTools;
      const commands = allowedTools
        ? discovered.filter((command) => allowedTools.includes(command.tool))
        : discovered;
      await this.queue.recordEffectiveTools?.(runId, [
        'view',
        'grep',
        'glob',
        ...(commands.length ? commands.map((command) => command.tool) : []),
      ]);
      const implement = context.mode === 'implement';
      await this.queue.reportProgress(
        runId,
        implement ? 'Copilot a preparar a alteração' : 'Copilot a investigar',
      );
      const connectorEnv: Record<string, string> =
        connectors && commands.length
          ? { ZEROOPS_CONNECTOR_URL: connectors.url, ZEROOPS_RUN_TOKEN: context.connectorToken }
          : {};
      const env = { ...credentials, ...connectorEnv };
      const site = await this.siteSources(context.project?.siteKey ?? null);
      const report = await this.adapter.execute({
        workspace,
        mode: implement ? 'implement' : 'investigate',
        prompt: investigationPrompt(context, site.sources, commands),
        timeoutMs: this.options.timeoutMs,
        outputLimitBytes: this.options.outputLimitBytes,
        readOnlyDirectories: site.readOnlyDirectories,
        signal: abort.signal,
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
      const patch = implement
        ? await this.patch(workspace, site.readOnlyDirectories, report.files)
        : null;
      conversation?.publish({
        type: 'status',
        text: implement ? 'Proposta de alteração concluída' : 'Investigação concluída',
      });
      await conversation?.close();
      await this.queue.complete(runId, {
        summary: report.summary,
        replyDraft: report.replyDraft,
        evidence: report.evidence,
        clientQuestions: report.clientQuestions,
        ...(implement ? { patch, proposedTests: report.proposedTests } : {}),
      });
      this.log({ event: 'agent.run_succeeded', runId });
    } catch (error) {
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
      await this.queue.fail(runId, code);
      this.log({
        event: 'agent.run_failed',
        runId,
        code,
        type: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message.slice(0, 300) : undefined,
      });
    } finally {
      clearInterval(watcher);
      await conversation?.close();
      await rm(workspace, { recursive: true, force: true });
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
