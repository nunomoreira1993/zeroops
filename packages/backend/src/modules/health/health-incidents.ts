import type { Database } from '../../database/database.js';
import { healthAlertKey } from '../../../../contracts/src/index.js';
import { demoScenarioOf } from '../incidents/incident-demo.js';
import { healthOccurrenceSuppressed, ticketWorkPaused } from '../tickets/ticket-purge-health.js';
import {
  HealthIncidentLifecycle,
  incidentInvestigationInstructions,
  parseLabels,
  type IncidentEnvironment,
  type IncidentState,
} from './health-incident-lifecycle.js';
import type { IncidentMetricReadings } from './health-incident-metrics.js';
import { incidentRank } from './health-incident-report.js';
import { closedTicketStatuses, type HealthTicketGateway } from './health-tickets.js';
import type { HealthRepository } from './health.repository.js';

/** Alerta crítico recebido do Alertmanager, já gravado em `health_external_alerts`. */
export interface IncidentAlertInput {
  alertId: string;
  /** Ticket a que o alerta já estava ligado (disparos anteriores). */
  linkedTicketId: string | null;
  environment: IncidentEnvironment;
  name: string;
  labels: Record<string, string>;
  /** Título legível, ex.: «Mysql down em db1». */
  title: string;
  description: string;
  priority: 'high' | 'critical';
}

/**
 * Cascata: um alerta junta-se ao incidente se começou até este tempo depois do primeiro alerta do
 * incidente. Falhas que começam mais tarde são outro problema e abrem outro incidente.
 */
const JOIN_WINDOW_MINUTES = 10;

/** Título do ticket: ambiente, causa provável e quantos alertas se juntaram. */
export function incidentTitle(environment: IncidentEnvironment, root: string, extra: number) {
  const env = environment === 'quality' ? 'QA' : 'Produção';
  const more = extra > 0 ? ` (+${extra} alerta${extra > 1 ? 's' : ''})` : '';
  return `[Saúde][${env}] ${root}${more}`.slice(0, 180);
}

/**
 * Incidentes da Saúde: alertas críticos do mesmo ambiente em cascata (ex.: MySQL em baixo e os
 * sites a falhar) ficam num só ticket, com a causa mais provável no título. O Copilot investiga
 * ao abrir e, quando tudo recupera, o ciclo de vida fecha com relatório e mensagem ao cliente.
 */
export class HealthIncidents {
  constructor(
    private readonly db: Database,
    private readonly repository: HealthRepository,
    private readonly tickets: HealthTicketGateway,
    private readonly lifecycle: HealthIncidentLifecycle,
    private readonly metrics?: IncidentMetricReadings,
  ) {}

