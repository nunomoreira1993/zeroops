import { execFile } from 'node:child_process';
import { chmod, chown, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentIdentity } from './copilot-process.js';

const execFileAsync = promisify(execFile);

/**
 * Identidade de sistema atribuída a um único job (run, assistente, entrega). Enquanto o job dura,
 * nenhum outro job usa o mesmo uid: os ficheiros, processos e a home de um job ficam fora do
 * alcance do código de outro. `release` termina os processos que sobrem e apaga o que o uid deixou.
 */
export interface JobIdentity extends AgentIdentity {
  /** `true` quando o uid é exclusivo do job (pool); `false` no modo partilhado de compatibilidade. */
  exclusive: boolean;
  release(): Promise<void>;
}

export interface JobIdentitySource {
  /** Identidade para um job novo; `null` quando o executor não muda de uid (desenvolvimento). */
  acquire(): Promise<JobIdentity | null>;
}

export class JobIdentityExhausted extends Error {
  constructor() {
    super('Sem identidades de job livres: o job volta à fila.');
    this.name = 'JobIdentityExhausted';
  }
}

/** A limpeza de um uid não ficou confirmada: o uid fica em quarentena (não é reutilizado). */
export class JobIdentityCleanupError extends Error {
  constructor(
    readonly uid: number,
    readonly failures: { step: string; message: string }[],
  ) {
    super(
      `Limpeza do uid ${uid} por confirmar (${failures.map((item) => `${item.step}: ${item.message}`).join('; ')}).`,
    );
    this.name = 'JobIdentityCleanupError';
  }
}

/** Diagnóstico de um uid em quarentena. */
export interface QuarantinedIdentity {
  uid: number;
  since: Date;
  attempts: number;
  nextRetryAt: Date;
  failures: { step: string; message: string }[];
}

/** Operações de sistema do pool (injetáveis nos testes). */
export interface SandboxSystem {
  prepareHome(path: string, uid: number, gid: number): Promise<void>;
  removeHome(path: string): Promise<void>;
  /** Termina todos os processos cujo uid real ou efetivo é `uid`; devolve quantos encontrou. */
  killProcesses(uid: number): Promise<number>;
  /** Remove as entradas de topo de `directory` que pertencem a `uid` (ex.: `/tmp`, `/dev/shm`). */
  removeOwnedEntries(directory: string, uid: number): Promise<number>;
  /**
   * Remove os worktrees de tentativas (`<root>/<projeto>/<workspace>/attempts/<n>`) que pertencem a
   * `uid`. Os repositórios bare e o resto do workspace ficam intactos.
   */
  removeOwnedWorktrees(root: string, uid: number): Promise<number>;
}

export interface JobIdentityPoolOptions {
  uidBase: number;
  count: number;
  /** Raiz das homes privadas (`<homeRoot>/<uid>`), propriedade de root e sem listagem. */
  homeRoot: string;
  /** Diretórios partilhados onde um job pode deixar ficheiros (limpos no fim do job). */
  scratchDirectories?: string[];
  /** Raízes dos workspaces Git (`ZEROOPS_DEV_WORKSPACES`): worktrees do uid são removidos. */
  worktreeRoots?: string[];
  /** Espera inicial antes de nova limpeza de um uid em quarentena (duplica até 15 min). */
  recoveryDelayMs?: number;
  system?: SandboxSystem;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
}

const MAX_RECOVERY_DELAY_MS = 15 * 60_000;
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * Pool de uids exclusivos (P-A/F02). Cada job recebe um uid livre e uma home nova `0700`; no fim
 * os processos do uid são terminados e a home, os temporários e os worktrees do uid são apagados
 * antes de o uid voltar ao pool. Se a limpeza não ficar confirmada, o uid fica em quarentena e só
 * volta depois de uma limpeza completa (tentada com intervalos crescentes). Pressupõe um único
 * executor por intervalo de uids (o pool é em memória; depois de um reinício cada uid é limpo
 * antes da primeira utilização).
 */
export class JobIdentityPool implements JobIdentitySource {
  private readonly inUse = new Set<number>();
  private readonly quarantine = new Map<number, QuarantinedIdentity>();
  private next = 0;
  private readonly system: SandboxSystem;
  private readonly now: () => number;

  constructor(private readonly options: JobIdentityPoolOptions) {
    if (!Number.isInteger(options.uidBase) || options.uidBase < 1000)
      throw new Error('ZEROOPS_JOB_UID_BASE inválido (mínimo 1000).');
    if (!Number.isInteger(options.count) || options.count < 1 || options.count > 65_536)
      throw new Error('ZEROOPS_JOB_UID_COUNT inválido.');
    this.system = options.system ?? linuxSandboxSystem;
    this.now = options.now ?? Date.now;
  }

  get size() {
    return this.options.count;
  }

  get active() {
    return this.inUse.size;
  }

