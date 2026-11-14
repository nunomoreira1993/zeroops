import type {
  HealthChartAlertTarget,
  HealthSettings,
  HealthStatus,
} from '../../../../../contracts/src/index.js';

export interface CheckResult {
  checkId: string;
  status: HealthStatus;
  value: number | null;
  unit: string | null;
  summary: string;
  details?: Record<string, unknown>;
  /** Apenas medidas que causaram o alerta, com recurso identificado na recolha. */
  chartTargets?: HealthChartAlertTarget[];
}

export interface PreviousCheckState {
  value: number | null;
  details: Record<string, unknown> | null;
}

export interface CollectorContext {
  projectId: string;
  settings: HealthSettings;
  now: Date;
  /** Ultimo estado guardado de uma verificacao (para calcular deltas entre ciclos). */
  previous(checkId: string): PreviousCheckState | undefined;
}

/**
 * Fonte de dados de um conjunto de verificacoes. Se `collect` falhar, o monitor marca todas as
 * verificacoes declaradas em `checks` como `unknown` com o codigo do erro.
 */
export interface HealthCollector {
  readonly name: string;
  readonly checks: readonly string[];
  /** Recolhe cada verificação declarada; falhas da fonte são convertidas pelo monitor em `unknown`. */
  collect(context: CollectorContext): Promise<CheckResult[]>;
}

/** Cria resultado sem dados, distinguindo falha/ausência de fonte de um estado saudável. */
export function unknown(
  checkId: string,
  summary: string,
  details?: Record<string, unknown>,
): CheckResult {
  return { checkId, status: 'unknown', value: null, unit: null, summary, details };
}

/** Estado para um valor em que "mais alto e pior": warning acima do limite, critical acima de `criticalFactor` vezes. */
export function above(value: number, limit: number, criticalFactor = 1.5): HealthStatus {
  if (value >= limit * criticalFactor) return 'critical';
  if (value >= limit) return 'warning';
  return 'ok';
}

/** Estado para um valor em que "mais baixo e pior" (ex.: % livre). */
export function below(value: number, limit: number, criticalFactor = 0.5): HealthStatus {
  if (value <= limit * criticalFactor) return 'critical';
  if (value <= limit) return 'warning';
  return 'ok';
}

const RANK: Record<HealthStatus, number> = { ok: 0, unknown: 1, warning: 2, critical: 3 };
/** Devolve o estado mais severo, mantendo a ordenação explícita do domínio. */
export function worst(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>((acc, item) => (RANK[item] > RANK[acc] ? item : acc), 'ok');
}

/** Arredonda uma métrica ao número de casas decimais indicado. */
export function round(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Extrai um código técnico estável sem serializar mensagens ou dados potencialmente sensíveis. */
export function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code;
  return error instanceof Error ? error.name : 'UnknownError';
}
