import { CRITICALITY_ORDER, HEALTH_CATALOG } from './health-catalog.js';
import { resolveRecipients } from './health-recipients.js';
import type { HealthRepository } from './health.repository.js';

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Relatorio periodico (diario) de disponibilidade e desempenho, enviado por e-mail. */
export class HealthReporter {
  constructor(
    private readonly repository: HealthRepository,
    private readonly publicUrl?: string,
  ) {}

  /** Enfileira o relatorio se ja passou a hora configurada e ainda nao foi enviado hoje (UTC). */
  async sendIfDue(projectId: string, now = new Date(), force = false): Promise<string | null> {
    const record = await this.repository.settings(projectId);
    if (!record) return null;
    const { settings, lastReportAt } = record;
    const today = now.toISOString().slice(0, 10);
    const due =
      now.getUTCHours() >= settings.reportHourUtc &&
      lastReportAt?.toISOString().slice(0, 10) !== today;
    if (!force && !due) return null;
    const recipients = resolveRecipients(settings, 'report', 'periodic-report');
    const { subject, body } = await this.build(projectId, now);
    const notificationId = await this.repository.queueNotification({
      projectId,
      alertId: null,
      kind: 'report',
      channel: 'email',
      recipients,
      subject,
      body,
      state: recipients.length ? 'pending' : 'blocked',
      errorCode: recipients.length ? undefined : 'no_recipients',
    });
    await this.repository.touch(projectId, 'last_report_at', now);
    return notificationId;
  }

  /** Agrega amostras e alertas recentes num relatório sem expor credenciais. */
  async build(projectId: string, now: Date) {
    const since = new Date(now.getTime() - 86400000);
    const [availability, states, responseTimes, counts, alerts] = await Promise.all([
      this.repository.availability(projectId, since),
      this.repository.states(projectId),
      this.repository.values(projectId, 'response-time', since),
      this.repository.alertCounts(projectId, since),
      this.repository.recentAlerts(projectId, since),
    ]);
    const open = alerts
      .filter((alert) => !alert.resolvedAt)
      .sort((a, b) => CRITICALITY_ORDER[a.criticality] - CRITICALITY_ORDER[b.criticality]);
    const site = availability.get('site-availability');
    const siteAvailability =
      site && site.total - site.unknown > 0
        ? ((site.ok / (site.total - site.unknown)) * 100).toFixed(2)
        : '-';
    const average = responseTimes.length
      ? Math.round(responseTimes.reduce((acc, value) => acc + value, 0) / responseTimes.length)
      : null;
    const lines = [
      `Relatório de disponibilidade e desempenho — últimas 24h (até ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
      '',
      `Disponibilidade do site: ${siteAvailability}%`,
      `Tempo de resposta: médio ${average ?? '-'} ms, p95 ${percentile(responseTimes, 95) ?? '-'} ms`,
      `Alertas: ${counts.opened} abertos e ${counts.resolved} resolvidos nas últimas 24h; ${open.length} ainda abertos.`,
      '',
      'Alertas abertos:',
      ...(open.length
        ? open.map(
            (alert) =>
              `- [${alert.criticality}] ${HEALTH_CATALOG.find((e) => e.id === alert.checkId)?.title}: ${alert.summary}${alert.assignedName ? ` (atribuído a ${alert.assignedName})` : ''}`,
          )
        : ['- nenhum']),
      '',
      'Estado por verificação (disponibilidade 24h = amostras OK / amostras com dados):',
      ...HEALTH_CATALOG.map((entry) => {
        const state = states.get(entry.id);
        const stats = availability.get(entry.id);
        const measured = stats ? stats.total - stats.unknown : 0;
        const pct =
          stats && measured > 0 ? `${((stats.ok / measured) * 100).toFixed(1)}%` : 'sem dados';
        return `- [${entry.criticality}] ${entry.title}: ${state?.status ?? 'sem dados'} · ${pct} · ${state?.summary ?? ''}`;
      }),
      '',
      this.publicUrl ? `Painel: ${this.publicUrl.replace(/\/$/, '')}/#health` : '',
    ];
    return {
      subject: `[ZeroOps Saúde] Relatório diário ${now.toISOString().slice(0, 10)} — site ${siteAvailability}%, ${open.length} alertas abertos`,
      body: lines.join('\n').trim(),
    };
  }
}
