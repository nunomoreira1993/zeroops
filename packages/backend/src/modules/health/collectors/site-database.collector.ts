import type { HealthSettings, HealthSiteMetrics } from '../../../../../contracts/src/index.js';
import type { SqlResult } from '../../connectors/site-database.connector.js';
import {
  above,
  errorCode,
  round,
  unknown,
  worst,
  type CheckResult,
  type CollectorContext,
  type HealthCollector,
} from './collector.js';

export interface SiteQueryRunner {
  query(sql: string): Promise<SqlResult>;
  close(): Promise<void>;
}

/** Abre uma ligacao so de leitura a BD do site do ambiente indicado (null se nao configurada). */
export type SiteDatabaseOpener = (
  projectId: string,
  environment: HealthSettings['sourceEnvironment'],
) => Promise<SiteQueryRunner | null>;

/** Metricas recolhidas pelo agente no servidor da BD (alternativa a ligacao direta). */
export type AgentSiteMetricsSource = (
  context: CollectorContext,
) => Promise<{ host: string; metrics: HealthSiteMetrics } | null>;

type Row = Record<string, unknown>;
type MetricName = Exclude<keyof HealthSiteMetrics, 'errors'>;

function firstRow(result: SqlResult): Row {
  const row = result.rows[0] ?? [];
  return Object.fromEntries(result.columns.map((column, index) => [column, row[index]]));
}

const num = (value: unknown) =>
  value === null || value === undefined || value === '' ? 0 : Number(value);
const id = (value: unknown) =>
  value === null || value === undefined || value === '' ? null : Number(value);

/** Encomendas pagas e nao anuladas das ultimas 24h; `data_agendar` zero significa "sem agendamento". */
const DUE_AT = "IF(e.data_agendar > '2000-01-01', e.data_agendar, e.data)";

/**
 * Consultas so de leitura a BD do site. O agente de host executa exatamente as mesmas
 * (deploy/health-agent/zeroops-health-agent.sh); manter os dois sincronizados.
 */
export const SITE_QUERIES = {
  shift4: `SELECT COUNT(*) AS total,
      SUM(TRIM(result_code) NOT REGEXP '^(0+)?$' AND result_message NOT LIKE '%pending%') AS failed,
      SUM((TRIM(result_code) = '' OR result_message LIKE '%pending%') AND action_date < NOW() - INTERVAL 10 MINUTE) AS pending
    FROM encomendas_shift4 WHERE action = 'auth' AND action_date >= NOW() - INTERVAL 60 MINUTE`,
  wallet: `SELECT COUNT(*) AS total,
      SUM(status = 'FAIL') AS failed,
      SUM(status IN ('NEW','PENDING','REVIEW') AND created_at < NOW() - INTERVAL 10 MINUTE) AS pending,
      SUM(method = 'MBWAY') AS mbway,
      SUM(method = 'MBWAY' AND status = 'FAIL') AS mbway_failed
    FROM encomendas_wallet WHERE created_at >= NOW() - INTERVAL 60 MINUTE`,
  divergence: `SELECT COUNT(*) AS n, MIN(e.id) AS first_id FROM encomendas e
    WHERE e.data >= NOW() - INTERVAL 1 DAY AND e.data < NOW() - INTERVAL 15 MINUTE
      AND e.satisfeita <> 6 AND e.anulada = 0
      AND (EXISTS (SELECT 1 FROM encomendas_wallet w WHERE w.encomenda_id = e.id AND w.status = 'COMPLETED')
        OR EXISTS (SELECT 1 FROM encomendas_shift4 s WHERE s.encomenda_id = e.id AND TRIM(s.result_code) REGEXP '^0+$'))`,
  paidNotIntegrated: (minutes: number) => `SELECT COUNT(*) AS n, MIN(e.id) AS first_id,
      TIMESTAMPDIFF(MINUTE, MIN(${DUE_AT}), NOW()) AS oldest_minutes,
      SUM(e.integracao_falhada = 1) AS failed
    FROM encomendas e
    WHERE e.satisfeita = 6 AND e.anulada = 0 AND e.integrada = 0 AND e.flag_nao_integrar = 0
      AND e.data >= NOW() - INTERVAL 1 DAY AND ${DUE_AT} <= NOW() - INTERVAL ${minutes} MINUTE`,
};

