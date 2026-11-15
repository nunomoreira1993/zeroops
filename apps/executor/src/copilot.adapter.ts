import { isAbsolute } from 'node:path';
import type { AgentIdentity } from './copilot-process.js';
import type { AgentRunConversation } from './run-conversation.js';
import type { CompiledCapabilities } from './capability-bundle.js';
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
    /** F02: identidade exclusiva do job (sobrepõe a identidade fixa do processo). */
    identity?: AgentIdentity;
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
  /**
   * Posse atual da tentativa (atualizada pelo heartbeat). Quando devolve false, todos os pedidos de
   * permissão são negados: uma tentativa sem lease não produz novos efeitos.
   */
  isActive?: () => boolean;
  /**
   * Aprovação do plano (`exit_plan_mode`): `auto` aprova a ação recomendada sem perguntar (as
   * ferramentas continuam limitadas pela política); `human` pergunta à equipa e, sem resposta,
   * rejeita — a ausência de resposta nunca é aprovação. Por omissão `human`.
   */
  planApproval?: 'auto' | 'human';
  /**
   * Agente, skills e especialistas fixados no run (P04), já materializados e verificados. Só o
   * adaptador SDK os suporta; o CLI recusa o run em vez de os ignorar.
   */
  capabilities?: CompiledCapabilities;
  /**
   * Ferramentas próprias do ZeroOps expostas ao modelo (P06: autoria de fluxos). O handler corre no
   * executor e delega no backend, que valida, autoriza e fenca cada chamada. Só no SDK.
   */
  tools?: AgentTool[];
  /**
   * Checkout Git do ZeroOps (P08): o diff e os ficheiros vêm do Git, por isso a lista de ficheiros
   * do relatório é ignorada e o relatório não entra no commit.
   */
  gitWorkspace?: boolean;
  /** F02: identidade exclusiva do job; sem ela usa a identidade fixa do adaptador. */
  identity?: AgentIdentity;
}

/** Ferramenta própria registada na sessão Copilot. */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema dos argumentos (a validação definitiva é feita no backend). */
  parameters: Record<string, unknown>;
  handler(args: unknown, context: { toolCallId: string }): Promise<{ ok: boolean; text: string }>;
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
    if (input.capabilities)
      throw new Error('Skills e especialistas exigem o transporte SDK do Copilot (não o CLI).');
    if (input.tools?.length)
      throw new Error('Ferramentas de autoria exigem o transporte SDK do Copilot (não o CLI).');
    const { root, resultPath } = await prepareWorkspace(input.workspace);
    const shell = validateShell(input.shell);
    const args = [
      '--no-ask-user',
      '--output-format=json',
      ...(input.env?.COPILOT_MODEL ? ['--model', input.env.COPILOT_MODEL] : []),
      ...(input.env?.COPILOT_MODEL === 'fusion' && input.env.COPILOT_FUSION_TIER
        ? ['--fusion-tier', input.env.COPILOT_FUSION_TIER]
        : []),
      // `create`/`apply_patch` (modelos GPT) gravam o relatório; a escrita fica limitada por --allow-tool=write(...).
      `--available-tools=${['view', 'grep', 'glob', 'create', 'edit', 'apply_patch', ...(shell ? [shell.tool] : [])].join(',')}`,
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
      stdin: input.prompt + reportInstruction(input.mode, shell, input.gitWorkspace),
      timeoutMs: input.timeoutMs,
      outputLimitBytes: input.outputLimitBytes,
      signal: input.signal,
      env: input.env,
      ...(input.identity ? { identity: input.identity } : {}),
    });
    if (processResult.interrupted || processResult.exitCode !== 0)
      throw new Error('Copilot interrompido ou com falha; requer reconciliacao.');
    return readAgentReport(root, resultPath, input.mode, { gitWorkspace: input.gitWorkspace });
  }
}
