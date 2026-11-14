import {
  healthChartsQuerySchema,
  healthHeatmapQuerySchema,
  type HealthChart,
  type HealthChartEnvironment,
  type HealthChartInstance,
  type HealthChartRange,
  type HealthChartSeries,
  type HealthChartsResponse,
  type HealthHeatmapResponse,
  type User,
} from '../../../../../contracts/src/index.js';
import { DomainError } from '../../../errors.js';
import type { PromSeries } from '../../connectors/prometheus.connector.js';
import {
  CHART_PANELS,
  legendFor,
  rollupDefinitions,
  type ChartDefinition,
  type ChartQuery,
} from './chart-catalog.js';
import type { ChartRepository } from './chart.repository.js';
import type { RangeSource } from './chart-rollup.js';
import type { ChartEventsRepository } from './chart-events.js';

export interface ChartSource extends RangeSource {
  query(promql: string, at?: Date): Promise<PromSeries[]>;
}

/** Prometheus do ambiente; `instance` restringe todas as séries a um servidor. */
export type ChartSourceResolver = (
  projectId: string,
  environment: HealthChartEnvironment,
  instance?: string,
) => Promise<ChartSource | null>;

const DAY = 86400;
const HISTORY_SECONDS = 95 * DAY;
const RANGE_SECONDS: Record<Exclude<HealthChartRange, 'all'>, number> = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
  '395d': 395 * DAY,
};
/** Pontos por série nos intervalos lidos do Prometheus. */
export const CHART_POINTS = 300;
/** Janela mínima de `rate()`: 4 recolhas de 30 s. */
const MIN_WINDOW_SECONDS = 120;
const CONCURRENCY = 4;
const LISBON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Lisbon',
  weekday: 'short',
  day: 'numeric',
  hour: '2-digit',
  hourCycle: 'h23',
});
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Step alinhado e janela de cálculo de um intervalo lido do Prometheus. */
export function rangeStep(range: Exclude<HealthChartRange, 'all'>, nowSeconds: number) {
  const span = RANGE_SECONDS[range];
  const step = Math.max(15, Math.ceil(span / CHART_POINTS / 15) * 15);
  const end = Math.floor(nowSeconds / step) * step;
  return { span, step, start: end - span, end, window: `${Math.max(step, MIN_WINDOW_SECONDS)}s` };
}

function historyStep(first: number, nowSeconds: number) {
  const span = Math.max(MIN_WINDOW_SECONDS, nowSeconds - first);
  const step = Math.max(15, Math.ceil(span / CHART_POINTS / 15) * 15);
  const end = Math.floor(nowSeconds / step) * step;
  const start = Math.max(nowSeconds - HISTORY_SECONDS, Math.floor(first / step) * step);
  return { start, end, step, window: `${Math.max(step, MIN_WINDOW_SECONDS)}s` };
}