  /** uids indisponíveis por limpeza não confirmada (diagnóstico). */
  get quarantined(): QuarantinedIdentity[] {
    return [...this.quarantine.values()].map((item) => ({ ...item, failures: [...item.failures] }));
  }

  /**
   * Nova limpeza dos uids em quarentena cujo intervalo já passou (`force`: todos). Um uid só volta
   * ao pool quando todos os passos da limpeza forem confirmados.
   */
  async recover(force = false) {
    let recovered = 0;
    for (const item of [...this.quarantine.values()]) {
      if (!force && item.nextRetryAt.getTime() > this.now()) continue;
      try {
        await this.scrub(item.uid, this.home(item.uid));
      } catch (error) {
        this.isolate(item.uid, error);
        continue;
      }
      this.quarantine.delete(item.uid);
      this.inUse.delete(item.uid);
      recovered += 1;
      this.options.log?.({
        event: 'job_identity.recovered',
        uid: item.uid,
        attempts: item.attempts,
      });
    }
    return recovered;
  }

  async acquire(): Promise<JobIdentity> {
    if (this.quarantine.size) await this.recover();
    for (;;) {
      let uid: number | null = null;
      for (let index = 0; index < this.options.count; index += 1) {
        const candidate = this.options.uidBase + ((this.next + index) % this.options.count);
        if (!this.inUse.has(candidate)) {
          uid = candidate;
          this.next = (this.next + index + 1) % this.options.count;
          break;
        }
      }
      if (uid === null) throw new JobIdentityExhausted();
      this.inUse.add(uid);
      const home = this.home(uid);
      try {
        // Restos de um job anterior com este uid (ex.: executor reiniciado a meio) nunca passam.
        await this.scrub(uid, home);
      } catch (error) {
        this.isolate(uid, error);
        continue;
      }
      try {
        await this.system.prepareHome(home, uid, uid);
      } catch (error) {
        this.inUse.delete(uid);
        throw error;
      }
      return this.identity(uid, home);
    }
  }

  private identity(uid: number, home: string): JobIdentity {
    let released = false;
    return {
      uid,
      gid: uid,
      home,
      private: true,
      exclusive: true,
      release: async () => {
        if (released) return;
        try {
          await this.scrub(uid, home);
        } catch (error) {
          released = true;
          this.isolate(uid, error);
          throw error;
        }
        released = true;
        this.quarantine.delete(uid);
        this.inUse.delete(uid);
      },
    };
  }

  private home(uid: number) {
    return join(this.options.homeRoot, String(uid));
  }

  /** O uid continua ocupado (nenhum job o recebe) até uma limpeza completa em `recover`. */
  private isolate(uid: number, error: unknown) {
    const failures =
      error instanceof JobIdentityCleanupError
        ? error.failures
        : [{ step: 'cleanup', message: errorMessage(error) }];
    const previous = this.quarantine.get(uid);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = Math.min(
      (this.options.recoveryDelayMs ?? 60_000) * 2 ** (attempts - 1),
      MAX_RECOVERY_DELAY_MS,
    );
    this.inUse.add(uid);
    this.quarantine.set(uid, {
      uid,
      since: previous?.since ?? new Date(this.now()),
      attempts,
      nextRetryAt: new Date(this.now() + delay),
      failures,
    });
    this.options.log?.({
      event: 'job_identity.quarantined',
      uid,
      attempts,
      retryInMs: delay,
      failures,
    });
  }

  /**
   * Termina os processos e remove home, temporários e worktrees do uid. Cada passo corre mesmo
   * que um anterior falhe; qualquer falha deixa a limpeza por confirmar.
   */
  private async scrub(uid: number, home: string) {
    const failures: { step: string; message: string }[] = [];
    const step = async (name: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push({ step: name, message: errorMessage(error) });
      }
    };
    await step('processes', () => this.system.killProcesses(uid));
    await step('home', () => this.system.removeHome(home));
    for (const directory of this.options.scratchDirectories ?? [])
      await step(`scratch:${directory}`, () => this.system.removeOwnedEntries(directory, uid));
    for (const root of this.options.worktreeRoots ?? [])
      await step(`worktrees:${root}`, () => this.system.removeOwnedWorktrees(root, uid));
    // Processos que tenham sobrevivido à primeira passagem podiam recriar ficheiros.
    if (failures.length) await step('processes', () => this.system.killProcesses(uid));
    if (failures.length) throw new JobIdentityCleanupError(uid, failures);
  }
}

/**
 * Compatibilidade: uma identidade fixa partilhada por todos os jobs (`ZEROOPS_AGENT_UID`). Não há
 * isolamento entre jobs; `release` não termina processos (seriam de outros jobs).
 */
export class SharedIdentitySource implements JobIdentitySource {
  constructor(private readonly identity: AgentIdentity | undefined) {}

  async acquire(): Promise<JobIdentity | null> {
    if (!this.identity) return null;
    return {
      ...this.identity,
      exclusive: false,
      release: async () => undefined,
    };
  }
}

