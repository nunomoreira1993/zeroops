import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnvironment } from './copilot-process.js';
import { DevelopmentRunner } from './development-runner.js';
import {
  JobIdentityCleanupError,
  JobIdentityExhausted,
  JobIdentityPool,
  SharedIdentitySource,
  jobIdentitiesFromEnv,
  ownerOf,
  removeOwnedWorktrees,
  type SandboxSystem,
} from './job-sandbox.js';
import { WorkspaceManager, runCommand, worktreeAdminDir } from './workspace-manager.js';

class FakeSystem implements SandboxSystem {
  readonly calls: string[] = [];
  failPrepare = false;
  /** Worktrees residuais por uid (simulados) e falha injetada na sua remoção. */
  readonly worktrees = new Map<number, string[]>();
  failWorktrees = false;

  async prepareHome(path: string, uid: number) {
    this.calls.push(`prepare:${uid}`);
    if (this.failPrepare) throw new Error('mkdir falhou');
    void path;
  }
  async removeHome(path: string) {
    this.calls.push(`rmhome:${path.split(/[\\/]/).pop()}`);
  }
  async killProcesses(uid: number) {
    this.calls.push(`kill:${uid}`);
    return 0;
  }
  async removeOwnedEntries(directory: string, uid: number) {
    this.calls.push(`scratch:${directory}:${uid}`);
    return 0;
  }
  async removeOwnedWorktrees(root: string, uid: number) {
    this.calls.push(`worktrees:${root}:${uid}`);
    if (this.failWorktrees) throw new Error('EBUSY: worktree ocupado');
    const removed = this.worktrees.get(uid)?.length ?? 0;
    this.worktrees.delete(uid);
    return removed;
  }
}

const pool = (system: SandboxSystem, count = 2) =>
  new JobIdentityPool({
    uidBase: 61_000,
    count,
    homeRoot: '/var/lib/zeroops/jobs',
    scratchDirectories: ['/tmp'],
    system,
  });

describe('F02 — identidades exclusivas por job', () => {
  it('nenhum uid é partilhado por jobs ativos; esgotado o pool, o job volta à fila', async () => {
    const system = new FakeSystem();
    const identities = pool(system);
    const first = await identities.acquire();
    const second = await identities.acquire();
    expect(first.uid).not.toBe(second.uid);
    expect([first.uid, second.uid].sort()).toEqual([61_000, 61_001]);
    expect(first).toMatchObject({ gid: first.uid, private: true, exclusive: true });
    await expect(identities.acquire()).rejects.toBeInstanceOf(JobIdentityExhausted);
    await first.release();
    await first.release();
    expect(identities.active).toBe(1);
    const third = await identities.acquire();
    expect(third.uid).toBe(first.uid);
    // Antes de entregar e depois de libertar: processos, home e temporários do uid são apagados.
    const forUid = system.calls.filter((call) => call.endsWith(String(first.uid)));
    expect(forUid).toEqual([
      `kill:${first.uid}`,
      `rmhome:${first.uid}`,
      `scratch:/tmp:${first.uid}`,
      `prepare:${first.uid}`,
      `kill:${first.uid}`,
      `rmhome:${first.uid}`,
      `scratch:/tmp:${first.uid}`,
      `kill:${first.uid}`,
      `rmhome:${first.uid}`,
      `scratch:/tmp:${first.uid}`,
      `prepare:${first.uid}`,
    ]);
  });

  it('uma falha a preparar a home devolve o uid ao pool', async () => {
    const system = new FakeSystem();
    const identities = pool(system, 1);
    system.failPrepare = true;
    await expect(identities.acquire()).rejects.toThrow('mkdir falhou');
    expect(identities.active).toBe(0);
    system.failPrepare = false;
    expect((await identities.acquire()).uid).toBe(61_000);
  });

  it('uma falha de limpeza não recicla a identidade contaminada', async () => {
    const system = new FakeSystem();
    const identities = pool(system, 1);
    const identity = await identities.acquire();
    system.removeHome = async () => {
      throw new Error('home ainda ocupada');
    };
    await expect(identity.release()).rejects.toThrow('home ainda ocupada');
    expect(identities.active).toBe(1);
    await expect(identities.acquire()).rejects.toBeInstanceOf(JobIdentityExhausted);
  });

  it('a home privada isola estado do Copilot, configuração e temporários', async () => {
    const identity = await pool(new FakeSystem()).acquire();
    const env = agentEnvironment(
      { PATH: '/usr/bin', XDG_CONFIG_HOME: '/home/node/.config', SECRET: 'x' },
      identity,
    );
    expect(env.HOME).toBe(identity.home);
    for (const name of ['COPILOT_HOME', 'XDG_CONFIG_HOME', 'TMPDIR'])
      expect(env[name]?.startsWith(identity.home)).toBe(true);
    expect(env.SECRET).toBeUndefined();
    expect(ownerOf(identity)).toEqual({
      uid: identity.uid,
      gid: identity.uid,
      tmpDir: join(identity.home, 'tmp'),
    });
    // Identidade partilhada antiga: sem home privada (compatibilidade).
    const shared = await new SharedIdentitySource({
      uid: 1001,
      gid: 1001,
      home: '/home/agent',
    }).acquire();
    expect(shared).toMatchObject({ exclusive: false });
    expect(agentEnvironment({}, shared!).COPILOT_HOME).toBeUndefined();
    expect(ownerOf(shared)).toEqual({ uid: 1001, gid: 1001 });
    expect(await new SharedIdentitySource(undefined).acquire()).toBeNull();
  });

  it('sem ZEROOPS_JOB_UID_BASE mantém o modo partilhado; valores inválidos são recusados', () => {
    expect(jobIdentitiesFromEnv({}, undefined)).toBeInstanceOf(SharedIdentitySource);
    expect(
      () =>
        new JobIdentityPool({ uidBase: 10, count: 4, homeRoot: '/x', system: new FakeSystem() }),
    ).toThrow(/UID_BASE/);
    expect(
      () =>
        new JobIdentityPool({
          uidBase: 61_000,
          count: 0,
          homeRoot: '/x',
          system: new FakeSystem(),
        }),
    ).toThrow(/UID_COUNT/);
  });
});

