import type { HealthSettings, HealthStatus } from '../../../../contracts/src/index.js';
import type { CreateTicket } from '../../../../contracts/src/index.js';
import { healthAlertKey } from '../../../../contracts/src/index.js';
import {
  HEALTH_CATALOG,
  RENOTIFY_MINUTES,
  catalogEntry,
  type HealthCheckCatalogEntry,
} from './health-catalog.js';
import {
  errorCode,
  unknown,
  type CheckResult,
  type CollectorContext,
  type HealthCollector,
} from './collectors/collector.js';
import type { AlertRecord, HealthRepository, StateRecord } from './health.repository.js';
import { resolveRecipients } from './health-recipients.js';
import { activeQuietWindow } from './health-quiet-windows.js';
import type { CreateTicketOptions } from '../tickets/tickets.service.js';
import type { HealthTicketGateway } from './health-tickets.js';

export type AlertAction =
  | { type: 'none' }
  | { type: 'open' }
  | { type: 'update'; notify: boolean; reason?: 'escalated' | 'reminder' }
  | { type: 'resolve' };

/**
 * Decisao pura sobre o alerta de uma verificacao:
 * - abre quando o estado e warning/critical ha pelo menos `confirmMinutes`;
 * - re-notifica se agravar ou, sem rececao confirmada, quando passar o intervalo da criticidade;
 * - resolve quando volta a ok; `unknown` (sem dados) nao abre nem fecha alertas.
 */
export function decideAlert(
  entry: HealthCheckCatalogEntry,
  status: HealthStatus,
  statusSince: Date,
  open: Pick<AlertRecord, 'severity' | 'acknowledgedAt' | 'lastNotifiedAt' | 'openedAt'> | null,
  now: Date,
): AlertAction {
  if (status === 'unknown') return { type: 'none' };
  if (status === 'ok') return open ? { type: 'resolve' } : { type: 'none' };
  const confirmed = now.getTime() - statusSince.getTime() >= entry.confirmMinutes * 60000;
  if (!open) return confirmed ? { type: 'open' } : { type: 'none' };
  if (open.severity === 'warning' && status === 'critical')
    return { type: 'update', notify: true, reason: 'escalated' };
  const interval = RENOTIFY_MINUTES[entry.criticality];
  const last = open.lastNotifiedAt ?? open.openedAt;
  const due =
    interval !== null && !open.acknowledgedAt && now.getTime() - last.getTime() >= interval * 60000;
  return { type: 'update', notify: due, reason: due ? 'reminder' : undefined };
}

export interface CycleOutcome {
  results: CheckResult[];
  opened: number;
  resolved: number;
  notified: number;
}

