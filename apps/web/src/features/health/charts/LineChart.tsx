import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import type { HealthChart, HealthChartEnvironment, HealthChartEvent } from '@zeroops/contracts';
import { useIdentityLocale } from '../../../lib/identity';
import {
  SERIES_COLORS,
  clampZoom,
  chartEventDescription,
  formatChartTime,
  formatChartValue,
  minZoomSpan,
  panZoom,
  scaleZoom,
  splitCommonPrefix,
  tooltipLeft,
} from './chart-format';

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 12, right: 12, bottom: 26, left: 64 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const MAX_TOOLTIP_ROWS = 10;

interface Props {
  chart: HealthChart;
  environment: HealthChartEnvironment;
  from: number;
  to: number;
  stepSeconds: number;
  events?: HealthChartEvent[];
  instance?: string;
}

type Point = [number, number];

function niceMax(value: number) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((factor) => factor * power >= value) ?? 10;
  return step * power;
}

const baseKey = (key: string) => key.replace(/\|anterior$/, '');

function nearest(points: Point[], time: number, gap: number): Point | null {
  let best: Point | null = null;
  for (const point of points)
    if (!best || Math.abs(point[0] - time) < Math.abs(best[0] - time)) best = point;
  return best && Math.abs(best[0] - time) <= gap ? best : null;
}

/**
 * Linha temporal em SVG: séries, limiares de aviso/crítico, zoom por arrasto, deslocação,
 * séries ocultáveis pela legenda e tooltip ao lado do cursor com marcadores nos pontos.
 */
