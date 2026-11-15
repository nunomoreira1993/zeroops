import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { REPORT_FILE, type AgentMode, type AgentShell } from './agent-report.js';

/** Pedido de permissão do agente, reduzido aos campos usados pela política. */
export interface PermissionRequestLike {
  kind: string;
  [field: string]: unknown;
}

export interface PermissionDecision {
  approved: boolean;
  /** Resumo seguro para a conversa (sem conteúdo de ficheiros). */
  detail: string;
}

function inside(root: string, path: string) {
  const relativePath = relative(root, path);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

/**
 * Caminho canónico: resolve ligações simbólicas no maior prefixo existente, para que um symlink
 * dentro do workspace não dê acesso a ficheiros fora das raízes autorizadas.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
}

/**
 * Política de permissões do agente, equivalente às flags do modo não interativo:
 * leitura só no workspace e nas fontes do site; escrita só do relatório (ou do workspace em
 * `implement`); shell só com os comandos dos conectores; sem URLs nem memória; MCP só leitura.
 */
export class PermissionPolicy {
  private readonly readRoots: string[];
  private readonly commands: Set<string>;

  constructor(
    private readonly options: {
      root: string;
      mode: AgentMode;
      readOnlyDirectories?: string[];
      shell: AgentShell | null;
      /** Posse atual da tentativa; sem posse (lease perdido/cancelado) tudo é negado. */
      isActive?: () => boolean;
      /** Ferramentas próprias registadas pelo ZeroOps neste run (P06); as restantes são negadas. */
      customTools?: string[];
    },
  ) {
    this.readRoots = [options.root, ...(options.readOnlyDirectories ?? [])].flatMap((dir) => [
      ...new Set([resolve(dir), canonical(resolve(dir))]),
    ]);
    this.commands = new Set(options.shell?.commands ?? []);
  }

  /** Decide um pedido de permissão do agente (negado sempre que a tentativa perdeu a posse). */
  decide(request: PermissionRequestLike): PermissionDecision {
    if (this.options.isActive && !this.options.isActive())
      return { approved: false, detail: 'tentativa sem posse do run (lease perdido ou cancelado)' };
    switch (request.kind) {
      case 'read': {
        const path = String(request.resolvedPath ?? request.path ?? '');
        const target = canonical(resolve(this.options.root, path));
        return this.readRoots.some((root) => inside(root, target))
          ? { approved: true, detail: `ler ${path}` }
          : { approved: false, detail: `leitura fora das fontes autorizadas: ${path}` };
      }
      case 'write': {
        const path = String(request.fileName ?? '');
        const root = canonical(resolve(this.options.root));
        // `apply_patch` pode tocar vários ficheiros num só pedido: todos têm de ser autorizados.
        const edits = Array.isArray(request.fileEdits) ? request.fileEdits : [];
        const paths = [
          path,
          ...edits.flatMap((edit) =>
            ['before', 'after'].map((side) =>
              String((edit as Record<string, { path?: unknown }>)?.[side]?.path ?? ''),
            ),
          ),
        ].filter(Boolean);
        const allowed =
          paths.length > 0 &&
          paths.every((candidate) => {
            const target = canonical(resolve(this.options.root, candidate));
            // Metadados Git (worktree `.git`) nunca são escritos pelo agente.
            if (relative(root, target).split(sep)[0] === '.git') return false;
            return this.options.mode === 'implement'
              ? inside(root, target)
              : target === join(root, REPORT_FILE);
          });
        return allowed
          ? { approved: true, detail: `escrever ${path}` }
          : { approved: false, detail: `escrita não autorizada: ${path}` };
      }
      case 'shell': {
        const full = String(request.fullCommandText ?? '').slice(0, 300);
        const identifiers = (Array.isArray(request.commands) ? request.commands : []).map(
          (command) => String((command as { identifier?: unknown }).identifier ?? ''),
        );
        const allowed =
          identifiers.length > 0 &&
          identifiers.every((identifier) => this.commands.has(identifier)) &&
          request.hasWriteFileRedirection !== true &&
          !(Array.isArray(request.possibleUrls) && request.possibleUrls.length);
        return allowed
          ? { approved: true, detail: full }
          : { approved: false, detail: `comando não autorizado: ${full}` };
      }
      case 'mcp': {
        const tool = `${String(request.serverName ?? 'mcp')}/${String(request.toolName ?? '')}`;
        return request.readOnly === true
          ? { approved: true, detail: tool }
          : { approved: false, detail: `ferramenta MCP com escrita: ${tool}` };
      }
      case 'url':
        return { approved: false, detail: `acesso a URL negado: ${String(request.url ?? '')}` };
      case 'custom-tool': {
        // A ferramenta valida, autoriza e fenca cada chamada no backend; aqui só se limita o nome.
        const name = String(request.toolName ?? '');
        return this.options.customTools?.includes(name)
          ? { approved: true, detail: name }
          : { approved: false, detail: `ferramenta não registada: ${name}` };
      }
      default:
        return { approved: false, detail: `permissão não autorizada: ${request.kind}` };
    }
  }
}
