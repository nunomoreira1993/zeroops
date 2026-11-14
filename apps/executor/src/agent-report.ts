import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export type AgentMode = 'investigate' | 'implement';

/** Comandos de shell permitidos ao agente (ex.: conectores `zo-sql`, `zo-loki`). */
export interface AgentShell {
  tool: string;
  commands: string[];
}

export interface AgentReport {
  summary: string;
  files: { path: string; sha256: string }[];
  proposedTests: string[];
  replyDraft: string | null;
  evidence: { source: string; detail: string }[];
  /** Perguntas a enviar ao cliente (só informação que apenas o cliente sabe). */
  clientQuestions: string[];
  verifiedTests: false;
}

export const REPORT_FILE = '.zeroops-result.json';

const reportSchema = z.strictObject({
  summary: z.string().trim().min(1).max(10000),
  files: z.array(z.strictObject({ path: z.string().min(1).max(500) })).max(100),
  proposedTests: z.array(z.string().min(1).max(2000)).max(30),
  replyDraft: z.string().trim().max(10000).nullable().optional(),
  evidence: z
    .array(
      z.strictObject({
        source: z.string().trim().min(1).max(200),
        detail: z.string().trim().min(1).max(2000),
      }),
    )
    .max(50)
    .optional(),
  clientQuestions: z.array(z.string().trim().min(1).max(500)).max(5).optional(),
});

/** Limites do contrato de execução comuns a todos os transportes do Copilot. */
export function validateExecutionInput(input: {
  workspace: string;
  prompt: string;
  timeoutMs: number;
  outputLimitBytes: number;
}) {
  if (
    !isAbsolute(input.workspace) ||
    input.prompt.length < 1 ||
    input.prompt.length > 32000 ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 1800000 ||
    input.outputLimitBytes < 1 ||
    input.outputLimitBytes > 10485760
  ) {
    throw new Error('Contrato de execucao invalido.');
  }
}

/** Resolve o workspace e garante que não traz um relatório de um run anterior. */
export async function prepareWorkspace(workspace: string) {
  const root = await realpath(workspace);
  const resultPath = resolve(root, REPORT_FILE);
  try {
    await lstat(resultPath);
    throw new Error('Workspace reutilizado com relatorio anterior. Requer reconciliacao.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return { root, resultPath };
}

/** Normaliza a shell: sem comandos fica negada; nomes fora do padrão são recusados. */
export function validateShell(shell?: AgentShell): AgentShell | null {
  const value = shell?.commands.length ? shell : null;
  if (value && !/^[a-z]+$/.test(value.tool)) throw new Error('Ferramenta de shell invalida.');
  if (value?.commands.some((command) => !/^[a-z][a-z0-9-]{1,30}$/.test(command)))
    throw new Error('Comando de conector invalido.');
  return value;
}

/** Instrução final do prompt que define o formato do relatório. */
export function reportInstruction(mode: AgentMode, shell: AgentShell | null) {
  const filesInstruction =
    mode === 'implement'
      ? 'files ([{path: caminho relativo}] apenas dos ficheiros que alterou)'
      : 'files (lista vazia [], porque a investigacao nao altera ficheiros; cite no summary os ficheiros consultados)';
  const investigationFields =
    mode === 'investigate'
      ? ', replyDraft (resposta final e completa ao cliente em PT-PT, ou null se ainda faltar informacao do cliente), clientQuestions (lista, no maximo 5, de perguntas ao cliente sobre informacao que so ele sabe; [] se nao houver) e evidence (lista [{source, detail}] com cada evidencia consultada)'
      : '';
  const commandRule = shell
    ? `Nao execute comandos alem de ${shell.commands.join(', ')}`
    : 'Nao execute comandos';
  return `\nRegiste apenas em ${REPORT_FILE} um JSON com summary (texto), ${filesInstruction}, proposedTests (lista de comandos sugeridos)${investigationFields}. ${FORMAT_RULE} ${commandRule} nem publique alteracoes. Nao inclua segredos. Este relatorio nao comprova que os testes passaram.`;
}

/** Os textos são mostrados no chat do ticket, que interpreta Markdown (sem HTML). */
const FORMAT_RULE =
  'Escreva summary e replyDraft em Markdown legivel num chat: comece por uma frase de conclusao, use titulos curtos (###), listas com "-", `codigo` para comandos, ficheiros e valores, tabelas so quando comparar valores, e paragrafos curtos; nao use HTML.';

/** Lê e valida o relatório do agente, medindo os artefactos declarados dentro do workspace. */
export async function readAgentReport(
  root: string,
  resultPath: string,
  mode: AgentMode,
): Promise<AgentReport> {
  const reportFile = await realpath(resultPath).catch(() => {
    throw new Error('Relatorio ausente, externo ou demasiado grande.');
  });
  if (reportFile !== resultPath || (await stat(reportFile)).size > 131072)
    throw new Error('Relatorio ausente, externo ou demasiado grande.');
  const report = reportSchema.parse(JSON.parse(await readFile(reportFile, 'utf8')));
  const files: { path: string; sha256: string }[] = [];
  const seen = new Set<string>();
  for (const item of report.files) {
    if (
      isAbsolute(item.path) ||
      item.path.includes('\\') ||
      item.path.split('/').some((part) => !part || part === '..' || part === '.') ||
      item.path.includes(':') ||
      seen.has(item.path)
    )
      throw new Error('Caminho de artefacto invalido.');
    seen.add(item.path);
    const file = await realpath(resolve(root, item.path));
    const relativePath = relative(root, file);
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath))
      throw new Error('Artefacto fora do workspace.');
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > 1048576)
      throw new Error('Artefacto invalido ou demasiado grande.');
    files.push({
      path: item.path,
      sha256: createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    });
  }
  if (mode === 'investigate' && files.length)
    throw new Error('Investigacao nao pode apresentar alteracoes de codigo.');
  return {
    summary: report.summary,
    files,
    proposedTests: report.proposedTests,
    replyDraft: report.replyDraft ?? null,
    evidence: report.evidence ?? [],
    clientQuestions: mode === 'investigate' ? (report.clientQuestions ?? []) : [],
    verifiedTests: false,
  };
}
