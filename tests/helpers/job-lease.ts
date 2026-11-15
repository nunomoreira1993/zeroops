import type { Database } from '../../packages/backend/src/database/database.js';
import type { JobLease } from '../../packages/backend/src/modules/agents/job-leases.js';

/**
 * Coloca um job em `running` com um lease válido de um worker de teste (simula o claim do
 * executor nos testes que avançam o estado diretamente) e devolve o lease a usar nas escritas.
 */
export async function leaseJob(
  db: Database,
  jobId: string,
  table: 'agent_runs' | 'flow_assistant_requests' = 'agent_runs',
  workerId = 'test-worker',
): Promise<JobLease> {
  await db.query(
    `UPDATE ${table} SET status='running',worker_id=$2,lease_epoch=lease_epoch+1,
       attempt=GREATEST(attempt,1),heartbeat_at=NOW(3),
       lease_until=DATE_ADD(NOW(3),INTERVAL 120 SECOND)
     WHERE id=$1`,
    [jobId, workerId],
  );
  const row = (
    await db.query<{ lease_epoch: number }>(`SELECT lease_epoch FROM ${table} WHERE id=$1`, [jobId])
  ).rows[0];
  return { jobId, workerId, epoch: Number(row?.lease_epoch ?? 0), leaseSeconds: 120 };
}