/** Pool a partir do ambiente; sem `ZEROOPS_JOB_UID_BASE` usa a identidade partilhada antiga. */
export function jobIdentitiesFromEnv(
  env: NodeJS.ProcessEnv,
  shared: AgentIdentity | undefined,
  log?: (event: Record<string, unknown>) => void,
): JobIdentitySource {
  if (!env.ZEROOPS_JOB_UID_BASE) return new SharedIdentitySource(shared);
  if (process.platform === 'win32') throw new Error('O pool de uids exige Linux.');
  return new JobIdentityPool({
    uidBase: Number(env.ZEROOPS_JOB_UID_BASE),
    count: Number(env.ZEROOPS_JOB_UID_COUNT ?? 64),
    homeRoot: env.ZEROOPS_JOB_HOME_ROOT ?? '/home/node/jobs',
    scratchDirectories: [
      ...(env.ZEROOPS_JOB_SCRATCH_DIRS ?? '/tmp,/dev/shm').split(/[;,]/),
      // Diretórios `run-*` dos runs (entregues ao uid do job).
      ...(env.ZEROOPS_AGENT_WORKSPACE ? [env.ZEROOPS_AGENT_WORKSPACE] : []),
    ]
      .map((item) => item.trim())
      .filter((item, index, all) => item && all.indexOf(item) === index),
    worktreeRoots: env.ZEROOPS_DEV_WORKSPACES ? [env.ZEROOPS_DEV_WORKSPACES] : [],
    ...(log ? { log } : {}),
  });
}

/** Identidade de uma tentativa como dono de ficheiros/processos (`uid`/`gid`). */
export const ownerOf = (identity: AgentIdentity | null | undefined) =>
  identity
    ? {
        uid: identity.uid,
        gid: identity.gid,
        ...(identity.private ? { tmpDir: join(identity.home, 'tmp') } : {}),
      }
    : undefined;

const statusUids = (status: string) => {
  const line = status.split('\n').find((item) => item.startsWith('Uid:'));
  return line
    ? line
        .slice(4)
        .trim()
        .split(/\s+/)
        .map((value) => Number(value))
    : [];
};

/** Implementação Linux: `/proc` para processos, `lstat` (sem seguir symlinks) para ficheiros. */
export const linuxSandboxSystem: SandboxSystem = {
  async prepareHome(path, uid, gid) {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o711 });
    await chmod(join(path, '..'), 0o711);
    await mkdir(path, { mode: 0o700 });
    for (const child of ['tmp', '.copilot', '.config'])
      await mkdir(join(path, child), { mode: 0o700 });
    for (const target of [path, join(path, 'tmp'), join(path, '.copilot'), join(path, '.config')]) {
      await chown(target, uid, gid);
      await chmod(target, 0o700);
    }
  },
  async removeHome(path) {
    await rm(path, { recursive: true, force: true });
  },
  async killProcesses(uid) {
    // Repetido: um processo pode criar filhos enquanto os outros são terminados.
    let total = 0;
    const processes = async () => {
      const pids: number[] = [];
      for (const entry of await readdir('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return '';
            throw error;
          },
        );
        if (statusUids(status).includes(uid) && !/^State:\s+Z\b/m.test(status))
          pids.push(Number(entry));
      }
      return pids;
    };
    for (let round = 0; round < 5; round += 1) {
      const pids = await processes();
      if (!pids.length) break;
      total += pids.length;
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    const remaining = await processes();
    if (remaining.length)
      throw new Error(`Não foi possível terminar todos os processos do uid ${uid}.`);
    return total;
  },
  async removeOwnedEntries(directory, uid) {
    let removed = 0;
    // Diretório inexistente: nada do uid pode lá estar.
    for (const entry of await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    })) {
      const path = join(directory, entry);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (info?.uid !== uid) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  },
  removeOwnedWorktrees,
};

const directories = async (path: string) => {
  const entries = await readdir(path, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  // `withFileTypes` usa lstat: symlinks nunca são seguidos.
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
};

/**
 * Worktrees de tentativas de `uid` em `<root>/<projeto>/<workspace>/attempts/*`. Remove a árvore e
 * depois limpa os metadados do bare (`git worktree prune`, sem efeito nos commits nem nas branches).
 */
export async function removeOwnedWorktrees(root: string, uid: number) {
  let removed = 0;
  for (const project of await directories(root))
    for (const workspace of await directories(project)) {
      const attempts = join(workspace, 'attempts');
      let owned = 0;
      for (const entry of await readdir(attempts).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [] as string[];
        throw error;
      })) {
        const path = join(attempts, entry);
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!info || info.uid !== uid) continue;
        await rm(path, { recursive: true, force: true });
        owned += 1;
      }
      if (owned)
        await execFileAsync(
          'git',
          ['--git-dir', join(workspace, 'repo.git'), 'worktree', 'prune'],
          {
            timeout: 30_000,
          },
        ).catch(() => undefined);
      removed += owned;
    }
  return removed;
}
