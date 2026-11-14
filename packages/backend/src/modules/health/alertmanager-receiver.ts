import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  healthSettingsSchema,
  type HealthCriticality,
  type HealthQuietWindow,
  type HealthSettings,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { suspendedEnvironments } from '../incidents/health-suspension.js';
import { formatLisbonTime } from '../smtp/mail-layout.js';
import { activeQuietWindow } from './health-quiet-windows.js';
import { resolveRecipients } from './health-recipients.js';
import type { HealthIncidents } from './health-incidents.js';
import type { HealthRepository } from './health.repository.js';
import { alertmanagerChartContext } from './charts/chart-alert-context.js';

const text = z.string().max(2000);
/** Formato do `webhook_config` do Alertmanager (versão 4); campos extra são ignorados. */
export const alertmanagerPayloadSchema = z.object({
  alerts: z
    .array(
      z.object({
        status: z.enum(['firing', 'resolved']),
        labels: z.record(z.string().max(200), text),
        annotations: z.record(z.string().max(200), text).default({}),
        startsAt: z.string().max(64),
        endsAt: z.string().max(64).optional(),
        fingerprint: z.string().regex(/^[a-zA-Z0-9]{1,64}$/),
      }),
    )
    .max(200),
});
type AlertmanagerAlert = z.infer<typeof alertmanagerPayloadSchema>['alerts'][number];

const SEVERITY: Record<string, HealthCriticality> = {
  info: 'informativa',
  none: 'informativa',
  warning: 'preventiva',
  critical: 'critica',
  page: 'urgente',
  urgent: 'urgente',
};
const CRITICALITIES = new Set<string>(['informativa', 'preventiva', 'critica', 'urgente']);

/** Criticidade do alerta: label `criticality` explícita ou mapeamento da `severity` habitual. */
export function alertCriticality(labels: Record<string, string>): HealthCriticality {
  const explicit = labels.criticality;
  if (explicit && CRITICALITIES.has(explicit)) return explicit as HealthCriticality;
  return SEVERITY[(labels.severity ?? '').toLowerCase()] ?? 'preventiva';
}

const CRITICALITY_NAMES: Record<HealthCriticality, string> = {
  informativa: 'Informativa',
  preventiva: 'Preventiva',
  critica: 'Crítica',
  urgente: 'Urgente',
};
/** Labels habituais do Prometheus mostradas com nome legível; as restantes ficam em "Outras etiquetas". */
const LABEL_NAMES: Record<string, string> = {
  instance: 'Servidor',
  env: 'Ambiente',
  service: 'Serviço',
  job: 'Origem',
};
const HIDDEN_LABELS = new Set(['alertname', 'severity', 'criticality', 'role']);
const ENVIRONMENT_NAMES: Record<string, string> = {
  quality: 'Qualidade (QA)',
  production: 'Produção',
};
const labelValue = (key: string, value: string) =>
  key === 'env' ? (ENVIRONMENT_NAMES[value] ?? value) : value;
const readableTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatLisbonTime(date);
};
const opensTicket = (criticality: HealthCriticality) =>
  criticality === 'critica' || criticality === 'urgente';
/**
 * Título legível: anotação `title` da regra, o título já guardado (ex.: resolução por
 * reconciliação, sem anotações) ou o `alertname` em CamelCase separado em palavras.
 */
