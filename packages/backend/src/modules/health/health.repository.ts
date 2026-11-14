import { randomUUID } from 'node:crypto';
import {
  healthAgentSampleSchema,
  healthNotificationChartContextSchema,
  healthSettingsSchema,
  type HealthAgentSample,
  type HealthAlertEventKind,
  type HealthAlertSource,
  type HealthCriticality,
  type HealthNotificationChartContext,
  type HealthSettings,
  type HealthStatus,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { activeSuspension } from '../incidents/health-suspension.js';
import {
  healthOccurrenceSuppressed,
  ticketWorkPaused,
  type HealthOccurrence,
} from '../tickets/ticket-purge-health.js';
import type { StoredAgentSample } from './collectors/host-agent.collector.js';
import type { CheckResult } from './collectors/collector.js';

export interface SettingsRecord {
  settings: HealthSettings;
  agentTokenHash: string | null;
  lastCycleAt: Date | null;
  lastReportAt: Date | null;
}

export interface StateRecord {
  checkId: string;
  status: HealthStatus;
  value: number | null;
  unit: string | null;
  summary: string;
  details: Record<string, unknown> | null;
  checkedAt: Date;
  statusSince: Date;
}

export interface AlertRecord {
  id: string;
  projectId: string;
  checkId: string;
  criticality: HealthCriticality;
  severity: 'warning' | 'critical' | 'unknown';
  summary: string;
  ticketId: string | null;
  openedAt: Date;
  lastNotifiedAt: Date | null;
  notifyCount: number;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  resolvedAt: Date | null;
  emailState: NotificationDelivery['state'] | null;
  emailErrorCode: string | null;
}

export interface NotificationInput {
  projectId: string;
  environment?: 'production' | 'quality' | null;
  alertId: string | null;
  kind: 'alert' | 'resolved' | 'report';
  channel: 'email' | 'sms' | 'chamada';
  recipients: string[];
  subject: string;
  body: string;
  state?: 'pending' | 'blocked';
  errorCode?: string;
  chartContext?: HealthNotificationChartContext;
}

export interface NotificationRecord {
  id: string;
  projectId: string;
  recipients: string[];
  subject: string;
  body: string;
  attempts: number;
}

export interface NotificationDelivery {
  state: 'pending' | 'sent' | 'failed' | 'blocked';
  errorCode: string | null;
}

export interface AlertEventInput {
  projectId: string;
  alertId: string;
  source?: HealthAlertSource;
  kind: HealthAlertEventKind;
  actorId?: string | null;
  detail?: string | null;
  at?: Date;
}

export interface AlertEventRecord {
  alertId: string;
  kind: HealthAlertEventKind;
  at: Date;
  actorName: string | null;
  detail: string | null;
}

export interface ExternalAlertRecord {
  id: string;
  alertName: string;
  criticality: HealthCriticality;
  state: 'firing' | 'resolved';
  summary: string;
  startsAt: Date;
  resolvedAt: Date | null;
  ticketId: string | null;
}

export interface NotificationLogRecord {
  id: string;
  alertId: string | null;
  kind: 'alert' | 'resolved' | 'report';
  channel: 'email' | 'sms' | 'chamada';
  recipients: string[];
  subject: string;
  state: NotificationDelivery['state'];
  errorCode: string | null;
  attempts: number;
  createdAt: Date;
  sentAt: Date | null;
}

type Row = Record<string, unknown>;
const date = (value: unknown) => (value ? new Date(value as Date) : null);

function toAlert(row: Row): AlertRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    checkId: String(row.check_id),
    criticality: row.criticality as HealthCriticality,
    severity: row.severity as AlertRecord['severity'],
    summary: String(row.summary),
    ticketId: (row.ticket_id as string) ?? null,
    openedAt: new Date(row.opened_at as Date),
    lastNotifiedAt: date(row.last_notified_at),
    notifyCount: Number(row.notify_count),
    acknowledgedAt: date(row.acknowledged_at),
    acknowledgedBy: (row.acknowledged_by as string) ?? null,
    assignedTo: (row.assigned_to as string) ?? null,
    assignedName: (row.assigned_name as string) ?? null,
    resolvedAt: date(row.resolved_at),
    emailState: (row.email_state as AlertRecord['emailState']) ?? null,
    emailErrorCode: (row.email_error_code as string) ?? null,
  };
}

