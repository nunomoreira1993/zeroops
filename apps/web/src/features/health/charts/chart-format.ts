import type {
  HealthChart,
  HealthChartEvent,
  HealthChartInstance,
  HealthChartPanel,
  HealthChartRange,
  HealthChartUnit,
  HealthRollupMetric,
} from '@zeroops/contracts';
import type { Locale } from '../../../lib/identity';

/** Texto nas duas línguas da interface. */
export type LocalizedText = Record<Locale, string>;

/** Locale do `Intl` para números e datas. */
export const intlLocale = (locale: Locale) => (locale === 'en' ? 'en-GB' : 'pt-PT');

/** Datas completas no fuso das paragens, sem perder segundos nos periodos agregados. */
export function chartEventDescription(event: HealthChartEvent, locale: Locale) {
  const date = (value: string) =>
    new Intl.DateTimeFormat(intlLocale(locale), {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone: 'Europe/Lisbon',
    }).format(new Date(value));
  const pt = locale !== 'en';
  const title =
    event.kind === 'email'
      ? pt
        ? 'Email de alerta enviado (aceite pelo SMTP)'
        : 'Alert email sent (accepted by SMTP)'
      : event.kind === 'maintenance'
        ? pt
          ? 'Janela planeada registada, sem comprovar falha'
          : 'Recorded planned window, not proof of failure'
        : event.kind === 'db2'
          ? pt
            ? 'Compras: falha da sonda funcional DB2'
            : 'Purchases: functional DB2 probe failure'
          : pt
            ? 'Falha da sonda HTTP do site/app'
            : 'Site/app HTTP probe failure';
  return [
    title,
    date(event.at),
    event.count > 1
      ? `${event.count} ${pt ? 'emails agrupados, até' : 'grouped emails, until'} ${date(event.lastAt)}`
      : '',
    event.resource ?? '',
    event.alertContext
      ? `${pt ? 'Regra/verificação' : 'Rule/check'}: ${event.alertContext.key}`
      : '',
    event.environment === null
      ? pt
        ? 'Ambiente histórico não registado: contexto geral do projeto'
        : 'Historical environment not recorded: project context'
      : '',
    event.kind === 'maintenance' && event.lastAt !== event.at
      ? `${pt ? 'Último registo da janela em' : 'Window last recorded at'} ${date(event.lastAt)}`
      : '',
    event.planned ? (pt ? 'Dentro de paragem planeada' : 'Within planned downtime') : '',
    event.confirmedAt ? `${pt ? 'Confirmado em' : 'Confirmed at'} ${date(event.confirmedAt)}` : '',
    event.recoveredAt
      ? `${pt ? 'Recuperação observada em' : 'Recovery observed at'} ${date(event.recoveredAt)}`
      : '',
    event.observationGap
      ? pt
        ? 'Continuidade desconhecida: houve intervalo sem observação'
        : 'Unknown continuity: observation gap'
      : '',
    pt ? 'Hora de Lisboa' : 'Lisbon time',
  ]
    .filter(Boolean)
    .join(' · ');
}

export const PANEL_LABELS: Record<HealthChartPanel, LocalizedText> = {
  servers: { 'pt-PT': 'Servidores', en: 'Servers' },
  web: { 'pt-PT': 'Apache e PHP', en: 'Apache and PHP' },
  mysql: { 'pt-PT': 'MySQL', en: 'MySQL' },
  redis: { 'pt-PT': 'Redis', en: 'Redis' },
  db2: { 'pt-PT': 'DB2 (IBM i) e DTQ', en: 'DB2 (IBM i) and DTQ' },
  sites: { 'pt-PT': 'Sites e APIs', en: 'Sites and APIs' },
};

export const RANGE_LABELS: Record<HealthChartRange, LocalizedText> = {
  all: { 'pt-PT': 'Todo o histórico', en: 'All available history' },
  '1h': { 'pt-PT': '1 hora', en: '1 hour' },
  '6h': { 'pt-PT': '6 horas', en: '6 hours' },
  '24h': { 'pt-PT': '24 horas', en: '24 hours' },
  '7d': { 'pt-PT': '7 dias', en: '7 days' },
  '30d': { 'pt-PT': '30 dias', en: '30 days' },
  '90d': { 'pt-PT': '90 dias', en: '90 days' },
  '395d': { 'pt-PT': '13 meses', en: '13 months' },
};

