import { spawn } from 'node:child_process';
import type { SandboxProcess } from './copilot.adapter.js';

/** Variáveis herdadas pelo Copilot; tudo o resto (incl. credenciais da BD ZeroOps) fica de fora. */
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_HOME',
  'COPILOT_CACHE_HOME',
  'COPILOT_AUTO_UPDATE',
  'COPILOT_MODEL',
  'USE_TGREP',
  'XDG_CONFIG_HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
];

/** Utilizador sem privilégios com que o Copilot corre (diferente do processo do executor). */
export interface AgentIdentity {
  uid: number;
  gid: number;
  home: string;
}

/** Ambiente do processo do agente: só a allowlist herdada, o HOME do agente e as variáveis do run. */
export function agentEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  identity?: AgentIdentity,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...Object.fromEntries(
      INHERITED_ENV.flatMap((name) => (baseEnv[name] ? [[name, baseEnv[name]]] : [])),
    ),
    ...(identity ? { HOME: identity.home } : {}),
    ...extra,
  };
}

/**
 * Executa o Copilot CLI como processo filho. O isolamento é dado pelo contentor `executor`
 * (sem socket Docker, filesystem só de leitura, workspace em tmpfs, limites de memória) e,
 * com `identity`, por correr com outro uid: o agente não consegue ler o ambiente do executor.
 */
export class CopilotProcess implements SandboxProcess {
  constructor(
    private readonly command: string,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    private readonly identity?: AgentIdentity,
  ) {}

  run(input: Parameters<SandboxProcess['run']>[0]) {
    const env = agentEnvironment(this.baseEnv, this.identity, input.env);
    return new Promise<{ exitCode: number; interrupted: boolean }>((done, reject) => {
      const child = spawn(this.command, input.arguments, {
        cwd: input.workspace,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(this.identity ? { uid: this.identity.uid, gid: this.identity.gid } : {}),
      });
      let bytes = 0;
      let interrupted = false;
      const stop = () => {
        if (interrupted) return;
        interrupted = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      };
      const count = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > input.outputLimitBytes) stop();
      };
      child.stdout.on('data', count);
      child.stderr.on('data', count);
      const timer = setTimeout(stop, input.timeoutMs);
      input.signal?.addEventListener('abort', stop, { once: true });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', stop);
        done({ exitCode: exitCode ?? 1, interrupted });
      });
      child.stdin.end(input.stdin);
    });
  }
}
