import type { Queryable } from '../identity/membership.js';
export { ticketWorkPaused } from '../../database/ticket-maintenance.js';

export interface HealthOccurrence {
  source: 'internal' | 'prometheus';
  alertId: string;
}

/** Match the occurrence, not merely the alert fingerprint (which is reused after recovery). */
export async function healthOccurrenceSuppressed(
  db: Queryable,
  projectId: string,
  occurrence: HealthOccurrence,
) {
  const external = occurrence.source === 'prometheus';
  const found = await db.query(
    `SELECT a.id FROM ${external ? 'health_external_alerts' : 'health_alerts'} a
       JOIN ticket_purge_health_occurrences p
         ON p.project_id=a.project_id AND p.alert_id=a.id AND p.source=$3
        AND p.occurrence_at=a.${external ? 'starts_at' : 'opened_at'}
      WHERE a.project_id=$1 AND a.id=$2
        AND ${external ? "a.state='firing'" : 'a.resolved_at IS NULL'}`,
    [projectId, occurrence.alertId, occurrence.source],
  );
  return found.rowCount > 0;
}
