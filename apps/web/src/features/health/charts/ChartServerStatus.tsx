import type { HealthChart, HealthChartInstance } from '@zeroops/contracts';
import { useIdentityLocale } from '../../../lib/identity';
import { formatChartValue, roleLabel, sortInstances } from './chart-format';

interface Reading {
  chart: HealthChart;
  value: number;
}

function level(chart: HealthChart, value: number) {
  if (chart.crit !== null && value >= chart.crit) return 'is-crit';
  if (chart.warn !== null && value >= chart.warn) return 'is-warn';
  return 'is-ok';
}

/**
 * Último valor de cada gráfico `gauge` por servidor. Com várias séries no mesmo servidor
 * (ex.: um disco por partição) mostra o pior valor.
 */
function readingsByInstance(charts: HealthChart[]) {
  const byInstance = new Map<string, Reading[]>();
  for (const chart of charts.filter((item) => item.gauge)) {
    const worst = new Map<string, number>();
    for (const series of chart.series) {
      const last = series.points[series.points.length - 1];
      if (series.previous || !last) continue;
      const key = series.instance ?? '';
      worst.set(key, Math.max(worst.get(key) ?? -Infinity, last[1]));
    }
    for (const [instance, value] of worst)
      byInstance.set(instance, [...(byInstance.get(instance) ?? []), { chart, value }]);
  }
  return byInstance;
}

/** Domínio de uma sonda HTTP (ex.: blackbox), para não usar o URL inteiro como título. */
function hostOf(instance: string) {
  if (!/^https?:\/\//i.test(instance)) return null;
  try {
    return new URL(instance).hostname;
  } catch {
    return null;
  }
}

/** Estado atual com um cartão por servidor (papel + nome), para não misturar máquinas. */
export function ChartServerStatus({
  charts,
  instances,
}: {
  charts: HealthChart[];
  instances: HealthChartInstance[];
}) {
  const { locale, t } = useIdentityLocale();
  const readings = readingsByInstance(charts);
  if (!readings.size) return null;
  const known = new Map(instances.map((item) => [item.instance, item.role]));
  const cards = sortInstances(
    [...readings.keys()].map((instance) => ({ instance, role: known.get(instance) ?? null })),
  );
  return (
    <section
      className="stack health-chart-status"
      aria-label={t('Estado atual por servidor', 'Current status by server')}
    >
      <h2 className="health-chart-section-title">{t('Estado atual', 'Current status')}</h2>
      <div className="health-chart-servers">
        {cards.map(({ instance, role }) => {
          const host = role ? null : hostOf(instance);
          return (
            <article key={instance || 'geral'} className="panel health-chart-server">
              <header>
                <strong title={instance || undefined}>
                  {role ? roleLabel(role, locale) : (host ?? (instance || t('Geral', 'General')))}
                </strong>
                {(role || host) && <span className="health-muted">{instance}</span>}
              </header>
              <dl>
                {readings.get(instance)!.map(({ chart, value }) => (
                  <div key={chart.id} className={`health-chart-reading ${level(chart, value)}`}>
                    <dt>{chart.title}</dt>
                    <dd>{formatChartValue(value, chart.unit, locale)}</dd>
                    {chart.unit === 'percent' && (
                      <span className="health-chart-bar" aria-hidden="true">
                        <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
                      </span>
                    )}
                  </div>
                ))}
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}
