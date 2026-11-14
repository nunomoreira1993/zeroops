import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeftRight, Maximize2, Minimize2 } from 'lucide-react';
import {
  healthChartRanges,
  type HealthChart,
  type HealthChartRange,
  type HealthChartsResponse,
} from '@zeroops/contracts';
import { Loading, Notice, ResourceError } from '../../../components/ui';
import { useResource } from '../../../lib/hooks';
import { useIdentityLocale } from '../../../lib/identity';
import { LineChart } from './LineChart';
import {
  COMPACT_RANGE_LABELS,
  RANGE_LABELS,
  localizeChart,
  withInstanceLabels,
} from './chart-format';

interface Props {
  chart: HealthChart;
  baseline: HealthChartsResponse;
  instance: string;
  roles: Map<string, string | null>;
  rangeOverride: HealthChartRange | undefined;
  onRangeChange: (value: HealthChartRange | undefined) => void;
  compare: boolean;
}

/** O mesmo grafico permanece montado no dialogo modeless/modal: ampliar nao perde zoom ou series. */
export function HealthChartCard({
  chart,
  baseline,
  instance,
  roles,
  rangeOverride,
  onRangeChange,
  compare,
}: Props) {
  const { locale, t } = useIdentityLocale();
  const titleId = `health-chart-title-${useId()}`;
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const modal = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [compareOverride, setCompareOverride] = useState<boolean | null>(null);
  const range = rangeOverride ?? baseline.range;
  const canCompare = range !== 'all' && range !== '395d';
  const effectiveCompare = canCompare && (compareOverride ?? compare);
  const needsQuery =
    range !== baseline.range ||
    effectiveCompare !== (compare && baseline.range !== 'all' && baseline.range !== '395d');
  const params = new URLSearchParams({
    panel: baseline.panel,
    range,
    env: baseline.environment,
    chart: chart.id,
  });
  if (instance) params.set('instance', instance);
  if (effectiveCompare) params.set('compare', '1');
  const own = useResource<HealthChartsResponse>(
    needsQuery ? `/monitoring/charts?${params}` : null,
    ['1h', '6h', '24h'].includes(range) ? 60000 : 0,
  );
  const response = needsQuery ? own.data : baseline;
  const pending = needsQuery && !own.data && !own.error;
  const selected = response?.charts.find((item) => item.id === chart.id);
  const missingChart = Boolean(response && !response.unavailable && !selected);
  const effectiveChart = withInstanceLabels(
    localizeChart(selected ?? chart, locale),
    roles,
    locale,
  );
  const expandLabel = `${expanded ? t('Fechar ampliação', 'Close enlarged chart') : t('Ampliar', 'Enlarge')}: ${effectiveChart.title}`;
  const comparisonHint = !canCompare
    ? t('Comparação indisponível neste período', 'Comparison unavailable for this period')
    : effectiveCompare
      ? t('Desativar comparação', 'Disable comparison')
      : t('Comparar com o período anterior', 'Compare with the previous period');

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (expanded) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.close();
      element.showModal();
      modal.current = true;
      closeButton.current?.focus();
    } else if (modal.current) {
      element.close();
      element.show();
      modal.current = false;
      previousFocus.current?.focus();
    }
  }, [expanded]);

  return (
    <section className="panel health-chart-card">
      <dialog
        open
        ref={dialog}
        role={expanded ? 'dialog' : 'region'}
        aria-modal={expanded || undefined}
        aria-labelledby={titleId}
        className={`health-chart-card-dialog${expanded ? ' is-expanded' : ''}`}
        onCancel={(event) => {
          event.preventDefault();
          setExpanded(false);
        }}
      >
        <header>
          <h3 id={titleId}>{effectiveChart.title}</h3>
          <p className="health-muted">{effectiveChart.description}</p>
        </header>
        <div className="health-chart-filters health-chart-card-controls">
          <label>
            {t('Período', 'Period')}
            <select
              aria-label={`${t('Período deste gráfico', 'Chart period')}: ${effectiveChart.title}`}
              title={
                rangeOverride
                  ? RANGE_LABELS[range][locale]
                  : `${t('Período global', 'Global period')}: ${RANGE_LABELS[baseline.range][locale]}`
              }
              value={rangeOverride ?? ''}
              onChange={(event) =>
                onRangeChange(
                  event.target.value ? (event.target.value as HealthChartRange) : undefined,
                )
              }
            >
              <option value="">{t('Global', 'Global')}</option>
              {healthChartRanges.map((id) => (
                <option key={id} value={id}>
                  {COMPACT_RANGE_LABELS[id][locale]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="icon-button"
            aria-label={`${t('Comparar este gráfico', 'Compare this chart')}: ${effectiveChart.title}`}
            aria-pressed={effectiveCompare}
            disabled={!canCompare}
            title={comparisonHint}
            onClick={() => setCompareOverride(!effectiveCompare)}
          >
            <ArrowLeftRight size={16} aria-hidden="true" />
          </button>
          <button
            ref={expanded ? closeButton : undefined}
            type="button"
            className="icon-button"
            aria-label={expandLabel}
            title={expandLabel}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <Minimize2 size={16} aria-hidden="true" />
            ) : (
              <Maximize2 size={16} aria-hidden="true" />
            )}
          </button>
        </div>
        {pending && <Loading label={t('A carregar este gráfico…', 'Loading this chart…')} />}
        {needsQuery && own.error && <ResourceError error={own.error} retry={own.reload} />}
        {missingChart && (
          <ResourceError
            error={t(
              'A resposta não contém o gráfico pedido.',
              'The response does not contain the requested chart.',
            )}
            retry={own.reload}
          />
        )}
        {response?.unavailable && (
          <Notice tone="info">
            {locale === 'en'
              ? (response.unavailableEn ?? response.unavailable)
              : response.unavailable}
          </Notice>
        )}
        {selected?.error && (
          <Notice tone="warning">
            {locale === 'en' ? (selected.errorEn ?? selected.error) : selected.error}
          </Notice>
        )}
        <div
          hidden={
            pending ||
            Boolean(needsQuery && own.error) ||
            Boolean(response?.unavailable) ||
            Boolean(selected?.error) ||
            missingChart
          }
        >
          <LineChart
            chart={effectiveChart}
            environment={(response ?? baseline).environment}
            from={Date.parse((response ?? baseline).from) / 1000}
            to={Date.parse((response ?? baseline).to) / 1000}
            stepSeconds={(response ?? baseline).stepSeconds}
            events={response?.events ?? []}
            instance={instance}
          />
          {!effectiveChart.series.length && (
            <p className="health-muted health-chart-empty">
              {t('Sem dados neste período.', 'No data in this period.')}
            </p>
          )}
        </div>
      </dialog>
    </section>
  );
}
