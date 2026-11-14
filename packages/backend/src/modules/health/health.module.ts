import type { HealthChartEnvironment } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { siteDatabaseUrl } from '../connectors/site-database.connector.js';
import type { IntegrationSettingsService } from '../integrations/integration-settings.service.js';
import { LokiConnector } from '../connectors/loki.connector.js';
import { PrometheusConnector } from '../connectors/prometheus.connector.js';
import { SiteDatabaseConnector } from '../connectors/site-database.connector.js';
import type { CollectorContext } from './collectors/collector.js';
import { freshSamples, HostAgentCollector } from './collectors/host-agent.collector.js';
import { HttpProbeCollector } from './collectors/http-probe.collector.js';
import { FallbackCollector, PrometheusCollector } from './collectors/prometheus.collector.js';
import { LOG_SAMPLE_LIMIT, LogsCollector } from './collectors/logs.collector.js';
import { SiteDatabaseCollector } from './collectors/site-database.collector.js';
import { AlertmanagerReceiver } from './alertmanager-receiver.js';
import { AlertmanagerActiveAlerts, AlertReconciler } from './alert-reconciler.js';
import { AlertSpool } from './alert-spool.js';
import { HealthTickets } from './health-tickets.js';
import { HealthIncidentLifecycle, type IncidentDelegate } from './health-incident-lifecycle.js';
import { IncidentMetricReadings } from './health-incident-metrics.js';
import { HealthIncidents } from './health-incidents.js';
import { autoInvestigateNewTicket } from '../agents/agent-auto-runs.js';
import { TicketsService, type TicketCreatedHook } from '../tickets/tickets.service.js';
import { HealthMonitor } from './health-monitor.js';
import { MailBranding } from '../smtp/mail-branding.js';
import { HealthNotifier } from './health-notifier.js';
import { HealthReporter } from './health-reporter.js';
import { HealthRepository } from './health.repository.js';
import { HealthService } from './health.service.js';
import { PrometheusRulesSync } from './prometheus-rules-sync.js';
import { RemoteWriteForwarder } from './remote-write-forwarder.js';
import { ChartRepository } from './charts/chart.repository.js';
import { ChartRollup } from './charts/chart-rollup.js';
import { CHART_POINTS, HealthChartsService } from './charts/health-charts.service.js';
import { ChartAvailabilityObserver, ChartEventsRepository } from './charts/chart-events.js';

/**
 * Composicao do modulo Saude: coletores ligados as integracoes verificadas do projeto
 * (BD do site e Loki do ambiente de origem) e e-mail pelo SMTP de instancia.
 */