const ALERT_SELECT = `SELECT a.*, u.display_name AS assigned_name,
  (SELECT n.state FROM health_notifications n WHERE n.alert_id=a.id AND n.channel='email'
    ORDER BY n.created_at DESC LIMIT 1) AS email_state,
  (SELECT n.error_code FROM health_notifications n WHERE n.alert_id=a.id AND n.channel='email'
    ORDER BY n.created_at DESC LIMIT 1) AS email_error_code
  FROM health_alerts a LEFT JOIN users u ON u.id = a.assigned_to`;

/** Acesso a dados da monitorizacao de saude (tabelas health_*). */
export class HealthRepository {
  constructor(private readonly db: Database) {}

  /** Ticket work alone may be paused or an occurrence consumed; Health monitoring remains active. */
  async ticketSuppressed(projectId: string, occurrence: HealthOccurrence) {
    return (
      (await ticketWorkPaused(this.db, projectId)) ||
      healthOccurrenceSuppressed(this.db, projectId, occurrence)
    );
  }

  /** Saúde suspensa manualmente no ambiente: sem sondas, notificações nem tickets. */
  async isSuspended(projectId: string, environment: string) {
    return (await activeSuspension(this.db, projectId, environment)) !== null;
  }

  /** Lê configuração, hash do agente e marcas temporais do projeto. */
  async settings(projectId: string): Promise<SettingsRecord | null> {
    const found = await this.db.query<Row>('SELECT * FROM health_settings WHERE project_id=$1', [
      projectId,
    ]);
    const row = found.rows[0];
    if (!row) return null;
    return {
      settings: healthSettingsSchema.parse(row.config ?? {}),
      agentTokenHash: (row.agent_token_hash as string) ?? null,
      lastCycleAt: date(row.last_cycle_at),
      lastReportAt: date(row.last_report_at),
    };
  }

  /** Insere ou atualiza configuração, incrementando a versão para rastreio de alterações. */
  async saveSettings(projectId: string, settings: HealthSettings, actorId: string | null) {
    await this.db.query(
      `INSERT INTO health_settings (project_id, config, updated_by) VALUES ($1,$2,$3)
       ON DUPLICATE KEY UPDATE config=VALUES(config), updated_by=VALUES(updated_by), version=version+1`,
      [projectId, JSON.stringify(settings), actorId],
    );
  }

  /** Substitui o hash de autenticação do agente sem guardar o token em claro. */
  async setAgentTokenHash(projectId: string, hash: string) {
    await this.db.query('UPDATE health_settings SET agent_token_hash=$1 WHERE project_id=$2', [
      hash,
      projectId,
    ]);
  }

  /** Resolve o projeto associado ao hash de token apresentado pelo agente. */
  async projectByAgentToken(hash: string) {
    const found = await this.db.query<Row>(
      'SELECT project_id FROM health_settings WHERE agent_token_hash=$1',
      [hash],
    );
    return (found.rows[0]?.project_id as string | undefined) ?? null;
  }

  /** Lista projetos ativos com monitorização habilitada e configuração válida. */
  async enabledProjects(): Promise<string[]> {
    const found = await this.db.query<Row>(
      'SELECT s.project_id, s.config FROM health_settings s JOIN projects p ON p.id=s.project_id WHERE NOT p.archived',
    );
    return found.rows
      .filter((row) => healthSettingsSchema.safeParse(row.config ?? {}).data?.enabled)
      .map((row) => String(row.project_id));
  }

  /** Atualiza apenas a marca temporal de ciclo ou relatório permitida pelo contrato. */
  async touch(projectId: string, column: 'last_cycle_at' | 'last_report_at', at: Date) {
    await this.db.query(`UPDATE health_settings SET ${column}=$1 WHERE project_id=$2`, [
      at,
      projectId,
    ]);
  }

  /** Carrega o último estado persistido de cada verificação do projeto. */
  async states(projectId: string): Promise<Map<string, StateRecord>> {
    const found = await this.db.query<Row>('SELECT * FROM health_check_state WHERE project_id=$1', [
      projectId,
    ]);
    return new Map(
      found.rows.map((row) => [
        String(row.check_id),
        {
          checkId: String(row.check_id),
          status: row.status as HealthStatus,
          value: row.value === null ? null : Number(row.value),
          unit: (row.unit as string) ?? null,
          summary: String(row.summary),
          details: (row.details as Record<string, unknown>) ?? null,
          checkedAt: new Date(row.checked_at as Date),
          statusSince: new Date(row.status_since as Date),
        },
      ]),
    );
  }

