import { flowScenarioSpecSchema } from '../../../../contracts/src/index.js';
import type { FlowSimulationResultView } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import type { Queryable } from '../identity/membership.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  LOCAL_WORKER,
  OWNED_BY,
  recordJobEvent,
  validateWorker,
  type FencedOutcome,
  type HeartbeatState,
  type JobEventType,
  type JobLease,
  type WorkerIdentity,
} from '../agents/job-leases.js';
import type { ClaimedAssistantRequest } from './flow-assistant.js';
import { applyRoutingReply } from './flow-simulator.js';
import {
  finishSimulationResult,
  type CopilotRoutingRunInput,
  type SimulationRunRow,
} from './flow-simulation.service.js';

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Fila das avaliações do encaminhamento com o Copilot real (P07). Mesmo modelo de leases do P03:
 * claim atómico, heartbeat, fencing por época, cancelamento e recuperação. Só a tentativa atual
 * grava a resposta observada; uma falha nunca produz uma escolha.
 */
export class FlowSimulationQueue {
  constructor(private readonly db: Database) {}

  /** Reclama a próxima avaliação em fila, com lease e época novos. */
  async claimNext(worker: WorkerIdentity = LOCAL_WORKER): Promise<ClaimedAssistantRequest | null> {
    validateWorker(worker);
    return this.db.transaction(async (client) => {
      const job = (
        await client.query<SimulationRunRow>(
          `SELECT * FROM flow_simulation_runs WHERE status='queued' AND available_at<=NOW(3)
            ORDER BY available_at,created_at LIMIT 1 FOR UPDATE`,
        )
      ).rows[0];
      if (!job) return null;
      const input = json<CopilotRoutingRunInput>(job.run_input);
      if (!input?.prompt) {
        await client.query(
          "UPDATE flow_simulation_runs SET status='failed',error_code='context_unavailable',finished_at=NOW(3) WHERE id=$1",
          [job.id],
        );
        return null;
      }
      await client.query(
        `UPDATE flow_simulation_runs SET status='running', started_at=COALESCE(started_at,NOW(3)),
           worker_id=$2, lease_epoch=lease_epoch+1, attempt=attempt+1,
           lease_until=TIMESTAMPADD(SECOND,$3,NOW(3)), heartbeat_at=NOW(3)
         WHERE id=$1 AND status='queued'`,
        [job.id, worker.workerId, worker.leaseSeconds],
      );
      const owned = (
        await client.query<{ lease_epoch: number; attempt: number }>(
          'SELECT lease_epoch,attempt FROM flow_simulation_runs WHERE id=$1',
          [job.id],
        )
      ).rows[0]!;
      const lease: JobLease = {
        jobId: job.id,
        workerId: worker.workerId,
        epoch: Number(owned.lease_epoch),
        leaseSeconds: worker.leaseSeconds,
      };
      await this.event(client, job, lease, Number(owned.attempt), 'claimed');
      return {
        id: job.id,
        projectId: job.project_id,
        scope: 'simulation',
        prompt: input.prompt,
        lease,
      };
    });
  }

  /** Renova o lease; um cancelamento ou nova época faz o executor perder a posse. */
  async heartbeat(lease: JobLease): Promise<HeartbeatState> {
    const renewed = await this.db.query(
      `UPDATE flow_simulation_runs SET lease_until=TIMESTAMPADD(SECOND,$4,NOW(3)), heartbeat_at=NOW(3)
       WHERE ${OWNED_BY()}`,
      [lease.jobId, lease.workerId, lease.epoch, lease.leaseSeconds],
    );
    if (renewed.rowCount) return { owned: true, cancelRequested: false };
    await this.rejectStale(this.db, lease, 'lease_lost');
    return { owned: false, cancelRequested: true };
  }

  /** Grava a resposta observada (validada como no P05) e recalcula a comparação. */
  async complete(lease: JobLease, text: string): Promise<FencedOutcome> {
    return this.owned(lease, 'completed', async (client, job) => {
      const spec = flowScenarioSpecSchema.parse(json(job.scenario_spec) ?? {});
      const stored = json<FlowSimulationResultView>(job.result);
      if (!stored?.routing) throw new Error('Resultado da simulação inválido.');
      const finished = finishSimulationResult(
        { ...stored, routing: applyRoutingReply(stored.routing, text, 'copilot') },
        spec,
      );
      await client.query(
        `UPDATE flow_simulation_runs SET status='completed',result=$2,comparison=$3,verdict=$4,
                finished_at=NOW(3),lease_until=NULL WHERE id=$1`,
        [
          job.id,
          JSON.stringify(finished.result),
          JSON.stringify(finished.comparison),
          finished.comparison.verdict,
        ],
      );
      await this.event(client, job, lease, Number(job.attempt), 'completed', {
        decision: finished.result.routing?.decision ?? null,
      });
    });
  }