/** Executa as consultas e devolve os valores brutos; consultas falhadas ficam em `errors`. */
export async function querySiteMetrics(
  runner: SiteQueryRunner,
  paidNotIntegratedMinutes: number,
): Promise<HealthSiteMetrics> {
  const metrics: HealthSiteMetrics = {};
  const errors: string[] = [];
  const steps: [MetricName, () => Promise<void>][] = [
    [
      'saturation',
      async () => {
        const status = await runner.query(
          "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Slow_queries')",
        );
        const variables = await runner.query(
          "SHOW GLOBAL VARIABLES WHERE Variable_name='max_connections'",
        );
        const values = new Map(
          [...status.rows, ...variables.rows].map((row) => [
            String(row[0]).toLowerCase(),
            num(row[1]),
          ]),
        );
        metrics.saturation = {
          connected: values.get('threads_connected') ?? 0,
          max: values.get('max_connections') ?? 0,
          running: values.get('threads_running') ?? 0,
          slowQueriesTotal: values.get('slow_queries') ?? 0,
        };
      },
    ],
    [
      'shift4',
      async () => {
        const row = firstRow(await runner.query(SITE_QUERIES.shift4));
        metrics.shift4 = {
          total: num(row.total),
          failed: num(row.failed),
          pending: num(row.pending),
        };
      },
    ],
    [
      'wallet',
      async () => {
        const row = firstRow(await runner.query(SITE_QUERIES.wallet));
        metrics.wallet = {
          total: num(row.total),
          failed: num(row.failed),
          pending: num(row.pending),
          mbway: num(row.mbway),
          mbwayFailed: num(row.mbway_failed),
        };
      },
    ],
    [
      'divergence',
      async () => {
        const row = firstRow(await runner.query(SITE_QUERIES.divergence));
        metrics.divergence = { count: num(row.n), firstOrderId: id(row.first_id) };
      },
    ],
    [
      'paidNotIntegrated',
      async () => {
        const row = firstRow(
          await runner.query(SITE_QUERIES.paidNotIntegrated(paidNotIntegratedMinutes)),
        );
        metrics.paidNotIntegrated = {
          count: num(row.n),
          firstOrderId: id(row.first_id),
          oldestMinutes: num(row.oldest_minutes),
          failed: num(row.failed),
          thresholdMinutes: paidNotIntegratedMinutes,
        };
      },
    ],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(`${name}:${errorCode(error)}`);
    }
  }
  if (errors.length) metrics.errors = errors;
  return metrics;
}

const CHECK_OF: Record<MetricName, string> = {
  saturation: 'database-saturation',
  shift4: 'payments-shift4',
  wallet: 'payments-wallet',
  divergence: 'payments-divergence',
  paidNotIntegrated: 'paid-not-integrated',
};

/**
 * Verificacoes sobre a BD do site (normalmente Producao), com utilizador so de leitura: por
 * ligacao direta (integracao "Base de dados") ou, sem ela, pelas metricas enviadas pelo agente.
 * Semantica do site: pago = satisfeita=6; Shift4 (so tentativas action='auth'): sucesso = result_code
 * so com zeros ('0' ou '000'), pendente = vazio ou mensagem "pending" (3DS: 099/06); Wallet = status.
 */
export class SiteDatabaseCollector implements HealthCollector {
  readonly name = 'site-database';
  readonly checks = Object.values(CHECK_OF);

  constructor(
    private readonly open: SiteDatabaseOpener,
    private readonly agentMetrics?: AgentSiteMetricsSource,
  ) {}

  /** Recolhe métricas read-only da BD do ambiente configurado ou do agente do host. */
  async collect(context: CollectorContext): Promise<CheckResult[]> {
    const source = await this.metrics(context);
    if (!source)
      return this.checks.map((checkId) =>
        unknown(
          checkId,
          `Sem métricas da BD do site: integração "Base de dados" de ${context.settings.sourceEnvironment === 'production' ? 'Produção' : 'Qualidade'} não verificada e o agente não enviou o bloco "site".`,
        ),
      );
    const { metrics, origin } = source;
    const failed = new Map(
      (metrics.errors ?? []).map((item) => [item.slice(0, item.indexOf(':')), item]),
    );
    const evaluate = <K extends MetricName>(
      name: K,
      run: (value: NonNullable<HealthSiteMetrics[K]>) => CheckResult,
    ): CheckResult => {
      const value = metrics[name];
      if (value === undefined)
        return unknown(
          CHECK_OF[name],
          failed.has(name)
            ? `Consulta falhou (${failed.get(name)!.slice(name.length + 1)}) via ${origin}.`
            : `Sem dados via ${origin}.`,
        );
      const result = run(value as NonNullable<HealthSiteMetrics[K]>);
      return { ...result, details: { ...result.details, origin } };
    };
    return [
      evaluate('saturation', (value) => this.saturation(value, context)),
      evaluate('shift4', (value) => this.paymentRates('payments-shift4', 'Shift4', value, context)),
      evaluate('wallet', (value) =>
        this.paymentRates('payments-wallet', 'MEO Wallet', value, context, {
          mbway: value.mbway,
          mbwayFailed: value.mbwayFailed,
        }),
      ),
      evaluate('divergence', (value) => this.divergence(value, context)),
      evaluate('paidNotIntegrated', (value) => this.paidNotIntegrated(value)),
    ];
  }

