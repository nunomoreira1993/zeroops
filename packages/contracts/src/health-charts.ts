import { z } from 'zod';

/** Separadores da tab Gráficos da página Saúde. */
export const healthChartPanels = ['servers', 'web', 'mysql', 'redis', 'db2', 'sites'] as const;
export type HealthChartPanel = (typeof healthChartPanels)[number];

/**
 * `all` lê desde a primeira amostra ainda retida no Prometheus. Até 90 dias lê-se do
 * Prometheus; `395d` (13 meses) lê os agregados horários, com um ponto por dia.
 */
export const healthChartRanges = ['all', '1h', '6h', '24h', '7d', '30d', '90d', '395d'] as const;
export type HealthChartRange = (typeof healthChartRanges)[number];

export const healthChartEnvironments = ['production', 'quality'] as const;
export type HealthChartEnvironment = (typeof healthChartEnvironments)[number];

const chartResourceLabelsSchema = z.record(
  z.string().regex(/^(mountpoint|dsn|dtq|fstype)$/),
  z.string().max(2000),
);

export const healthChartAlertTargetSchema = z.strictObject({
  chartId: z.string().regex(/^[a-z0-9_]{1,80}$/),
  instance: z.string().min(1).max(2000),
  labels: chartResourceLabelsSchema.optional(),
});
export type HealthChartAlertTarget = z.infer<typeof healthChartAlertTargetSchema>;

/** Origem e recursos da ocorrencia, capturados antes de enfileirar a notificacao. */
export const healthNotificationChartContextSchema = z.strictObject({
  source: z.enum(['internal', 'prometheus']),
  key: z.string().min(1).max(2000),
  targets: z.array(healthChartAlertTargetSchema),
});
export type HealthNotificationChartContext = z.infer<typeof healthNotificationChartContextSchema>;

export type HealthChartUnit =
  'percent' | 'seconds' | 'bytes' | 'bytes_per_second' | 'per_second' | 'per_minute' | 'count';

const instanceSchema = z
  .string()
  .trim()
  .regex(/^[\w.:/-]{1,190}$/)
  .optional();

export const healthChartsQuerySchema = z.object({
  panel: z.enum(healthChartPanels).default('servers'),
  range: z.enum(healthChartRanges).default('24h'),
  env: z.enum(healthChartEnvironments).default('production'),
  instance: instanceSchema,
  chart: z
    .string()
    .regex(/^[a-z0-9_]{1,80}$/)
    .optional(),
  compare: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((value) => value === '1' || value === 'true'),
});
export type HealthChartsQuery = z.infer<typeof healthChartsQuerySchema>;

export interface HealthChartSeries {
  /** Identificador estável (legenda + período) para cores e chaves React. */
  key: string;
  label: string;
  /** Legenda em inglês (sem termos fixos em português); a interface usa `label` quando falta. */
  labelEn?: string;
  instance: string | null;
  /** `true` na série do período anterior (comparação). */
  previous: boolean;
  /** Pares [epoch segundos, valor]. */
  points: [number, number][];
}

export interface HealthChart {
  id: string;
  title: string;
  /** Versões em inglês (opcionais; a interface usa o texto em português quando faltam). */
  titleEn?: string;
  /** Categoria dentro do separador (ex.: «Utilização», «Armazenamento»), por ordem do catálogo. */
  group: string;
  groupEn?: string;
  description: string;
  descriptionEn?: string;
  unit: HealthChartUnit;
  /** Mostrar o último valor como cartão no topo do separador. */
  gauge: boolean;
  /** Limiares de aviso/crítico, desenhados como linhas horizontais (mesma unidade). */
  warn: number | null;
  crit: number | null;
  series: HealthChartSeries[];
  /** Erro da consulta (o separador continua a mostrar os restantes gráficos). */
  error: string | null;
  errorEn?: string | null;
}

export interface HealthChartInstance {
  instance: string;
  role: string | null;
}

/** Evento operacional; `at` é o instante observado, nunca a data de criação do ticket. */
export interface HealthChartEvent {
  id: string;
  kind: 'email' | 'http' | 'db2' | 'maintenance';
  environment?: HealthChartEnvironment | null;
  at: string;
  lastAt: string;
  count: number;
  resource: string | null;
  alertId?: string | null;
  alertContext?: HealthNotificationChartContext;
  planned: boolean;
  confirmedAt: string | null;
  recoveredAt: string | null;
  observationGap: boolean;
}

export interface HealthChartsResponse {
  panel: HealthChartPanel;
  range: HealthChartRange;
  environment: HealthChartEnvironment;
  source: 'prometheus' | 'rollup';
  from: string;
  to: string;
  /** Primeira amostra retida no período `all`; cada métrica pode começar mais tarde. */
  availableFrom?: string | null;
  stepSeconds: number;
  instances: HealthChartInstance[];
  charts: HealthChart[];
  events?: HealthChartEvent[];
  /** Motivo quando não há dados (integração Métricas por configurar, etc.). */
  unavailable: string | null;
  unavailableEn?: string | null;
}

/** Métricas com agregado horário (média, máximo e p95), base do mapa de calor e dos 13 meses. */
export const healthRollupMetrics = [
  'cpu',
  'memory',
  'disk',
  'inodes',
  'apache_busy',
  'fpm_busy',
  'mysql_connections',
  'mysql_ping',
  'redis_memory',
  'db2_cpu',
  'db2_asp',
  'site_availability',
  'site_latency',
] as const;
export type HealthRollupMetric = (typeof healthRollupMetrics)[number];

export const healthHeatmapQuerySchema = z.object({
  metric: z.enum(healthRollupMetrics).default('cpu'),
  env: z.enum(healthChartEnvironments).default('production'),
  instance: instanceSchema,
  days: z.coerce
    .number()
    .int()
    .refine((value) => [7, 28, 90].includes(value))
    .default(28),
});
export type HealthHeatmapQuery = z.infer<typeof healthHeatmapQuerySchema>;

export interface HealthHeatmapResponse {
  metric: HealthRollupMetric;
  title: string;
  titleEn?: string;
  unit: HealthChartUnit;
  environment: HealthChartEnvironment;
  instance: string | null;
  days: number;
  instances: string[];
  /** `cells[diaDaSemana][hora]`, segunda-feira = 0, hora de Lisboa; `null` sem dados. */
  cells: (number | null)[][];
  /** Média por dia do mês (1-31) no mesmo intervalo. */
  byMonthDay: (number | null)[];
  max: number | null;
  /** Limites da escala de cor (verde até `warn`, vermelho a partir de `crit`); `null` = escala relativa. */
  warn: number | null;
  crit: number | null;
  /** Valores altos são melhores (ex.: disponibilidade): a escala inverte. */
  higherIsBetter: boolean;
}
