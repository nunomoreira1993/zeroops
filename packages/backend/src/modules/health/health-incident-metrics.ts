import type { Database } from '../../database/database.js';
import type { PromSeries } from '../connectors/prometheus.connector.js';
import { parseLabels, type IncidentEnvironment } from './health-incident-lifecycle.js';

/** Leitura do Prometheus do ambiente: regras de alerta e consultas num instante. */
export interface IncidentMetricSource {
  alertRules(): Promise<{ name: string; query: string }[]>;
  query(promql: string, at?: Date): Promise<PromSeries[]>;
}

export type IncidentMetricSourceFactory = (
  projectId: string,
  environment: IncidentEnvironment,
) => Promise<IncidentMetricSource | null>;

const COMPARISON = /^([\s\S]+?)\s*(?:==|!=|>=|<=|>|<)\s*-?\d+(?:\.\d+)?\s*$/;
const SET_OPERATOR = /\b(?:and|or|unless)\b/;
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const AVAILABILITY = /^(?:[a-zA-Z_:][\w:]*_up|up|probe_success)\s*(?:\{[^}]*\})?$/;

/**
 * Expressão medida pela regra, sem o limite: `mysql_up == 0` → `mysql_up`,
 * `… * 100 < 15` → `… * 100`. `null` em regras sem limite simples (ex.: `absent_over_time`, `and`).
 */
export function measuredExpression(rule: string) {
  const match = COMPARISON.exec(rule.trim());
  if (!match) return null;
  const measured = match[1]!.trim();
  return SET_OPERATOR.test(measured.replace(QUOTED, '""')) ? null : measured;
}

const decimal = (value: number, digits: number) =>
  new Intl.NumberFormat('pt-PT', { maximumFractionDigits: digits }).format(value);

/** Valor legível para quem não conhece a métrica: disponibilidade, percentagem, dias ou segundos. */
export function formatMetricValue(measured: string, value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'sem dados';
  if (AVAILABILITY.test(measured))
    return `${value >= 1 ? 'Disponível' : 'Indisponível'} (${decimal(value, 0)})`;
  if (/\*\s*100\b/.test(measured)) return `${decimal(value, 1)} %`;
  if (/\/\s*86400\b/.test(measured)) return `${decimal(value, 0)} dias`;
  if (/_seconds\b/.test(measured)) return `${decimal(value, 2)} s`;
  return decimal(value, 2);
}

/** Valor da série do alerta: todas as labels da série iguais às do alerta, ou o mesmo servidor. */
export function alertValue(series: PromSeries[], labels: Record<string, string>) {
  const same = (item: PromSeries) =>
    Object.entries(item.labels).every(
      ([key, value]) => key === '__name__' || labels[key] === value,
    );
  const found =
    series.find(same) ??
    (labels.instance ? series.find((item) => item.labels.instance === labels.instance) : undefined);
  const value = found?.points.at(-1)?.[1];
  return value === undefined || !Number.isFinite(value) ? null : value;
}

/**
 * Valores das métricas de um incidente que recuperou: para cada alerta, a expressão da regra sem
 * o limite avaliada no disparo e na recuperação. O Alertmanager não envia valores, por isso são
 * lidos do Prometheus do ambiente; sem integração ou com falhas o relatório mostra «—».
 */
export class IncidentMetricReadings {
  constructor(
    private readonly db: Database,
    private readonly open: IncidentMetricSourceFactory,
  ) {}

  /** Lê e grava os valores antes/depois dos alertas do incidente; devolve quantos gravou. */
  async record(projectId: string, ticketId: string, environment: IncidentEnvironment) {
    const alerts = await this.db.query<{
      id: string;
      alert_name: string;
      labels: string;
      starts_at: Date;
      resolved_at: Date | null;
    }>(
      `SELECT id,alert_name,labels,starts_at,resolved_at FROM health_external_alerts
        WHERE project_id=$1 AND ticket_id=$2`,
      [projectId, ticketId],
    );
    if (!alerts.rowCount) return 0;
    const source = await this.open(projectId, environment).catch(() => null);
    if (!source) return 0;
    const rules = await source.alertRules().catch(() => []);
    const queries = new Map(rules.map((rule) => [rule.name, rule.query]));
    let recorded = 0;
    for (const alert of alerts.rows) {
      const rule = queries.get(alert.alert_name);
      const measured = rule ? measuredExpression(rule) : null;
      if (!measured) continue;
      const labels = parseLabels(alert.labels);
      const read = (at: Date) =>
        source
          .query(measured, at)
          .then((series) => alertValue(series, labels))
          .catch(() => undefined);
      const [before, after] = await Promise.all([
        read(alert.starts_at),
        read(alert.resolved_at ?? new Date()),
      ]);
      if (before === undefined && after === undefined) continue;
      await this.db.query(
        'UPDATE health_external_alerts SET metric_before=$1, metric_after=$2 WHERE id=$3',
        [
          before === undefined ? null : formatMetricValue(measured, before),
          after === undefined ? null : formatMetricValue(measured, after),
          alert.id,
        ],
      );
      recorded += 1;
    }
    return recorded;
  }
}
