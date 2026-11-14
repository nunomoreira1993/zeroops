import { randomUUID } from 'node:crypto';
import { preExecutionStatuses, type TicketStatus } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import type { Queryable } from '../identity/membership.js';
import { queueAgentRun } from '../agents/agent-auto-runs.js';
import type { RunFinishedHook } from '../agents/agent-runs.service.js';
import { appendAutomatedComment } from '../tickets/ticket-comments.js';
import { recordTicketMove } from '../tickets/ticket-move.js';
import {
  clientIncidentMessage,
  internalIncidentReport,
  type IncidentAlert,
  type IncidentReportInput,
} from './health-incident-report.js';

export type IncidentEnvironment = 'quality' | 'production';
export type IncidentState = 'open' | 'recovered' | 'reviewing' | 'closed';

export interface IncidentRow {
  ticket_id: string;
  project_id: string;
  environment: IncidentEnvironment;
  root_alert_id: string;
  state: IncidentState;
  review_run_id: string | null;
  opened_at: Date;
  recovered_at: Date | null;
}

interface TicketLock {
  status: TicketStatus;
  version: number;
  project_id: string;
  created_by: string;
}

const ENVIRONMENT_NAME: Record<IncidentEnvironment, string> = {
  quality: 'Qualidade (QA)',
  production: 'Produção',
};

/** Instruções da primeira investigação do Copilot num incidente da Saúde. */
export function incidentInvestigationInstructions(environment: IncidentEnvironment) {
  return [
    `Incidente detetado automaticamente pela Saúde (alerta do Prometheus) no ambiente de ${ENVIRONMENT_NAME[environment]}.`,
    `Investiga nesse ambiente (${environment}), só em modo de leitura: confirma o estado atual, procura a causa nos logs, métricas e base de dados e regista as evidências.`,
    'O incidente pode recuperar sozinho entretanto; nesse caso diz o que encontraste.',
    'Não faças perguntas ao cliente.',
  ].join(' ');
}

/** Instruções da análise pós-incidente: resumo técnico para a equipa e mensagem final ao cliente. */
export function incidentReviewInstructions(environment: IncidentEnvironment) {
  return [
    `Análise pós-incidente: o incidente no ambiente de ${ENVIRONMENT_NAME[environment]} já recuperou.`,
    'Lê a conversa (alertas, cronologia e relatório do incidente) e investiga nesse ambiente, só em modo de leitura, a causa provável, o impacto e o que pode evitar que se repita.',
    'Em summary escreve a análise técnica para a equipa, com as evidências.',
    'Em replyDraft escreve só o corpo da mensagem final ao cliente, sem saudação nem assinatura, em português de Portugal: o que aconteceu, o impacto e o que foi ou será feito. Sem detalhes sensíveis (IPs, nomes de servidores internos, credenciais).',
    'Não faças perguntas ao cliente.',
  ].join(' ');
}

/**
 * Indica se o incidente do ticket é conduzido por um fluxo do projeto (e acorda-o). Quando devolve
 * true, o ciclo de vida só regista a recuperação: análise, mensagem ao cliente e fecho ficam no fluxo.
 */
export type IncidentDelegate = (client: Queryable, ticketId: string) => Promise<boolean>;

/** Fecha o incidente do ticket (ex.: verificação do fluxo concluída); sem efeito se já fechado. */
export async function closeHealthIncident(client: Queryable, ticketId: string) {
  const closed = await client.query(
    "UPDATE health_incidents SET state='closed', closed_at=NOW(3), recovered_at=COALESCE(recovered_at,NOW(3)) WHERE ticket_id=$1 AND state<>'closed'",
    [ticketId],
  );
  if (closed.rowCount)
    await client.query(
      'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,NULL,$2,$3,$4)',
      [randomUUID(), ticketId, 'health.incident_closed', {}],
    );
}

/**
 * Fecho de um incidente da Saúde depois de todos os alertas recuperarem: relatório interno,
 * análise pós-incidente do Copilot (se configurado), mensagem final ao cliente e ticket resolvido.
 * Só usa o cliente SQL da transação, para correr também dentro do fim de um run do executor.
 */
export class HealthIncidentLifecycle {
  constructor(
    private readonly db: Database,
    private readonly delegate?: IncidentDelegate,
  ) {}

  /** Todos os alertas recuperaram: grava o relatório interno e avança para a análise/fecho. */
  async recover(client: Queryable, ticketId: string) {
    const ticket = await this.lockTicket(client, ticketId);
    const incident = await this.lockIncident(client, ticketId);
    if (!ticket || incident?.state !== 'open') return;
    await client.query(
      "UPDATE health_incidents SET state='recovered', recovered_at=NOW(3) WHERE ticket_id=$1",
      [ticketId],
    );
    const recovered = { ...incident, state: 'recovered' as const, recovered_at: new Date() };
    await appendAutomatedComment(client, {
      ticketId,
      projectId: incident.project_id,
      authorId: ticket.created_by,
      visibility: 'internal',
      body: internalIncidentReport(await this.reportInput(client, recovered)),
      authorKind: 'system',
    });
    if (await this.delegate?.(client, ticketId)) return;
    await this.advance(client, recovered, ticket);
  }