  /** Falha da tentativa atual: o encaminhamento fica por avaliar (nunca uma escolha arbitrária). */
  async fail(lease: JobLease, code: string): Promise<FencedOutcome> {
    return this.owned(lease, 'failed', async (client, job) => {
      await client.query(
        "UPDATE flow_simulation_runs SET status='failed',error_code=$2,finished_at=NOW(3),lease_until=NULL WHERE id=$1",
        [job.id, clip(code, 100)],
      );
      await this.event(client, job, lease, Number(job.attempt), 'failed', { code });
    });
  }

  /** Devolve a avaliação à fila sem consumir tentativa (paragem ordenada do executor). */
  async release(lease: JobLease, reason = 'shutdown'): Promise<FencedOutcome> {
    return this.db.transaction(async (client) => {
      const job = (
        await client.query<SimulationRunRow>(
          `SELECT * FROM flow_simulation_runs WHERE ${OWNED_BY()} FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!job) return this.rejectStale(client, lease, 'stale_attempt_rejected');
      await client.query(
        `UPDATE flow_simulation_runs SET status='queued', worker_id=NULL, lease_until=NULL,
           heartbeat_at=NULL, attempt=GREATEST(attempt-1,0) WHERE id=$1`,
        [job.id],
      );
      await this.event(client, job, lease, Number(job.attempt), 'released', { reason });
      return 'accepted';
    });
  }

  /** Avaliações com lease expirado voltam à fila uma vez; depois falham como interrompidas. */
  async recoverExpired(maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    const outcome = { requeued: 0, failed: 0 };
    const expired = await this.db.query<{ id: string }>(
      "SELECT id FROM flow_simulation_runs WHERE status='running' AND (lease_until IS NULL OR lease_until<=NOW(3)) LIMIT 50",
    );
    for (const { id } of expired.rows)
      await this.db.transaction(async (client) => {
        const job = (
          await client.query<SimulationRunRow>(
            `SELECT * FROM flow_simulation_runs WHERE id=$1 AND status='running'
               AND (lease_until IS NULL OR lease_until<=NOW(3)) FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!job) return;
        const lease: JobLease = {
          jobId: id,
          workerId: job.worker_id ?? '',
          epoch: Number(job.lease_epoch),
          leaseSeconds: 0,
        };
        if (Number(job.attempt) < maxAttempts) {
          await client.query(
            "UPDATE flow_simulation_runs SET status='queued', worker_id=NULL, lease_until=NULL, heartbeat_at=NULL WHERE id=$1",
            [id],
          );
          await this.event(client, job, lease, Number(job.attempt), 'lease_expired_requeued');
          outcome.requeued += 1;
          return;
        }
        await client.query(
          "UPDATE flow_simulation_runs SET status='failed',error_code='interrupted',finished_at=NOW(3),lease_until=NULL WHERE id=$1",
          [id],
        );
        await this.event(client, job, lease, Number(job.attempt), 'lease_expired_failed');
        outcome.failed += 1;
      });
    return outcome;
  }

  private async owned(
    lease: JobLease,
    terminal: 'completed' | 'failed',
    apply: (client: Queryable, job: SimulationRunRow) => Promise<void>,
  ): Promise<FencedOutcome> {
    return this.db.transaction(async (client) => {
      const job = (
        await client.query<SimulationRunRow>(
          `SELECT * FROM flow_simulation_runs WHERE ${OWNED_BY()} FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!job) return this.rejectStale(client, lease, 'stale_attempt_rejected', terminal);
      await apply(client, job);
      return 'accepted';
    });
  }

  private async rejectStale(
    client: Queryable,
    lease: JobLease,
    type: JobEventType,
    terminal?: string,
  ): Promise<FencedOutcome> {
    const row = (
      await client.query<SimulationRunRow>('SELECT * FROM flow_simulation_runs WHERE id=$1', [
        lease.jobId,
      ])
    ).rows[0];
    if (!row) return 'stale';
    if (
      terminal &&
      row.status === terminal &&
      row.worker_id === lease.workerId &&
      Number(row.lease_epoch) === lease.epoch
    )
      return 'duplicate';
    await this.event(client, row, lease, Number(row.attempt), type, {
      currentEpoch: Number(row.lease_epoch),
      currentStatus: row.status,
    });
    return 'stale';
  }

  private async event(
    client: Queryable,
    job: SimulationRunRow,
    lease: JobLease,
    attempt: number,
    type: JobEventType,
    details?: Record<string, unknown>,
  ) {
    await recordJobEvent(client, {
      kind: 'flow_simulation',
      jobId: job.id,
      projectId: job.project_id,
      attempt,
      epoch: lease.epoch,
      workerId: lease.workerId || null,
      type,
      details,
    });
  }
}
