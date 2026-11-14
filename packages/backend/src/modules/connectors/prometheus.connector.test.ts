import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrometheusConnector, scopePromQl, windowMs } from './prometheus.connector.js';

const env = 'env="production"';

describe('scopePromQl', () => {
  it('acrescenta os matchers a seletores simples e com labels', () => {
    expect(scopePromQl('up == 0', env)).toBe('up{env="production"} == 0');
    expect(scopePromQl('redis_up{job="redis"}', env)).toBe(
      'redis_up{job="redis",env="production"}',
    );
    expect(scopePromQl('{__name__="up"}', env)).toBe('{__name__="up",env="production"}');
  });

  it('não toca em funções, agregações, janelas, by(), offset nem strings', () => {
    expect(
      scopePromQl(
        'sum by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m] offset 1h)) / count by(instance)(node_cpu_seconds_total)',
        env,
      ),
    ).toBe(
      'sum by (instance) (rate(node_cpu_seconds_total{mode="idle",env="production"}[5m] offset 1h)) / count by(instance)(node_cpu_seconds_total{env="production"})',
    );
    expect(scopePromQl('label_replace(up, "dst", "$1", "job", "(.*)")', env)).toBe(
      'label_replace(up{env="production"}, "dst", "$1", "job", "(.*)")',
    );
    expect(scopePromQl('node_load5 > bool 1e3', env)).toBe(
      'node_load5{env="production"} > bool 1e3',
    );
  });

  it('devolve a expressão intacta sem matchers', () => {
    expect(scopePromQl('up', undefined)).toBe('up');
  });
});

describe('PrometheusConnector', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('limita a janela e o número de pontos e converte valores', async () => {
    const fetchMock = vi.fn(async (_url: URL) =>
      Response.json({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { instance: 'web1' },
              values: [
                [1, '0.5'],
                [2, '0.75'],
              ],
            },
            { metric: { instance: 'web2' }, values: [[1, '1']] },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const connector = new PrometheusConnector(
      'http://127.0.0.1:9090',
      { maxSeries: 1 },
      undefined,
      env,
    );
    const series = await connector.queryRange('up', '30d', new Date(1_000_000_000));
    expect(series).toEqual([
      {
        labels: { instance: 'web1' },
        points: [
          [1, 0.5],
          [2, 0.75],
        ],
      },
    ]);
    const url = fetchMock.mock.calls[0]![0];
    expect(url.pathname).toBe('/api/v1/query_range');
    expect(url.searchParams.get('query')).toBe('up{env="production"}');
    const span = Number(url.searchParams.get('end')) - Number(url.searchParams.get('start'));
    expect(span).toBe(windowMs('7d') / 1000);
    expect(Number(url.searchParams.get('step'))).toBeGreaterThanOrEqual(span / 500);
  });

  it('rejeita respostas de erro com código conhecido', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ status: 'error', error: 'parse error' }, { status: 400 })),
    );
    await expect(
      new PrometheusConnector('http://127.0.0.1:9090').query('up('),
    ).rejects.toMatchObject({
      code: 'PROM_FAILED',
    });
  });
});