/** Corre tarefas com concorrência limitada, mantendo a ordem dos resultados. */
async function limited<T>(tasks: (() => Promise<T>)[], size: number) {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

function errorMessage(error: unknown) {
  return error instanceof DomainError ? error.message : 'A consulta ao Prometheus falhou.';
}

function englishErrorMessage(error: unknown) {
  if (!(error instanceof DomainError)) return 'The Prometheus query failed.';
  if (error.code === 'PROM_FAILED' || error.code === 'PROM_TEST_FAILED')
    return error.message.replace(/^(O )?Prometheus respondeu /, 'Prometheus returned ');
  if (error.code === 'PROM_INVALID')
    return 'The Prometheus query is invalid or exceeds the allowed time range or point limit.';
  return error.message;
}

/** Gráficos da Saúde: histórico retido no Prometheus e agregados horários (13 meses). */
export class HealthChartsService {
  constructor(
    private readonly authorize: (actor: User) => Promise<{ projectId: string }>,
    private readonly resolve: ChartSourceResolver,
    private readonly repository: ChartRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly events?: ChartEventsRepository,
  ) {}

  /** Séries e indicadores do painel pedido, para o ambiente e período indicados. */
  async charts(actor: User, raw: unknown): Promise<HealthChartsResponse> {
    const { projectId } = await this.authorize(actor);
    const parsed = healthChartsQuerySchema.safeParse(raw ?? {});
    if (!parsed.success) throw new DomainError('VALIDATION', 'Filtro dos gráficos inválido.', 400);
    const query = parsed.data;
    const panel = CHART_PANELS[query.panel];
    const definitions = query.chart
      ? panel.charts.filter((chart) => chart.id === query.chart)
      : panel.charts;
    if (!definitions.length)
      throw new DomainError('VALIDATION', 'O gráfico não pertence a este separador.', 400);
    const instance = panel.ignoresInstance ? undefined : query.instance;
    const eventSelection = { chartIds: definitions.map((chart) => chart.id), instance };
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    const base = {
      panel: query.panel,
      range: query.range,
      environment: query.env,
    };
    const source = await this.resolve(projectId, query.env, instance);
    const instances = source ? await this.instances(source) : [];

    if (query.range === '395d') {
      const span = RANGE_SECONDS['395d'];
      const charts = await this.rollupCharts(
        projectId,
        query.env,
        definitions,
        new Date((nowSeconds - span) * 1000),
        instance,
      );
      return {
        ...base,
        source: 'rollup',
        from: new Date((nowSeconds - span) * 1000).toISOString(),
        to: new Date(nowSeconds * 1000).toISOString(),
        stepSeconds: DAY,
        instances,
        charts,
        events: await this.events?.events(
          projectId,
          query.env,
          new Date((nowSeconds - span) * 1000),
          new Date(nowSeconds * 1000),
          eventSelection,
        ),
        unavailable: charts.length ? null : 'Este separador não tem métricas com histórico longo.',
        unavailableEn: charts.length ? null : 'This tab has no metrics with long-term history.',
      };
    }

    const availableFrom =
      query.range === 'all' && source ? await this.historyStart(source, nowSeconds) : null;
    const { start, end, step, window } =
      query.range === 'all'
        ? historyStep(availableFrom ?? nowSeconds, nowSeconds)
        : rangeStep(query.range, nowSeconds);
    const frame = {
      from: new Date(start * 1000).toISOString(),
      to: new Date(end * 1000).toISOString(),
      stepSeconds: step,
      ...(query.range === 'all'
        ? {
            availableFrom:
              availableFrom === null ? null : new Date(availableFrom * 1000).toISOString(),
          }
        : {}),
    };
    if (!source)
      return {
        ...base,
        ...frame,
        source: 'prometheus',
        instances,
        charts: [],
        unavailable: `A integração Métricas (Prometheus) de ${query.env === 'production' ? 'Produção' : 'Qualidade'} não está configurada.`,
        unavailableEn: `The ${query.env === 'production' ? 'Production' : 'Quality'} Metrics integration (Prometheus) is not configured.`,
      };
    if (query.range === 'all' && availableFrom === null)
      return {
        ...base,
        ...frame,
        source: 'prometheus',
        instances,
        charts: [],
        unavailable: 'Não existem métricas históricas disponíveis neste ambiente ou servidor.',
        unavailableEn: 'No historical metrics are available for this environment or server.',
      };
    const charts = await limited(
      definitions.map(
        (chart) => () =>
          this.prometheusChart(
            source,
            chart,
            { start, end, step, window },
            query.compare && query.range !== 'all',
          ),
      ),
      CONCURRENCY,
    );
    return {
      ...base,
      ...frame,
      source: 'prometheus',
      instances,
      charts,
      unavailable: null,
      events: await this.events?.events(
        projectId,
        query.env,
        new Date(start * 1000),
        new Date(end * 1000),
        eventSelection,
      ),
    };
  }

  private async historyStart(source: ChartSource, nowSeconds: number) {
    const coarse = await source.query(
      'min(min_over_time(timestamp(up)[95d:1h]))',
      new Date(nowSeconds * 1000),
    );
    const first = coarse[0]?.points[0]?.[1];
    if (first === undefined) return null;
    if (!Number.isFinite(first) || first > nowSeconds)
      throw new DomainError('PROM_INVALID', 'O início do histórico Prometheus é inválido.', 502);

    // A pesquisa horária pode saltar o início da recolha; refina apenas essa primeira hora.
    const refined = await source.query(
      'min(min_over_time(timestamp(up)[1h:30s]))',
      new Date(Math.min(nowSeconds, first + 60) * 1000),
    );
    const exact = refined[0]?.points[0]?.[1];
    if (exact === undefined || !Number.isFinite(exact) || exact > nowSeconds)
      throw new DomainError(
        'PROM_INVALID',
        'Não foi possível confirmar o início do histórico Prometheus.',
        502,
      );
    return Math.max(nowSeconds - HISTORY_SECONDS, Math.min(first, exact));
  }

  private async prometheusChart(
    source: ChartSource,
    chart: ChartDefinition,
    frame: { start: number; end: number; step: number; window: string },
    compare: boolean,
  ): Promise<HealthChart> {
    const view = this.emptyChart(chart);
    const span = frame.end - frame.start;
    try {
      for (const query of chart.queries) {
        const promql = query.expr.replaceAll('$w', frame.window);
        const periods = compare ? [false, true] : [false];
        for (const previous of periods) {
          const shift = previous ? span : 0;
          const found = await source.queryRangeBetween(
            promql,
            frame.start - shift,
            frame.end - shift,
            frame.step,
          );
          for (const series of found)
            view.series.push(this.toSeries(query, series, previous, shift));
        }
      }
    } catch (error) {
      view.error = errorMessage(error);
      view.errorEn = englishErrorMessage(error);
    }
    return view;
  }

  private toSeries(
    query: ChartQuery,
    series: PromSeries,
    previous: boolean,
    shift: number,
  ): HealthChartSeries {
    const label = legendFor(query.legend, series.labels) || 'valor';
    const labelEn = legendFor(query.legendEn ?? query.legend, series.labels) || 'value';
    return {
      key: `${label}${previous ? '|anterior' : ''}`,
      label: previous ? `${label} (período anterior)` : label,
      labelEn: previous ? `${labelEn} (previous period)` : labelEn,
      instance: series.labels.instance ?? null,
      previous,
      points: series.points
        .filter(([, value]) => Number.isFinite(value))
        .map(([time, value]) => [time + shift, value]),
    };
  }

  private async rollupCharts(
    projectId: string,
    environment: HealthChartEnvironment,
    charts: ChartDefinition[],
    since: Date,
    instance?: string,
  ) {
    const withRollup = charts.filter((chart) => chart.queries.some((query) => query.rollup));
    const metrics = withRollup.flatMap((chart) =>
      chart.queries.flatMap((query) => (query.rollup ? [query.rollup] : [])),
    );
    const rows = await this.repository.daily(projectId, environment, metrics, since, instance);
    return withRollup.map((chart) => {
      const view = this.emptyChart(chart);
      for (const query of chart.queries) {
        if (!query.rollup) continue;
        const byInstance = new Map<string, typeof rows>();
        for (const row of rows.filter((item) => item.metric === query.rollup))
          byInstance.set(row.instance, [...(byInstance.get(row.instance) ?? []), row]);
        for (const [host, items] of byInstance) {
          const label = legendFor(query.legend, { instance: host }) || host;
          const labelEn = legendFor(query.legendEn ?? query.legend, { instance: host }) || host;
          const points = (field: 'avg' | 'max') =>
            items.flatMap((item) =>
              item[field] === null
                ? []
                : [[item.day.getTime() / 1000, item[field]] as [number, number]],
            );
          view.series.push(
            {
              key: `${label}|media`,
              label: `${label} · média diária`,
              labelEn: `${labelEn} · daily average`,
              instance: host,
              previous: false,
              points: points('avg'),
            },
            {
              key: `${label}|max`,
              label: `${label} · máximo diário`,
              labelEn: `${labelEn} · daily maximum`,
              instance: host,
              previous: false,
              points: points('max'),
            },
          );
        }
      }
      return view;
    });
  }

  private emptyChart(chart: ChartDefinition): HealthChart {
    return {
      id: chart.id,
      title: chart.title,
      titleEn: chart.titleEn,
      group: chart.group,
      groupEn: chart.groupEn,
      description: chart.description,
      descriptionEn: chart.descriptionEn,
      unit: chart.unit,
      gauge: Boolean(chart.gauge),
      warn: chart.warn ?? null,
      crit: chart.crit ?? null,
      series: [],
      error: null,
    };
  }

  /** Servidores do ambiente (node_exporter), com o papel definido na recolha. */
  private async instances(source: ChartSource): Promise<HealthChartInstance[]> {
    try {
      const found = await source.query('max by(instance, role)(node_load1)');
      return found
        .map((series) => ({
          instance: series.labels.instance ?? '',
          role: series.labels.role ?? null,
        }))
        .filter((item) => item.instance)
        .sort((a, b) => a.instance.localeCompare(b.instance));
    } catch {
      return [];
    }
  }

  /** Média por dia da semana e hora (Lisboa) e por dia do mês, a partir dos agregados horários. */
  async heatmap(actor: User, raw: unknown): Promise<HealthHeatmapResponse> {
    const { projectId } = await this.authorize(actor);
    const parsed = healthHeatmapQuerySchema.safeParse(raw ?? {});
    if (!parsed.success)
      throw new DomainError('VALIDATION', 'Filtro do mapa de calor inválido.', 400);
    const query = parsed.data;
    const definition = rollupDefinitions().get(query.metric)!;
    const since = new Date(this.now().getTime() - query.days * DAY * 1000);
    const instances = await this.repository.instances(projectId, query.env, query.metric, since);
    const instance =
      query.instance && instances.includes(query.instance) ? query.instance : instances[0];
    const bucket = () => ({ sum: 0, count: 0 });
    const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, bucket));
    const monthDays = Array.from({ length: 31 }, bucket);
    if (instance)
      for (const row of await this.repository.hourly(
        projectId,
        query.env,
        query.metric,
        since,
        instance,
      )) {
        if (row.avg === null) continue;
        const parts = Object.fromEntries(
          LISBON.formatToParts(row.hourStart).map((part) => [part.type, part.value]),
        );
        for (const target of [
          cells[WEEKDAYS.indexOf(parts.weekday ?? '')]?.[Number(parts.hour)],
          monthDays[Number(parts.day) - 1],
        ])
          if (target) {
            target.sum += row.avg;
            target.count += 1;
          }
      }
    const mean = ({ sum, count }: { sum: number; count: number }) => (count ? sum / count : null);
    const matrix = cells.map((row) => row.map(mean));
    const values = matrix.flat().filter((value): value is number => value !== null);
    const { chart } = definition;
    const scale = chart.heatmap ?? { warn: chart.warn, crit: chart.crit };
    return {
      metric: query.metric,
      title: definition.chart.title,
      titleEn: definition.chart.titleEn,
      unit: definition.chart.unit,
      environment: query.env,
      instance: instance ?? null,
      days: query.days,
      instances,
      cells: matrix,
      byMonthDay: monthDays.map(mean),
      max: values.length ? Math.max(...values) : null,
      warn: scale.warn ?? null,
      crit: scale.crit ?? null,
      higherIsBetter: chart.heatmap?.higherIsBetter ?? false,
    };
  }
}
