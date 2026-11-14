import { isAbsolute, relative, resolve, sep } from 'node:path';
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
    },
  ) {
    this.readRoots = [options.root, ...(options.readOnlyDirectories ?? [])].map((dir) =>
      resolve(dir),
    );
    this.commands = new Set(options.shell?.commands ?? []);
  }

  decide(request: PermissionRequestLike): PermissionDecision {
    switch (request.kind) {
      case 'read': {
        const path = String(request.resolvedPath ?? request.path ?? '');
        const target = resolve(this.options.root, path);
        return this.readRoots.some((root) => inside(root, target))
          ? { approved: true, detail: `ler ${path}` }
          : { approved: false, detail: `leitura fora das fontes autorizadas: ${path}` };
      }
      case 'write': {
        const path = String(request.fileName ?? '');
        const target = resolve(this.options.root, path);
        const allowed =
          this.options.mode === 'implement'
            ? inside(this.options.root, target)
            : target === resolve(this.options.root, REPORT_FILE);
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
      default:
        return { approved: false, detail: `permissão não autorizada: ${request.kind}` };
    }
  }
}
