import { DomainError } from '../../errors.js';
import { redactText } from './redaction.js';

export interface LogLine {
  time: string;
  labels: Record<string, string>;
  line: string;
}

const SINCE = /^(\d{1,4})(m|h|d)$/;
const UNIT_MS = { m: 60000, h: 3600000, d: 86400000 } as const;

/** URL de uma rota do Loki, preservando um eventual prefixo de proxy no URL base. */
export function lokiEndpoint(baseUrl: string, path: string) {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
}

/** Pesquisa de logs no Loki (LogQL) limitada em janela temporal e número de linhas. */
export class LokiConnector {
  constructor(
    private readonly baseUrl: string,
    private readonly limits = { maxLines: 200, maxWindowMs: 7 * 86400000, timeoutMs: 15000 },
    private readonly token?: string,
  ) {}

  private headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /** Confirma que a API de leitura responde (usado no botão Testar das integrações). */
  async ping() {
    const response = await fetch(lokiEndpoint(this.baseUrl, 'loki/api/v1/labels'), {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.limits.timeoutMs),
    });
    if (!response.ok)
      throw new DomainError('LOKI_TEST_FAILED', `O Loki respondeu ${response.status}.`, 503);
  }

  /** Executa LogQL num intervalo e volume limitados; redige dados sensíveis das linhas devolvidas. */
  async query(input: { query: string; since?: string; limit?: number }): Promise<LogLine[]> {
    const query = input.query.trim();
    if (!query.startsWith('{') || query.length > 2000)
      throw new DomainError('LOKI_INVALID', 'Use um seletor LogQL, por exemplo {job="php"}.', 400);
    const since = SINCE.exec(input.since ?? '1h');
    if (!since) throw new DomainError('LOKI_INVALID', 'Janela inválida; use 30m, 6h ou 2d.', 400);
    const windowMs = Math.min(
      Number(since[1]) * UNIT_MS[since[2] as keyof typeof UNIT_MS],
      this.limits.maxWindowMs,
    );
    const limit = Math.min(Math.max(input.limit ?? 100, 1), this.limits.maxLines);
    const end = Date.now();
    const url = lokiEndpoint(this.baseUrl, 'loki/api/v1/query_range');
    url.search = new URLSearchParams({
      query,
      start: `${(end - windowMs) * 1e6}`,
      end: `${end * 1e6}`,
      limit: String(limit),
      direction: 'backward',
    }).toString();
    const response = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.limits.timeoutMs),
    });
    if (!response.ok)
      throw new DomainError(
        'LOKI_FAILED',
        `Loki respondeu ${response.status}: ${(await response.text()).slice(0, 300)}`,
        400,
      );
    const body = (await response.json()) as {
      data?: { result?: { stream?: Record<string, string>; values?: [string, string][] }[] };
    };
    return (body.data?.result ?? [])
      .flatMap((stream) =>
        (stream.values ?? []).map(([ns, line]) => ({
          ns: BigInt(ns),
          labels: stream.stream ?? {},
          line,
        })),
      )
      .sort((a, b) => (a.ns < b.ns ? 1 : a.ns > b.ns ? -1 : 0))
      .slice(0, limit)
      .map((item) => ({
        time: new Date(Number(item.ns / 1000000n)).toISOString(),
        labels: item.labels,
        line: redactText(item.line.slice(0, 2000)),
      }));
  }
}
