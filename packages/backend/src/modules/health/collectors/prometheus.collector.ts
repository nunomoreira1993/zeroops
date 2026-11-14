import type { HealthSettings, HealthStatus } from '../../../../../contracts/src/index.js';
import type { PromSeries } from '../../connectors/prometheus.connector.js';
import {
  above,
  below,
  errorCode,
  round,
  unknown,
  worst,
  type CheckResult,
  type CollectorContext,
  type HealthCollector,
} from './collector.js';

export interface PrometheusQueries {
  query(promql: string): Promise<PromSeries[]>;
}

export type PrometheusSource = (
  projectId: string,
  environment: HealthSettings['sourceEnvironment'],
) => Promise<PrometheusQueries | null>;

/**
 * Discos reais. As partilhas NFS servidas pelos próprios servidores (rede interna 172.16.1.x, ex.:
 * a pasta `log` do backend montada no 21-web) ficam de fora: o disco de origem já é medido e
 * contá-las duplicava o alarme. Partilhas de servidores externos (ex.: `/mnt/backup`) continuam.
 */
const REAL_FS = 'fstype!~"tmpfs|devtmpfs|overlay|squashfs|nsfs|ramfs",device!~"172[.]16[.]1[.].*"';

/** Expressões PromQL de cada verificação; os matchers do ambiente são acrescentados pelo conector. */
export const PROMETHEUS_QUERIES = {
  diskFree: `node_filesystem_avail_bytes{${REAL_FS}} / node_filesystem_size_bytes{${REAL_FS}} * 100`,
  inodeFree: `node_filesystem_files_free{${REAL_FS}} / node_filesystem_files{${REAL_FS}} * 100`,
  loadPerCore: 'node_load5 / on(instance) count by(instance)(node_cpu_seconds_total{mode="idle"})',
  memoryUsed: '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100',
  up: 'up',
  redis: 'redis_up',
} as const;

const PROMETHEUS_CHECKS = [
  'server-service',
  'disk-space',
  'inodes',
  'cpu-memory',
  'redis',
] as const;

interface Sample {
  instance: string;
  label: string;
  value: number;
  resource: string | null;
  fstype: string | null;
}

function samples(series: PromSeries[], label?: string): Sample[] {
  return series.flatMap((item) => {
    const value = item.points.at(-1)?.[1];
    if (value === undefined || !Number.isFinite(value)) return [];
    const instance = item.labels.instance ?? item.labels.job ?? 'prometheus';
    return [
      {
        instance,
        label: label ? (item.labels[label] ?? instance) : instance,
        value,
        resource: item.labels.instance ?? null,
        fstype: item.labels.fstype ?? null,
      },
    ];
  });
}

/**
 * Verificações do servidor a partir do Prometheus (node/redis exporters). Sem integração
 * "Métricas" verificada, ou sem séries para uma métrica, o resultado é `unknown`.
 */
export class PrometheusCollector implements HealthCollector {
  readonly name = 'prometheus';
  readonly checks = PROMETHEUS_CHECKS;

  constructor(private readonly open: PrometheusSource) {}

  /** Avalia as verificações a partir das métricas do Prometheus do ambiente configurado. */
  async collect(context: CollectorContext): Promise<CheckResult[]> {
    const source = await this.open(context.projectId, context.settings.sourceEnvironment);
    if (!source)
      return this.checks.map((id) =>
        unknown(id, 'Integração "Métricas" (Prometheus) não verificada.'),
      );
    const read = async (promql: string) => {
      try {
        return { series: await source.query(promql) };
      } catch (error) {
        return { error: errorCode(error) };
      }
    };
    const [diskFree, inodeFree, load, memory, up, redis] = await Promise.all(
      Object.values(PROMETHEUS_QUERIES).map(read),
    );
    const t = context.settings.thresholds;
    return [
      this.services(up!),
      this.lowest('disk-space', diskFree!, t.diskFreePercent, 'espaço livre'),
      this.lowest('inodes', inodeFree!, t.inodeFreePercent, 'inodes livres'),
      this.cpuMemory(load!, memory!, t.cpuLoadPerCore, t.memoryUsedPercent),
      this.redis(redis!),
    ];
  }

  private services(read: Read): CheckResult {
    const found = this.samplesOf('server-service', read, 'job');
    if (!Array.isArray(found)) return found;
    const down = found.filter((item) => item.value === 0);
    return {
      checkId: 'server-service',
      status: down.length ? 'critical' : 'ok',
      value: down.length,
      unit: 'alvos em baixo',
      summary: down.length
        ? `Sem resposta do Prometheus: ${down.map((item) => `${item.label}@${item.instance}`).join(', ')}.`
        : `${found.length} alvos monitorizados respondem.`,
      details: { targets: found.map((item) => ({ ...item, up: item.value === 1 })) },
    };
  }

  private lowest(checkId: string, read: Read, limit: number, label: string): CheckResult {
    const found = this.samplesOf(checkId, read, 'mountpoint');
    if (!Array.isArray(found)) return found;
    const free = found.map((item) => ({ ...item, value: round(item.value) }));
    const min = free.reduce((acc, item) => (item.value < acc.value ? item : acc));
    return {
      checkId,
      status: below(min.value, limit),
      value: min.value,
      unit: '% livre',
      summary: `Menor ${label}: ${min.label} em ${min.instance} com ${min.value}% (limite ${limit}%).`,
      details: {
        disks: free.map((item) => ({
          instance: item.instance,
          mount: item.label,
          free: item.value,
        })),
      },
      chartTargets: free.flatMap((item) => {
        if (below(item.value, limit) === 'ok' || !item.resource || !item.fstype) return [];
        const network = ['nfs', 'nfs4', 'cifs', 'smbfs', 'fuse.sshfs'].includes(item.fstype);
        if (network && checkId === 'inodes') return [];
        return [
          {
            chartId: network ? 'network_fs' : checkId === 'inodes' ? 'inodes' : 'disk',
            instance: item.resource,
            labels: { mountpoint: item.label, fstype: item.fstype },
          },
        ];
      }),
    };
  }