  /** Atualiza estado corrente e acrescenta amostra histórica para métricas. */
  async saveState(projectId: string, result: CheckResult, checkedAt: Date, statusSince: Date) {
    await this.db.query(
      `INSERT INTO health_check_state (project_id, check_id, status, value, unit, summary, details, checked_at, status_since)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON DUPLICATE KEY UPDATE status=VALUES(status), value=VALUES(value), unit=VALUES(unit), summary=VALUES(summary),
         details=VALUES(details), checked_at=VALUES(checked_at), status_since=VALUES(status_since)`,
      [
        projectId,
        result.checkId,
        result.status,
        result.value,
        result.unit,
        result.summary.slice(0, 500),
        result.details ? JSON.stringify(result.details) : null,
        checkedAt,
        statusSince,
      ],
    );
    await this.db.query(
      'INSERT INTO health_samples (project_id, check_id, status, value, created_at) VALUES ($1,$2,$3,$4,$5)',
      [projectId, result.checkId, result.status, result.value, checkedAt],
    );
  }

  /** Obtém o alerta ainda aberto para uma verificação específica. */
  async openAlert(projectId: string, checkId: string) {
    const found = await this.db.query<Row>(`${ALERT_SELECT} WHERE a.open_key=$1`, [
      `${projectId}:${checkId}`,
    ]);
    return found.rows[0] ? toAlert(found.rows[0]) : null;
  }

  /** Obtém alerta apenas quando pertence ao projeto indicado. */
  async alert(projectId: string, alertId: string) {
    const found = await this.db.query<Row>(`${ALERT_SELECT} WHERE a.id=$1 AND a.project_id=$2`, [
      alertId,
      projectId,
    ]);
    return found.rows[0] ? toAlert(found.rows[0]) : null;
  }

  /** Lista alertas recentes e ainda abertos, limitando o histórico a cem entradas. */
  async recentAlerts(projectId: string, since: Date) {
    const found = await this.db.query<Row>(
      `${ALERT_SELECT} WHERE a.project_id=$1 AND (a.resolved_at IS NULL OR a.opened_at >= $2)
       ORDER BY a.resolved_at IS NULL DESC, a.opened_at DESC LIMIT 100`,
      [projectId, since],
    );
    return found.rows.map(toAlert);
  }

