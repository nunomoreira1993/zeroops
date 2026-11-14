import type {
  IncidentResource,
  RecoveryCriterion,
  ValidationSettings,
} from '../../../../contracts/src/index.js';
import type { PromSeries } from '../connectors/prometheus.connector.js';

/** Resultado de uma medição: `ok=null` quando não há dados para decidir. */
export interface RecoveryMeasurement {
  ok: boolean | null;
  detail: string;
}

export interface RecoveryProbeInput {
  projectId: string;
  environment: string;
  criterion: RecoveryCriterion;
  resource: IncidentResource;
  settings: ValidationSettings;
}

export interface RecoveryProbe {
  measure(input: RecoveryProbeInput): Promise<RecoveryMeasurement>;
}

/** Fontes de leitura usadas pela sonda (integrações do projeto; só leitura). */
export interface RecoveryProbeSources {
  prometheus(
    projectId: string,
    environment: string,
  ): Promise<{ query(promql: string): Promise<PromSeries[]> } | null>;
  database(
    projectId: string,
    environment: string,
  ): Promise<{ query(sql: string): Promise<unknown>; close(): Promise<void> } | null>;
  fetch?: typeof fetch;
  httpTimeoutMs?: number;
}

const NO_DATA: RecoveryMeasurement = { ok: null, detail: 'Sem dados para este critério.' };

/** Filtro PromQL do host (`instance` com ou sem porta). */
function hostMatcher(resource: IncidentResource) {
  if (!resource.host) return '';
  const escaped = resource.host.replace(/[\\.*+?^${}()|[\]"]/g, (char) => `\\\\${char}`);
  return `instance=~"${escaped}(:[0-9]+)?"`;
}

const join = (...parts: string[]) => parts.filter(Boolean).join(',');

function firstValue(series: PromSeries[]) {
  const point = series[0]?.points.at(-1);
  return point && Number.isFinite(point[1]) ? point[1] : null;
}

const pct = (value: number) => `${value.toFixed(1)}%`;

/**
 * Sonda que confirma a recuperação a partir da falha observada: espaço livre, memória
 * disponível, carga por núcleo, serviço systemd ativo, query segura à BD ou HTTP visível ao
 * utilizador. Erros de leitura contam como «sem dados» (nunca como recuperado).
 */
export class IntegrationRecoveryProbe implements RecoveryProbe {
  constructor(private readonly sources: RecoveryProbeSources) {}

  async measure(input: RecoveryProbeInput): Promise<RecoveryMeasurement> {
    try {
      switch (input.criterion) {
        case 'disk_free':
          return await this.diskFree(input);
        case 'memory_pressure':
          return await this.memory(input);
        case 'cpu_load':
          return await this.cpu(input);
        case 'service_active':
          return await this.service(input);
        case 'database_query':
          return await this.database(input);
        case 'http_check':
          return await this.http(input);
        default:
          return NO_DATA;
      }
    } catch (error) {
      return {
        ok: null,
        detail: `Leitura falhou (${error instanceof Error ? error.name : 'erro'}).`,
      };
    }
  }

  private async promValue(input: RecoveryProbeInput, promql: string) {
    const prometheus = await this.sources.prometheus(input.projectId, input.environment);
    if (!prometheus) return undefined;
    return firstValue(await prometheus.query(promql));
  }

  private async diskFree(input: RecoveryProbeInput): Promise<RecoveryMeasurement> {
    const filter = join('fstype!~"tmpfs|overlay|squashfs|devtmpfs"', hostMatcher(input.resource));
    const value = await this.promValue(
      input,
      `min(100 * node_filesystem_avail_bytes{${filter}} / node_filesystem_size_bytes{${filter}})`,
    );
    if (value === undefined || value === null) return NO_DATA;
    const limit = input.settings.diskFreePercent;
    return { ok: value >= limit, detail: `Espaço livre mínimo ${pct(value)} (limite ${limit}%).` };
  }

  private async memory(input: RecoveryProbeInput): Promise<RecoveryMeasurement> {
    const filter = hostMatcher(input.resource);
    const value = await this.promValue(
      input,
      `min(100 * node_memory_MemAvailable_bytes{${filter}} / node_memory_MemTotal_bytes{${filter}})`,
    );
    if (value === undefined || value === null) return NO_DATA;
    const limit = input.settings.memoryAvailablePercent;
    return {
      ok: value >= limit,
      detail: `Memória disponível ${pct(value)} (limite ${limit}%).`,
    };
  }

  private async cpu(input: RecoveryProbeInput): Promise<RecoveryMeasurement> {
    const filter = hostMatcher(input.resource);
    const value = await this.promValue(
      input,
      `max(node_load5{${filter}} / on(instance) count by(instance)(node_cpu_seconds_total{${join('mode="idle"', filter)}}))`,
    );
    if (value === undefined || value === null) return NO_DATA;
    const limit = input.settings.cpuLoadPerCore;
    return {
      ok: value <= limit,
      detail: `Carga a 5 min por núcleo ${value.toFixed(2)} (limite ${limit}).`,
    };
  }

  private async service(input: RecoveryProbeInput): Promise<RecoveryMeasurement> {
    const unit = input.resource.unit;
    if (!unit) return NO_DATA;
    const value = await this.promValue(
      input,
      `max(node_systemd_unit_state{${join(`name="${unit}"`, 'state="active"', hostMatcher(input.resource))}})`,
    );
    if (value === undefined || value === null) return NO_DATA;
    return { ok: value === 1, detail: `${unit} ${value === 1 ? 'ativo' : 'inativo'}.` };
  }

  private async database(input: RecoveryProbeInput): Promise<RecoveryMeasurement> {
    if (input.resource.engine === 'db2') {
      const value = await this.promValue(input, 'max(zeroops_db2_up)');
      if (value === undefined || value === null) return NO_DATA;
      return {
        ok: value === 1,
        detail: `DB2: SELECT 1 FROM SYSIBM.SYSDUMMY1 ${value === 1 ? 'responde' : 'falha'} (exportador).`,
      };
    }
    const database = await this.sources.database(input.projectId, input.environment);
    if (!database) return NO_DATA;
    try {
      await database.query('SELECT 1');
      return { ok: true, detail: 'Query de leitura SELECT 1 à base de dados respondeu.' };
    } catch (error) {
      return {
        ok: false,
        detail: `Query de leitura SELECT 1 falhou (${error instanceof Error ? error.name : 'erro'}).`,
      };
    } finally {
      await database.close().catch(() => undefined);
    }
  }

  private async http(input: RecoveryProbeInput): Promise<RecoveryMeasurement> {
    const url = input.settings.httpUrl;
    if (!url) return NO_DATA;
    const request = this.sources.fetch ?? fetch;
    try {
      const response = await request(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.sources.httpTimeoutMs ?? 8000),
      });
      return {
        ok: response.status < 400,
        detail: `GET ${url} respondeu HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `GET ${url} sem resposta (${error instanceof Error ? error.name : 'erro'}).`,
      };
    }
  }
}
