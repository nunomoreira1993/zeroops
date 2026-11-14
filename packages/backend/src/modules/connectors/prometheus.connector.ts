import { DomainError } from '../../errors.js';
import { lokiEndpoint } from './loki.connector.js';
import { redactText } from './redaction.js';

export interface PromSeries {
  labels: Record<string, string>;
  /** Pares [epoch segundos, valor]; consultas instantâneas devolvem um único ponto. */
  points: [number, number][];
}

export interface PrometheusLimits {
  maxSeries: number;
  maxPoints: number;
  maxWindowMs: number;
  timeoutMs: number;
}

const WINDOW = /^(\d{1,4})(m|h|d)$/;
const UNIT_MS = { m: 60000, h: 3600000, d: 86400000 } as const;
const DEFAULT_LIMITS: PrometheusLimits = {
  maxSeries: 50,
  maxPoints: 500,
  maxWindowMs: 7 * 86400000,
  timeoutMs: 15000,
};

/** Converte `30m`, `6h` ou `2d` em milissegundos. */
export function windowMs(value: string) {
  const match = WINDOW.exec(value);
  if (!match) throw new DomainError('PROM_INVALID', 'Janela inválida; use 30m, 6h ou 2d.', 400);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

const PROMQL_KEYWORDS = new Set([
  'and',
  'or',
  'unless',
  'bool',
  'offset',
  'atan2',
  'inf',
  'nan',
  'sum',
  'min',
  'max',
  'avg',
  'count',
  'group',
  'stddev',
  'stdvar',
  'topk',
  'bottomk',
  'quantile',
  'count_values',
  'limitk',
  'limit_ratio',
]);
const PROMQL_TOKENS =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\]]*\]|\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)|(?<![\w.:])([a-zA-Z_:][a-zA-Z0-9_:]*)(\s*\{[^}]*\})?(\s*\()?|\{([^}]*)\}/g;

/**
 * Acrescenta os matchers do ambiente a cada seletor de métrica da expressão
 * (`up` -> `up{env="production"}`, `x{job="a"}` -> `x{job="a",env="production"}`).
 * Strings, janelas `[5m]`, cláusulas `by (...)`, funções e operadores não são tocados.
 */
export function scopePromQl(query: string, matchers?: string) {
  if (!matchers) return query;
  const merge = (inner: string) => `{${inner.trim() ? `${inner.trim()},` : ''}${matchers}}`;
  return query.replace(
    PROMQL_TOKENS,
    (
      whole,
      name: string | undefined,
      braces: string | undefined,
      call: string | undefined,
      bare: string | undefined,
    ) => {
      if (bare !== undefined) return merge(bare);
      if (!name || call || PROMQL_KEYWORDS.has(name)) return whole;
      return `${name}${merge(braces ? braces.trim().slice(1, -1) : '')}`;
    },
  );
}

/** Consultas de leitura à API HTTP do Prometheus, limitadas em janela, pontos e séries. */
export class PrometheusConnector {
  private readonly limits: PrometheusLimits;

  constructor(
    private readonly baseUrl: string,
    limits: Partial<PrometheusLimits> = {},
    private readonly token?: string,
    private readonly matchers?: string,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  private headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /** Confirma que a API responde (botão Testar das integrações). */
  async ping() {
    const response = await fetch(lokiEndpoint(this.baseUrl, 'api/v1/status/buildinfo'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.limits.timeoutMs),
    });
    if (!response.ok)
      throw new DomainError('PROM_TEST_FAILED', `O Prometheus respondeu ${response.status}.`, 503);
  }

  /** Valor atual de uma expressão PromQL. */
  async query(promql: string, at?: Date): Promise<PromSeries[]> {
    const params: Record<string, string> = { query: this.validate(promql) };
    if (at) params.time = String(at.getTime() / 1000);
    return this.request('api/v1/query', params);
  }

