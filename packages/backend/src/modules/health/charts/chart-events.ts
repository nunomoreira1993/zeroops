import { createHash, randomUUID } from 'node:crypto';
import {
  effectiveAlertRules,
  healthNotificationChartContextSchema,
  type HealthChartEnvironment,
  type HealthChartEvent,
  type HealthSettings,
} from '../../../../../contracts/src/index.js';
import type { Database } from '../../../database/database.js';
import { activeQuietWindow, withinQuietWindow } from '../health-quiet-windows.js';
import { activeSuspension } from '../../incidents/health-suspension.js';
import type { ChartSourceResolver } from './health-charts.service.js';
import { CHART_PANELS } from './chart-catalog.js';

interface EmailSelection {
  chartIds: readonly string[];
  instance?: string;
}

interface Observation {
  cause: 'http' | 'db2' | 'maintenance';
  resource: string;
  available: boolean;
  planned: boolean;
  confirmMinutes: number;
}

interface OutageRow {
  id: string;
  started_at: Date;
  confirmed_at: Date | null;
  last_observed_at: Date;
}

/** Historico de indisponibilidade e emails, sem conteudo de mensagens nem dependencias de tickets. */
export class ChartEventsRepository {
  constructor(private readonly db: Database) {}

  /** Suspensao administrativa impede novas consultas, sem apagar historico. */
  async suspended(projectId: string, environment: HealthChartEnvironment) {
    return Boolean(await activeSuspension(this.db, projectId, environment));
  }

  /** Regista uma amostra funcional; falta de amostra nunca confirma falha nem recuperacao. */
  async observe(
    projectId: string,
    environment: HealthChartEnvironment,
    observation: Observation,
    now: Date,
  ) {
    const key = createHash('sha256')
      .update(JSON.stringify([projectId, environment, observation.cause, observation.resource]))
      .digest('hex');
    await this.db.transaction(async (client) => {
      // Serializa observadores do mesmo projeto, incluindo primeira insercao concorrente.
      await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      const open = (
        await client.query<OutageRow>(
          'SELECT id,started_at,confirmed_at,last_observed_at FROM health_chart_outages WHERE open_key=$1 FOR UPDATE',
          [key],
        )
      ).rows[0];
      if (open && now <= open.last_observed_at) return;
      if (observation.available) {
        if (open)
          await client.query(
            'UPDATE health_chart_outages SET recovered_at=$2,last_observed_at=$2,open_key=NULL,observation_gap=observation_gap OR $3 WHERE id=$1',
            [open.id, now, now.getTime() - open.last_observed_at.getTime() > 150000],
          );
        return;
      }
      if (!open) {
        await client.query(
          `INSERT INTO health_chart_outages
           (id,project_id,environment,cause,resource,open_key,started_at,confirmed_at,last_observed_at,planned)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7,$9)`,
          [
            randomUUID(),
            projectId,
            environment,
            observation.cause,
            observation.resource,
            key,
            now,
            observation.confirmMinutes === 0 ? now : null,
            observation.planned,
          ],
        );
        return;
      }
      const gap = now.getTime() - open.last_observed_at.getTime() > 150000;
      const start = gap && !open.confirmed_at ? now : open.started_at;
      const confirmed =
        open.confirmed_at ??
        (now.getTime() - start.getTime() >= observation.confirmMinutes * 60000 ? now : null);
      await client.query(
        `UPDATE health_chart_outages SET started_at=$2,confirmed_at=$3,last_observed_at=$4,
           observation_gap=observation_gap OR $5 WHERE id=$1`,
        [open.id, start, confirmed, now, gap],
      );
    });
  }

