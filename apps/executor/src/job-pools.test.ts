import { describe, expect, it } from 'vitest';
import { executorJobConfig, JobPool } from './job-pools.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('JobPool', () => {
  it('o assistente continua a responder enquanto um run prolongado ocupa o pool de execução', async () => {
    let releaseRun!: () => void;
    const runBlocked = new Promise<void>((resolve) => (releaseRun = resolve));
    let runsStarted = 0;
    let answered = 0;
    const runs = new JobPool(
      'runs',
      async () => {
        runsStarted += 1;
        await runBlocked;
        return true;
      },
      { concurrency: 1, idleMs: 5 },
    ).start();
    const assistant = new JobPool(
      'assistant',
      async () => {
        answered += 1;
        return answered <= 5;
      },
      { concurrency: 1, idleMs: 5 },
    ).start();
    await wait(80);
    expect(runsStarted).toBe(1);
    expect(runs.active).toBe(1);
    expect(answered).toBeGreaterThanOrEqual(5);
    releaseRun();
    await Promise.all([runs.drain(1000), assistant.drain(1000)]);
  });

  it('a drenagem espera pelo job e, findo o prazo, pede-lhe que se devolva à fila', async () => {
    const seen: string[] = [];
    let claims = 0;
    const pool = new JobPool(
      'runs',
      (shutdown) => {
        claims += 1;
        return new Promise<boolean>((resolve) =>
          shutdown.addEventListener('abort', () => {
            seen.push('released');
            resolve(true);
          }),
        );
      },
      { concurrency: 1, idleMs: 5 },
    ).start();
    await wait(10);
    await pool.drain(30);
    expect(seen).toEqual(['released']);
    expect(claims).toBe(1);
    expect(pool.active).toBe(0);
  });

  it('em pausa (drenagem de rollout) não reclama jobs novos e retoma quando libertada', async () => {
    let draining = true;
    let claims = 0;
    const pool = new JobPool(
      'runs',
      async () => {
        claims += 1;
        return false;
      },
      { concurrency: 1, idleMs: 5, paused: () => draining },
    ).start();
    await wait(40);
    expect(claims).toBe(0);
    draining = false;
    await wait(40);
    expect(claims).toBeGreaterThan(0);
    await pool.drain(100);
  });

  it('usa valores iniciais conservadores e rejeita configurações fora dos limites', () => {
    const defaults = executorJobConfig({});
    expect(defaults).toMatchObject({
      leaseSeconds: 90,
      runConcurrency: 1,
      assistantConcurrency: 1,
      projectRunLimit: 2,
      maxAttempts: 2,
    });
    expect(defaults.workerId).toMatch(/^[A-Za-z0-9._:@-]{1,120}$/);
    expect(
      executorJobConfig({ ZEROOPS_JOB_LEASE_SECONDS: '5', ZEROOPS_EXECUTOR_RUN_CONCURRENCY: '99' }),
    ).toMatchObject({ leaseSeconds: 90, runConcurrency: 1 });
  });
});
