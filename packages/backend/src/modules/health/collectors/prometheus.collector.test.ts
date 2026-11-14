import { describe, expect, it } from 'vitest';
import { healthSettingsSchema } from '../../../../../contracts/src/index.js';
import type { PromSeries } from '../../connectors/prometheus.connector.js';
import { unknown, type HealthCollector } from './collector.js';
import {
  FallbackCollector,
  PROMETHEUS_QUERIES,
  PrometheusCollector,
} from './prometheus.collector.js';

const settings = healthSettingsSchema.parse({});
const context = { projectId: 'p', settings, now: new Date(), previous: () => undefined };
const series = (labels: Record<string, string>, value: number): PromSeries => ({
  labels,
  points: [[1, value]],
});

describe('PrometheusCollector', () => {
  it('avalia disco, CPU/memória, alvos e Redis com os limites da Saúde', async () => {
    const data: Record<string, PromSeries[]> = {
      [PROMETHEUS_QUERIES.diskFree]: [
        series({ instance: 'web', mountpoint: '/' }, 40),
        series({ instance: 'web', mountpoint: '/var' }, 4),
      ],
      [PROMETHEUS_QUERIES.inodeFree]: [series({ instance: 'web', mountpoint: '/' }, 90)],
      [PROMETHEUS_QUERIES.loadPerCore]: [series({ instance: 'web' }, 0.2)],
      [PROMETHEUS_QUERIES.memoryUsed]: [series({ instance: 'web' }, 30)],
      [PROMETHEUS_QUERIES.up]: [
        series({ instance: 'web', job: 'node' }, 1),
        series({ instance: 'db', job: 'mysqld' }, 0),
      ],
      [PROMETHEUS_QUERIES.redis]: [],
    };
    const results = await new PrometheusCollector(async () => ({
      query: async (promql) => data[promql] ?? [],
    })).collect(context);
    const byId = Object.fromEntries(results.map((item) => [item.checkId, item]));
    expect(byId['disk-space']).toMatchObject({ status: 'critical', value: 4 });
    expect(byId['inodes']?.status).toBe('ok');
    expect(byId['cpu-memory']?.status).toBe('ok');
    expect(byId['server-service']).toMatchObject({ status: 'critical', value: 1 });
    expect(byId['server-service']?.summary).toContain('mysqld@db');
    expect(byId['redis']?.status).toBe('unknown');
  });

  it('fica unknown sem integração verificada', async () => {
    const results = await new PrometheusCollector(async () => null).collect(context);
    expect(results.every((item) => item.status === 'unknown')).toBe(true);
  });

  it('associa somente a medida e recurso que falharam, separando carga, RAM e partilhas', async () => {
    const data: Record<string, PromSeries[]> = {
      [PROMETHEUS_QUERIES.loadPerCore]: [series({ instance: 'web' }, 0.2)],
      [PROMETHEUS_QUERIES.memoryUsed]: [series({ instance: 'db' }, 99)],
      [PROMETHEUS_QUERIES.diskFree]: [
        series({ instance: 'web', mountpoint: '/', fstype: 'ext4' }, 2),
        series({ instance: 'web', mountpoint: '/backup', fstype: 'nfs4' }, 2),
        series({ job: 'node', mountpoint: '/unknown' }, 1),
      ],
      [PROMETHEUS_QUERIES.inodeFree]: [
        series({ instance: 'web', mountpoint: '/backup', fstype: 'nfs4' }, 1),
      ],
    };
    const collector = new PrometheusCollector(async () => ({
      query: async (promql) => data[promql] ?? [],
    }));
    const first = new Map(
      (await collector.collect(context)).map((result) => [result.checkId, result]),
    );
    expect(first.get('cpu-memory')?.chartTargets).toEqual([{ chartId: 'memory', instance: 'db' }]);
    expect(first.get('disk-space')?.chartTargets).toEqual([
      { chartId: 'disk', instance: 'web', labels: { mountpoint: '/', fstype: 'ext4' } },
      {
        chartId: 'network_fs',
        instance: 'web',
        labels: { mountpoint: '/backup', fstype: 'nfs4' },
      },
    ]);
    expect(first.get('inodes')?.chartTargets).toEqual([]);

    data[PROMETHEUS_QUERIES.loadPerCore] = [series({ instance: 'web' }, 10)];
    data[PROMETHEUS_QUERIES.memoryUsed] = [series({ instance: 'db' }, 10)];
    expect(
      (await collector.collect(context)).find((result) => result.checkId === 'cpu-memory')
        ?.chartTargets,
    ).toEqual([{ chartId: 'load', instance: 'web' }]);
  });
});

describe('FallbackCollector', () => {
  const fake = (
    name: string,
    results: () => Promise<ReturnType<typeof unknown>[]>,
  ): HealthCollector => ({
    name,
    checks: ['disk-space', 'redis', 'log-growth'],
    collect: results,
  });

  it('prefere a fonte principal e recorre à secundária quando falta ou falha', async () => {
    const primary = fake('prometheus', async () => [
      { checkId: 'disk-space', status: 'ok', value: 50, unit: '% livre', summary: 'prom' },
      unknown('redis', 'sem séries'),
    ]);
    const fallback = fake('host-agent', async () => [
      { checkId: 'disk-space', status: 'warning', value: 9, unit: '% livre', summary: 'agente' },
      { checkId: 'redis', status: 'ok', value: 1, unit: null, summary: 'agente' },
      { checkId: 'log-growth', status: 'ok', value: 1, unit: 'MB/h', summary: 'agente' },
    ]);
    const results = await new FallbackCollector(primary, fallback).collect(context);
    expect(results.map((item) => [item.checkId, item.summary])).toEqual([
      ['disk-space', 'prom'],
      ['redis', 'agente'],
      ['log-growth', 'agente'],
    ]);
    expect(results[0]?.details).toMatchObject({ source: 'prometheus' });

    const failing = fake('prometheus', async () => {
      throw new Error('down');
    });
    const recovered = await new FallbackCollector(failing, fallback).collect(context);
    expect(recovered.map((item) => item.summary)).toEqual(['agente', 'agente', 'agente']);
  });
});
