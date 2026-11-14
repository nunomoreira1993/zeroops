import type { HealthChartEnvironment } from '../../../../../contracts/src/index.js';
import type { PromSeries } from '../../connectors/prometheus.connector.js';
import { rollupDefinitions } from './chart-catalog.js';
import type { ChartRepository, HourlyRow } from './chart.repository.js';

/** Consulta de intervalo ao Prometheus do ambiente (epoch segundos). */
export interface RangeSource {
  queryRangeBetween(
    promql: string,
    start: number,
    end: number,
    step: number,
  ): Promise<PromSeries[]>;
}

export type RangeSourceResolver = (
  projectId: string,
  environment: HealthChartEnvironment,
) => Promise<RangeSource | null>;

const HOUR = 3600000;
/** Atraso antes de agregar uma hora: dá tempo ao remote write de Produção. */
const SETTLE_MS = 5 * 60000;
/** Primeira execução: recupera o histórico ainda guardado no Prometheus. */
const BACKFILL_MS = 14 * 86400000;
/** Horas por lote (um pedido por métrica e agregado cobre o lote todo). */
const BATCH_HOURS = 168;
const ENVIRONMENTS: HealthChartEnvironment[] = ['production', 'quality'];

/** Expressão instantânea de uma consulta do catálogo, por servidor. */
export function rollupExpression(expr: string) {
  return `max by(instance)(${expr.replaceAll('$w', '2m')})`;
}

/**
 * Agrega cada hora completa em média, máximo e p95 por servidor (subconsultas `[1h:1m]`) e
 * guarda em `health_metric_hourly`. Corre no ciclo de Saúde do worker; sem trabalho pendente
 * custa uma query à BD por ambiente.
 */
export class ChartRollup {
  constructor(
    private readonly repository: ChartRepository,
    private readonly resolve: RangeSourceResolver,
  ) {}

  /** Agrega as horas completas ainda em falta, por ambiente, em `health_metric_hourly`. */
  async runDue(projectId: string, now: Date) {
    const done: { environment: HealthChartEnvironment; hours: number }[] = [];
    const lastComplete = Math.floor((now.getTime() - SETTLE_MS) / HOUR) * HOUR - HOUR;
    for (const environment of ENVIRONMENTS) {
      const last = await this.repository.lastHour(projectId, environment);
      const first = last
        ? last.getTime() + HOUR
        : Math.floor((now.getTime() - BACKFILL_MS) / HOUR) * HOUR;
      if (first > lastComplete) continue;
      const source = await this.resolve(projectId, environment);
      if (!source) continue;
      const upTo = Math.min(lastComplete, first + (BATCH_HOURS - 1) * HOUR);
      const rows = await this.collect(source, first, upTo);
      await this.repository.save(projectId, environment, rows, new Date(upTo));
      done.push({ environment, hours: (upTo - first) / HOUR + 1 });
    }
    return done;
  }

  /** Lê o lote [first, upTo] (inícios de hora); cada ponto avaliado no fim da respetiva hora. */
  private async collect(source: RangeSource, first: number, upTo: number) {
    const rows = new Map<string, HourlyRow>();
    const start = (first + HOUR) / 1000;
    const end = (upTo + HOUR) / 1000;
    for (const [metric, { query }] of rollupDefinitions()) {
      const inner = rollupExpression(query.expr);
      const aggregates = {
        avg: `avg_over_time((${inner})[1h:1m])`,
        max: `max_over_time((${inner})[1h:1m])`,
        p95: `quantile_over_time(0.95, (${inner})[1h:1m])`,
      };
      for (const [field, promql] of Object.entries(aggregates) as [
        'avg' | 'max' | 'p95',
        string,
      ][]) {
        for (const series of await source.queryRangeBetween(promql, start, end, 3600)) {
          const instance = series.labels.instance ?? '';
          for (const [time, value] of series.points) {
            if (!Number.isFinite(value)) continue;
            const hourStart = new Date(time * 1000 - HOUR);
            const key = `${metric}|${instance}|${hourStart.getTime()}`;
            const row = rows.get(key) ?? {
              metric,
              instance,
              hourStart,
              avg: null,
              max: null,
              p95: null,
            };
            row[field] = value;
            rows.set(key, row);
          }
        }
      }
    }
    return [...rows.values()];
  }
}
