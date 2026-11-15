import type { Queryable } from '../identity/membership.js';

/** Executor que reclama tentativas: identificador estável no processo e duração do lease. */
export interface WorkerIdentity {
  workerId: string;
  /** Duração do lease; o executor renova-o com heartbeats bem antes de expirar. */
  leaseSeconds: number;
}

/**
 * Posse de uma tentativa. `epoch` é o fencing token: cresce em cada claim ou recuperação e todas
 * as escritas do executor exigem a época atual com lease válido.
 */
export interface JobLease {
  jobId: string;
  workerId: string;
  epoch: number;
  /** Duração usada nas renovações (heartbeat). */
  leaseSeconds: number;
}

/** Resultado de uma escrita protegida pela posse da tentativa. */
export type FencedOutcome = 'accepted' | 'duplicate' | 'stale';

/** Estado devolvido pelo heartbeat: perdeu a posse ou foi pedido o cancelamento. */
export interface HeartbeatState {
  owned: boolean;
  cancelRequested: boolean;
}

export type JobKind = 'agent_run' | 'flow_assistant' | 'ticket_routing' | 'flow_simulation';

export type JobEventType =
  | 'claimed'
  | 'lease_lost'
  | 'lease_expired_requeued'
  | 'lease_expired_failed'
  | 'lease_expired_cancelled'
  | 'released'
  | 'cancel_requested'
  | 'stale_attempt_rejected'
  | 'completed'
  | 'failed';

/** Worker usado por testes e ferramentas locais; o executor define sempre o seu próprio. */
export const LOCAL_WORKER: WorkerIdentity = { workerId: 'local', leaseSeconds: 120 };

/** Máximo de tentativas antes de um lease expirado falhar o job (1 original + 1 recuperação). */
export const DEFAULT_MAX_ATTEMPTS = 2;

/** Condição SQL de posse atual (`$1` id, `$2` worker, `$3` época) para a tabela indicada. */
export const OWNED_BY = (alias = '') =>
  `${alias}id=$1 AND ${alias}status='running' AND ${alias}worker_id=$2 AND ${alias}lease_epoch=$3 AND ${alias}lease_until>NOW(3)`;

/** Valida o worker antes de o gravar (evita IDs vazios ou leases absurdos). */
export function validateWorker(worker: WorkerIdentity) {
  if (!/^[A-Za-z0-9._:@-]{1,120}$/.test(worker.workerId))
    throw new Error('Identificador de worker inválido.');
  if (
    !Number.isInteger(worker.leaseSeconds) ||
    worker.leaseSeconds < 5 ||
    worker.leaseSeconds > 3600
  )
    throw new Error('Duração do lease inválida.');
  return worker;
}

/** Regista um evento correlacionado do ciclo de vida de uma tentativa. */
export async function recordJobEvent(
  client: Queryable,
  event: {
    kind: JobKind;
    jobId: string;
    projectId: string;
    ticketId?: string | null;
    flowStepId?: string | null;
    attempt?: number;
    epoch?: number;
    workerId?: string | null;
    type: JobEventType;
    details?: Record<string, unknown>;
  },
) {
  await client.query(
    `INSERT INTO agent_job_events(job_kind,job_id,project_id,ticket_id,flow_step_id,attempt,lease_epoch,worker_id,event_type,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      event.kind,
      event.jobId,
      event.projectId,
      event.ticketId ?? null,
      event.flowStepId ?? null,
      event.attempt ?? 0,
      event.epoch ?? 0,
      event.workerId ?? null,
      event.type,
      event.details ? JSON.stringify(event.details) : null,
    ],
  );
}
