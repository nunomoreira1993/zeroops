import { chmod, chown, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentIdentity } from './copilot-process.js';

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

/** Operações de sistema do pool (injetáveis nos testes). */
export interface SandboxSystem {
  prepareHome(path: string, uid: number, gid: number): Promise<void>;
  removeHome(path: string): Promise<void>;
  /** Termina todos os processos cujo uid real ou efetivo é `uid`; devolve quantos encontrou. */
  killProcesses(uid: number): Promise<number>;
  /** Remove as entradas de topo de `directory` que pertencem a `uid` (ex.: `/tmp`, `/dev/shm`). */
  removeOwnedEntries(directory: string, uid: number): Promise<number>;
}

export interface JobIdentityPoolOptions {
  uidBase: number;
  count: number;
  /** Raiz das homes privadas (`<homeRoot>/<uid>`), propriedade de root e sem listagem. */
  homeRoot: string;
  /** Diretórios partilhados onde um job pode deixar ficheiros (limpos no fim do job). */
  scratchDirectories?: string[];
  system?: SandboxSystem;
}

/**
 * Pool de uids exclusivos (P-A/F02). Cada job recebe um uid livre e uma home nova `0700`; no fim
 * os processos do uid são terminados e a home e os temporários do uid são apagados antes de o uid
 * voltar ao pool. Pressupõe um único executor por intervalo de uids (o pool é em memória).
 */
export class JobIdentityPool implements JobIdentitySource {
  private readonly inUse = new Set<number>();
  private next = 0;
  private readonly system: SandboxSystem;

  constructor(private readonly options: JobIdentityPoolOptions) {
    if (!Number.isInteger(options.uidBase) || options.uidBase < 1000)
      throw new Error('ZEROOPS_JOB_UID_BASE inválido (mínimo 1000).');
    if (!Number.isInteger(options.count) || options.count < 1 || options.count > 65_536)
      throw new Error('ZEROOPS_JOB_UID_COUNT inválido.');
    this.system = options.system ?? linuxSandboxSystem;
  }

  get size() {
    return this.options.count;
  }

  get active() {
    return this.inUse.size;
  }

  async acquire(): Promise<JobIdentity> {
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
    const home = join(this.options.homeRoot, String(uid));
    try {
      // Restos de um job anterior com este uid (ex.: executor reiniciado a meio) nunca passam.
      await this.scrub(uid, home);
      await this.system.prepareHome(home, uid, uid);
    } catch (error) {
      this.inUse.delete(uid);
      throw error;
    }
    let released = false;
    return {
      uid,
      gid: uid,
      home,
      private: true,
      exclusive: true,
      release: async () => {
        if (released) return;
        await this.scrub(uid, home);
        released = true;
        this.inUse.delete(uid);
      },
    };
  }

  private async scrub(uid: number, home: string) {
    await this.system.killProcesses(uid);
    await this.system.removeHome(home);
    for (const directory of this.options.scratchDirectories ?? [])
      await this.system.removeOwnedEntries(directory, uid);
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
): JobIdentitySource {
  if (!env.ZEROOPS_JOB_UID_BASE) return new SharedIdentitySource(shared);
  if (process.platform === 'win32') throw new Error('O pool de uids exige Linux.');
  return new JobIdentityPool({
    uidBase: Number(env.ZEROOPS_JOB_UID_BASE),
    count: Number(env.ZEROOPS_JOB_UID_COUNT ?? 64),
    homeRoot: env.ZEROOPS_JOB_HOME_ROOT ?? '/home/node/jobs',
    scratchDirectories: (env.ZEROOPS_JOB_SCRATCH_DIRS ?? '/tmp,/dev/shm')
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean),
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
    for (const entry of await readdir(directory)) {
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
};