  private cpuMemory(load: Read, memory: Read, loadLimit: number, memoryLimit: number): CheckResult {
    const loads = 'series' in load ? samples(load.series) : [];
    const memories = 'series' in memory ? samples(memory.series) : [];
    if (!loads.length && !memories.length)
      return unknown(
        'cpu-memory',
        'O Prometheus não tem métricas de CPU/memória (node_exporter).',
        {
          error: 'error' in load ? load.error : 'error' in memory ? memory.error : 'NO_SERIES',
        },
      );
    const maxOf = (items: Sample[]) =>
      items.length ? items.reduce((acc, item) => (item.value > acc.value ? item : acc)) : null;
    const topLoad = maxOf(loads);
    const topMemory = maxOf(memories);
    const loadPerCore = topLoad ? round(topLoad.value, 2) : null;
    const memoryUsed = topMemory ? round(topMemory.value) : null;
    const status: HealthStatus = worst([
      loadPerCore === null ? 'ok' : above(loadPerCore, loadLimit),
      memoryUsed === null
        ? 'ok'
        : above(memoryUsed, memoryLimit, Math.min(100 / memoryLimit, 1.06)),
    ]);
    return {
      checkId: 'cpu-memory',
      status,
      value: memoryUsed,
      unit: '% memória',
      summary: `Carga/core (5 min): ${loadPerCore ?? '-'}${topLoad ? ` em ${topLoad.instance}` : ''} (limite ${loadLimit}); memória usada: ${memoryUsed ?? '-'}%${topMemory ? ` em ${topMemory.instance}` : ''} (limite ${memoryLimit}%).`,
      details: { loadPerCore, memoryUsed, loads, memories },
      chartTargets: [
        ...loads.flatMap((item) =>
          item.resource && above(round(item.value, 2), loadLimit) !== 'ok'
            ? [{ chartId: 'load', instance: item.resource }]
            : [],
        ),
        ...memories.flatMap((item) =>
          item.resource &&
          above(round(item.value), memoryLimit, Math.min(100 / memoryLimit, 1.06)) !== 'ok'
            ? [{ chartId: 'memory', instance: item.resource }]
            : [],
        ),
      ],
    };
  }

  private redis(read: Read): CheckResult {
    const found = this.samplesOf('redis', read);
    if (!Array.isArray(found)) return found;
    const down = found.filter((item) => item.value !== 1);
    return {
      checkId: 'redis',
      status: down.length ? 'critical' : 'ok',
      value: down.length ? 0 : 1,
      unit: null,
      summary: down.length
        ? `Redis sem resposta em ${down.map((item) => item.instance).join(', ')}.`
        : 'Redis responde (redis_exporter).',
      chartTargets: down.flatMap((item) =>
        item.resource ? [{ chartId: 'redis_up', instance: item.resource }] : [],
      ),
    };
  }

  private samplesOf(checkId: string, read: Read, label?: string): Sample[] | CheckResult {
    if ('error' in read)
      return unknown(checkId, `Consulta ao Prometheus falhou (${read.error}).`, {
        error: read.error,
      });
    const found = samples(read.series, label);
    return found.length
      ? found
      : unknown(checkId, 'O Prometheus não tem séries para esta verificação.');
  }
}

type Read = { series: PromSeries[] } | { error: string };

/**
 * Usa o resultado da fonte principal (ex.: Prometheus) sempre que tem dados e recorre à
 * secundária (ex.: agente do host) nas restantes verificações. Falhas de uma fonte não
 * escondem os dados da outra.
 */
export class FallbackCollector implements HealthCollector {
  readonly name: string;
  readonly checks: readonly string[];

  constructor(
    private readonly primary: HealthCollector,
    private readonly fallback: HealthCollector,
  ) {
    this.name = `${primary.name}+${fallback.name}`;
    this.checks = [...new Set([...fallback.checks, ...primary.checks])];
  }

  /** Usa o coletor principal e completa com o alternativo as verificações em falta ou falhadas. */
  async collect(context: CollectorContext): Promise<CheckResult[]> {
    const [primary, fallback] = await Promise.allSettled([
      this.primary.collect(context),
      this.fallback.collect(context),
    ]);
    const preferred = new Map(
      (primary.status === 'fulfilled' ? primary.value : [])
        .filter((item) => item.status !== 'unknown')
        .map((item) => [item.checkId, item]),
    );
    const secondary = new Map(
      fallback.status === 'fulfilled'
        ? fallback.value.map((item) => [item.checkId, item])
        : this.fallback.checks.map((id) => [
            id,
            unknown(id, `Fonte ${this.fallback.name} falhou.`, {
              error: errorCode(fallback.reason),
            }),
          ]),
    );
    return this.checks.map((id) => {
      const chosen = preferred.get(id);
      if (chosen) return { ...chosen, details: { ...chosen.details, source: this.primary.name } };
      return (
        secondary.get(id) ??
        unknown(id, `Sem dados de ${this.primary.name} nem de ${this.fallback.name}.`)
      );
    });
  }
}