export const COMPACT_RANGE_LABELS: Record<HealthChartRange, LocalizedText> = {
  all: { 'pt-PT': 'Tudo', en: 'All' },
  '1h': { 'pt-PT': '1 h', en: '1 h' },
  '6h': { 'pt-PT': '6 h', en: '6 h' },
  '24h': { 'pt-PT': '24 h', en: '24 h' },
  '7d': { 'pt-PT': '7 d', en: '7 d' },
  '30d': { 'pt-PT': '30 d', en: '30 d' },
  '90d': { 'pt-PT': '90 d', en: '90 d' },
  '395d': { 'pt-PT': '395 d', en: '395 d' },
};

export const ROLE_LABELS: Record<string, LocalizedText> = {
  db: { 'pt-PT': 'Backend e BD', en: 'Backend and DB' },
  backend: { 'pt-PT': 'Backend', en: 'Backend' },
  frontend: { 'pt-PT': 'Frontend', en: 'Frontend' },
  static: { 'pt-PT': 'Static', en: 'Static' },
  qa: { 'pt-PT': 'Qualidade (dev)', en: 'Quality (dev)' },
};

/** Nome do papel do servidor; papéis desconhecidos mostram-se tal como vêm. */
export function roleLabel(role: string, locale: Locale = 'pt-PT'): string {
  return ROLE_LABELS[role]?.[locale] ?? role;
}

/** Ordem de apresentação dos servidores (do mais crítico para o menos). */
const ROLE_ORDER = ['db', 'backend', 'frontend', 'static', 'qa'];

/** Instâncias do ambiente ordenadas por papel e depois por nome. */
export function sortInstances<T extends HealthChartInstance>(instances: T[]): T[] {
  const rank = (role: string | null) => {
    const index = ROLE_ORDER.indexOf(role ?? '');
    return index === -1 ? ROLE_ORDER.length : index;
  };
  return [...instances].sort(
    (a, b) => rank(a.role) - rank(b.role) || a.instance.localeCompare(b.instance),
  );
}

/** «Backend e BD · uqphorders22-db» quando o papel é conhecido; senão o próprio nome. */
export function instanceLabel(
  instance: string,
  roles: Map<string, string | null>,
  locale: Locale = 'pt-PT',
): string {
  const role = roles.get(instance);
  return role ? `${roleLabel(role, locale)} · ${instance}` : instance;
}

/** Título, categoria, descrição e legendas na língua da interface (português quando falta). */
export function localizeChart(chart: HealthChart, locale: Locale): HealthChart {
  if (locale !== 'en') return chart;
  return {
    ...chart,
    title: chart.titleEn || chart.title,
    group: chart.groupEn || chart.group,
    description: chart.descriptionEn || chart.description,
    series: chart.series.map((series) => ({ ...series, label: series.labelEn || series.label })),
  };
}

/** Gráficos agrupados pela categoria, na ordem em que aparecem no catálogo. */
export function groupCharts(charts: HealthChart[]): { group: string; charts: HealthChart[] }[] {
  const groups = new Map<string, HealthChart[]>();
  for (const chart of charts) groups.set(chart.group, [...(groups.get(chart.group) ?? []), chart]);
  return [...groups].map(([group, items]) => ({ group, charts: items }));
}

/** Legendas com o papel do servidor (ex.: «Frontend · uqphorders21-web»). */
export function withInstanceLabels(
  chart: HealthChart,
  roles: Map<string, string | null>,
  locale: Locale = 'pt-PT',
): HealthChart {
  return {
    ...chart,
    series: chart.series.map((series) =>
      series.instance && roles.get(series.instance)
        ? {
            ...series,
            label: series.label.replace(
              series.instance,
              instanceLabel(series.instance, roles, locale),
            ),
          }
        : series,
    ),
  };
}

export const HEATMAP_METRICS: Record<HealthRollupMetric, LocalizedText> = {
  cpu: { 'pt-PT': 'CPU', en: 'CPU' },
  memory: { 'pt-PT': 'Memória', en: 'Memory' },
  disk: { 'pt-PT': 'Disco', en: 'Disk' },
  inodes: { 'pt-PT': 'Inodes', en: 'Inodes' },
  apache_busy: { 'pt-PT': 'Workers Apache ocupados', en: 'Busy Apache workers' },
  fpm_busy: { 'pt-PT': 'Processos PHP-FPM ativos', en: 'Active PHP-FPM processes' },
  mysql_connections: { 'pt-PT': 'Ligações MySQL', en: 'MySQL connections' },
  mysql_ping: { 'pt-PT': 'Resposta MySQL', en: 'MySQL response' },
  redis_memory: { 'pt-PT': 'Memória Redis', en: 'Redis memory' },
  db2_cpu: { 'pt-PT': 'CPU DB2', en: 'DB2 CPU' },
  db2_asp: { 'pt-PT': 'Disco (ASP) DB2', en: 'DB2 disk (ASP)' },
  site_availability: { 'pt-PT': 'Disponibilidade dos sites', en: 'Site availability' },
  site_latency: { 'pt-PT': 'Tempo de resposta dos sites', en: 'Site response time' },
};

