import { useState } from 'react';
import {
  healthRollupMetrics,
  type HealthChartEnvironment,
  type HealthHeatmapResponse,
  type HealthRollupMetric,
} from '@zeroops/contracts';
import { Loading, ResourceError } from '../../../components/ui';
import { useResource } from '../../../lib/hooks';
import { useIdentityLocale } from '../../../lib/identity';
import {
  HEATMAP_METRICS,
  HEATMAP_WEEKDAYS,
  formatChartValue,
  heatmapLegendGradient,
  heatmapLegendPosition,
  heatmapRange,
  heatmapScale,
} from './chart-format';

/** Mapa de calor dia da semana × hora (Lisboa) e média por dia do mês, a partir dos agregados horários. */
export function HealthHeatmap({
  environment,
  instance,
}: {
  environment: HealthChartEnvironment;
  instance: string;
}) {
  const { locale, t } = useIdentityLocale();
  const weekdays = HEATMAP_WEEKDAYS[locale];
  const [metric, setMetric] = useState<HealthRollupMetric>('cpu');
  const [days, setDays] = useState(28);
  const params = new URLSearchParams({ metric, env: environment, days: String(days) });
  if (instance) params.set('instance', instance);
  const heatmap = useResource<HealthHeatmapResponse>(`/monitoring/charts/heatmap?${params}`);
  const data = heatmap.data;
  const format = (value: number | null) => (data ? formatChartValue(value, data.unit, locale) : '');
  const range = data ? heatmapRange([...data.cells.flat(), ...data.byMonthDay]) : null;
  const scale = data ? heatmapScale(data, range, data.unit) : null;
  const shade = (value: number | null) => scale?.color(value);
  // Pior valor do período: o máximo, ou o mínimo quando valores altos são melhores.
  const worst = range && data ? (data.higherIsBetter ? range.min : range.max) : null;

  return (
    <section className="panel health-heatmap">
      <header className="health-chart-head">
        <div>
          <h3>{t('Comportamento por dia e hora', 'Behaviour by day and hour')}</h3>
          <p className="health-muted">
            {t(
              `Média horária dos últimos ${days} dias (hora de Lisboa). Ajuda a perceber picos de almoço, jantar, fins de semana e dias do mês.`,
              `Hourly average over the last ${days} days (Lisbon time). Helps spot lunch, dinner, weekend and day-of-month peaks.`,
            )}
          </p>
        </div>
        <div className="health-chart-filters">
          <label>
            {t('Métrica', 'Metric')}
            <select
              value={metric}
              onChange={(event) => setMetric(event.target.value as HealthRollupMetric)}
            >
              {healthRollupMetrics.map((id) => (
                <option key={id} value={id}>
                  {HEATMAP_METRICS[id][locale]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Período', 'Period')}
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              <option value={7}>{t('7 dias', '7 days')}</option>
              <option value={28}>{t('4 semanas', '4 weeks')}</option>
              <option value={90}>{t('90 dias', '90 days')}</option>
            </select>
          </label>
        </div>
      </header>
      {heatmap.error && <ResourceError error={heatmap.error} retry={heatmap.reload} />}
      {!data && !heatmap.error && (
        <Loading label={t('A carregar o mapa de calor…', 'Loading heatmap…')} />
      )}
      {data && data.max === null && (
        <p className="health-muted">
          {t(
            `Ainda não há agregados horários para esta métrica${data.instance ? ` em ${data.instance}` : ''}. O worker grava-os de hora a hora.`,
            `There are no hourly aggregates for this metric yet${data.instance ? ` on ${data.instance}` : ''}. The worker stores them every hour.`,
          )}
        </p>
      )}
      {data && data.max !== null && (
        <>
          <div
            className="health-heatmap-grid"
            role="table"
            aria-label={t('Média por dia da semana e hora', 'Average by weekday and hour')}
          >
            <span />
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="health-heatmap-hour">
                {hour % 3 === 0 ? `${hour}h` : ''}
              </span>
            ))}
            {data.cells.map((row, day) => (
              <div key={day} className="health-heatmap-row" role="row">
                <span className="health-heatmap-label">{weekdays[day]}</span>
                {row.map((value, hour) => (
                  <span
                    key={hour}
                    role="cell"
                    className="health-heatmap-cell"
                    style={{ background: shade(value) }}
                    title={`${weekdays[day]} ${hour}h: ${format(value)}`}
                  />
                ))}
              </div>
            ))}
          </div>
          <h4 className="health-heatmap-subtitle">
            {t('Média por dia do mês', 'Average by day of the month')}
          </h4>
          <div className="health-heatmap-month">
            {data.byMonthDay.map((value, index) => (
              <span
                key={index}
                className="health-heatmap-cell"
                style={{ background: shade(value) }}
                title={`${t('Dia', 'Day')} ${index + 1}: ${format(value)}`}
              >
                {index + 1}
              </span>
            ))}
          </div>
          {scale && worst !== null && (
            <div className="health-heatmap-legend">
              <span>{format(scale.domain.min)}</span>
              <span className="health-heatmap-legend-track">
                <span
                  className="health-heatmap-legend-bar"
                  style={{ background: heatmapLegendGradient(scale) }}
                  aria-hidden="true"
                />
                {scale.warn !== null && (
                  <span
                    className="health-heatmap-legend-tick is-warn"
                    style={{ left: `${heatmapLegendPosition(scale.warn, scale.domain)}%` }}
                    title={t('Limite de aviso', 'Warning threshold')}
                  >
                    {format(scale.warn)}
                  </span>
                )}
                {scale.crit !== null && (
                  <span
                    className="health-heatmap-legend-tick is-crit"
                    style={{ left: `${heatmapLegendPosition(scale.crit, scale.domain)}%` }}
                    title={t('Limite crítico', 'Critical threshold')}
                  >
                    {format(scale.crit)}
                  </span>
                )}
                <span
                  className="health-heatmap-legend-worst"
                  style={{ left: `${heatmapLegendPosition(worst, scale.domain)}%` }}
                  title={`${t('Pior média horária do período', 'Worst hourly average in the period')}: ${format(worst)}`}
                >
                  ▲ {data.higherIsBetter ? t('mín.', 'min.') : t('máx.', 'max.')} {format(worst)}
                </span>
              </span>
              <span>{format(scale.domain.max)}</span>
              <span className="health-muted">
                {data.instance ? `${t('Servidor', 'Server')} ${data.instance} · ` : ''}
                {scale.absolute
                  ? t(
                      'marcas: aviso e crítico · vermelho só a partir do limite crítico',
                      'marks: warning and critical · red only from the critical threshold',
                    )
                  : t(
                      'sem limite conhecido: verde = melhor, vermelho = pior no período',
                      'no known threshold: green = best, red = worst in the period',
                    )}
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
