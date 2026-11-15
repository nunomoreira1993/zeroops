import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Configuração dos pools e leases do executor, lida do ambiente com valores conservadores. */
export interface ExecutorJobConfig {
  workerId: string;
  leaseSeconds: number;
  runConcurrency: number;
  assistantConcurrency: number;
  routingConcurrency: number;
  projectRunLimit: number;
  maxAttempts: number;
  recoveryMs: number;
  drainMs: number;
  idleMs: number;
}

function bounded(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Lê `ZEROOPS_*` (worker, lease, concorrência, recuperação e drenagem). */
export function executorJobConfig(env: NodeJS.ProcessEnv): ExecutorJobConfig {
  const workerId = (
    env.ZEROOPS_WORKER_ID || `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  )
    .replace(/[^A-Za-z0-9._:@-]/g, '-')
    .slice(0, 120);
  return {
    workerId,
    leaseSeconds: bounded(env.ZEROOPS_JOB_LEASE_SECONDS, 90, 15, 3600),
    runConcurrency: bounded(env.ZEROOPS_EXECUTOR_RUN_CONCURRENCY, 1, 1, 8),
    assistantConcurrency: bounded(env.ZEROOPS_EXECUTOR_ASSISTANT_CONCURRENCY, 1, 1, 8),
    routingConcurrency: bounded(env.ZEROOPS_EXECUTOR_ROUTING_CONCURRENCY, 1, 1, 8),
    projectRunLimit: bounded(env.ZEROOPS_JOB_PROJECT_RUN_LIMIT, 2, 1, 32),
    maxAttempts: bounded(env.ZEROOPS_JOB_MAX_ATTEMPTS, 2, 1, 5),
    recoveryMs: bounded(env.ZEROOPS_JOB_RECOVERY_MS, 30000, 1000, 600000),
    drainMs: bounded(env.ZEROOPS_EXECUTOR_DRAIN_MS, 20000, 0, 600000),
    idleMs: bounded(env.ZEROOPS_EXECUTOR_IDLE_MS, 3000, 100, 60000),
  };
}

/** Unidade de trabalho de um pool: processa no máximo um job e indica se havia trabalho. */
export type JobStep = (shutdown: AbortSignal) => Promise<boolean>;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Pool com capacidade própria (ex.: assistente interativo vs. runs prolongados), para que um job
 * longo num pool nunca bloqueie o outro. `stop()` deixa de reclamar; `drain()` espera pelos jobs em
 * curso e, findo o prazo, sinaliza `shutdown` para os devolver à fila.
 */
export class JobPool {
  private readonly loops: Promise<void>[] = [];
  private readonly claiming = new AbortController();
  private readonly shutdown = new AbortController();
  private busy = 0;

  constructor(
    readonly name: string,
    private readonly step: JobStep,
    private readonly options: {
      concurrency: number;
      idleMs: number;
      onError?: (error: unknown) => void;
      /** Drenagem de rollout: enquanto devolver true o pool não reclama jobs novos. */
      paused?: () => boolean;
    },
  ) {}

  /** Número de jobs em execução neste momento. */
  get active() {
    return this.busy;
  }

  /** Arranca `concurrency` ciclos independentes. */
  start() {
    for (let index = 0; index < this.options.concurrency; index += 1) this.loops.push(this.loop());
    return this;
  }

  /** Deixa de reclamar novos jobs (os que estão em curso continuam). */
  stop() {
    this.claiming.abort();
  }

  /** Espera pelos jobs em curso até `ms`; depois pede-lhes que se devolvam à fila e termina. */
  async drain(ms: number) {
    this.stop();
    const all = Promise.all(this.loops);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      all.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) this.shutdown.abort();
    await all;
  }

  private async loop() {
    while (!this.claiming.signal.aborted) {
      if (this.options.paused?.()) {
        await sleep(this.options.idleMs, this.claiming.signal);
        continue;
      }
      let worked = false;
      this.busy += 1;
      try {
        worked = await this.step(this.shutdown.signal);
      } catch (error) {
        this.options.onError?.(error);
        await sleep(this.options.idleMs * 3, this.claiming.signal);
      } finally {
        this.busy -= 1;
      }
      if (!worked) await sleep(this.options.idleMs, this.claiming.signal);
    }
  }
}
