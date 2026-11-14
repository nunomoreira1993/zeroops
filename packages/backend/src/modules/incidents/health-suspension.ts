import { randomUUID } from 'node:crypto';
import type {
  HealthSuspensionState,
  HealthSuspensionView,
  IncidentEnvironmentKey,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import type { Queryable } from '../identity/membership.js';
import { appendAutomatedComment } from '../tickets/ticket-comments.js';

export interface ActiveSuspension {
  id: string;
  reason: string;
  suspendedBy: string;
  suspendedAt: Date;
}

/** Suspensão ativa da Saúde no projeto e ambiente (null quando a Saúde está a correr). */
export async function activeSuspension(
  client: Queryable,
  projectId: string,
  environment: string,
): Promise<ActiveSuspension | null> {
  const row = (
    await client.query<{ id: string; reason: string; suspended_by: string; suspended_at: Date }>(
      `SELECT id,reason,suspended_by,suspended_at FROM health_suspensions
        WHERE project_id=$1 AND environment=$2 AND resumed_at IS NULL
        ORDER BY suspended_at DESC LIMIT 1`,
      [projectId, environment],
    )
  ).rows[0];
  return row
    ? {
        id: row.id,
        reason: row.reason,
        suspendedBy: row.suspended_by,
        suspendedAt: new Date(row.suspended_at),
      }
    : null;
}

/** Ambientes suspensos do projeto (o relay recusa intervenções nestes ambientes). */
export async function suspendedEnvironments(
  client: Queryable,
  projectId: string,
): Promise<IncidentEnvironmentKey[]> {
  const rows = (
    await client.query<{ environment: IncidentEnvironmentKey }>(
      'SELECT DISTINCT environment FROM health_suspensions WHERE project_id=$1 AND resumed_at IS NULL',
      [projectId],
    )
  ).rows;
  return rows.map((row) => row.environment);
}

const ENV_NAMES: Record<IncidentEnvironmentKey, string> = {
  quality: 'Qualidade',
  production: 'Produção',
};
const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

/** Tickets da Saúde do projeto e ambiente com o fluxo ainda em curso. */
const HEALTH_TICKETS = `SELECT t.id FROM tickets t
  WHERE t.project_id=$1 AND t.origin='health' AND t.environment=$2 AND t.status NOT IN ('resolved','cancelled')`;

/**
 * Suspensão manual da Saúde por projeto e ambiente. Enquanto suspensa, os alertas só ficam
 * registados: não há sondas, e-mails, tickets, investigação do Copilot nem intervenções. O trabalho
 * em curso é cancelado de imediato e a retoma é sempre manual.
 */
export class HealthSuspensions {
  constructor(private readonly db: Database) {}

  async state(projectId: string): Promise<HealthSuspensionState> {
    const rows = (
      await this.db.query<{
        id: string;
        environment: IncidentEnvironmentKey;
        reason: string;
        suspended_by: string | null;
        suspended_at: Date;
        resumed_by: string | null;
        resumed_at: Date | null;
        cancelled_runs: number;
      }>(
        `SELECT s.id,s.environment,s.reason,s.suspended_at,s.resumed_at,s.cancelled_runs,
                a.display_name AS suspended_by, b.display_name AS resumed_by
           FROM health_suspensions s
           LEFT JOIN users a ON a.id=s.suspended_by
           LEFT JOIN users b ON b.id=s.resumed_by
          WHERE s.project_id=$1 ORDER BY s.suspended_at DESC LIMIT 20`,
        [projectId],
      )
    ).rows;
    const views: HealthSuspensionView[] = rows.map((row) => ({
      id: row.id,
      environment: row.environment,
      reason: row.reason,
      suspendedBy: row.suspended_by ?? '—',
      suspendedAt: iso(row.suspended_at)!,
      resumedBy: row.resumed_by,
      resumedAt: iso(row.resumed_at),
      cancelledRuns: Number(row.cancelled_runs),
    }));
    const active: HealthSuspensionState['active'] = {};
    for (const view of views)
      if (!view.resumedAt && !active[view.environment]) active[view.environment] = view;
    return { active, history: views };
  }

  /** Suspende: regista o motivo e cancela já o trabalho em curso (runs, intervenções e pedidos ao relay). */
  async suspend(
    projectId: string,
    environment: IncidentEnvironmentKey,
    reason: string,
    actorId: string,
    now = new Date(),
  ) {
    return this.db.transaction(async (client) => {
      await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      if (await activeSuspension(client, projectId, environment))
        throw new DomainError(
          'HEALTH_SUSPENDED',
          `A Saúde de ${ENV_NAMES[environment]} já está suspensa.`,
          409,
        );
      const tickets = (
        await client.query<{ id: string }>(HEALTH_TICKETS, [projectId, environment])
      ).rows.map((row) => row.id);
      let cancelledRuns = 0;
      if (tickets.length) {
        const list = tickets.map((_, index) => `$${index + 1}`).join(',');
        const at = `$${tickets.length + 1}`;
        const queued = await client.query(
          `UPDATE agent_runs SET status='cancelled', error_code='health_suspended', finished_at=${at}
            WHERE status='queued' AND ticket_id IN (${list})`,
          [...tickets, now],
        );
        const running = await client.query(
          `UPDATE agent_runs SET cancel_requested=1 WHERE status='running' AND ticket_id IN (${list})`,
          tickets,
        );
        cancelledRuns = queued.rowCount + running.rowCount;
        await client.query(
          `UPDATE flow_executions SET suspended_at=${at}
            WHERE status IN ('running','waiting') AND suspended_at IS NULL AND ticket_id IN (${list})`,
          [...tickets, now],
        );
        await client.query(
          `UPDATE incident_interventions SET status='cancelled', finished_at=${at},
                  result_text='Cancelada: Saúde suspensa.'
            WHERE status IN ('pending','running') AND ticket_id IN (${list})`,
          [...tickets, now],
        );
      }
      // Pedidos de intervenção ainda não executados pelo relay deste ambiente.
      await client.query(
        `UPDATE connector_relay_requests SET status='expired', error_code='health_suspended', finished_at=$3
          WHERE project_id=$1 AND status='pending' AND tool IN ('restart','reboot','param')
            AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.environment'))=$2`,
        [projectId, environment, now],
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO health_suspensions (id,project_id,environment,reason,suspended_by,suspended_at,cancelled_runs)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, projectId, environment, reason, actorId, now, cancelledRuns],
      );
      for (const ticketId of tickets)
        await appendAutomatedComment(client, {
          ticketId,
          projectId,
          authorId: actorId,
          visibility: 'internal',
          authorKind: 'system',
          body: `**Saúde suspensa em ${ENV_NAMES[environment]}.** O fluxo deste incidente está parado e o trabalho em curso foi cancelado.\n\nMotivo: ${reason}`,
        });
      return { id, cancelledRuns, tickets: tickets.length };
    });
  }

  /** Retoma: os fluxos parados continuam e as investigações canceladas voltam a ser pedidas. */
  async resume(
    projectId: string,
    environment: IncidentEnvironmentKey,
    actorId: string,
    now = new Date(),
  ) {
    return this.db.transaction(async (client) => {
      await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      const active = await activeSuspension(client, projectId, environment);
      if (!active)
        throw new DomainError(
          'HEALTH_NOT_SUSPENDED',
          `A Saúde de ${ENV_NAMES[environment]} não está suspensa.`,
          409,
        );
      await client.query(
        `UPDATE health_suspensions SET resumed_by=$2, resumed_at=$3
          WHERE project_id=$1 AND environment=$4 AND resumed_at IS NULL`,
        [projectId, actorId, now, environment],
      );
      // Alertas registados durante a suspensão: os ainda ativos passam a silenciados e o worker
      // notifica-os (e abre o ticket) no próximo ciclo; os já resolvidos ficam só no histórico.
      const alertEnv = `(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(labels,'$.env'))='quality' THEN 'quality' ELSE 'production' END)`;
      await client.query(
        `UPDATE health_external_alerts SET muted=CASE WHEN state='firing' THEN 1 ELSE muted END, suspended=0
          WHERE project_id=$1 AND suspended=1 AND ${alertEnv}=$2`,
        [projectId, environment],
      );
      const executions = (
        await client.query<{ id: string; ticket_id: string; current_step_id: string | null }>(
          `SELECT e.id,e.ticket_id,e.current_step_id FROM flow_executions e JOIN tickets t ON t.id=e.ticket_id
            WHERE e.project_id=$1 AND t.environment=$2 AND e.suspended_at IS NOT NULL`,
          [projectId, environment],
        )
      ).rows;
      for (const execution of executions) {
        // O Copilot cancelado pela suspensão é pedido de novo (o run antigo deixa de contar).
        if (execution.current_step_id)
          await client.query(
            `UPDATE flow_execution_steps s JOIN agent_runs r ON r.id=s.agent_run_id
                SET s.agent_run_id=NULL
              WHERE s.id=$1 AND s.status='waiting' AND (r.status IN ('cancelled','failed') OR r.cancel_requested=1)`,
            [execution.current_step_id],
          );
        await client.query('UPDATE flow_executions SET suspended_at=NULL, wake_at=$2 WHERE id=$1', [
          execution.id,
          now,
        ]);
        await appendAutomatedComment(client, {
          ticketId: execution.ticket_id,
          projectId,
          authorId: actorId,
          visibility: 'internal',
          authorKind: 'system',
          body: `**Saúde retomada em ${ENV_NAMES[environment]}.** O fluxo deste incidente continua a partir da etapa em que parou.`,
        });
      }
      return { resumed: executions.length };
    });
  }
}
