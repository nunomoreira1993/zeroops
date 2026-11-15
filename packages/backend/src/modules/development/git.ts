import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Resultado de um comando Git (stderr já recortado e sem credenciais). */
export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Falha de um comando Git, com stderr redigido e indicação de resultado remoto incerto. */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    /** Falha de rede/tempo: o efeito remoto pode ter acontecido (reconciliar antes de repetir). */
    readonly uncertain: boolean,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export interface GitRunOptions {
  cwd?: string;
  /** Token do repositório: só no ambiente deste comando (nunca em `.git/config` nem no URL). */
  credential?: string | null;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxBuffer?: number;
}

const SAFE_ENV = ['PATH', 'HOME', 'LANG', 'TZ', 'SYSTEMROOT', 'TEMP', 'TMP'];

let isolatedGlobalConfig: string | undefined;

/**
 * Config «global» própria do ZeroOps, só com `safe.directory`. No transporte local o Git limpa
 * `GIT_CONFIG_COUNT`/`-c` antes de lançar o upload-pack, mas mantém `GIT_CONFIG_GLOBAL`; sem isto
 * um processo não-root não lê repositórios montados que pertencem a outro utilizador.
 */
function globalConfigPath() {
  if (!isolatedGlobalConfig) {
    const dir = mkdtempSync(join(tmpdir(), 'zeroops-git-'));
    const file = join(dir, 'gitconfig');
    writeFileSync(file, '[safe]\n\tdirectory = *\n', { mode: 0o600 });
    isolatedGlobalConfig = file;
  }
  return isolatedGlobalConfig;
}

/** Ambiente mínimo do Git: sem prompts, sem config do utilizador/sistema e credencial por cabeçalho. */
export function gitEnvironment(options: Pick<GitRunOptions, 'credential' | 'env'> = {}) {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfigPath(),
    GIT_AUTHOR_NAME: 'ZeroOps',
    GIT_AUTHOR_EMAIL: 'zeroops@localhost',
    GIT_COMMITTER_NAME: 'ZeroOps',
    GIT_COMMITTER_EMAIL: 'zeroops@localhost',
  });
  const extra: [string, string][] = [
    ['safe.directory', '*'],
    ['protocol.file.allow', 'always'],
    ['core.autocrlf', 'false'],
    ['commit.gpgsign', 'false'],
  ];
  if (options.credential)
    extra.push([
      'http.extraHeader',
      `Authorization: Basic ${Buffer.from(`x-access-token:${options.credential}`).toString('base64')}`,
    ]);
  env.GIT_CONFIG_COUNT = String(extra.length);
  extra.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return { ...env, ...(options.env ?? {}) };
}

/** Remove credenciais conhecidas e userinfo de URLs de qualquer texto de erro/log. */
export function redactGit(text: string, credential?: string | null) {
  let value = text.replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@');
  if (credential) value = value.split(credential).join('***');
  return value.replace(/Authorization: Basic [A-Za-z0-9+/=]+/g, 'Authorization: ***');
}

const UNCERTAIN = [
  /could not resolve host/i,
  /connection (timed out|reset|refused)/i,
  /the remote end hung up/i,
  /early eof/i,
  /operation timed out/i,
  /RPC failed/i,
  /unable to access/i,
];

/** Executa `git` sem shell (argumentos nunca interpretados) e com limites de tempo e saída. */
export function runGit(args: string[], options: GitRunOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: options.cwd,
        env: gitEnvironment(options),
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const err = redactGit(String(stderr), options.credential).slice(0, 4000);
        if (!error) return resolve({ stdout: String(stdout), stderr: err });
        const killed = (error as { killed?: boolean }).killed === true;
        const code = typeof error.code === 'number' ? error.code : null;
        reject(
          new GitCommandError(
            redactGit(
              `git ${args[0] ?? ''} falhou: ${err || error.message}`,
              options.credential,
            ).slice(0, 500),
            code,
            err,
            killed || UNCERTAIN.some((pattern) => pattern.test(err)),
          ),
        );
      },
    );
  });
}

/**
 * URL autorizado: `https://` ou `file://`, sem credenciais, e dentro de uma das raízes permitidas
 * (`ZEROOPS_DEV_ALLOWED_REPO_ROOTS`). Sem raízes configuradas nenhum repositório é aceite.
 */
export function repositoryUrlAllowed(url: string, roots: readonly string[]) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['https:', 'file:'].includes(parsed.protocol) || parsed.username || parsed.password)
    return false;
  if (parsed.search || parsed.hash) return false;
  if (decodeURIComponent(parsed.pathname).split('/').includes('..')) return false;
  const normalized = parsed.toString();
  return roots.some((root) => {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return normalized.startsWith(prefix);
  });
}

/** Raízes de URL autorizadas para repositórios (`ZEROOPS_DEV_ALLOWED_REPO_ROOTS`). */
export function allowedRepositoryRoots(env: NodeJS.ProcessEnv = process.env) {
  return (env.ZEROOPS_DEV_ALLOWED_REPO_ROOTS ?? '')
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export const GIT_SHA = /^[a-f0-9]{40}$/;

/** SHA de uma branch remota (`null` quando não existe). */
export async function remoteBranchSha(
  url: string,
  branch: string,
  options: GitRunOptions = {},
): Promise<string | null> {
  const { stdout } = await runGit(['ls-remote', '--heads', '--', url, `refs/heads/${branch}`], {
    timeoutMs: 60_000,
    ...options,
  });
  const line = stdout
    .split('\n')
    .map((item) => item.trim().split(/\s+/))
    .find((parts) => parts[1] === `refs/heads/${branch}`);
  const sha = line?.[0] ?? null;
  return sha && GIT_SHA.test(sha) ? sha : null;
}