  /** Série temporal de uma expressão entre `now - window` e `now`, com step ajustado ao limite. */
  async queryRange(promql: string, window: string, now = new Date()): Promise<PromSeries[]> {
    const span = Math.min(windowMs(window), this.limits.maxWindowMs);
    const step = Math.max(15, Math.ceil(span / 1000 / this.limits.maxPoints));
    const end = now.getTime() / 1000;
    return this.queryRangeBetween(promql, end - span / 1000, end, step);
  }

  /** Série temporal com início, fim (epoch segundos) e step explícitos, dentro dos limites. */
  async queryRangeBetween(
    promql: string,
    start: number,
    end: number,
    step: number,
  ): Promise<PromSeries[]> {
    if (!(end >= start) || !(step >= 1))
      throw new DomainError('PROM_INVALID', 'Intervalo inválido.', 400);
    if (
      (end - start) * 1000 > this.limits.maxWindowMs ||
      (end - start) / step > this.limits.maxPoints
    )
      throw new DomainError(
        'PROM_INVALID',
        'Intervalo acima do limite de janela ou de pontos.',
        400,
      );
    return this.request('api/v1/query_range', {
      query: this.validate(promql),
      start: String(start),
      end: String(end),
      step: String(step),
    });
  }

  /** Regras de alerta carregadas no Prometheus: nome do alerta e expressão PromQL. */
  async alertRules(): Promise<{ name: string; query: string }[]> {
    const url = lokiEndpoint(this.baseUrl, 'api/v1/rules');
    url.search = new URLSearchParams({ type: 'alert' }).toString();
    const response = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.limits.timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as {
      status?: string;
      data?: { groups?: { rules?: { name?: unknown; query?: unknown }[] }[] };
    };
    if (!response.ok || body.status !== 'success')
      throw new DomainError('PROM_FAILED', `Prometheus respondeu ${response.status}.`, 400);
    return (body.data?.groups ?? []).flatMap((group) =>
      (group.rules ?? []).flatMap((rule) =>
        typeof rule.name === 'string' && typeof rule.query === 'string'
          ? [{ name: rule.name, query: rule.query }]
          : [],
      ),
    );
  }

  private validate(promql: string) {
    const query = promql.trim();
    if (!query || query.length > 2000)
      throw new DomainError('PROM_INVALID', 'Indique uma expressão PromQL (máx. 2000).', 400);
    return scopePromQl(query, this.matchers);
  }

  private async request(path: string, params: Record<string, string>) {
    const url = lokiEndpoint(this.baseUrl, path);
    url.search = new URLSearchParams(params).toString();
    const response = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.limits.timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as {
      status?: string;
      error?: string;
      data?: {
        resultType?: string;
        result?:
          | {
              metric?: Record<string, string>;
              value?: [number, string];
              values?: [number, string][];
            }[]
          | [number, string];
      };
    };
    if (!response.ok || body.status !== 'success')
      throw new DomainError(
        'PROM_FAILED',
        `Prometheus respondeu ${response.status}: ${redactText(String(body.error ?? '').slice(0, 300))}`,
        400,
      );
    const data = body.data;
    if (data?.resultType === 'scalar' && Array.isArray(data.result))
      return [{ labels: {}, points: [this.point(data.result as [number, string])] }];
    const result = Array.isArray(data?.result)
      ? (data.result as {
          metric?: Record<string, string>;
          value?: [number, string];
          values?: [number, string][];
        }[])
      : [];
    return result.slice(0, this.limits.maxSeries).map((series) => ({
      labels: Object.fromEntries(
        Object.entries(series.metric ?? {}).map(([key, value]) => [key, redactText(value)]),
      ),
      points: (series.values ?? (series.value ? [series.value] : []))
        .slice(-this.limits.maxPoints)
        .map((pair) => this.point(pair)),
    }));
  }

  private point([time, value]: [number, string]): [number, number] {
    return [time, Number(value)];
  }
}