/** Dias da semana do mapa de calor, segunda-feira primeiro. */
export const HEATMAP_WEEKDAYS: Record<Locale, string[]> = {
  'pt-PT': ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};

/**
 * Separa o início comum das legendas («Frontend · uqphorders21-web · recebido» e
 * «… · enviado» → «Frontend · uqphorders21-web» + «recebido»/«enviado»), para o tooltip
 * mostrar o servidor uma só vez.
 */
export function splitCommonPrefix(labels: string[]): { prefix: string; rest: string[] } {
  const parts = labels.map((label) => label.split(' · '));
  if (parts.length < 2) return { prefix: '', rest: labels };
  let shared = 0;
  const shortest = Math.min(...parts.map((items) => items.length));
  while (shared < shortest - 1 && parts.every((items) => items[shared] === parts[0]![shared]))
    shared += 1;
  if (!shared) return { prefix: '', rest: labels };
  return {
    prefix: parts[0]!.slice(0, shared).join(' · '),
    rest: parts.map((items) => items.slice(shared).join(' · ')),
  };
}

/**
 * Posição horizontal do tooltip (px a partir da esquerda do gráfico): ao lado do cursor,
 * do lado onde cabe, e nunca fora do cartão.
 */
export function tooltipLeft(cursorPx: number, tipWidth: number, plotWidth: number, gap = 14) {
  if (cursorPx + gap + tipWidth <= plotWidth) return cursorPx + gap;
  if (cursorPx - gap - tipWidth >= 0) return cursorPx - gap - tipWidth;
  return Math.max(0, plotWidth - tipWidth);
}

/** Menor e maior valor conhecidos, para a escala de cor do mapa de calor. */
export function heatmapRange(values: (number | null)[]): { min: number; max: number } | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!known.length) return null;
  return { min: Math.min(...known), max: Math.max(...known) };
}

export interface HeatmapScale {
  /** Cor da célula; `undefined` sem valor. */
  color: (value: number | null) => string | undefined;
  /** Intervalo mostrado na legenda. */
  domain: { min: number; max: number };
  /** Limites marcados na legenda (`null` na escala relativa). */
  warn: number | null;
  crit: number | null;
  absolute: boolean;
}

const hsl = (hue: number) => `hsl(${Math.round(hue)}, 70%, 46%)`;

/**
 * Escala de cor do mapa de calor. Com limites, é absoluta: verde até ao aviso, amarelo → laranja
 * até ao crítico e vermelho só a partir do crítico (o máximo do período não fica vermelho se não
 * chegou ao limite). Sem limites, verde → vermelho entre o mínimo e o máximo do período.
 */
export function heatmapScale(
  limits: { warn: number | null; crit: number | null; higherIsBetter: boolean },
  range: { min: number; max: number } | null,
  unit: HealthChartUnit,
): HeatmapScale {
  const { warn, crit, higherIsBetter } = limits;
  if (warn !== null && crit !== null && warn !== crit) {
    const best = higherIsBetter ? 100 : 0;
    // «Distância» ao melhor valor: cresce no sentido do pior, em qualquer tipo de métrica.
    const away = (value: number) => (higherIsBetter ? best - value : value - best);
    const w = away(warn);
    const c = away(crit);
    const color = (value: number | null) => {
      if (value === null || !Number.isFinite(value)) return undefined;
      const d = Math.max(0, away(value));
      if (d <= w) return hsl(120 - (30 * d) / w);
      if (d < c) return hsl(60 - (40 * (d - w)) / (c - w));
      return hsl(0);
    };
    const domain = higherIsBetter
      ? { min: Math.min(range?.min ?? crit, crit - (best - crit)), max: best }
      : {
          min: 0,
          max:
            unit === 'percent' ? 100 : Math.max(crit * 1.25, Math.min(range?.max ?? 0, crit * 3)),
        };
    return { color, domain, warn, crit, absolute: true };
  }
  const domain = range ?? { min: 0, max: 1 };
  const color = (value: number | null) => {
    if (value === null || !range) return undefined;
    const span = range.max - range.min;
    let ratio = span > 0 ? (value - range.min) / span : 0;
    if (higherIsBetter) ratio = 1 - ratio;
    return hsl(120 * (1 - Math.max(0, Math.min(1, ratio))));
  };
  return { color, domain, warn: null, crit: null, absolute: false };
}

/** Posição (0–100 %) de um valor no domínio da legenda. */
export function heatmapLegendPosition(value: number, domain: { min: number; max: number }) {
  const span = domain.max - domain.min;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(100, ((value - domain.min) / span) * 100));
}

