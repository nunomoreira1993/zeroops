import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentEnvironment } from './copilot-process.js';
import {
  JobIdentityExhausted,
  JobIdentityPool,
  SharedIdentitySource,
  jobIdentitiesFromEnv,
  ownerOf,
  type SandboxSystem,
} from './job-sandbox.js';
import { runCommand, worktreeAdminDir } from './workspace-manager.js';

class FakeSystem implements SandboxSystem {
  readonly calls: string[] = [];
  failPrepare = false;

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