  /** Volta a abrir um incidente que recuperou mas voltou a ter alertas ativos. */
  async reopen(client: Queryable, ticketId: string) {
    await client.query(
      `UPDATE health_incidents SET state='open', recovered_at=NULL, review_run_id=NULL
        WHERE ticket_id=$1 AND state IN ('recovered','reviewing')`,
      [ticketId],
    );
  }

  /** Hook do fim de run: conclui a análise pós-incidente ou retoma o fecho que esperava pelo run. */
  readonly onRunFinished: RunFinishedHook = async (client, run, outcome) => {
    if (run.run_trigger === 'flow') return;
    const incident = await this.lockIncident(client, run.ticket_id);
    if (!incident) return;
    const ticket = await this.lockTicket(client, run.ticket_id);
    if (!ticket) return;
    if (incident.state === 'recovered' && (await this.delegate?.(client, run.ticket_id))) return;
    if (incident.state === 'reviewing' && incident.review_run_id === run.id)
      await this.finalize(
        client,
        incident,
        ticket,
        outcome === 'succeeded' ? await this.analysis(client, run.id) : null,
      );
    else if (incident.state === 'recovered') await this.advance(client, incident, ticket);
  };

  /**
   * Recupera incidentes parados: análise cujo run terminou sem passar pelo hook (ex.: executor
   * reiniciado) ou recuperação à espera de um run que já acabou.
   */
  async sweep() {
    const stuck = await this.db.query<{ ticket_id: string }>(
      `SELECT i.ticket_id FROM health_incidents i
        WHERE i.state IN ('recovered','reviewing')
          AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.ticket_id=i.ticket_id AND r.status IN ('queued','running'))
        LIMIT 20`,
    );
    for (const { ticket_id: ticketId } of stuck.rows)
      await this.db.transaction(async (client) => {
        const ticket = await this.lockTicket(client, ticketId);
        const incident = await this.lockIncident(client, ticketId);
        if (!ticket || !incident) return;
        if (incident.state === 'recovered' && (await this.delegate?.(client, ticketId))) return;
        if (incident.state === 'reviewing')
          await this.finalize(
            client,
            incident,
            ticket,
            incident.review_run_id ? await this.analysis(client, incident.review_run_id) : null,
          );
        else if (incident.state === 'recovered') await this.advance(client, incident, ticket);
      });
    return stuck.rowCount;
  }

  /** Espera por um run em curso, pede a análise pós-incidente ou fecha logo sem Copilot. */
  private async advance(client: Queryable, incident: IncidentRow, ticket: TicketLock) {
    if (['resolved', 'cancelled'].includes(ticket.status)) {
      await this.close(client, incident.ticket_id);
      return;
    }
    const active = await client.query(
      "SELECT id FROM agent_runs WHERE ticket_id=$1 AND status IN ('queued','running')",
      [incident.ticket_id],
    );
    if (active.rowCount) return;
    const runId = await queueAgentRun(client, {
      ticketId: incident.ticket_id,
      projectId: incident.project_id,
      requestedBy: ticket.created_by,
      instructions: incidentReviewInstructions(incident.environment),
      trigger: 'incident_review',
      ticketVersion: ticket.version,
    });
    if (runId) {
      await client.query(
        "UPDATE health_incidents SET state='reviewing', review_run_id=$2 WHERE ticket_id=$1",
        [incident.ticket_id, runId],
      );
      return;
    }
    await this.finalize(client, incident, ticket, null);
  }

  /** Mensagem final ao cliente, ticket resolvido (se ainda não está em trabalho) e incidente fechado. */
  private async finalize(
    client: Queryable,
    incident: IncidentRow,
    ticket: TicketLock,
    analysis: string | null,
  ) {
    const input = await this.reportInput(client, incident);
    await appendAutomatedComment(client, {
      ticketId: incident.ticket_id,
      projectId: incident.project_id,
      authorId: ticket.created_by,
      visibility: 'public',
      body: clientIncidentMessage(input, analysis),
      authorKind: 'system',
    });
    if (preExecutionStatuses.includes(ticket.status))
      await recordTicketMove(client, {
        ticketId: incident.ticket_id,
        projectId: incident.project_id,
        from: ticket.status,
        to: 'resolved',
        version: ticket.version,
        actorId: null,
        action: 'health.incident_resolved',
      });
    else if (!['resolved', 'cancelled'].includes(ticket.status))
      await appendAutomatedComment(client, {
        ticketId: incident.ticket_id,
        projectId: incident.project_id,
        authorId: ticket.created_by,
        visibility: 'internal',
        body: 'O incidente recuperou, mas o pedido fica aberto porque já há trabalho em curso.',
        authorKind: 'system',
      });
    await this.close(client, incident.ticket_id);
  }

