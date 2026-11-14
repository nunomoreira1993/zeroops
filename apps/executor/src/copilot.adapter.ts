import { isAbsolute } from 'node:path';
import type { AgentRunConversation } from './run-conversation.js';
import {
  prepareWorkspace,
  readAgentReport,
  reportInstruction,
  validateExecutionInput,
  validateShell,
  type AgentMode,
  type AgentReport,
  type AgentShell,
} from './agent-report.js';

export interface SandboxProcess {
  run(input: {
    workspace: string;
    arguments: string[];
    stdin: string;
    timeoutMs: number;
    outputLimitBytes: number;
    signal?: AbortSignal;
    /** Variáveis adicionais apenas para este run (ex.: token dos conectores). */
    env?: Record<string, string>;
  }): Promise<{ exitCode: number; interrupted: boolean }>;
}

/** Contrato de uma execução do Copilot, comum ao CLI não interativo e ao SDK interativo. */
export interface CopilotExecuteInput {
  workspace: string;
  prompt: string;
  mode: AgentMode;
  timeoutMs: number;
  outputLimitBytes: number;
  signal?: AbortSignal;
  /** Diretorios adicionais so de leitura (ex.: checkout do site). */
  readOnlyDirectories?: string[];
  /** Comandos de shell permitidos (ex.: zo-sql); sem comandos, a shell fica negada. */
  shell?: AgentShell;
  env?: Record<string, string>;
  /** Conversa ao vivo com a equipa (streaming, perguntas e mensagens de seguimento). */
  conversation?: AgentRunConversation;
}

export interface CopilotAgent {
  execute(input: CopilotExecuteInput): Promise<AgentReport>;
}

const SECRET_ENV = 'COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN';

/** Copilot CLI em modo não interativo (`copilot -p`): sem streaming nem perguntas à equipa. */
export class CopilotCliAdapter implements CopilotAgent {
  constructor(private readonly sandbox: SandboxProcess) {}

  async execute(input: CopilotExecuteInput) {
    validateExecutionInput(input);
    const { root, resultPath } = await prepareWorkspace(input.workspace);
    const shell = validateShell(input.shell);
    const args = [
      '--no-ask-user',
      '--output-format=json',
      ...(input.env?.COPILOT_MODEL ? ['--model', input.env.COPILOT_MODEL] : []),
      ...(input.env?.COPILOT_MODEL === 'fusion' && input.env.COPILOT_FUSION_TIER
        ? ['--fusion-tier', input.env.COPILOT_FUSION_TIER]
        : []),
      // `create` is required for the report file; writes stay limited by --allow-tool=write(...).
      `--available-tools=${['view', 'grep', 'glob', 'create', 'edit', ...(shell ? [shell.tool] : [])].join(',')}`,
      ...(shell
        ? shell.commands.map((command) => `--allow-tool=shell(${command}:*)`)
        : ['--deny-tool=shell']),
      `--secret-env-vars=${SECRET_ENV}`,
      '--deny-url=*',
      '--allow-tool=read',
      input.mode === 'implement'
        ? '--allow-tool=write'
        : '--allow-tool=write(.zeroops-result.json)',
      ...(input.readOnlyDirectories ?? []).flatMap((directory) => {
        if (!isAbsolute(directory)) throw new Error('Diretorio adicional invalido.');
        return ['--add-dir', directory];
      }),
    ];
    const processResult = await this.sandbox.run({
      workspace: root,
      arguments: args,
      stdin: input.prompt + reportInstruction(input.mode, shell),
      timeoutMs: input.timeoutMs,
      outputLimitBytes: input.outputLimitBytes,
      signal: input.signal,
      env: input.env,
    });
    if (processResult.interrupted || processResult.exitCode !== 0)
      throw new Error('Copilot interrompido ou com falha; requer reconciliacao.');
    return readAgentReport(root, resultPath, input.mode);
  }
}
