import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chown, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type {
  DevelopmentCommand,
  DevelopmentFileChange,
} from '../../../packages/contracts/src/index.js';
import { GIT_SHA, runGit } from '../../../packages/backend/src/modules/development/git.js';
import { REPORT_FILE } from './agent-report.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Saída máxima guardada de cada comando de teste. */
const TEST_OUTPUT_LIMIT = 200_000;

export interface WorkspaceOwner {
  uid: number;
  gid: number;
}

export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  log: string;
  durationMs: number;
}

/** Executa um comando configurado no checkout, como o utilizador do agente e sem segredos. */
export type CommandExecutor = (input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  owner?: WorkspaceOwner;
}) => Promise<CommandResult>;

/** Ambiente mínimo dos comandos de teste: nunca herda tokens nem credenciais do executor. */
function commandEnvironment(cwd: string): NodeJS.ProcessEnv {
  const keep = ['PATH', 'LANG', 'TZ', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'];
  const env: NodeJS.ProcessEnv = { HOME: cwd, CI: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of keep) if (process.env[key]) env[key] = process.env[key];
  return env;
}

export const runCommand: CommandExecutor = ({ command, cwd, timeoutMs, owner }) =>
  new Promise((done) => {
    const started = Date.now();
    const posix = process.platform !== 'win32';
    const child = spawn(command, {
      cwd,
      shell: true,
      env: commandEnvironment(cwd),
      detached: posix,
      windowsHide: true,
      ...(owner && posix ? { uid: owner.uid, gid: owner.gid } : {}),
    });
    let log = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      log += chunk.toString('utf8');
      if (log.length > TEST_OUTPUT_LIMIT * 2) log = log.slice(-TEST_OUTPUT_LIMIT);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (posix && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // o processo já terminou
      }
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      done({
        exitCode: timedOut ? null : exitCode,
        timedOut,
        log: log.length > TEST_OUTPUT_LIMIT ? log.slice(-TEST_OUTPUT_LIMIT) : log,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (error) => {
      append(Buffer.from(`\n${error.message}\n`));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

/** Checkout de uma tentativa: worktree próprio sobre o repositório bare do workspace. */
export interface AttemptCheckout {
  gitDir: string;
  path: string;
  /** Commit em que o worktree foi criado (head anterior ou base). */
  startSha: string;
}

/**
 * Workspaces Git persistentes do P08: um repositório bare por workspace
 * (`<root>/<projectId>/<workspaceId>/repo.git`) e um worktree por tentativa
 * (`attempts/<run>-<época>`). O head confirmado vive na branch local do workspace; tentativas
 * diferentes nunca partilham o mesmo diretório de trabalho.
 */
export class WorkspaceManager {
  constructor(
    private readonly root: string,
    private readonly owner?: WorkspaceOwner,
    private readonly execute: CommandExecutor = runCommand,
  ) {}

  directory(projectId: string, workspaceId: string) {
    if (!UUID.test(projectId) || !UUID.test(workspaceId))
      throw new Error('Identificador de workspace inválido.');
    return join(resolve(this.root), projectId, workspaceId);
  }

  /** Inicializa (uma vez) o bare e obtém a branch base autorizada; devolve o SHA remoto atual. */
  async fetchBase(input: {
    projectId: string;
    workspaceId: string;
    url: string;
    baseBranch: string;
    credential: string | null;
  }) {
    const gitDir = join(this.directory(input.projectId, input.workspaceId), 'repo.git');
    const exists = await stat(join(gitDir, 'HEAD')).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await mkdir(gitDir, { recursive: true });
      await runGit(['init', '--bare', '--quiet', gitDir]);
    }
    await mkdir(join(gitDir, 'info'), { recursive: true });
    // O relatório do agente nunca entra no commit.
    await writeFile(join(gitDir, 'info', 'exclude'), `${REPORT_FILE}\n`);
    await runGit(
      [
        '--git-dir',
        gitDir,
        'fetch',
        '--no-tags',
        '--quiet',
        input.url,
        `+refs/heads/${input.baseBranch}:refs/remotes/origin/${input.baseBranch}`,
      ],
      { credential: input.credential, timeoutMs: 300_000 },
    );
    const sha = (
      await runGit(['--git-dir', gitDir, 'rev-parse', `refs/remotes/origin/${input.baseBranch}`])
    ).stdout.trim();
    if (!GIT_SHA.test(sha)) throw new Error('Branch base sem commit válido.');
    return { gitDir, remoteBaseSha: sha };
  }

  async hasCommit(gitDir: string, sha: string) {
    return runGit(['--git-dir', gitDir, 'cat-file', '-e', `${sha}^{commit}`]).then(
      () => true,
      () => false,
    );
  }

  /** Cria o worktree da tentativa no commit indicado (destacado: só o executor move a branch). */
  async checkout(gitDir: string, attempt: string, sha: string): Promise<AttemptCheckout> {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(attempt)) throw new Error('Tentativa inválida.');
    if (!GIT_SHA.test(sha)) throw new Error('SHA inválido.');
    const path = join(gitDir, '..', 'attempts', attempt);
    await this.removeCheckout({ gitDir, path, startSha: sha });
    await mkdir(join(gitDir, '..', 'attempts'), { recursive: true });
    await runGit(['--git-dir', gitDir, 'worktree', 'add', '--detach', '--quiet', path, sha]);
    if (this.owner) await chownTree(path, this.owner);
    return { gitDir, path, startSha: sha };
  }

  /** Árvore atual do checkout (hash do conteúdo efetivamente testado, mesmo sem commit). */
  async workingTree(checkout: AttemptCheckout) {
    await runGit(['add', '-A', '--', '.'], { cwd: checkout.path });
    return (await runGit(['write-tree'], { cwd: checkout.path })).stdout.trim();
  }

  /**
   * Commit do conteúdo do checkout sobre `parent` (sem mexer no HEAD do worktree). Sem alterações
   * devolve o próprio `parent`.
   */
  async commit(checkout: AttemptCheckout, parent: string, message: string) {
    await rm(join(checkout.path, REPORT_FILE), { force: true });
    const tree = await this.workingTree(checkout);
    const parentTree = (
      await runGit(['rev-parse', `${parent}^{tree}`], { cwd: checkout.path })
    ).stdout.trim();
    if (tree === parentTree) return parent;
    const sha = (
      await runGit(['commit-tree', tree, '-p', parent, '-m', message], { cwd: checkout.path })
    ).stdout.trim();
    if (!GIT_SHA.test(sha)) throw new Error('Commit inválido.');
    return sha;
  }

  /** Move a branch local do workspace (CAS sobre o valor anterior). */
  async updateBranch(gitDir: string, branch: string, sha: string, previous: string | null) {
    await runGit([
      '--git-dir',
      gitDir,
      'update-ref',
      `refs/heads/${branch}`,
      sha,
      ...(previous ? [previous] : []),
    ]);
  }

  /** Diff completo base..head obtido do Git (binários incluídos) e a lista A/M/D/R/T. */
  async diff(gitDir: string, base: string, head: string) {
    const [patch, names] = await Promise.all([
      runGit(['--git-dir', gitDir, 'diff', '--binary', '--no-color', '-M', base, head]),
      runGit(['--git-dir', gitDir, 'diff', '--name-status', '-z', '-M', base, head]),
    ]);
    return { diff: patch.stdout, files: parseNameStatus(names.stdout) };
  }

  /** SHA-256 do conteúdo de cada ficheiro no commit indicado. */
  async fileHashes(gitDir: string, sha: string, paths: string[]) {
    const result: { path: string; sha256: string }[] = [];
    for (const path of paths) {
      const blob = await new Promise<Buffer>((done, fail) => {
        const child = spawn('git', ['--git-dir', gitDir, 'cat-file', 'blob', `${sha}:${path}`], {
          windowsHide: true,
        });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.on('error', fail);
        child.on('close', (code) =>
          code === 0 ? done(Buffer.concat(chunks)) : fail(new Error('Blob inexistente.')),
        );
      });
      result.push({ path, sha256: createHash('sha256').update(blob).digest('hex') });
    }
    return result;
  }

  /** `ancestor` é antecessor de (ou igual a) `descendant`. */
  async isAncestor(gitDir: string, ancestor: string, descendant: string) {
    return runGit(['--git-dir', gitDir, 'merge-base', '--is-ancestor', ancestor, descendant]).then(
      () => true,
      () => false,
    );
  }

  /**
   * P09 — integra `head` no checkout (destacado no topo da branch de destino) com um merge sem
   * fast-forward. Em conflito aborta o merge e devolve os ficheiros em conflito; nada é publicado.
   */
  async mergeCheckout(
    checkout: AttemptCheckout,
    head: string,
    message: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[] }> {
    if (!GIT_SHA.test(head)) throw new Error('SHA inválido.');
    try {
      await runGit(['merge', '--no-ff', '--no-edit', '-m', message, head], { cwd: checkout.path });
    } catch {
      const conflicts = (
        await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: checkout.path }).catch(
          () => ({ stdout: '' }),
        )
      ).stdout
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean);
      await runGit(['merge', '--abort'], { cwd: checkout.path }).catch(() => undefined);
      return { ok: false, conflicts };
    }
    if (this.owner) await chownTree(checkout.path, this.owner);
    const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: checkout.path })).stdout.trim();
    if (!GIT_SHA.test(sha)) throw new Error('Merge sem commit válido.');
    return { ok: true, sha };
  }

  /** Digest do conteúdo exato de um commit (`git archive` em tar): identifica o artefacto. */
  async archiveDigest(gitDir: string, sha: string) {
    if (!GIT_SHA.test(sha)) throw new Error('SHA inválido.');
    const digest = await new Promise<string>((done, fail) => {
      const child = spawn('git', ['--git-dir', gitDir, 'archive', '--format=tar', sha], {
        windowsHide: true,
      });
      const hash = createHash('sha256');
      child.stdout.on('data', (chunk: Buffer) => hash.update(chunk));
      child.on('error', fail);
      child.on('close', (code) =>
        code === 0 ? done(hash.digest('hex')) : fail(new Error('git archive falhou.')),
      );
    });
    return `sha256:${digest}`;
  }

  /**
   * Hash das alterações introduzidas entre dois commits, independente da posição das linhas e
   * dos blobs (sem cabeçalhos `index` nem `@@`): igual quando a integração aplica exatamente a
   * mesma alteração revista sobre uma base mais recente.
   */
  async stableDiffHash(gitDir: string, from: string, to: string) {
    const raw = (
      await runGit([
        '--git-dir',
        gitDir,
        'diff',
        '-U0',
        '--no-color',
        '--no-renames',
        '--binary',
        from,
        to,
      ])
    ).stdout;
    const stable = raw
      .split('\n')
      .filter((line) => !line.startsWith('index ') && !line.startsWith('@@'))
      .join('\n');
    return createHash('sha256').update(stable).digest('hex');
  }

  /** Executa um comando configurado (setup ou teste) no checkout da tentativa. */
  runConfigured(checkout: AttemptCheckout, command: DevelopmentCommand) {
    return this.execute({
      command: command.command,
      cwd: checkout.path,
      timeoutMs: command.timeoutSeconds * 1000,
      ...(this.owner ? { owner: this.owner } : {}),
    });
  }

  async removeCheckout(checkout: AttemptCheckout) {
    await runGit([
      '--git-dir',
      checkout.gitDir,
      'worktree',
      'remove',
      '--force',
      checkout.path,
    ]).catch(() => undefined);
    await rm(checkout.path, { recursive: true, force: true });
    await runGit(['--git-dir', checkout.gitDir, 'worktree', 'prune']).catch(() => undefined);
  }

  /** Remove o workspace inteiro (os artefactos já estão na base de dados). */
  async destroy(projectId: string, workspaceId: string) {
    await rm(this.directory(projectId, workspaceId), { recursive: true, force: true });
  }
}

export function parseNameStatus(raw: string): DevelopmentFileChange[] {
  const parts = raw.split('\0').filter((part) => part.length);
  const files: DevelopmentFileChange[] = [];
  for (let index = 0; index < parts.length;) {
    const code = parts[index++]!;
    const status = code[0] as DevelopmentFileChange['status'];
    if (status === 'R' || code[0] === 'C') {
      const previousPath = parts[index++]!;
      const path = parts[index++]!;
      files.push(code[0] === 'C' ? { status: 'A', path } : { status: 'R', path, previousPath });
    } else {
      const path = parts[index++]!;
      files.push({ status: ['A', 'M', 'D', 'T'].includes(status) ? status : 'M', path });
    }
  }
  return files;
}

async function chownTree(path: string, owner: WorkspaceOwner) {
  await chown(path, owner.uid, owner.gid);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = `${path}${sep}${entry.name}`;
    if (entry.isDirectory()) await chownTree(child, owner);
    else await chown(child, owner.uid, owner.gid).catch(() => undefined);
  }
}
