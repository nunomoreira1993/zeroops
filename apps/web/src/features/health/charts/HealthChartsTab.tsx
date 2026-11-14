import { useState } from 'react';
import {
  healthChartPanels,
  healthChartRanges,
  type HealthChartEnvironment,
  type HealthChartPanel,
  type HealthChartRange,
  type HealthChartsResponse,
} from '@zeroops/contracts';
import { Loading, Notice, ResourceError } from '../../../components/ui';
import { useResource } from '../../../lib/hooks';
import { useIdentityLocale } from '../../../lib/identity';
import { HealthTabBar } from '../HealthTabs';
import { ChartServerStatus } from './ChartServerStatus';
import { HealthHeatmap } from './HealthHeatmap';
import { HealthChartCard } from './HealthChartCard';
import {
  PANEL_LABELS,
  RANGE_LABELS,
  groupCharts,
  intlLocale,
  localizeChart,
  roleLabel,
  sortInstances,
} from './chart-format';
import '../../../styles/health-charts.css';

/** Tab Gráficos da Saúde: percentagens atuais, séries temporais por serviço e mapa de calor. */
export function HealthChartsTab() {
  const { locale, t } = useIdentityLocale();
  const [panel, setPanel] = useState<HealthChartPanel>('servers');
  const [range, setRange] = useState<HealthChartRange>('all');
  const [environment, setEnvironment] = useState<HealthChartEnvironment>('production');
  const [instance, setInstance] = useState('');
  const [compare, setCompare] = useState(false);
  const [chartRanges, setChartRanges] = useState<Record<string, HealthChartRange | undefined>>({});
  const canCompare = range !== 'all' && range !== '395d';
  const params = new URLSearchParams({ panel, range, env: environment });
  if (instance) params.set('instance', instance);
  if (compare && canCompare) params.set('compare', '1');
  const refresh = ['1h', '6h', '24h'].includes(range) ? 60000 : 0;
  const charts = useResource<HealthChartsResponse>(`/monitoring/charts?${params}`, refresh);
  const data = charts.data;
  const instances = sortInstances(data?.instances ?? []);
  const roles = new Map(instances.map((item) => [item.instance, item.role]));
  const localized = (data?.charts ?? []).map((chart) => localizeChart(chart, locale));
  const availableFrom = data?.availableFrom
    ? new Intl.DateTimeFormat(intlLocale(locale), {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Europe/Lisbon',
      }).format(new Date(data.availableFrom))
    : null;

  return (
    <div className="stack health-charts">
      <HealthTabBar
        tabs={healthChartPanels.map((id) => ({ id, label: PANEL_LABELS[id][locale] }))}
        active={panel}
        onSelect={setPanel}
        idPrefix="health-charts"
        label={t('Serviços com gráficos', 'Services with charts')}
        variant="sub"
      />
      <div className="health-chart-filters">
        <label>
          {t('Ambiente', 'Environment')}
          <select
            value={environment}
            onChange={(event) => {
              setEnvironment(event.target.value as HealthChartEnvironment);
              setInstance('');
            }}
          >
            <option value="production">{t('Produção', 'Production')}</option>
            <option value="quality">{t('Qualidade', 'Quality')}</option>
          </select>
        </label>
        <label>
          {t('Período', 'Period')}
          <select
            value={range}
            onChange={(event) => setRange(event.target.value as HealthChartRange)}
          >
            {healthChartRanges.map((id) => (
              <option key={id} value={id}>
                {RANGE_LABELS[id][locale]}
              </option>
            ))}
          </select>
        </label>
        {panel !== 'sites' && (
          <label>
            {t('Servidor', 'Server')}
            <select value={instance} onChange={(event) => setInstance(event.target.value)}>
              <option value="">{t('Todos', 'All')}</option>
              {instances.map((item) => (
                <option key={item.instance} value={item.instance}>
                  {item.role ? `${roleLabel(item.role, locale)} · ` : ''}
                  {item.instance}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="health-chart-check">
          <input
            type="checkbox"
            checked={compare && canCompare}
            disabled={!canCompare}
            onChange={(event) => setCompare(event.target.checked)}
          />
          {t('Comparar com o período anterior', 'Compare with the previous period')}
        </label>
      </div>
      <div
        id={`health-charts-panel-${panel}`}
        role="tabpanel"
        aria-labelledby={`health-charts-tab-${panel}`}
        className="stack"
      >
        {charts.error && <ResourceError error={charts.error} retry={charts.reload} />}
        {!data && !charts.error && (
          <Loading label={t('A carregar os gráficos…', 'Loading charts…')} />
        )}
        {data?.unavailable && (
          <Notice tone="info">
            {locale === 'en' ? data.unavailableEn || data.unavailable : data.unavailable}
          </Notice>
        )}
        {data && !data.unavailable && (
          <>
            {availableFrom && (
              <p className="health-muted">
                {t('Histórico disponível desde ', 'History available since ')}
                <time dateTime={data.availableFrom ?? undefined}>{availableFrom}</time>
                {t(
                  ' (hora de Lisboa). Cada métrica começa na sua própria data; não são preenchidos intervalos sem medições.',
                  ' (Lisbon time). Each metric starts on its own date; intervals without measurements are not filled.',
                )}
              </p>
            )}
            <p className="health-muted">
              {data.source === 'rollup'
                ? t(
                    'Médias diárias dos agregados horários guardados pelo ZeroOps.',
                    'Daily averages of the hourly aggregates stored by ZeroOps.',
                  )
                : t(
                    `Prometheus, um ponto a cada ${data.stepSeconds} s.`,
                    `Prometheus, one point every ${data.stepSeconds} s.`,
                  )}
              {refresh ? t(' Atualiza a cada minuto.', ' Refreshes every minute.') : ''}
              {panel !== 'sites' && instances.length > 0 && (
                <>
                  {t(' Servidores: ', ' Servers: ')}
                  {instances
                    .map((item) =>
                      item.role
                        ? `${roleLabel(item.role, locale)} (${item.instance})`
                        : item.instance,
                    )
                    .join(', ')}
                  .
                </>
              )}
            </p>
            <ChartServerStatus charts={localized} instances={instances} />
            {groupCharts(localized).map(({ group, charts: items }) => (
              <section key={group} className="stack" aria-label={group}>
                <h2 className="health-chart-section-title">{group}</h2>
                <div className="health-chart-grid-cards">
                  {items.map((chart) => (
                    <HealthChartCard
                      key={chart.id}
                      chart={chart}
                      baseline={data}
                      instance={panel === 'sites' ? '' : instance}
                      roles={roles}
                      compare={compare}
                      rangeOverride={chartRanges[`${panel}:${chart.id}`]}
                      onRangeChange={(value) =>
                        setChartRanges((current) => ({
                          ...current,
                          [`${panel}:${chart.id}`]: value,
                        }))
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
      <HealthHeatmap environment={environment} instance={instance} />
    </div>
  );
}