/** Gradiente da legenda, amostrado da própria escala (mínimo → máximo do domínio). */
export function heatmapLegendGradient(scale: HeatmapScale): string {
  const { min, max } = scale.domain;
  const stops = Array.from({ length: 21 }, (_, index) => {
    const value = min + ((max - min) * index) / 20;
    return `${scale.color(value) ?? 'transparent'} ${index * 5}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Paleta com contraste suficiente em fundo claro. */
export const SERIES_COLORS = [
  '#175cd3',
  '#c4320a',
  '#067647',
  '#6941c6',
  '#b54708',
  '#0e7090',
  '#c11574',
  '#475467',
];

const number = (value: number, digits: number, locale: Locale) =>
  value.toLocaleString(intlLocale(locale), { maximumFractionDigits: digits });

const scaled = (value: number, base: number, units: string[], locale: Locale) => {
  let index = 0;
  let current = Math.abs(value);
  while (current >= base && index < units.length - 1) {
    current /= base;
    index += 1;
  }
  return `${number(Math.sign(value) * current, current < 10 ? 1 : 0, locale)} ${units[index]}`;
};

/** Formata um valor na unidade do gráfico, na língua da interface (português por omissão). */
export function formatChartValue(
  value: number | null | undefined,
  unit: HealthChartUnit,
  locale: Locale = 'pt-PT',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'percent':
      return `${number(value, value < 10 ? 1 : 0, locale)}%`;
    case 'seconds':
      return value < 1 ? `${number(value * 1000, 0, locale)} ms` : `${number(value, 2, locale)} s`;
    case 'bytes':
      return scaled(value, 1024, ['B', 'KB', 'MB', 'GB', 'TB'], locale);
    case 'bytes_per_second':
      return `${scaled(value, 1024, ['B', 'KB', 'MB', 'GB'], locale)}/s`;
    case 'per_second':
      return `${number(value, value < 10 ? 2 : 0, locale)}/s`;
    case 'per_minute':
      return `${number(value, value < 10 ? 1 : 0, locale)}/min`;
    default:
      return number(value, value < 10 ? 1 : 0, locale);
  }
}

/** Data curta para eixos e tooltips, ajustada ao intervalo visível (hora de Lisboa). */
export function formatChartTime(
  epochSeconds: number,
  spanSeconds: number,
  locale: Locale = 'pt-PT',
): string {
  const options: Intl.DateTimeFormatOptions =
    spanSeconds <= 86400
      ? { hour: '2-digit', minute: '2-digit' }
      : spanSeconds <= 31 * 86400
        ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
        : { day: '2-digit', month: 'short', year: '2-digit' };
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...options,
    timeZone: 'Europe/Lisbon',
  }).format(epochSeconds * 1000);
}

/** Janela temporal mínima de zoom: 2 pontos de recolha ou 2 minutos. */
export function minZoomSpan(stepSeconds: number): number {
  return Math.max(stepSeconds * 2, 120);
}

/**
 * Normaliza uma janela de zoom ao período carregado. Devolve `null` quando cobre todo o
 * período (sem zoom) e garante uma largura mínima centrada no ponto pedido.
 */
export function clampZoom(
  start: number,
  end: number,
  from: number,
  to: number,
  minSpan: number,
): [number, number] | null {
  let a = Math.max(from, Math.min(start, end));
  let b = Math.min(to, Math.max(start, end));
  const width = Math.min(Math.max(b - a, minSpan), to - from);
  if (b - a < width) {
    const center = (a + b) / 2;
    a = Math.max(from, Math.min(center - width / 2, to - width));
    b = a + width;
  }
  return a <= from && b >= to ? null : [a, b];
}

/** Afasta (factor > 1) ou aproxima (factor < 1) a janela à volta do centro. */
export function scaleZoom(
  view: [number, number],
  factor: number,
  from: number,
  to: number,
  minSpan: number,
): [number, number] | null {
  const center = (view[0] + view[1]) / 2;
  const half = ((view[1] - view[0]) * factor) / 2;
  let a = center - half;
  let b = center + half;
  if (a < from) [a, b] = [from, b + (from - a)];
  if (b > to) [a, b] = [a - (b - to), to];
  return clampZoom(a, b, from, to, minSpan);
}

/** Desloca a janela no tempo sem sair do período carregado. */
export function panZoom(
  view: [number, number],
  delta: number,
  from: number,
  to: number,
): [number, number] {
  const width = view[1] - view[0];
  const a = Math.max(from, Math.min(view[0] + delta, to - width));
  return [a, a + width];
}