  private async metrics(
    context: CollectorContext,
  ): Promise<{ metrics: HealthSiteMetrics; origin: string } | null> {
    const runner = await this.open(context.projectId, context.settings.sourceEnvironment);
    if (runner) {
      try {
        return {
          metrics: await querySiteMetrics(
            runner,
            context.settings.thresholds.paidNotIntegratedMinutes,
          ),
          origin: 'ligação direta',
        };
      } finally {
        await runner.close().catch(() => undefined);
      }
    }
    const agent = await this.agentMetrics?.(context);
    return agent ? { metrics: agent.metrics, origin: `agente ${agent.host}` } : null;
  }

  private saturation(
    value: NonNullable<HealthSiteMetrics['saturation']>,
    context: CollectorContext,
  ): CheckResult {
    const max = value.max || 1;
    const previous = context.previous('database-saturation')?.details?.slowQueriesTotal;
    const slowDelta =
      typeof previous === 'number' && value.slowQueriesTotal >= previous
        ? value.slowQueriesTotal - previous
        : 0;
    const usage = round((value.connected / max) * 100);
    const t = context.settings.thresholds;
    return {
      checkId: 'database-saturation',
      status: worst([
        above(usage, t.dbConnectionsPercent, 1.15),
        above(slowDelta, t.slowQueries, 3),
      ]),
      value: usage,
      unit: '% ligações',
      summary: `Ligações ${value.connected}/${max} (${usage}%), em execução ${value.running}; queries lentas desde a última verificação: ${slowDelta}.`,
      details: { ...value, max, slowDelta },
    };
  }

  private paymentRates(
    checkId: string,
    label: string,
    value: { total: number; failed: number; pending: number },
    context: CollectorContext,
    extra: Record<string, unknown> = {},
  ): CheckResult {
    const { total, failed, pending } = value;
    const t = context.settings.thresholds;
    if (total < t.paymentMinAttempts)
      return {
        checkId,
        status: 'ok',
        value: total,
        unit: 'tentativas/h',
        summary: `${label}: ${total} tentativas na última hora (amostra abaixo de ${t.paymentMinAttempts}; ${failed} falhas, ${pending} pendentes).`,
        details: { total, failed, pending, ...extra },
      };
    const failedPercent = round((failed / total) * 100);
    const pendingPercent = round((pending / total) * 100);
    return {
      checkId,
      status: worst([
        above(failedPercent, t.paymentFailurePercent),
        above(pendingPercent, t.paymentPendingPercent),
      ]),
      value: failedPercent,
      unit: '% falhas',
      summary: `${label}: ${total} tentativas/h, ${failedPercent}% falhas/recusas (limite ${t.paymentFailurePercent}%), ${pendingPercent}% pendentes (limite ${t.paymentPendingPercent}%).`,
      details: { total, failed, pending, failedPercent, pendingPercent, ...extra },
    };
  }

  private divergence(
    value: NonNullable<HealthSiteMetrics['divergence']>,
    context: CollectorContext,
  ): CheckResult {
    const limit = context.settings.thresholds.divergenceCount;
    return {
      checkId: 'payments-divergence',
      status: above(value.count, limit, 5),
      value: value.count,
      unit: 'encomendas',
      summary: value.count
        ? `${value.count} encomenda(s) com pagamento confirmado mas não finalizada(s) nas últimas 24h (ex.: #${value.firstOrderId}).`
        : 'Sem divergências entre pagamentos confirmados e encomendas (24h).',
      details: { ...value },
    };
  }

  private paidNotIntegrated(
    value: NonNullable<HealthSiteMetrics['paidNotIntegrated']>,
  ): CheckResult {
    const minutes = value.thresholdMinutes;
    return {
      checkId: 'paid-not-integrated',
      status: value.count > 0 ? 'critical' : 'ok',
      value: value.count,
      unit: 'encomendas',
      summary: value.count
        ? `${value.count} encomenda(s) paga(s) por integrar há mais de ${minutes} min (mais antiga: ${value.oldestMinutes} min, ex.: #${value.firstOrderId}; ${value.failed} com integração falhada).`
        : `Sem encomendas pagas por integrar há mais de ${minutes} min.`,
      details: { ...value },
    };
  }
}