  /** Filtra antes de agrupar por ocorrencia/recurso em ate 300 intervalos por associacao. */
  async events(
    projectId: string,
    environment: HealthChartEnvironment,
    from: Date,
    to: Date,
    selection: EmailSelection = {
      chartIds: Object.values(CHART_PANELS).flatMap((panel) =>
        panel.charts.map((chart) => chart.id),
      ),
    },
  ): Promise<HealthChartEvent[]> {
    const bucket = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 1000 / 300));
    const targets = selection.chartIds.map((chartId) =>
      JSON.stringify({
        chartId,
        ...(selection.instance ? { instance: selection.instance } : {}),
      }),
    );
    const matches = targets
      .map((_, index) => `JSON_CONTAINS(JSON_EXTRACT(chart_context,'$.targets'),$${index + 6})`)
      .join(' OR ');
    const emails = await this.db.query<{
      id: string;
      alert_id: string | null;
      chart_context: unknown;
      at: Date;
      last_at: Date;
      count: number;
      environment: HealthChartEnvironment;
    }>(
      `SELECT MIN(id) AS id,MIN(alert_id) AS alert_id,chart_context,MIN(sent_at) AS at,
         MAX(sent_at) AS last_at,COUNT(*) AS count,environment
       FROM health_notifications WHERE project_id=$1 AND environment=$2
         AND channel='email' AND kind='alert' AND state='sent' AND sent_at BETWEEN $3 AND $4
         AND (${matches || '0'})
       GROUP BY COALESCE(alert_id,id),environment,chart_context,FLOOR(UNIX_TIMESTAMP(sent_at)/$5)
       ORDER BY at`,
      [projectId, environment, from, to, bucket, ...targets],
    );
    const outages = await this.db.query<{
      id: string;
      cause: 'http' | 'db2' | 'maintenance';
      resource: string;
      started_at: Date;
      confirmed_at: Date;
      recovered_at: Date | null;
      planned: boolean;
      observation_gap: boolean;
      last_observed_at: Date;
    }>(
      `SELECT id,cause,resource,started_at,confirmed_at,recovered_at,planned,observation_gap,last_observed_at
       FROM health_chart_outages WHERE project_id=$1 AND environment=$2
         AND confirmed_at IS NOT NULL AND started_at BETWEEN $3 AND $4 ORDER BY started_at`,
      [projectId, environment, from, to],
    );
    return [
      ...emails.rows.map((row): HealthChartEvent => {
        const context = healthNotificationChartContextSchema.parse(row.chart_context);
        const matched = context.targets.filter(
          (target) =>
            selection.chartIds.includes(target.chartId) &&
            (!selection.instance || target.instance === selection.instance),
        );
        return {
          id: row.id,
          kind: 'email',
          environment: row.environment,
          alertId: row.alert_id,
          alertContext: { ...context, targets: matched },
          at: row.at.toISOString(),
          lastAt: row.last_at.toISOString(),
          count: Number(row.count),
          resource: [
            ...new Set(
              matched.map((target) =>
                [target.instance, ...Object.values(target.labels ?? {})].join(' · '),
              ),
            ),
          ].join('; '),
          planned: false,
          confirmedAt: null,
          recoveredAt: null,
          observationGap: false,
        };
      }),
      ...outages.rows.map((row): HealthChartEvent => ({
        id: row.id,
        kind: row.cause,
        environment,
        at: row.started_at.toISOString(),
        lastAt:
          row.cause === 'maintenance'
            ? row.last_observed_at.toISOString()
            : row.started_at.toISOString(),
        count: 1,
        resource: row.resource,
        planned: Boolean(row.planned),
        confirmedAt: row.cause === 'maintenance' ? null : row.confirmed_at.toISOString(),
        recoveredAt: row.cause === 'maintenance' ? null : (row.recovered_at?.toISOString() ?? null),
        observationGap:
          Boolean(row.observation_gap) ||
          (!row.recovered_at && to.getTime() - row.last_observed_at.getTime() > 150000),
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }
}

/** Observa sondas funcionais mesmo durante silencio planeado, sem abrir alertas ou enviar emails. */
export class ChartAvailabilityObserver {
  constructor(
    private readonly repository: Pick<ChartEventsRepository, 'observe' | 'suspended'>,
    private readonly resolve: ChartSourceResolver,
  ) {}

  /** Consulta somente DB2 funcional e sondas HTTP nos ambientes com integracao verificada. */
  async run(projectId: string, settings: HealthSettings, now: Date) {
    for (const environment of ['production', 'quality'] as const) {
      if (await this.repository.suspended(projectId, environment)) continue;
      for (const window of settings.quietWindows.filter((item) =>
        item.checks.some((target) =>
          [
            'rule:Db2Indisponivel',
            'rule:SiteIndisponivel',
            'probe:db2',
            'site-availability',
            'app-api-availability',
          ].includes(target),
        ),
      )) {
        await this.repository.observe(
          projectId,
          environment,
          {
            cause: 'maintenance',
            resource: `${window.name} (${window.start}–${window.end}, ${window.timezone})`,
            available: !withinQuietWindow(window, now),
            planned: true,
            confirmMinutes: 0,
          },
          now,
        );
      }
      const source = await this.resolve(projectId, environment);
      if (!source) continue;
      const rules = effectiveAlertRules(settings.alertRules);
      for (const [cause, expression, ruleId] of [
        [
          'db2',
          'zeroops_db2_up and on(instance) (time() - node_textfile_mtime_seconds{file=~".*zeroops[.]prom"} <= 150)',
          'Db2Indisponivel',
        ],
        [
          'http',
          'probe_success{job="http"} and (time() - timestamp(probe_success{job="http"}) <= 150)',
          'SiteIndisponivel',
        ],
      ] as const) {
        const rule = rules.find((item) => item.id === ruleId);
        for (const series of await source.query(expression, now)) {
          const value = series.points.at(-1)?.[1];
          const instance = series.labels.instance;
          const resource =
            instance && cause === 'db2' && series.labels.dsn
              ? `${instance} (${series.labels.dsn})`
              : instance;
          if (!resource || (value !== 0 && value !== 1)) continue;
          const configuredHttp = [settings.siteUrl, settings.appUrl, ...settings.apiUrls];
          if (
            cause === 'http' &&
            !configuredHttp.includes(resource) &&
            !['site', 'app', 'api'].includes(series.labels.service ?? '')
          )
            continue;
          await this.repository.observe(
            projectId,
            environment,
            {
              cause,
              resource,
              available: value === 1,
              confirmMinutes: rule?.forMinutes ?? 0,
              planned: Boolean(activeQuietWindow(settings, `rule:${ruleId}`, now)),
            },
            now,
          );
        }
      }
    }
  }
}
