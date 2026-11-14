import type { SqlClient } from '../../../database/database.js';

export interface HourlyRow {
  metric: string;
  instance: string;
  hourStart: Date;
  avg: number | null;
  max: number | null;
  p95: number | null;
}

/** Marca da última hora agregada por ambiente (avança mesmo quando não há séries). */
export const ROLLUP_MARKER = '_rollup';
const RETENTION_DAYS = 400;

type Row = Record<string, unknown>;
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/** Agregados horários das métricas dos gráficos (`health_metric_hourly`). */
export class ChartRepository {
  constructor(private readonly db: SqlClient) {}

  /** Início da última hora já agregada no ambiente, ou `null` se nunca correu. */
  async lastHour(projectId: string, environment: string) {
    const found = await this.db.query<Row>(
      `SELECT MAX(hour_start) AS last FROM health_metric_hourly
       WHERE project_id=$1 AND environment=$2 AND metric=$3`,
      [projectId, environment, ROLLUP_MARKER],
    );
    const last = found.rows[0]?.last;
    return last ? new Date(last as Date) : null;
  }

  /** Guarda (ou substitui) os agregados e avança a marca para `upTo`. */
  async save(projectId: string, environment: string, rows: HourlyRow[], upTo: Date) {
    const all = [
      ...rows,
      { metric: ROLLUP_MARKER, instance: '', hourStart: upTo, avg: null, max: null, p95: null },
    ];
    for (let index = 0; index < all.length; index += 200) {
      const chunk = all.slice(index, index + 200);
      const values: unknown[] = [];
      const tuples = chunk.map((row) => {
        const base = values.length;
        values.push(
          projectId,
          environment,
          row.metric,
          row.instance,
          row.hourStart,
          row.avg,
          row.max,
          row.p95,
        );
        return `(${Array.from({ length: 8 }, (_, offset) => `$${base + offset + 1}`).join(',')})`;
      });
      await this.db.query(
        `INSERT INTO health_metric_hourly
           (project_id, environment, metric, instance, hour_start, avg_value, max_value, p95_value)
         VALUES ${tuples.join(',')}
         ON DUPLICATE KEY UPDATE avg_value=VALUES(avg_value), max_value=VALUES(max_value),
           p95_value=VALUES(p95_value)`,
        values,
      );
    }
  }

  /** Média e máximo diários (UTC) das métricas indicadas desde `since`. */
  async daily(
    projectId: string,
    environment: string,
    metrics: string[],
    since: Date,
    instance?: string,
  ) {
    if (!metrics.length) return [];
    const params: unknown[] = [projectId, environment, since, ...metrics];
    const placeholders = metrics.map((_, index) => `$${index + 4}`).join(',');
    let filter = '';
    if (instance) {
      params.push(instance);
      filter = ` AND instance=$${params.length}`;
    }
    const found = await this.db.query<Row>(
      `SELECT metric, instance, DATE(hour_start) AS day, AVG(avg_value) AS avg_value,
              MAX(max_value) AS max_value
       FROM health_metric_hourly
       WHERE project_id=$1 AND environment=$2 AND hour_start >= $3 AND metric IN (${placeholders})${filter}
       GROUP BY metric, instance, DATE(hour_start)
       ORDER BY day`,
      params,
    );
    return found.rows.map((row) => ({
      metric: String(row.metric),
      instance: String(row.instance),
      day: new Date(row.day as Date),
      avg: num(row.avg_value),
      max: num(row.max_value),
    }));
  }

  /** Valores horários de uma métrica (mapa de calor). */
  async hourly(
    projectId: string,
    environment: string,
    metric: string,
    since: Date,
    instance: string,
  ) {
    const found = await this.db.query<Row>(
      `SELECT hour_start, avg_value FROM health_metric_hourly
       WHERE project_id=$1 AND environment=$2 AND metric=$3 AND instance=$4 AND hour_start >= $5
       ORDER BY hour_start`,
      [projectId, environment, metric, instance, since],
    );
    return found.rows.map((row) => ({
      hourStart: new Date(row.hour_start as Date),
      avg: num(row.avg_value),
    }));
  }

  /** Servidores (ou URLs) com agregados de uma métrica desde `since`. */
  async instances(projectId: string, environment: string, metric: string, since: Date) {
    const found = await this.db.query<Row>(
      `SELECT DISTINCT instance FROM health_metric_hourly
       WHERE project_id=$1 AND environment=$2 AND metric=$3 AND hour_start >= $4
       ORDER BY instance`,
      [projectId, environment, metric, since],
    );
    return found.rows.map((row) => String(row.instance));
  }

  /** Retenção de 400 dias (13 meses com margem). */
  async prune(now: Date) {
    await this.db.query('DELETE FROM health_metric_hourly WHERE hour_start < $1', [
      new Date(now.getTime() - RETENTION_DAYS * 86400000),
    ]);
  }
}
