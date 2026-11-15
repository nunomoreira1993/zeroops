import type { QueryResult, QueryResultRow } from './sql-client.js';

interface Queryable {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

/** Detentor de um lock durável: entrega, intervenção Health ou outro trabalho com identidade. */
export interface LockHolder {
  kind: 'delivery' | 'intervention';
  id: string;
  projectId: string | null;
}

export type LockAttempt =
  | { acquired: true; epoch: number }
  | { acquired: false; holder: { kind: string; id: string; projectId: string | null } };

/** Chave do lock da Saúde: o recurso real (host + unidade), partilhado entre projetos. */
export const healthResourceKey = (host: string, unit: string | null) =>
  `health:${host.toLowerCase()}|${(unit ?? '*').toLowerCase()}`;

/** Chave do lock de integração: repositório e branch de destino. */
export const integrationLockKey = (repositoryId: string, branch: string) =>
  `integrate:${repositoryId}:${branch}`;

/** Chave do lock do ambiente de publicação de uma pipeline. */
export const environmentLockKey = (pipelineId: string, environment: string) =>
  `env:${pipelineId}:${environment}`;

/**
 * Obtém (ou renova, se já for o detentor) um lock durável. Um lock expirado pode ser tomado: a
 * época cresce e o detentor anterior perde-o. Corre na transação do chamador (sem I/O externo).
 */
export async function acquireResourceLock(
  client: Queryable,
  key: string,
  holder: LockHolder,
  ttlSeconds: number,
): Promise<LockAttempt> {
  const ttl = Math.max(5, Math.min(Math.round(ttlSeconds), 7 * 24 * 3600));
  const current = (
    await client.query<{
      holder_kind: string;
      holder_id: string;
      project_id: string | null;
      epoch: number;
      expired: number;
    }>(
      `SELECT holder_kind,holder_id,project_id,epoch,expires_at<=NOW(3) AS expired
         FROM resource_locks WHERE lock_key=$1 FOR UPDATE`,
      [key],
    )
  ).rows[0];
  if (!current) {
    try {
      await client.query(
        `INSERT INTO resource_locks(lock_key,holder_kind,holder_id,project_id,epoch,expires_at)
         VALUES($1,$2,$3,$4,1,TIMESTAMPADD(SECOND,$5,NOW(3)))`,
        [key, holder.kind, holder.id, holder.projectId, ttl],
      );
      return { acquired: true, epoch: 1 };
    } catch (error) {
      if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
      const winner = await resourceLockHolder(client, key);
      return {
        acquired: false,
        holder: {
          kind: winner?.holder_kind ?? 'unknown',
          id: winner?.holder_id ?? '',
          projectId: winner?.project_id ?? null,
        },
      };
    }
  }
  const same = current.holder_kind === holder.kind && current.holder_id === holder.id;
  if (!same && !Number(current.expired))
    return {
      acquired: false,
      holder: { kind: current.holder_kind, id: current.holder_id, projectId: current.project_id },
    };
  const epoch = same ? Number(current.epoch) : Number(current.epoch) + 1;
  await client.query(
    `UPDATE resource_locks SET holder_kind=$2,holder_id=$3,project_id=$4,epoch=$5,
       acquired_at=CASE WHEN $6=1 THEN acquired_at ELSE NOW(3) END,
       expires_at=TIMESTAMPADD(SECOND,$7,NOW(3))
     WHERE lock_key=$1`,
    [key, holder.kind, holder.id, holder.projectId, epoch, same ? 1 : 0, ttl],
  );
  return { acquired: true, epoch };
}

/** Liberta o lock apenas se ainda pertencer ao detentor indicado. */
export async function releaseResourceLock(
  client: Queryable,
  key: string,
  holder: Pick<LockHolder, 'kind' | 'id'>,
) {
  const result = await client.query(
    'DELETE FROM resource_locks WHERE lock_key=$1 AND holder_kind=$2 AND holder_id=$3',
    [key, holder.kind, holder.id],
  );
  return result.rowCount > 0;
}

/** Liberta todos os locks de um detentor (fim da entrega ou da intervenção). */
export async function releaseLocksOf(client: Queryable, holder: Pick<LockHolder, 'kind' | 'id'>) {
  await client.query('DELETE FROM resource_locks WHERE holder_kind=$1 AND holder_id=$2', [
    holder.kind,
    holder.id,
  ]);
}

/** Detentor atual de um lock (expirado ou não), para mostrar filas e recusas. */
export async function resourceLockHolder(client: Queryable, key: string) {
  return (
    (
      await client.query<{
        holder_kind: string;
        holder_id: string;
        project_id: string | null;
        expires_at: Date;
      }>(
        'SELECT holder_kind,holder_id,project_id,expires_at FROM resource_locks WHERE lock_key=$1',
        [key],
      )
    ).rows[0] ?? null
  );
}