function scheduledJobTicketInput(
  settings: HealthSettings,
  result: CheckResult,
): { input: CreateTicket; options: CreateTicketOptions } {
  const environment = settings.sourceEnvironment;
  const environmentName = environment === 'quality' ? 'Qualidade (QA)' : 'Produção';
  const summaries = new Set<string>();
  const collectSummaries = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collectSummaries);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (
      'summary' in value &&
      typeof value.summary === 'string' &&
      'status' in value &&
      value.status !== 'ok'
    )
      summaries.add(value.summary);
    Object.values(value).forEach(collectSummaries);
  };
  collectSummaries(result.details);
  const taskDetails = [...summaries]
    .map((summary) => `- ${summary}`)
    .join('\n')
    .slice(0, 12000);
  return {
    input: {
      title: `[Saúde][${environmentName}] Falhas em tarefas agendadas`,
      description: [
        `Incidente detetado automaticamente pela Saúde em ${environmentName}.`,
        '',
        `Verificação: ${catalogEntry('scheduled-jobs').title}`,
        `Criticidade: ${result.status === 'critical' ? 'crítica' : 'aviso'}`,
        `Resumo: ${result.summary}`,
        taskDetails ? `\nTarefas com falha ou atraso:\n${taskDetails}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      category: 'incident',
      environment,
      priority: 'high',
    },
    options: {
      origin: 'health',
      alertKey: healthAlertKey('check', 'scheduled-jobs'),
      agentInstructions: [
        `Alerta crítico da verificação interna de tarefas agendadas no ambiente ${environmentName}.`,
        'Investiga em modo estritamente de leitura: confirma se as falhas HTTP 5xx persistem, consulta os logs e identifica a causa provável e o impacto.',
        'Não voltes a executar tarefas, não reinicies serviços e não alteres código, dados ou configuração.',
        'Regista as evidências no resumo interno e não faças perguntas ao cliente.',
      ].join(' '),
    },
  };
}

const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: 'OK',
  warning: 'AVISO',
  critical: 'CRÍTICO',
  unknown: 'SEM DADOS',
};

/** Executa as verificacoes de um projeto, guarda o estado e gere alertas e notificacoes. */
export class HealthMonitor {
  constructor(
    private readonly repository: HealthRepository,
    private readonly collectors: readonly HealthCollector[],
    private readonly publicUrl?: string,
    private readonly tickets?: HealthTicketGateway,
  ) {}

  /** Recolhe as fontes, persiste estados e aplica as transições de alerta do projeto. */
  async runCycle(projectId: string, now = new Date()): Promise<CycleOutcome> {
    const record = await this.repository.settings(projectId);
    if (!record) return { results: [], opened: 0, resolved: 0, notified: 0 };
    if (await this.repository.isSuspended(projectId, record.settings.sourceEnvironment))
      return { results: [], opened: 0, resolved: 0, notified: 0 };
    const states = await this.repository.states(projectId);
    const context: CollectorContext = {
      projectId,
      settings: record.settings,
      now,
      previous: (checkId) => {
        const state = states.get(checkId);
        return state ? { value: state.value, details: state.details } : undefined;
      },
    };
    const results: CheckResult[] = [];
    for (const collector of this.collectors) {
      try {
        const collected = await collector.collect(context);
        const ids = new Set(collected.map((item) => item.checkId));
        results.push(
          ...collected,
          ...collector.checks
            .filter((id) => !ids.has(id))
            .map((id) => unknown(id, 'Sem resultado do coletor.')),
        );
      } catch (error) {
        const code = errorCode(error);
        results.push(
          ...collector.checks.map((id) =>
            unknown(id, `Recolha "${collector.name}" falhou (${code}).`),
          ),
        );
      }
    }
    results.push(this.reportCheck(record.settings, record.lastReportAt, now));
    const outcome: CycleOutcome = { results, opened: 0, resolved: 0, notified: 0 };
    for (const result of results) {
      if (!HEALTH_CATALOG.some((entry) => entry.id === result.checkId)) continue;
      const previous = states.get(result.checkId);
      const statusSince =
        previous && previous.status === result.status ? previous.statusSince : now;
      await this.repository.saveState(projectId, result, now, statusSince);
      await this.applyAlert(projectId, record.settings, result, statusSince, now, outcome);
    }
    await this.repository.touch(projectId, 'last_cycle_at', now);
    return outcome;
  }

  private reportCheck(settings: HealthSettings, lastReportAt: Date | null, now: Date): CheckResult {
    if (!resolveRecipients(settings, 'report').length)
      return unknown('periodic-report', 'Sem destinatários do relatório configurados.');
    if (!lastReportAt)
      return unknown('periodic-report', `Primeiro relatório às ${settings.reportHourUtc}:00 UTC.`);
    const hours = (now.getTime() - lastReportAt.getTime()) / 3600000;
    return {
      checkId: 'periodic-report',
      status: hours > 26 ? 'warning' : 'ok',
      value: Math.round(hours),
      unit: 'h desde o último',
      summary: `Último relatório em ${lastReportAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    };
  }

  private async applyAlert(
    projectId: string,
    settings: HealthSettings,
    result: CheckResult,
    statusSince: Date,
    now: Date,
    outcome: CycleOutcome,
  ) {
    const entry = catalogEntry(result.checkId);
    const open = await this.repository.openAlert(projectId, entry.id);
    let action = decideAlert(entry, result.status, statusSince, open, now);
    // Paragem planeada: não abre nem relembra; se o problema persistir, abre quando a janela fechar.
    const quiet = Boolean(activeQuietWindow(settings, entry.id, now));
    if (quiet) {
      if (action.type === 'open') return;
      if (action.type === 'update') action = { type: 'update', notify: false };
    }
    const severity = result.status as AlertRecord['severity'];
    if (action.type === 'open') {
      const alert = await this.repository.createAlert(
        projectId,
        entry.id,
        entry.criticality,
        severity,
        result.summary,
        now,
      );
      outcome.opened += 1;
      await this.repository.recordAlertEvent({
        projectId,
        alertId: alert.id,
        kind: 'opened',
        detail: result.summary,
        at: now,
      });
      outcome.notified += await this.notify(
        projectId,
        settings,
        entry,
        alert,
        result,
        'alert',
        true,
      );
      await this.repository.markNotified(alert.id, now);
      if (!quiet) await this.ensureScheduledJobTicket(projectId, settings, result, alert);
    } else if (action.type === 'update' && open) {
      await this.repository.updateAlert(open.id, severity, result.summary);
      if (action.reason)
        await this.repository.recordAlertEvent({
          projectId,
          alertId: open.id,
          kind: action.reason,
          detail: result.summary,
          at: now,
        });
      if (action.notify) {
        outcome.notified += await this.notify(
          projectId,
          settings,
          entry,
          open,
          result,
          'alert',
          false,
          action.reason,
        );
        await this.repository.markNotified(open.id, now);
      }
      if (!quiet) await this.ensureScheduledJobTicket(projectId, settings, result, open);
    } else if (action.type === 'resolve' && open) {
      await this.repository.resolveAlert(open.id, now);
      await this.repository.recordAlertEvent({
        projectId,
        alertId: open.id,
        kind: 'resolved',
        detail: result.summary,
        at: now,
      });
      outcome.resolved += 1;
      outcome.notified += await this.notify(
        projectId,
        settings,
        entry,
        open,
        result,
        'resolved',
        false,
      );
      if (open.ticketId)
        await this.tickets?.comment(
          projectId,
          open.ticketId,
          `A verificação «${entry.title}» recuperou. Estado atual: ${result.summary}`,
        );
    }
  }

  private async ensureScheduledJobTicket(
    projectId: string,
    settings: HealthSettings,
    result: CheckResult,
    alert: AlertRecord,
  ) {
    if (result.checkId !== 'scheduled-jobs' || result.status !== 'critical' || alert.ticketId)
      return;
    const healthOccurrence = { source: 'internal' as const, alertId: alert.id };
    if (await this.repository.ticketSuppressed(projectId, healthOccurrence)) return;
    if (!this.tickets)
      throw new Error('Criação de tickets para falhas de tarefas agendadas não configurada.');
    const { input, options } = scheduledJobTicketInput(settings, result);
    const ticket = await this.tickets.open(projectId, input, { ...options, healthOccurrence });
    if (!ticket && (await this.repository.ticketSuppressed(projectId, healthOccurrence))) return;
    if (!ticket)
      throw new Error(`Não foi possível criar um ticket para o alerta de Saúde ${alert.id}.`);
    await this.repository.linkTicket(projectId, alert.id, ticket.id);
    await this.repository.recordAlertEvent({
      projectId,
      alertId: alert.id,
      kind: 'ticket',
      detail: ticket.id,
    });
  }

  /** Enfileira as notificacoes dos canais da criticidade. SMS/chamada ficam bloqueados sem fornecedor. */
  private async notify(
    projectId: string,
    settings: HealthSettings,
    entry: HealthCheckCatalogEntry,
    alert: AlertRecord,
    result: CheckResult,
    kind: 'alert' | 'resolved',
    first: boolean,
    reason?: 'escalated' | 'reminder',
  ) {
    if (!entry.channels.includes('email')) return 0;
    const recipients = resolveRecipients(settings, entry.criticality, entry.id);
    const prefix =
      kind === 'resolved'
        ? 'RESOLVIDO'
        : `${entry.criticality.toUpperCase()}${reason === 'reminder' ? ' (lembrete)' : reason === 'escalated' ? ' (agravado)' : ''}`;
    const subject = `[ZeroOps Saúde][${prefix}] ${entry.title}`;
    const link = this.publicUrl ? `${this.publicUrl.replace(/\/$/, '')}/#health` : null;
    const body = [
      kind === 'resolved'
        ? `A verificação voltou ao normal.`
        : `Estado: ${STATUS_LABEL[result.status]}`,
      '',
      `Verificação: ${entry.title}`,
      `Criticidade: ${entry.criticality} (canais: ${entry.channels.join(', ')})`,
      `Detalhe: ${result.summary}`,
      `Aberto em: ${alert.openedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`,
      alert.assignedName ? `Atribuído a: ${alert.assignedName}` : 'Atribuído a: ninguém',
      kind === 'alert' && entry.criticality === 'urgente'
        ? 'Confirme a receção e atribua o alerta na página Saúde.'
        : '',
      link ? `Painel: ${link}` : '',
    ]
      .filter((line, index) => line !== '' || index === 1)
      .join('\n');
    await this.repository.queueNotification({
      projectId,
      environment: settings.sourceEnvironment,
      alertId: alert.id,
      chartContext: {
        source: 'internal',
        key: entry.id,
        targets: result.chartTargets ?? [],
      },
      kind,
      channel: 'email',
      recipients,
      subject,
      body,
      state: recipients.length ? 'pending' : 'blocked',
      errorCode: recipients.length ? undefined : 'no_recipients',
    });
    if (first)
      for (const channel of entry.channels.filter((item) => item === 'sms' || item === 'chamada'))
        await this.repository.queueNotification({
          projectId,
          environment: settings.sourceEnvironment,
          alertId: alert.id,
          kind,
          channel,
          recipients: [],
          subject,
          body: result.summary,
          state: 'blocked',
          errorCode: 'channel_not_configured',
        });
    return recipients.length ? 1 : 0;
  }
}

export type { StateRecord };