export function LineChart({
  chart,
  environment,
  from,
  to,
  stepSeconds,
  events = [],
  instance = '',
}: Props) {
  const { locale, t } = useIdentityLocale();
  const clipId = `chart-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipBox, setTipBox] = useState({ tip: 0, plot: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [eventKinds, setEventKinds] = useState({ email: true, outage: true, planned: true });
  const [eventPage, setEventPage] = useState(25);
  const loadedSpan = to - from;
  const minSpan = minZoomSpan(stepSeconds);

  // Mudar o período (24 h, 7 dias, ...) repõe o zoom; a atualização automática mantém-no.
  useEffect(() => setZoom(null), [loadedSpan]);

  const view = zoom ? clampZoom(zoom[0], zoom[1], from, to, minSpan) : null;
  const viewFrom = view?.[0] ?? from;
  const viewTo = view?.[1] ?? to;
  const span = Math.max(1, viewTo - viewFrom);
  const visibleEvents = events.filter((event) => {
    const time = Date.parse(event.at) / 1000;
    return (
      time >= viewFrom &&
      time <= viewTo &&
      (event.kind === 'email'
        ? eventKinds.email &&
          event.environment === environment &&
          event.alertContext?.targets.some(
            (target) => target.chartId === chart.id && (!instance || target.instance === instance),
          )
        : event.planned
          ? eventKinds.planned
          : eventKinds.outage)
    );
  });
  const eventScope = (event: HealthChartEvent) =>
    event.kind !== 'email' && instance && event.resource !== instance
      ? t(
          'Contexto do ambiente, não do servidor filtrado',
          'Environment context, not the filtered server',
        )
      : '';
  const markerGroups = new Map<string, HealthChartEvent[]>();
  for (const event of visibleEvents) {
    const bucket = Math.floor((((Date.parse(event.at) / 1000 - viewFrom) / span) * PLOT_W) / 4);
    const key = `${event.kind}:${event.planned}:${bucket}`;
    const group = markerGroups.get(key) ?? [];
    group.push(event);
    markerGroups.set(key, group);
  }

  const colors = useMemo(() => {
    const byLabel = new Map<string, string>();
    for (const series of chart.series) {
      const base = baseKey(series.key);
      if (!byLabel.has(base))
        byLabel.set(base, SERIES_COLORS[byLabel.size % SERIES_COLORS.length]!);
    }
    return byLabel;
  }, [chart.series]);

  const visible = chart.series.filter((series) => !hidden.has(baseKey(series.key)));
  const values = visible.flatMap((series) =>
    series.points.filter(([time]) => time >= viewFrom && time <= viewTo).map(([, value]) => value),
  );
  const dataMax = Math.max(0, ...values, chart.warn ?? 0, chart.crit ?? 0);
  const dataMin = Math.min(0, ...values);
  const yMax =
    chart.unit === 'percent' && dataMax <= 100
      ? Math.min(100, niceMax(dataMax * 1.1) || 100)
      : niceMax(dataMax * 1.1);
  const yMin = dataMin < 0 ? -niceMax(-dataMin) : 0;
  const x = (time: number) => PAD.left + ((time - viewFrom) / span) * PLOT_W;
  const y = (value: number) => PAD.top + PLOT_H - ((value - yMin) / (yMax - yMin || 1)) * PLOT_H;
  const gap = Math.max(stepSeconds * 3, 180);

  const path = (points: Point[]) => {
    let d = '';
    let last: number | null = null;
    for (const [time, value] of points) {
      d += `${last === null || time - last > gap ? 'M' : 'L'}${x(time).toFixed(1)},${y(value).toFixed(1)}`;
      last = time;
    }
    return d;
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => yMin + (yMax - yMin) * ratio);
  const timeTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => viewFrom + span * ratio);

  const timeAt = (clientX: number): number | null => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box?.width) return null;
    const px = ((clientX - box.left) / box.width) * WIDTH;
    const time = viewFrom + ((px - PAD.left) / PLOT_W) * span;
    return time < viewFrom || time > viewTo ? null : time;
  };
  const clampTime = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box?.width) return viewFrom;
    const px = ((clientX - box.left) / box.width) * WIDTH;
    const time = viewFrom + ((px - PAD.left) / PLOT_W) * span;
    return Math.max(viewFrom, Math.min(viewTo, time));
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const time = timeAt(event.clientX);
    if (time === null) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ start: time, end: time });
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (drag) setDrag({ ...drag, end: clampTime(event.clientX) });
    setHover(timeAt(event.clientX));
  };
  const onPointerUp = () => {
    if (drag && Math.abs(drag.end - drag.start) >= span * 0.01)
      setZoom(clampZoom(drag.start, drag.end, from, to, minSpan));
    setDrag(null);
  };

  const rows = (
    hover === null
      ? []
      : visible
          .map((series) => ({ series, point: nearest(series.points, hover, gap) }))
          .filter((row): row is { series: (typeof visible)[number]; point: Point } =>
            Boolean(row.point),
          )
  ).sort((a, b) => b.point[1] - a.point[1]);
  const cursor =
    hover === null
      ? null
      : rows.reduce<number>(
          (best, row) =>
            Math.abs(row.point[0] - hover) < Math.abs(best - hover) ? row.point[0] : best,
          rows[0]?.point[0] ?? hover,
        );
  const cursorPct = cursor === null ? 0 : (x(cursor) / WIDTH) * 100;
  const shownRows = rows.slice(0, MAX_TOOLTIP_ROWS);
  const tipLabels = splitCommonPrefix(shownRows.map(({ series }) => series.label));

  // Mede o tooltip depois de desenhado para o manter dentro do cartão.
  useLayoutEffect(() => {
    const tip = tipRef.current?.offsetWidth ?? 0;
    const plot = plotRef.current?.clientWidth ?? 0;
    setTipBox((current) =>
      current.tip === tip && current.plot === plot ? current : { tip, plot },
    );
  });
  const tooltipStyle = {
    left: `${tooltipLeft((cursorPct / 100) * tipBox.plot, tipBox.tip, tipBox.plot)}px`,
  };

  const toggle = (key: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const legend = chart.series.filter((series) => !series.previous);
  const zoomed = view !== null;

  return (
    <div className="health-chart-plot" ref={plotRef}>
      <div className="health-chart-toolbar">
        <span className="health-muted">
          {zoomed
            ? `${formatChartTime(viewFrom, loadedSpan, locale)} – ${formatChartTime(viewTo, loadedSpan, locale)}`
            : t(
                'Arraste no gráfico para ampliar um intervalo.',
                'Drag on the chart to zoom into a range.',
              )}
        </span>
        <div
          className="health-chart-zoom"
          role="group"
          aria-label={t('Zoom do gráfico', 'Chart zoom')}
        >
          {zoomed && (
            <>
              <button
                type="button"
                aria-label={t('Recuar no tempo', 'Go back in time')}
                title={t('Recuar no tempo', 'Go back in time')}
                disabled={viewFrom <= from}
                onClick={() => setZoom(panZoom([viewFrom, viewTo], -span / 2, from, to))}
              >
                ‹
              </button>
              <button
                type="button"
                aria-label={t('Avançar no tempo', 'Go forward in time')}
                title={t('Avançar no tempo', 'Go forward in time')}
                disabled={viewTo >= to}
                onClick={() => setZoom(panZoom([viewFrom, viewTo], span / 2, from, to))}
              >
                ›
              </button>
            </>
          )}
          <button
            type="button"
            aria-label={t('Aproximar', 'Zoom in')}
            title={t('Aproximar', 'Zoom in')}
            disabled={span <= minSpan}
            onClick={() => setZoom(scaleZoom([viewFrom, viewTo], 0.5, from, to, minSpan))}
          >
            +
          </button>
          <button
            type="button"
            aria-label={t('Afastar', 'Zoom out')}
            title={t('Afastar', 'Zoom out')}
            disabled={!zoomed}
            onClick={() => setZoom(scaleZoom([viewFrom, viewTo], 2, from, to, minSpan))}
          >
            −
          </button>
          <button type="button" disabled={!zoomed} onClick={() => setZoom(null)}>
            {t('Repor', 'Reset')}
          </button>
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${chart.title}: ${t('gráfico temporal', 'time series chart')}`}
        className={drag ? 'is-selecting' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => {
          if (!drag) setHover(null);
        }}
        onDoubleClick={() => setZoom(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top - 4} width={PLOT_W} height={PLOT_H + 8} />
          </clipPath>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="health-chart-grid"
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className="health-chart-axis" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">
              {formatChartValue(tick, chart.unit, locale)}
            </text>
          </g>
        ))}
        {timeTicks.map((tick, index) => (
          <text
            key={tick}
            className="health-chart-axis"
            x={x(tick)}
            y={HEIGHT - 6}
            textAnchor={index === 0 ? 'start' : index === timeTicks.length - 1 ? 'end' : 'middle'}
          >
            {formatChartTime(tick, span, locale)}
          </text>
        ))}
        {chart.warn !== null && chart.warn <= yMax && (
          <line
            className="health-chart-threshold is-warn"
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={y(chart.warn)}
            y2={y(chart.warn)}
          />
        )}
        {chart.crit !== null && chart.crit <= yMax && (
          <line
            className="health-chart-threshold is-crit"
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={y(chart.crit)}
            y2={y(chart.crit)}
          />
        )}
        <g clipPath={`url(#${clipId})`}>
          {[...markerGroups].map(([key, members]) => {
            const event = members[0]!;
            const count = members.reduce((total, member) => total + member.count, 0);
            return (
              <g
                key={`event:${key}`}
                className={`health-chart-event is-${event.kind}${event.planned ? ' is-planned' : ''}`}
                onPointerDown={(pointer) => pointer.stopPropagation()}
              >
                <title>
                  {members
                    .map((member) =>
                      [chartEventDescription(member, locale), eventScope(member)]
                        .filter(Boolean)
                        .join(' · '),
                    )
                    .join('\n')}
                </title>
                <line
                  x1={x(Date.parse(event.at) / 1000)}
                  x2={x(Date.parse(event.at) / 1000)}
                  y1={PAD.top}
                  y2={PAD.top + PLOT_H}
                />
                <circle
                  cx={x(Date.parse(event.at) / 1000)}
                  cy={PAD.top + (event.kind === 'email' ? 4 : event.kind === 'db2' ? 11 : 18)}
                  r={3}
                />
                {count > 1 && (
                  <text
                    x={x(Date.parse(event.at) / 1000) + 4}
                    y={PAD.top + 10}
                    className="health-chart-axis"
                  >
                    {count}
                  </text>
                )}
              </g>
            );
          })}
          {visible.map((series) => (
            <path
              key={series.key}
              d={path(series.points)}
              fill="none"
              stroke={colors.get(baseKey(series.key))}
              strokeWidth={series.previous ? 1.25 : 1.75}
              strokeDasharray={series.previous ? '5 4' : undefined}
              opacity={series.previous ? 0.7 : 1}
            />
          ))}
        </g>
        {drag && (
          <rect
            className="health-chart-selection"
            x={x(Math.min(drag.start, drag.end))}
            y={PAD.top}
            width={Math.abs(x(drag.end) - x(drag.start))}
            height={PLOT_H}
          />
        )}
        {cursor !== null && !drag && (
          <>
            <line
              className="health-chart-cursor"
              x1={x(cursor)}
              x2={x(cursor)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
            />
            {rows.map(({ series, point }) => (
              <circle
                key={series.key}
                className="health-chart-marker"
                cx={x(point[0])}
                cy={y(point[1])}
                r={3.5}
                fill={colors.get(baseKey(series.key))}
              />
            ))}
          </>
        )}
      </svg>
      {cursor !== null && !drag && rows.length > 0 && (
        <div className="health-chart-tooltip" style={tooltipStyle} ref={tipRef}>
          <strong>{formatChartTime(cursor, Math.min(span, 86400 * 2), locale)}</strong>
          {tipLabels.prefix && (
            <em className="health-chart-tooltip-prefix" title={tipLabels.prefix}>
              {tipLabels.prefix}
            </em>
          )}
          {shownRows.map(({ series, point }, index) => (
            <span key={series.key}>
              <i style={{ background: colors.get(baseKey(series.key)) }} />
              <span className="health-chart-tooltip-label" title={series.label}>
                {tipLabels.rest[index]}
              </span>
              <b>{formatChartValue(point[1], chart.unit, locale)}</b>
            </span>
          ))}
          {rows.length > MAX_TOOLTIP_ROWS && (
            <span className="health-muted">
              + {rows.length - MAX_TOOLTIP_ROWS} {t('séries', 'series')}
            </span>
          )}
        </div>
      )}
      <ul className="health-chart-legend">
        {legend.map((series) => {
          const off = hidden.has(series.key);
          return (
            <li key={series.key}>
              <button
                type="button"
                className={off ? 'is-off' : undefined}
                aria-pressed={!off}
                title={off ? t('Mostrar série', 'Show series') : t('Ocultar série', 'Hide series')}
                onClick={() => toggle(series.key)}
              >
                <i style={{ background: colors.get(series.key) }} />
                {series.label}
              </button>
            </li>
          );
        })}
        {chart.series.some((series) => series.previous) && (
          <li className="is-previous">- - {t('período anterior', 'previous period')}</li>
        )}
      </ul>
      <div className="health-chart-event-filters">
        {(['email', 'outage', 'planned'] as const).map((kind) => (
          <label key={kind} className={`health-chart-event-key is-${kind}`}>
            <input
              type="checkbox"
              checked={eventKinds[kind]}
              onChange={(event) =>
                setEventKinds((current) => ({ ...current, [kind]: event.target.checked }))
              }
            />
            {kind === 'email'
              ? t('Emails enviados', 'Sent emails')
              : kind === 'outage'
                ? t('Indisponibilidade observada', 'Observed unavailability')
                : t('Paragens planeadas', 'Planned downtime')}
          </label>
        ))}
      </div>
      <details className="health-chart-events-detail">
        <summary>
          {t('Eventos operacionais', 'Operational events')} (
          {visibleEvents.reduce((count, event) => count + event.count, 0)})
        </summary>
        <p className="health-muted">
          {t(
            'Hora observada pela sonda, não a hora exata da falha. Silêncio/ausência de métricas não prova indisponibilidade. SMTP não confirma chegada à caixa de correio.',
            'Time observed by the probe, not the exact failure time. Silence/missing metrics does not prove downtime. SMTP does not confirm inbox delivery.',
          )}
        </p>
        <ul>
          {visibleEvents.slice(0, eventPage).map((event) => (
            <li key={event.id}>
              {chartEventDescription(event, locale)}
              {eventScope(event) && <small> · {eventScope(event)}</small>}
            </li>
          ))}
        </ul>
        {visibleEvents.length > eventPage && (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setEventPage((page) => page + 25)}
          >
            {t('Mostrar mais eventos', 'Show more events')} ({visibleEvents.length - eventPage})
          </button>
        )}
        <a href="#health">{t('Abrir alertas da Saúde', 'Open Health alerts')}</a>
      </details>
    </div>
  );
}