describe('F02 — limpeza confirmada antes de reutilizar o uid', () => {
  const clockedPool = (
    system: SandboxSystem,
    count: number,
    clock: { now: number },
    log: unknown[],
  ) =>
    new JobIdentityPool({
      uidBase: 61_000,
      count,
      homeRoot: '/var/lib/zeroops/jobs',
      scratchDirectories: ['/tmp'],
      worktreeRoots: ['/ws'],
      recoveryDelayMs: 1000,
      system,
      now: () => clock.now,
      log: (event) => log.push(event),
    });

  it('uma falha a remover o worktree deixa o uid em quarentena; recupera só com limpeza confirmada', async () => {
    const system = new FakeSystem();
    const clock = { now: 1_000_000 };
    const log: Record<string, unknown>[] = [];
    const identities = clockedPool(system, 1, clock, log);
    const identity = await identities.acquire();
    system.worktrees.set(identity.uid, ['/ws/p/w/attempts/r1-1']);
    system.failWorktrees = true;
    system.calls.length = 0;
    await expect(identity.release()).rejects.toBeInstanceOf(JobIdentityCleanupError);
    // Os restantes passos correram apesar da falha; processos voltam a ser terminados no fim.
    expect(system.calls).toEqual([
      'kill:61000',
      'rmhome:61000',
      'scratch:/tmp:61000',
      'worktrees:/ws:61000',
      'kill:61000',
    ]);
    expect(identities.quarantined).toMatchObject([
      { uid: 61_000, attempts: 1, failures: [{ step: 'worktrees:/ws' }] },
    ]);
    expect(log).toContainEqual(expect.objectContaining({ event: 'job_identity.quarantined' }));
    // Não reutilizado: nem antes do intervalo de recuperação nem com nova falha.
    await expect(identities.acquire()).rejects.toBeInstanceOf(JobIdentityExhausted);
    clock.now += 1001;
    await expect(identities.acquire()).rejects.toBeInstanceOf(JobIdentityExhausted);
    expect(identities.quarantined[0]!.attempts).toBe(2);
    expect(system.worktrees.get(61_000)).toEqual(['/ws/p/w/attempts/r1-1']);
    // Limpeza confirmada: o uid volta ao pool, sem restos.
    system.failWorktrees = false;
    clock.now += 2001;
    const reused = await identities.acquire();
    expect(reused.uid).toBe(61_000);
    expect(system.worktrees.has(61_000)).toBe(false);
    expect(identities.quarantined).toEqual([]);
    expect(log).toContainEqual(expect.objectContaining({ event: 'job_identity.recovered' }));
  });

  it('depois de um reinício do executor, um uid com restos por limpar é saltado e isolado', async () => {
    const system = new FakeSystem();
    system.worktrees.set(61_000, ['/ws/p/w/attempts/antigo']);
    system.failWorktrees = true;
    const clock = { now: 0 };
    const identities = clockedPool(system, 2, clock, []);
    await expect(identities.acquire()).rejects.toBeInstanceOf(JobIdentityExhausted);
    system.failWorktrees = false;
    system.worktrees.set(61_000, ['/ws/p/w/attempts/antigo']);
    // Pool novo (reinício): cada uid é limpo antes da primeira utilização.
    const restarted = clockedPool(system, 2, clock, []);
    const identity = await restarted.acquire();
    expect(identity.uid).toBe(61_000);
    expect(system.worktrees.has(61_000)).toBe(false);
  });

  it('worktree real: release propaga a falha de remoção e o uid só volta com o worktree apagado', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeroops-f02-'));
    try {
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
      const source = join(root, 'source');
      await mkdir(source);
      git(source, 'init', '-q', '-b', 'main');
      await writeFile(join(source, 'a.txt'), 'a\n');
      git(source, 'add', '.');
      git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
      const workspaces = join(root, 'workspaces');
      const manager = new WorkspaceManager(workspaces);
      const { gitDir, remoteBaseSha } = await manager.fetchBase({
        projectId: randomUUID(),
        workspaceId: randomUUID(),
        url: source,
        baseBranch: 'main',
        credential: null,
      });
      const checkout = await manager.checkout(gitDir, 'run1-1', remoteBaseSha);
      await writeFile(join(checkout.path, 'residuo.txt'), 'segredo do job\n');
      const releases: string[] = [];
      const runner = new DevelopmentRunner(
        {
          releaseWorkspace: async (_lease: unknown, workspaceId: string) => {
            releases.push(workspaceId);
          },
        } as never,
        manager,
      );
      manager.removeCheckout = async () => {
        throw new Error('EBUSY: remoção injetada');
      };
      const prepared = {
        runId: 'run1',
        context: { workspace: { id: 'w1' } },
        checkout,
      } as never;
      await expect(runner.release(prepared, {} as never, false)).rejects.toThrow(
        /remoção injetada/,
      );
      expect(releases).toEqual(['w1']);
      await expect(readFile(join(checkout.path, 'residuo.txt'), 'utf8')).resolves.toContain(
        'segredo',
      );

      // Pool: o uid do job (61000) é o dono real dos ficheiros do worktree.
      const ownerUid = (await lstat(checkout.path)).uid;
      const system = new FakeSystem();
      let mode: 'idle' | 'fail' | 'real' = 'idle';
      system.removeOwnedWorktrees = async (directory, uid) => {
        if (mode === 'idle') return 0;
        if (mode === 'fail') throw new Error('EBUSY: worktree ocupado');
        return removeOwnedWorktrees(directory, uid === 61_000 ? ownerUid : -1);
      };
      const clock = { now: 0 };
      const pool = new JobIdentityPool({
        uidBase: 61_000,
        count: 1,
        homeRoot: join(root, 'homes'),
        worktreeRoots: [workspaces],
        recoveryDelayMs: 10,
        system,
        now: () => clock.now,
      });
      const identity = await pool.acquire();
      mode = 'fail';
      await expect(identity.release()).rejects.toBeInstanceOf(JobIdentityCleanupError);
      await expect(pool.acquire()).rejects.toBeInstanceOf(JobIdentityExhausted);
      await expect(readFile(join(checkout.path, 'residuo.txt'), 'utf8')).resolves.toContain(
        'segredo',
      );
      mode = 'real';
      clock.now += 20;
      expect((await pool.acquire()).uid).toBe(61_000);
      await expect(lstat(checkout.path)).rejects.toThrow();
      // O repositório bare (commits e branches) fica.
      expect((await lstat(join(gitDir, 'HEAD'))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('removeOwnedWorktrees só remove worktrees do uid indicado', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zeroops-wt-'));
    try {
      const attempts = join(root, 'p', 'w', 'attempts');
      await mkdir(join(attempts, 'r1-1'), { recursive: true });
      await mkdir(join(root, 'p', 'w', 'repo.git'), { recursive: true });
      const uid = (await lstat(join(attempts, 'r1-1'))).uid;
      expect(await removeOwnedWorktrees(root, uid + 12_345)).toBe(0);
      expect(await removeOwnedWorktrees(join(root, 'nao-existe'), uid)).toBe(0);
      expect(await removeOwnedWorktrees(root, uid)).toBe(1);
      await expect(lstat(join(attempts, 'r1-1'))).rejects.toThrow();
      expect((await lstat(join(root, 'p', 'w', 'repo.git'))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('F02/F04 — workspace e processos', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'zeroops-sandbox-'));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('um comando abortado termina de imediato com a árvore de processos', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = runCommand({
      command: 'node -e "setTimeout(() => {}, 60000)"',
      cwd: root,
      timeoutMs: 120_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    // Já abortado antes de começar: nem arranca.
    const before = await runCommand({
      command: "node -e \"require('fs').writeFileSync('nao-devia.txt', 'x')\"",
      cwd: root,
      timeoutMs: 10_000,
      signal: AbortSignal.abort(),
    });
    expect(before.aborted).toBe(true);
    await expect(readFile(join(root, 'nao-devia.txt'))).rejects.toThrow();
  });

  it('o executor não segue um `.git` do worktree que aponte para fora do bare', async () => {
    const gitDir = join(root, 'repo.git');
    await mkdir(join(gitDir, 'worktrees', 'a1'), { recursive: true });
    await mkdir(join(root, 'outro', 'admin'), { recursive: true });
    const attempt = join(root, 'tentativa');
    await mkdir(attempt, { recursive: true });
    await writeFile(join(attempt, '.git'), `gitdir: ${join(root, 'outro', 'admin')}\n`);
    await expect(worktreeAdminDir(gitDir, attempt)).rejects.toThrow(/inesperado/);
    await writeFile(
      join(attempt, '.git'),
      `gitdir: ${join(gitDir, 'worktrees', '..', '..', 'outro', 'admin')}\n`,
    );
    await expect(worktreeAdminDir(gitDir, attempt)).rejects.toThrow(/inesperado/);
    await writeFile(join(attempt, '.git'), `gitdir: ${join(gitDir, 'worktrees', 'a1')}\n`);
    expect(await worktreeAdminDir(gitDir, attempt)).toMatch(/a1$/);
  });
});