const alertTitle = (alert: AlertmanagerAlert, fallback: string, stored?: string | null) => {
  const title = alert.annotations.title?.trim();
  if (title) return title.slice(0, 120);
  if (stored) return stored.slice(0, 120);
  const name = alert.labels.alertname;
  if (!name) return fallback;
  const words = name
    .replace(/([a-zà-ÿ0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return (words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()).slice(0, 120);
};

type Transition = 'new' | 'refire' | 'resolved';
interface StoredAlert {
  id: string;
  state: 'firing' | 'resolved';
  ticket_id: string | null;
  title: string | null;
  /** 1 quando o disparo foi silenciado por uma paragem planeada (ainda sem e-mail nem ticket). */
  muted: boolean;
}
interface MutedRow {
  id: string;
  project_id: string;
  fingerprint: string;
  title: string | null;
  summary: string;
  labels: string;
  starts_at: Date;
  ticket_id: string | null;
}
/** `missed`: o disparo não chegou (ex.: ZeroOps em baixo) e só foi recebida a resolução. */
interface AlertTransition {
  kind: Transition;
  stored: StoredAlert;
  missed?: boolean;
}

const MISSED_NOTE =
  'O disparo deste alerta não foi recebido em tempo real (ZeroOps indisponível); registado a partir da resolução.';
const RELEASED_NOTE =
  'Alerta disparado durante uma paragem planeada e ainda ativo depois de ela terminar.';
const SUSPENDED_NOTE = 'Sem notificação: Saúde suspensa neste ambiente.';

/** Ambiente do alerta pela label `env` (sem label conta como produção). */
export const alertEnvironment = (labels: Record<string, string>) =>
  labels.env === 'quality' ? 'quality' : 'production';

function date(value: string | undefined, fallback: Date) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() > 2000
    ? parsed
    : fallback;
}

/**
 * Recebe os alertas do Alertmanager: deduplica por fingerprint, envia e-mail para as listas da
 * criticidade e abre um ticket nos alertas críticos/urgentes (anotado quando volta a disparar
 * ou é resolvido). Repetições de um alerta ainda ativo só atualizam o registo.
 */
export class AlertmanagerReceiver {
  constructor(
    private readonly db: Database,
    private readonly repository: HealthRepository,
    private readonly incidents: HealthIncidents | null,
    private readonly publicUrl?: string,
  ) {}

  /** Valida o webhook do Alertmanager e regista/encaminha os alertas recebidos para o projeto. */
  async receive(projectId: string, body: unknown) {
    const parsed = alertmanagerPayloadSchema.safeParse(body);
    if (!parsed.success)
      throw new DomainError('VALIDATION', 'Payload do Alertmanager inválido.', 400);
    const settings = await this.settingsOf(projectId);
    const suspensions = await suspendedEnvironments(this.db, projectId);
    const now = new Date();
    let notified = 0;
    let opened = 0;
    let muted = 0;
    for (const alert of parsed.data.alerts) {
      const transition = await this.store(projectId, alert, now);
      if (!transition) continue;
      if (suspensions.includes(alertEnvironment(alert.labels))) {
        await this.suspendedAlert(projectId, alert, transition, now);
        muted += 1;
        continue;
      }
      const quiet = activeQuietWindow(settings, `rule:${alert.labels.alertname ?? ''}`, now);
      const silenced = await this.silenced(transition, quiet);
      if (transition.missed)
        await this.repository.recordAlertEvent({
          projectId,
          alertId: transition.stored.id,
          source: 'prometheus',
          kind: 'opened',
          detail: alert.annotations.summary ?? alert.labels.alertname ?? null,
          at: date(alert.startsAt, now),
        });
      await this.repository.recordAlertEvent({
        projectId,
        alertId: transition.stored.id,
        source: 'prometheus',
        kind:
          transition.kind === 'new'
            ? 'opened'
            : transition.kind === 'refire'
              ? 'refired'
              : 'resolved',
        detail:
          silenced && quiet
            ? `Sem notificação: paragem planeada «${quiet.name}».`
            : (alert.annotations.summary ?? alert.labels.alertname ?? null),
        at: now,
      });
      if (silenced) {
        muted += 1;
        continue;
      }
      notified += await this.notify(projectId, settings, alert, transition);
      opened += await this.ticket(projectId, alert, transition);
    }
    return { accepted: parsed.data.alerts.length, notified, opened, muted };
  }

  /**
   * Saúde suspensa no ambiente do alerta: só fica registado (`suspended`), sem e-mail nem ticket.
   * Na retoma, os que continuam ativos passam a silenciados e são libertados pelo `releaseMuted`.
   */
  private async suspendedAlert(
    projectId: string,
    alert: AlertmanagerAlert,
    transition: AlertTransition,
    now: Date,
  ) {
    const resolved = transition.kind === 'resolved';
    await this.db.query(
      resolved
        ? 'UPDATE health_external_alerts SET suspended=0, muted=0 WHERE id=$1'
        : 'UPDATE health_external_alerts SET suspended=1 WHERE id=$1',
      [transition.stored.id],
    );
    await this.repository.recordAlertEvent({
      projectId,
      alertId: transition.stored.id,
      source: 'prometheus',
      kind: resolved ? 'resolved' : transition.kind === 'new' ? 'opened' : 'refired',
      detail:
        `${SUSPENDED_NOTE} ${alert.annotations.summary ?? alert.labels.alertname ?? ''}`.trim(),
      at: now,
    });
  }

  /**
   * Paragem planeada: o disparo fica registado (`muted`) sem e-mail nem ticket, e a resolução de
   * um alerta que nunca foi notificado também não notifica. Devolve se o alerta foi silenciado.
   */
  private async silenced(transition: AlertTransition, quiet: HealthQuietWindow | undefined) {
    const { kind, stored } = transition;
    if (kind !== 'resolved') {
      if (!quiet) return false;
      await this.db.query('UPDATE health_external_alerts SET muted=1 WHERE id=$1', [stored.id]);
      return true;
    }
    if (!stored.muted && !(transition.missed && quiet)) return false;
    await this.db.query('UPDATE health_external_alerts SET muted=0 WHERE id=$1', [stored.id]);
    return true;
  }

  /**
   * Alertas silenciados por uma paragem planeada que continuam ativos depois de ela terminar:
   * notifica-os (e abre o ticket) nessa altura. Corre no ciclo de reconciliação do worker.
   */
  async releaseMuted(now = new Date()) {
    const rows = await this.db.query<MutedRow>(
      `SELECT id, project_id, fingerprint, title, summary, labels, starts_at, ticket_id
         FROM health_external_alerts WHERE source='alertmanager' AND state='firing' AND muted=1`,
    );
    const settings = new Map<string, HealthSettings>();
    const suspensions = new Map<string, string[]>();
    let released = 0;
    for (const row of rows.rows) {
      const projectSettings =
        settings.get(row.project_id) ?? (await this.settingsOf(row.project_id));
      settings.set(row.project_id, projectSettings);
      const suspended =
        suspensions.get(row.project_id) ?? (await suspendedEnvironments(this.db, row.project_id));
      suspensions.set(row.project_id, suspended);
      const labels = JSON.parse(row.labels) as Record<string, string>;
      if (suspended.includes(alertEnvironment(labels))) continue;
      if (activeQuietWindow(projectSettings, `rule:${labels.alertname ?? ''}`, now)) continue;
      const claimed = await this.db.query(
        'UPDATE health_external_alerts SET muted=0 WHERE id=$1 AND muted=1',
        [row.id],
      );
      if (claimed.rowCount !== 1) continue;
      const alert: AlertmanagerAlert = {
        status: 'firing',
        labels,
        annotations: {
          summary: row.summary,
          description: RELEASED_NOTE,
          ...(row.title ? { title: row.title } : {}),
        },
        startsAt: new Date(row.starts_at).toISOString(),
        fingerprint: row.fingerprint,
      };
      const transition: AlertTransition = {
        kind: 'new',
        stored: {
          id: row.id,
          state: 'firing',
          ticket_id: row.ticket_id,
          title: row.title,
          muted: false,
        },
      };
      await this.notify(row.project_id, projectSettings, alert, transition);
      await this.ticket(row.project_id, alert, transition);
      released += 1;
    }
    return released;
  }

  private async settingsOf(projectId: string) {
    return (await this.repository.settings(projectId))?.settings ?? healthSettingsSchema.parse({});
  }

  /** Grava o alerta e devolve a transição relevante (ou `null` numa repetição sem mudança). */
  private async store(
    projectId: string,
    alert: AlertmanagerAlert,
    now: Date,
  ): Promise<AlertTransition | null> {
    const name = (alert.labels.alertname ?? 'alerta').slice(0, 120);
    const summary = (alert.annotations.summary ?? alert.annotations.description ?? name).slice(
      0,
      500,
    );
    const criticality = alertCriticality(alert.labels);
    const startsAt = date(alert.startsAt, now);
    const labels = JSON.stringify(alert.labels);
    const title = alert.annotations.title?.trim().slice(0, 160) || null;
    if (alert.status === 'firing') {
      const inserted = await this.db.query(
        `INSERT IGNORE INTO health_external_alerts
           (id,project_id,source,fingerprint,alert_name,title,criticality,state,summary,labels,starts_at,last_received_at)
         VALUES ($1,$2,'alertmanager',$3,$4,$10,$5,'firing',$6,$7,$8,$9)`,
        [
          randomUUID(),
          projectId,
          alert.fingerprint,
          name,
          criticality,
          summary,
          labels,
          startsAt,
          now,
          title,
        ],
      );
      const stored = await this.find(projectId, alert.fingerprint);
      if (!stored) return null;
      if (inserted.rowCount === 1) return { kind: 'new', stored };
      await this.db.query(
        `UPDATE health_external_alerts
            SET fire_count=fire_count + IF(state='resolved', 1, 0),
                starts_at=IF(state='resolved', $1, starts_at),
                state='firing', resolved_at=NULL, summary=$2, labels=$3, criticality=$4, last_received_at=$5,
                title=COALESCE($7, title)
          WHERE id=$6`,
        [startsAt, summary, labels, criticality, now, stored.id, title],
      );
      return stored.state === 'resolved' ? { kind: 'refire', stored } : null;
    }
    const resolvedAt = date(alert.endsAt, now);
    const stored = await this.find(projectId, alert.fingerprint);
    if (!stored) {
      const inserted = await this.db.query(
        `INSERT IGNORE INTO health_external_alerts
           (id,project_id,source,fingerprint,alert_name,title,criticality,state,summary,labels,starts_at,resolved_at,last_received_at)
         VALUES ($1,$2,'alertmanager',$3,$4,$11,$5,'resolved',$6,$7,$8,$9,$10)`,
        [
          randomUUID(),
          projectId,
          alert.fingerprint,
          name,
          criticality,
          summary,
          labels,
          startsAt,
          resolvedAt,
          now,
          title,
        ],
      );
      const created = await this.find(projectId, alert.fingerprint);
      return inserted.rowCount === 1 && created
        ? { kind: 'resolved', stored: created, missed: true }
        : null;
    }
    if (stored.state === 'resolved') return null;
    await this.db.query(
      `UPDATE health_external_alerts SET state='resolved', resolved_at=$1, last_received_at=$2 WHERE id=$3`,
      [resolvedAt, now, stored.id],
    );
    return { kind: 'resolved', stored };
  }

  private async find(projectId: string, fingerprint: string) {
    const found = await this.db.query<StoredAlert>(
      `SELECT id,state,ticket_id,title,muted FROM health_external_alerts
        WHERE project_id=$1 AND source='alertmanager' AND fingerprint=$2`,
      [projectId, fingerprint],
    );
    return found.rows[0] ?? null;
  }

  private describe(alert: AlertmanagerAlert, criticality: HealthCriticality) {
    const known = Object.entries(LABEL_NAMES)
      .filter(([key]) => alert.labels[key])
      .map(([key, name]) => `${name}: ${labelValue(key, alert.labels[key] ?? '')}`);
    const others = Object.entries(alert.labels)
      .filter(([key]) => !(key in LABEL_NAMES) && !HIDDEN_LABELS.has(key))
      .map(([key, value]) => `  - ${key}: ${value}`);
    const link = this.publicUrl ? `${this.publicUrl.replace(/\/$/, '')}/#health` : null;
    return [
      alert.annotations.summary ?? alert.labels.alertname ?? 'Alerta do Prometheus',
      alert.annotations.description ?? '',
      '',
      `Criticidade: ${CRITICALITY_NAMES[criticality]}`,
      `Início: ${readableTime(alert.startsAt)}`,
      `Alerta: ${alert.labels.alertname ?? '-'}`,
      ...known,
      ...(others.length ? ['Outras etiquetas:', ...others] : []),
      link ? `Painel: ${link}` : '',
    ]
      .filter((line, index) => line !== '' || index === 2)
      .join('\n');
  }

  private async notify(
    projectId: string,
    settings: HealthSettings,
    alert: AlertmanagerAlert,
    transition: AlertTransition,
  ) {
    const { kind } = transition;
    const criticality = alertCriticality(alert.labels);
    const name = alert.labels.alertname ?? 'alerta';
    const recipients = resolveRecipients(settings, criticality, `alertmanager:${name}`);
    const prefix = kind === 'resolved' ? 'RESOLVIDO' : CRITICALITY_NAMES[criticality].toUpperCase();
    const instance = alert.labels.instance ? ` (${alert.labels.instance})` : '';
    await this.repository.queueNotification({
      projectId,
      environment:
        alert.labels.env === 'quality' || alert.labels.env === 'production'
          ? alert.labels.env
          : null,
      alertId: transition.stored.id,
      chartContext: alertmanagerChartContext(name, alert.labels),
      kind: kind === 'resolved' ? 'resolved' : 'alert',
      channel: 'email',
      recipients,
      subject: `[ZeroOps Saúde][${prefix}] ${alertTitle(alert, 'Alerta', transition.stored.title)}${instance}`,
      body: transition.missed
        ? `${MISSED_NOTE}\n\n${this.describe(alert, criticality)}`
        : this.describe(alert, criticality),
      state: recipients.length ? 'pending' : 'blocked',
      errorCode: recipients.length ? undefined : 'no_recipients',
    });
    return recipients.length ? 1 : 0;
  }

  /**
   * Alertas críticos/urgentes abrem (ou juntam-se a) um incidente da Saúde; a recuperação de todos
   * os alertas do incidente inicia a análise pós-incidente e o fecho com relatório.
   */
  private async ticket(projectId: string, alert: AlertmanagerAlert, transition: AlertTransition) {
    const { kind, stored, missed } = transition;
    const criticality = alertCriticality(alert.labels);
    if (!this.incidents || !opensTicket(criticality)) return 0;
    const name = alertTitle(alert, 'Alerta', stored.title);
    const where = alert.labels.instance ? ` em ${alert.labels.instance}` : '';
    const resolvedNote = `Alerta «${name}»${where} recuperou em ${alert.endsAt ? readableTime(alert.endsAt) : 'agora'}.`;
    const description = this.describe(alert, criticality);
    const input = {
      alertId: stored.id,
      linkedTicketId: stored.ticket_id,
      environment: alert.labels.env === 'quality' ? ('quality' as const) : ('production' as const),
      name: alert.labels.alertname ?? name,
      labels: alert.labels,
      title: `${name}${where}`,
      description: missed ? `${MISSED_NOTE}\n\n${description}` : description,
      priority: criticality === 'urgente' ? ('critical' as const) : ('high' as const),
    };
    try {
      if (kind === 'resolved') {
        if (stored.ticket_id) {
          await this.incidents.recovered(projectId, stored.ticket_id, resolvedNote);
          return 0;
        }
        if (!missed) return 0;
        const incident = await this.incidents.fired(projectId, input);
        if (incident) await this.incidents.recovered(projectId, incident.ticketId, resolvedNote);
        return incident?.opened ? 1 : 0;
      }
      const incident = await this.incidents.fired(projectId, input);
      return incident?.opened ? 1 : 0;
    } catch {
      // O e-mail já ficou em fila; uma falha no ticket não bloqueia o webhook.
      return 0;
    }
  }
}