  private async close(client: Queryable, ticketId: string) {
    await client.query(
      "UPDATE health_incidents SET state='closed', closed_at=NOW(3), recovered_at=COALESCE(recovered_at,NOW(3)) WHERE ticket_id=$1",
      [ticketId],
    );
    await client.query(
      'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,NULL,$2,$3,$4)',
      [randomUUID(), ticketId, 'health.incident_closed', {}],
    );
  }

  /** Resposta proposta pela análise pós-incidente, se o run terminou com sucesso. */
  private async analysis(client: Queryable, runId: string) {
    const found = await client.query<{ reply_draft: string | null }>(
      "SELECT reply_draft FROM agent_runs WHERE id=$1 AND status='succeeded'",
      [runId],
    );
    return found.rows[0]?.reply_draft ?? null;
  }

  private async lockTicket(client: Queryable, ticketId: string) {
    const found = await client.query<TicketLock>(
      'SELECT status,version,project_id,created_by FROM tickets WHERE id=$1 FOR UPDATE',
      [ticketId],
    );
    return found.rows[0] ?? null;
  }

  private async lockIncident(client: Queryable, ticketId: string) {
    const found = await client.query<IncidentRow>(
      'SELECT * FROM health_incidents WHERE ticket_id=$1 FOR UPDATE',
      [ticketId],
    );
    return found.rows[0] ?? null;
  }

  /** Alertas e avisos (e-mails) do incidente, para os relatórios. */
  async reportInput(client: Queryable, incident: IncidentRow): Promise<IncidentReportInput> {
    const alerts = await client.query<{
      id: string;
      alert_name: string;
      title: string | null;
      summary: string;
      labels: string;
      criticality: string;
      starts_at: Date;
      resolved_at: Date | null;
      fire_count: number;
      metric_before: string | null;
      metric_after: string | null;
    }>(
      `SELECT id,alert_name,title,summary,labels,criticality,starts_at,resolved_at,fire_count,metric_before,metric_after
         FROM health_external_alerts WHERE ticket_id=$1 ORDER BY starts_at`,
      [incident.ticket_id],
    );
    const list: IncidentAlert[] = alerts.rows.map((row) => ({
      id: row.id,
      name: row.alert_name,
      title: row.title,
      summary: row.summary,
      labels: parseLabels(row.labels),
      criticality: row.criticality,
      startsAt: row.starts_at,
      resolvedAt: row.resolved_at,
      fireCount: row.fire_count,
      metricBefore: row.metric_before,
      metricAfter: row.metric_after,
    }));
    const ids = list.map((alert) => alert.id);
    const openedAt = new Date(
      Math.min(incident.opened_at.getTime(), ...list.map((alert) => alert.startsAt.getTime())),
    );
    // O alerta é o mesmo registo em cada disparo (por fingerprint): só contam os avisos deste incidente.
    const noticesSince = new Date(openedAt.getTime() - 60_000);
    const notices = ids.length
      ? await client.query<{
          alert_id: string | null;
          kind: string;
          recipients: string;
          subject: string;
          state: string;
          created_at: Date;
          sent_at: Date | null;
        }>(
          `SELECT alert_id,kind,recipients,subject,state,created_at,sent_at FROM health_notifications
            WHERE alert_id IN (${ids.map((_, index) => `$${index + 2}`).join(',')})
              AND created_at >= $1 ORDER BY created_at`,
          [noticesSince, ...ids],
        )
      : { rows: [] };
    const lastRecovery = Math.max(0, ...list.map((alert) => alert.resolvedAt?.getTime() ?? 0));
    return {
      environment: incident.environment,
      openedAt,
      recoveredAt: lastRecovery ? new Date(lastRecovery) : (incident.recovered_at ?? new Date()),
      rootAlertId: incident.root_alert_id,
      alerts: list,
      notifications: notices.rows.map((row) => ({
        alertId: row.alert_id,
        kind: row.kind,
        recipients: row.recipients ? row.recipients.split(',').filter(Boolean) : [],
        subject: row.subject,
        state: row.state,
        createdAt: row.created_at,
        sentAt: row.sent_at,
      })),
    };
  }
}

/** Labels do alerta guardadas como JSON (texto ou já convertidas); `{}` se inválidas. */
export function parseLabels(value: string | Record<string, string>) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}
