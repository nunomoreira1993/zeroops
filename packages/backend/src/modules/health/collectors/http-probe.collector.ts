import {
  above,
  round,
  unknown,
  type CheckResult,
  type CollectorContext,
  type HealthCollector,
} from './collector.js';

export type HttpFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: 'follow' },
) => Promise<{ status: number }>;

interface Probe {
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

/** Monitorizacao externa: disponibilidade do site, app e APIs e tempo de resposta. */
export class HttpProbeCollector implements HealthCollector {
  readonly name = 'http';
  readonly checks = ['site-availability', 'app-api-availability', 'response-time'] as const;

  constructor(
    private readonly fetcher: HttpFetch = (url, init) => fetch(url, init),
    private readonly timeoutMs = 10000,
  ) {}

  /** Consulta URLs configuradas e calcula disponibilidade e tempo de resposta sem assumir sucesso ausente. */
  async collect(context: CollectorContext): Promise<CheckResult[]> {
    const { siteUrl, appUrl, apiUrls, thresholds } = context.settings;
    const site = siteUrl ? await this.probe(siteUrl) : null;
    const others = await Promise.all(
      [appUrl, ...apiUrls]
        .filter((url): url is string => Boolean(url))
        .map((url) => this.probe(url)),
    );
    const all = [site, ...others].filter((item): item is Probe => item !== null);
    return [
      site
        ? this.availability('site-availability', [site])
        : unknown('site-availability', 'URL do site não configurado.'),
      others.length
        ? this.availability('app-api-availability', others)
        : unknown('app-api-availability', 'URLs da app/APIs não configurados.'),
      this.responseTime(
        all.filter((item) => item.ok),
        thresholds.responseMs,
      ),
    ];
  }

  private async probe(url: string): Promise<Probe> {
    const started = performance.now();
    try {
      const response = await this.fetcher(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'follow',
      });
      return {
        url,
        ok: response.status < 500,
        status: response.status,
        ms: Math.round(performance.now() - started),
      };
    } catch (error) {
      return {
        url,
        ok: false,
        status: null,
        ms: Math.round(performance.now() - started),
        error: error instanceof Error ? error.name : 'Error',
      };
    }
  }

  private availability(checkId: string, probes: Probe[]): CheckResult {
    const failed = probes.filter((item) => !item.ok);
    return {
      checkId,
      status: failed.length ? 'critical' : 'ok',
      value: probes.length - failed.length,
      unit: `de ${probes.length}`,
      summary: failed.length
        ? `Indisponível: ${failed.map((item) => `${item.url} (${item.status ?? item.error})`).join(', ')}.`
        : `${probes.length} endereço(s) disponível(eis).`,
      details: { probes },
      chartTargets: failed.map((item) => ({
        chartId: 'site_availability',
        instance: item.url,
      })),
    };
  }

  private responseTime(probes: Probe[], limit: number): CheckResult {
    if (!probes.length) return unknown('response-time', 'Sem respostas para medir.');
    const average = round(probes.reduce((acc, item) => acc + item.ms, 0) / probes.length, 0);
    return {
      checkId: 'response-time',
      status: above(average, limit, 2),
      value: average,
      unit: 'ms',
      summary: `Tempo médio de resposta: ${average} ms (limite ${limit} ms).`,
      details: { probes: probes.map(({ url, ms }) => ({ url, ms })) },
      chartTargets:
        above(average, limit, 2) === 'ok'
          ? []
          : probes
              .filter((item) => above(item.ms, limit, 2) !== 'ok')
              .map((item) => ({ chartId: 'site_latency', instance: item.url })),
    };
  }
}