  /** Alerta disparou: anota o ticket ligado, junta a um incidente aberto ou abre um novo. */
  async fired(projectId: string, alert: IncidentAlertInput) {
    if (await ticketWorkPaused(this.db, projectId)) return null;
    if (
      await healthOccurrenceSuppressed(this.db, projectId, {
        source: 'prometheus',
        alertId: alert.alertId,
      })
    )
      return null;
    if (alert.linkedTicketId) {
      const status = await this.tickets.status(projectId, alert.linkedTicketId);
      if (status && !closedTicketStatuses.has(status)) {
        await this.tickets.comment(
          projectId,
          alert.linkedTicketId,
          `**Alerta voltou a disparar:** ${alert.title}\n\n${alert.description}`,
        );
        await this.db.transaction((client) => this.lifecycle.reopen(client, alert.linkedTicketId!));
        return { ticketId: alert.linkedTicketId, opened: false };
      }
    }
    const demo = demoScenarioOf(alert.labels);
    // Cada demonstração é um incidente próprio, mesmo que outra tenha começado há pouco.
    const joinable = demo ? null : await this.joinable(projectId, alert.environment, alert.alertId);
    if (joinable) {
      await this.attach(projectId, alert, joinable);
      return { ticketId: joinable.ticket_id, opened: false };
    }
    const ticket = await this.tickets.open(
      projectId,
      {
        title: incidentTitle(alert.environment, alert.title, 0),
        description: alert.description,
        category: 'incident',
        environment: alert.environment,
        priority: alert.priority,
      },
      {
        agentInstructions: incidentInvestigationInstructions(alert.environment),
        origin: 'health',
        alertKey: healthAlertKey('prometheus', alert.name),
        healthOccurrence: { source: 'prometheus', alertId: alert.alertId },
      },
    );
    if (!ticket) return null;
    await this.db.query(
      `INSERT INTO health_incidents(ticket_id,project_id,environment,root_alert_id,root_title,demo_scenario)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [ticket.id, projectId, alert.environment, alert.alertId, alert.title.slice(0, 160), demo],
    );
    await this.link(projectId, alert.alertId, ticket.id);
    return { ticketId: ticket.id, opened: true };
  }

  /** Alerta recuperou: espera pelos restantes ou inicia o fecho do incidente. */
  async recovered(projectId: string, ticketId: string, note: string) {
    const incident = (
      await this.db.query<{ state: IncidentState; environment: IncidentEnvironment }>(
        'SELECT state, environment FROM health_incidents WHERE ticket_id=$1',
        [ticketId],
      )
    ).rows[0];
    // Tickets anteriores aos incidentes: só regista a recuperação.
    if (!incident) {
      await this.tickets.comment(projectId, ticketId, note);
      return;
    }
    if (incident.state !== 'open') return;
    const firing = Number(
      (
        await this.db.query<{ total: number }>(
          "SELECT COUNT(*) AS total FROM health_external_alerts WHERE ticket_id=$1 AND state='firing'",
          [ticketId],
        )
      ).rows[0]?.total ?? 0,
    );
    if (firing > 0) {
      await this.tickets.comment(
        projectId,
        ticketId,
        `${note} Ainda ${firing === 1 ? 'há 1 alerta ativo' : `há ${firing} alertas ativos`} neste incidente.`,
      );
      return;
    }
    // Fora da transação: o Prometheus pode demorar e o relatório só precisa dos valores gravados.
    await this.metrics?.record(projectId, ticketId, incident.environment);
    await this.db.transaction((client) => this.lifecycle.recover(client, ticketId));
  }

  private async joinable(projectId: string, environment: IncidentEnvironment, alertId: string) {
    const found = await this.db.query<{
      ticket_id: string;
      state: IncidentState;
      root_alert_id: string;
      root_title: string;
      root_name: string;
      root_labels: string;
    }>(
      `SELECT i.ticket_id, i.state, i.root_alert_id, i.root_title,
              r.alert_name AS root_name, r.labels AS root_labels
         FROM health_incidents i
         JOIN tickets t ON t.id=i.ticket_id
         JOIN health_external_alerts r ON r.id=i.root_alert_id
        WHERE i.project_id=$1 AND i.environment=$2 AND i.state<>'closed' AND i.demo_scenario IS NULL
          AND t.status NOT IN ('resolved','cancelled')
          AND (SELECT n.starts_at FROM health_external_alerts n WHERE n.id=$3)
              <= (SELECT MIN(a.starts_at) FROM health_external_alerts a WHERE a.ticket_id=i.ticket_id)
                 + INTERVAL ${JOIN_WINDOW_MINUTES} MINUTE
        ORDER BY i.opened_at DESC LIMIT 1`,
      [projectId, environment, alertId],
    );
    return found.rows[0] ?? null;
  }

  /** Junta o alerta ao incidente; se explicar melhor a falha, passa a ser a causa provável. */
  private async attach(
    projectId: string,
    alert: IncidentAlertInput,
    incident: NonNullable<Awaited<ReturnType<HealthIncidents['joinable']>>>,
  ) {
    await this.link(projectId, alert.alertId, incident.ticket_id);
    const promoted =
      incidentRank(alert.name, alert.labels) >
      incidentRank(incident.root_name, parseLabels(incident.root_labels));
    await this.tickets.comment(
      projectId,
      incident.ticket_id,
      `**Alerta associado ao incidente:** ${alert.title}${promoted ? '\n\nPassa a ser a causa mais provável do incidente.' : ''}\n\n${alert.description}`,
    );
    const rootTitle = promoted ? alert.title.slice(0, 160) : incident.root_title;
    await this.db.transaction(async (client) => {
      if (promoted)
        await client.query(
          'UPDATE health_incidents SET root_alert_id=$2, root_title=$3 WHERE ticket_id=$1',
          [incident.ticket_id, alert.alertId, rootTitle],
        );
      await this.lifecycle.reopen(client, incident.ticket_id);
    });
    const total = Number(
      (
        await this.db.query<{ total: number }>(
          'SELECT COUNT(*) AS total FROM health_external_alerts WHERE ticket_id=$1',
          [incident.ticket_id],
        )
      ).rows[0]?.total ?? 1,
    );
    await this.tickets.retitle(
      projectId,
      incident.ticket_id,
      incidentTitle(alert.environment, rootTitle, total - 1),
    );
  }

  private async link(projectId: string, alertId: string, ticketId: string) {
    await this.db.query('UPDATE health_external_alerts SET ticket_id=$1 WHERE id=$2', [
      ticketId,
      alertId,
    ]);
    await this.repository.recordAlertEvent({
      projectId,
      alertId,
      source: 'prometheus',
      kind: 'ticket',
      detail: ticketId,
    });
  }
}
