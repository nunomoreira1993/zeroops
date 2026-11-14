import type { SqlClient } from './sql-client.js';

/** Current, project-scoped ticket lease; locking reads also guard concurrent lease changes. */
export async function ticketWorkPaused(db: Pick<SqlClient, 'query'>, projectId: string) {
  return (
    (
      await db.query(
        'SELECT project_id FROM ticket_purge_maintenance WHERE project_id=$1 AND lease_until>NOW(3) LOCK IN SHARE MODE',
        [projectId],
      )
    ).rowCount > 0
  );
}