  /** Abre alerta único por projeto/verificação e devolve o registo persistido. */
  async createAlert(
    projectId: string,
    checkId: string,
    criticality: HealthCriticality,
    severity: AlertRecord['severity'],
    summary: string,
    at: Date,
  ) {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO health_alerts (id, project_id, check_id, criticality, severity, summary, open_key, opened_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        projectId,
        checkId,
        criticality,
        severity,
        summary.slice(0, 500),
        `${projectId}:${checkId}`,
        at,
      ],
    );
    return (await this.alert(projectId, id))!;
  }

  /** Atualiza severidade e resumo do alerta, limitando o texto armazenado. */
  async updateAlert(alertId: string, severity: AlertRecord['severity'], summary: string) {
    await this.db.query('UPDATE health_alerts SET severity=$1, summary=$2 WHERE id=$3', [
      severity,
      summary.slice(0, 500),
      alertId,
    ]);
  }

  /** Liga um ticket ao alerta interno, sem substituir uma ligação já existente. */
  async linkTicket(projectId: string, alertId: string, ticketId: string) {
    const updated = await this.db.query(
      'UPDATE health_alerts SET ticket_id=$1 WHERE id=$2 AND project_id=$3 AND ticket_id IS NULL',
      [ticketId, alertId, projectId],
    );
    if (!updated.rowCount) {
      const alert = await this.alert(projectId, alertId);
      if (alert?.ticketId === ticketId) return;
      throw new Error(`Não foi possível associar o ticket ao alerta de Saúde ${alertId}.`);
    }
  }

  /** Regista o envio de notificação e incrementa a contagem de avisos do alerta. */
  async markNotified(alertId: string, at: Date) {
    await this.db.query(
      'UPDATE health_alerts SET last_notified_at=$1, notify_count=notify_count+1 WHERE id=$2',
      [at, alertId],
    );
  }

  /** Fecha alerta e liberta a chave de unicidade para uma ocorrência futura. */
  async resolveAlert(alertId: string, at: Date) {
    await this.db.query('UPDATE health_alerts SET resolved_at=$1, open_key=NULL WHERE id=$2', [
      at,
      alertId,
    ]);
  }

  /** Confirma alerta sem substituir uma confirmação anterior; limita a operação ao projeto. */
  async acknowledge(projectId: string, alertId: string, userId: string) {
    const result = await this.db.query(
      `UPDATE health_alerts SET acknowledged_at=COALESCE(acknowledged_at, NOW(3)),
         acknowledged_by=COALESCE(acknowledged_by, $1) WHERE id=$2 AND project_id=$3`,
      [userId, alertId, projectId],
    );
    return result.rowCount > 0;
  }

  /** Atribui ou remove responsável do alerta, limitado ao projeto. */
  async assign(projectId: string, alertId: string, userId: string | null) {
    const result = await this.db.query(
      'UPDATE health_alerts SET assigned_to=$1 WHERE id=$2 AND project_id=$3',
      [userId, alertId, projectId],
    );
    return result.rowCount > 0;
  }

  /** Lista membros ativos não-clientes elegíveis para receber atribuição de alertas. */
  async teamMembers(projectId: string) {
    const found = await this.db.query<Row>(
      `SELECT u.id, u.display_name FROM users u JOIN project_memberships m ON m.user_id=u.id
       WHERE m.project_id=$1 AND m.role<>'client' AND NOT u.disabled AND NOT m.disabled ORDER BY u.display_name`,
      [projectId],
    );
    return found.rows.map((row) => ({ id: String(row.id), displayName: String(row.display_name) }));
  }

  /** Acrescenta um evento ao histórico de um alarme (interno ou do Prometheus). */
  async recordAlertEvent(input: AlertEventInput) {
    await this.db.query(
      `INSERT INTO health_alert_events (project_id, alert_id, source, kind, actor_id, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.projectId,
        input.alertId,
        input.source ?? 'internal',
        input.kind,
        input.actorId ?? null,
        input.detail ? input.detail.slice(0, 500) : null,
        input.at ?? new Date(),
      ],
    );
  }

  /** Alertas internos abertos no período ou ainda ativos, opcionalmente de uma só verificação. */
  async historyAlerts(projectId: string, since: Date, checkId?: string) {
    const found = await this.db.query<Row>(
      `SELECT a.*, u.display_name AS assigned_name, k.display_name AS acknowledged_name
       FROM health_alerts a LEFT JOIN users u ON u.id=a.assigned_to LEFT JOIN users k ON k.id=a.acknowledged_by
       WHERE a.project_id=$1 AND (a.resolved_at IS NULL OR a.opened_at >= $2 OR a.resolved_at >= $2)
         AND ($3 IS NULL OR a.check_id=$3)
       ORDER BY a.opened_at DESC LIMIT 300`,
      [projectId, since, checkId ?? null],
    );
    return found.rows.map((row) => ({
      ...toAlert(row),
      acknowledgedName: (row.acknowledged_name as string) ?? null,
    }));
  }

  /** Alertas recebidos do Alertmanager no período ou ainda a disparar. */
  async historyExternalAlerts(projectId: string, since: Date): Promise<ExternalAlertRecord[]> {
    const found = await this.db.query<Row>(
      `SELECT * FROM health_external_alerts
       WHERE project_id=$1 AND (state='firing' OR starts_at >= $2 OR resolved_at >= $2)
       ORDER BY starts_at DESC LIMIT 300`,
      [projectId, since],
    );
    return found.rows.map((row) => ({
      id: String(row.id),
      alertName: String(row.alert_name),
      criticality: row.criticality as HealthCriticality,
      state: row.state as ExternalAlertRecord['state'],
      summary: String(row.summary),
      startsAt: new Date(row.starts_at as Date),
      resolvedAt: date(row.resolved_at),
      ticketId: (row.ticket_id as string) ?? null,
    }));
  }

  /** Eventos dos alarmes indicados, por ordem cronológica, com o nome de quem agiu. */
  async alertEvents(projectId: string, alertIds: string[]): Promise<AlertEventRecord[]> {
    if (!alertIds.length) return [];
    const marks = alertIds.map((_, index) => `$${index + 2}`).join(',');
    const found = await this.db.query<Row>(
      `SELECT e.alert_id, e.kind, e.detail, e.created_at, u.display_name AS actor_name
       FROM health_alert_events e LEFT JOIN users u ON u.id=e.actor_id
       WHERE e.project_id=$1 AND e.alert_id IN (${marks}) ORDER BY e.created_at, e.id`,
      [projectId, ...alertIds],
    );
    return found.rows.map((row) => ({
      alertId: String(row.alert_id),
      kind: row.kind as AlertEventRecord['kind'],
      at: new Date(row.created_at as Date),
      actorName: (row.actor_name as string) ?? null,
      detail: (row.detail as string) ?? null,
    }));
  }

  /** Notificações do período e as dos alarmes indicados (mesmo que anteriores), mais recentes primeiro. */
  async notificationLog(
    projectId: string,
    since: Date,
    alertIds: string[] = [],
  ): Promise<NotificationLogRecord[]> {
    const marks = alertIds.map((_, index) => `$${index + 3}`).join(',');
    const found = await this.db.query<Row>(
      `SELECT id, alert_id, kind, channel, recipients, subject, state, error_code, attempts, created_at, sent_at
       FROM health_notifications
       WHERE project_id=$1 AND (created_at >= $2${marks ? ` OR alert_id IN (${marks})` : ''})
       ORDER BY created_at DESC LIMIT 1000`,
      [projectId, since, ...alertIds],
    );
    return found.rows.map((row) => ({
      id: String(row.id),
      alertId: (row.alert_id as string) ?? null,
      kind: row.kind as NotificationLogRecord['kind'],
      channel: row.channel as NotificationLogRecord['channel'],
      recipients: String(row.recipients ?? '')
        .split(',')
        .filter(Boolean),
      subject: String(row.subject),
      state: row.state as NotificationLogRecord['state'],
      errorCode: (row.error_code as string) ?? null,
      attempts: Number(row.attempts),
      createdAt: new Date(row.created_at as Date),
      sentAt: date(row.sent_at),
    }));
  }

  /** Persiste uma notificação com destinatários e conteúdo já preparados pelo serviço de domínio. */
  async queueNotification(input: NotificationInput) {
    const id = randomUUID();
    const chartContext =
      input.chartContext === undefined
        ? null
        : JSON.stringify(healthNotificationChartContextSchema.parse(input.chartContext));
    const environment =
      input.environment !== undefined
        ? input.environment
        : ((await this.settings(input.projectId))?.settings.sourceEnvironment ?? null);
    await this.db.query(
      `INSERT INTO health_notifications (id, project_id, alert_id, kind, channel, recipients, subject, body, state, error_code,environment,chart_context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        input.projectId,
        input.alertId,
        input.kind,
        input.channel,
        input.recipients.join(','),
        input.subject.slice(0, 300),
        input.body,
        input.state ?? 'pending',
        input.errorCode ?? null,
        environment,
        chartContext,
      ],
    );
    return id;
  }

  /** Lê apenas o estado/código de erro de uma entrega de email do projeto. */
  async notificationDelivery(projectId: string, id: string): Promise<NotificationDelivery | null> {
    const found = await this.db.query<Row>(
      'SELECT state, error_code FROM health_notifications WHERE id=$1 AND project_id=$2 AND channel=$3',
      [id, projectId, 'email'],
    );
    const row = found.rows[0];
    if (!row) return null;
    return {
      state: row.state as NotificationDelivery['state'],
      errorCode: (row.error_code as string) ?? null,
    };
  }

  /** Carrega emails pendentes em ordem de criação até ao limite solicitado. */
  async pendingEmails(limit = 20): Promise<NotificationRecord[]> {
    const found = await this.db.query<Row>(
      `SELECT * FROM health_notifications WHERE state='pending' AND channel='email' ORDER BY created_at LIMIT ${Math.trunc(limit)}`,
    );
    return found.rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      recipients: String(row.recipients).split(',').filter(Boolean),
      subject: String(row.subject),
      body: String(row.body),
      attempts: Number(row.attempts),
    }));
  }

  /** Persiste resultado/tentativa da entrega e carimba data apenas quando enviada. */
  async markNotification(
    id: string,
    state: 'pending' | 'sent' | 'failed' | 'blocked',
    errorCode: string | null,
  ) {
    await this.db.query(
      `UPDATE health_notifications SET state=$1, error_code=$2, attempts=attempts+1,
         sent_at=IF($1='sent', NOW(3), sent_at) WHERE id=$3`,
      [state, errorCode, id],
    );
  }

  /** Guarda amostra autenticada do agente associada ao projeto. */
  async insertAgentSample(projectId: string, sample: HealthAgentSample) {
    await this.db.query(
      'INSERT INTO health_agent_samples (project_id, host, payload) VALUES ($1,$2,$3)',
      [projectId, sample.host, JSON.stringify(sample)],
    );
  }

  private async agentSample(sql: string, values: unknown[]): Promise<StoredAgentSample | null> {
    const found = await this.db.query<Row>(sql, values);
    const row = found.rows[0];
    if (!row) return null;
    const parsed = healthAgentSampleSchema.safeParse(row.payload);
    return parsed.success
      ? { receivedAt: new Date(row.received_at as Date), sample: parsed.data }
      : null;
  }

  /** Obtém a amostra mais recente do agente para o projeto. */
  latestAgentSample(projectId: string) {
    return this.agentSample(
      'SELECT payload, received_at FROM health_agent_samples WHERE project_id=$1 ORDER BY received_at DESC LIMIT 1',
      [projectId],
    );
  }

  /** Ultima amostra de cada host com envio nas ultimas 24h. */
  /** Obtém a amostra mais recente por host, apenas para hosts com heartbeat nas últimas 24 horas. */
  async latestAgentSamples(projectId: string): Promise<StoredAgentSample[]> {
    const found = await this.db.query<Row>(
      `SELECT s.payload, s.received_at FROM health_agent_samples s
       JOIN (SELECT MAX(id) AS last_id FROM health_agent_samples
             WHERE project_id=$1 AND received_at >= NOW(3) - INTERVAL 1 DAY GROUP BY host) h
         ON h.last_id = s.id
       ORDER BY s.received_at DESC`,
      [projectId],
    );
    return found.rows.flatMap((row) => {
      const parsed = healthAgentSampleSchema.safeParse(row.payload);
      return parsed.success
        ? [{ receivedAt: new Date(row.received_at as Date), sample: parsed.data }]
        : [];
    });
  }

  /** Obtém a amostra mais recente de um host anterior ao instante indicado. */
  latestAgentSampleBefore(projectId: string, host: string, before: Date) {
    return this.agentSample(
      `SELECT payload, received_at FROM health_agent_samples
       WHERE project_id=$1 AND host=$2 AND received_at <= $3
       ORDER BY received_at DESC LIMIT 1`,
      [projectId, host, before],
    );
  }

  /** Disponibilidade por verificacao: amostras e amostras ok desde `since`. */
  async availability(projectId: string, since: Date) {
    const found = await this.db.query<Row>(
      `SELECT check_id, COUNT(*) AS total, SUM(status='ok') AS ok, SUM(status='unknown') AS unknown_count
       FROM health_samples WHERE project_id=$1 AND created_at >= $2 GROUP BY check_id`,
      [projectId, since],
    );
    return new Map(
      found.rows.map((row) => [
        String(row.check_id),
        { total: Number(row.total), ok: Number(row.ok), unknown: Number(row.unknown_count) },
      ]),
    );
  }

  /** Lê valores numéricos de uma verificação desde o início da janela indicada. */
  async values(projectId: string, checkId: string, since: Date) {
    const found = await this.db.query<Row>(
      `SELECT value FROM health_samples WHERE project_id=$1 AND check_id=$2 AND created_at >= $3 AND value IS NOT NULL`,
      [projectId, checkId, since],
    );
    return found.rows.map((row) => Number(row.value));
  }

  /** Conta alertas abertos/resolvidos dentro da janela para o relatório periódico. */
  async alertCounts(projectId: string, since: Date) {
    const found = await this.db.query<Row>(
      `SELECT SUM(opened_at >= $2) AS opened, SUM(resolved_at >= $2) AS resolved
       FROM health_alerts WHERE project_id=$1`,
      [projectId, since],
    );
    return {
      opened: Number(found.rows[0]?.opened ?? 0),
      resolved: Number(found.rows[0]?.resolved ?? 0),
    };
  }

  /** Retencao: amostras 30 dias, amostras do agente 2 dias, notificacoes 90 dias, eventos de alarmes 1 ano. */
  async prune(now: Date) {
    const day = 86400000;
    await this.db.query('DELETE FROM health_samples WHERE created_at < $1', [
      new Date(now.getTime() - 30 * day),
    ]);
    await this.db.query('DELETE FROM health_agent_samples WHERE received_at < $1', [
      new Date(now.getTime() - 2 * day),
    ]);
    await this.db.query(
      "DELETE FROM health_notifications WHERE created_at < $1 AND state<>'pending'",
      [new Date(now.getTime() - 90 * day)],
    );
    await this.db.query('DELETE FROM health_alert_events WHERE created_at < $1', [
      new Date(now.getTime() - 365 * day),
    ]);
  }

  /** Gera identificador para um novo registo de saúde. */
  newId() {
    return randomUUID();
  }
}