export function createHealthMonitoring(
  db: Database,
  settings: IntegrationSettingsService,
  publicUrl?: string,
  prometheusWriteUrl?: string,
  alertSpoolDir?: string,
  alertmanagerUrl?: string,
  prometheusRules?: { directory?: string; url?: string },
  hooks: { ticketCreated?: TicketCreatedHook[]; incidentDelegate?: IncidentDelegate } = {},
) {
  const repository = new HealthRepository(db);
  const prometheus = async (
    projectId: string,
    environment: HealthChartEnvironment,
    instance?: string,
  ) => {
    const found = await settings.runtimeValues(projectId, environment, 'metrics');
    if (!found) return null;
    const matchers = [found.values.matchers, instance ? `instance="${instance}"` : '']
      .filter(Boolean)
      .join(',');
    return new PrometheusConnector(
      found.values.url,
      { timeoutMs: 20000, maxSeries: 60, maxPoints: CHART_POINTS + 10, maxWindowMs: 95 * 86400000 },
      found.values.token,
      matchers || undefined,
    );
  };
  const freshAgentSamples = async (context: CollectorContext) =>
    freshSamples(
      await repository.latestAgentSamples(context.projectId),
      context.now,
      context.settings.thresholds.agentStaleMinutes,
    );
  const collectors = [
    new HttpProbeCollector(),
    new FallbackCollector(
      new PrometheusCollector(async (projectId, environment) => {
        const found = await settings.runtimeValues(projectId, environment, 'metrics');
        if (!found) return null;
        const connector = new PrometheusConnector(
          found.values.url,
          { timeoutMs: 15000 },
          found.values.token,
          found.values.matchers,
        );
        return { query: (promql) => connector.query(promql) };
      }),
      new HostAgentCollector({
        latest: (projectId) => repository.latestAgentSamples(projectId),
        latestBefore: (projectId, host, before) =>
          repository.latestAgentSampleBefore(projectId, host, before),
      }),
    ),
    new SiteDatabaseCollector(
      async (projectId, environment) => {
        const found = await settings.runtimeValues(projectId, environment, 'database');
        if (!found) return null;
        const connector = new SiteDatabaseConnector(siteDatabaseUrl(found.values), {
          maxRows: 50,
          timeoutSeconds: 20,
        });
        return { query: (sql) => connector.query(sql), close: () => connector.close() };
      },
      async (context) => {
        const found = (await freshAgentSamples(context)).find((item) => item.sample.site);
        return found ? { host: found.sample.host, metrics: found.sample.site! } : null;
      },
    ),
    new LogsCollector(
      async (projectId, environment) => {
        const found = await settings.runtimeValues(projectId, environment, 'telemetry');
        if (!found) return null;
        return new LokiConnector(
          found.values.url,
          { maxLines: LOG_SAMPLE_LIMIT, maxWindowMs: 3600000, timeoutMs: 20000 },
          found.values.token,
        );
      },
      async (context) => {
        const found = (await freshAgentSamples(context)).filter((item) => item.sample.logEvents);
        if (!found.length) return null;
        const events = found.map((item) => item.sample.logEvents!);
        return {
          hosts: found.map((item) => item.sample.host),
          windowMinutes: Math.max(...events.map((item) => item.windowMinutes)),
          applicationErrors: events.reduce((acc, item) => acc + item.applicationErrors, 0),
          authFailures: events.reduce((acc, item) => acc + item.authFailures, 0),
          sample: events.flatMap((item) => item.sample ?? []).slice(0, 5),
        };
      },
    ),
  ];
  const healthTickets = new HealthTickets(
    db,
    new TicketsService(db, [], hooks.ticketCreated ?? [autoInvestigateNewTicket]),
  );
  const monitor = new HealthMonitor(repository, collectors, publicUrl, healthTickets);
  const reporter = new HealthReporter(repository, publicUrl);
  const branding = new MailBranding(db);
  const notifier = new HealthNotifier(
    repository,
    (environment) => settings.runtimeSmtp(environment),
    undefined,
    (projectId) => branding.forProject(projectId),
  );
  const incidentLifecycle = new HealthIncidentLifecycle(db, hooks.incidentDelegate);
  const incidentMetrics = new IncidentMetricReadings(db, async (projectId, environment) => {
    const found = await settings.runtimeValues(projectId, environment, 'metrics');
    if (!found) return null;
    return new PrometheusConnector(
      found.values.url,
      { timeoutMs: 10000, maxSeries: 200 },
      found.values.token,
      found.values.matchers,
    );
  });
  const receiver = new AlertmanagerReceiver(
    db,
    repository,
    new HealthIncidents(db, repository, healthTickets, incidentLifecycle, incidentMetrics),
    publicUrl,
  );
  const service = new HealthService(
    db,
    repository,
    monitor,
    reporter,
    notifier,
    receiver,
    prometheusWriteUrl ? new RemoteWriteForwarder(prometheusWriteUrl) : undefined,
    alertSpoolDir ? new AlertSpool(alertSpoolDir) : undefined,
    alertmanagerUrl
      ? new AlertReconciler(db, receiver, new AlertmanagerActiveAlerts(alertmanagerUrl))
      : undefined,
    incidentLifecycle,
    prometheusRules?.directory
      ? new PrometheusRulesSync(db, repository, prometheusRules.directory, prometheusRules.url)
      : undefined,
  );
  const charts = new ChartRepository(db);
  const chartEvents = new ChartEventsRepository(db);
  return {
    repository,
    monitor,
    reporter,
    notifier,
    service,
    charts: {
      repository: charts,
      rollup: new ChartRollup(charts, prometheus),
      events: new ChartAvailabilityObserver(chartEvents, prometheus),
      service: new HealthChartsService(
        (actor) => service.viewer(actor),
        prometheus,
        charts,
        undefined,
        chartEvents,
      ),
    },
  };
}
