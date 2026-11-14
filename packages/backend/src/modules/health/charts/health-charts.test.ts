import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  healthSettingsSchema,
  type HealthNotificationChartContext,
  type User,
} from '../../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../../tests/helpers/test-database.js';
import { ChartAvailabilityObserver, ChartEventsRepository } from './chart-events.js';
import { alertmanagerChartContext } from './chart-alert-context.js';
import { HealthRepository } from '../health.repository.js';
import type { PromSeries } from '../../connectors/prometheus.connector.js';
import { DomainError } from '../../../errors.js';
import { CHART_PANELS } from './chart-catalog.js';
import { ChartRollup, rollupExpression } from './chart-rollup.js';
import { ChartRepository } from './chart.repository.js';
import { HealthChartsService, rangeStep, type ChartSource } from './health-charts.service.js';

const HOUR = 3600000;
const actor = { id: 'u1', projectId: 'p1' } as User;
const authorize = async () => ({ projectId: 'p1' });

describe('ChartRollup', () => {
  it('agrega as horas completas em falta e guarda média, máximo e p95 por servidor', async () => {
    const now = new Date('2026-11-10T13:20:00Z');
    const save = vi.fn();
    const repository = {
      lastHour: vi.fn(async (_p: string, env: string) =>
        env === 'production' ? new Date('2026-11-10T10:00:00Z') : null,
      ),
      save,
    } as unknown as ChartRepository;
    const calls: [string, number, number, number][] = [];
    const source = {
      queryRangeBetween: vi.fn(async (promql: string, start: number, end: number, step: number) => {
        calls.push([promql, start, end, step]);
        const value = promql.startsWith('avg') ? 10 : promql.startsWith('max') ? 30 : 25;
        return [
          {
            labels: { instance: 'web' },
            points: [
              [start, value],
              [end, value + 1],
            ],
          },
        ] as PromSeries[];
      }),
    };
    const rollup = new ChartRollup(repository, async (_p, env) =>
      env === 'production' ? source : null,
    );

    const done = await rollup.runDue('p1', now);

    expect(done).toEqual([{ environment: 'production', hours: 2 }]);
    // Horas de 11h e 12h (13h ainda não terminou); avaliadas no fim de cada hora.
    expect(calls[0]?.slice(1)).toEqual([
      Date.parse('2026-11-10T12:00:00Z') / 1000,
      Date.parse('2026-11-10T13:00:00Z') / 1000,
      3600,
    ]);
    expect(calls[0]?.[0]).toBe(
      `avg_over_time((${rollupExpression('100 * (1 - avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[$w])))')})[1h:1m])`,
    );
    const [, environment, rows, upTo] = save.mock.calls[0]!;
    expect(environment).toBe('production');
    expect(upTo).toEqual(new Date('2026-11-10T12:00:00Z'));
    expect(rows).toContainEqual({
      metric: 'cpu',
      instance: 'web',
      hourStart: new Date('2026-11-10T11:00:00Z'),
      avg: 10,
      max: 30,
      p95: 25,
    });
  });

  it('não consulta o Prometheus quando a última hora já está agregada', async () => {
    const resolve = vi.fn();
    const repository = {
      lastHour: vi.fn(async () => new Date(Date.parse('2026-11-10T12:00:00Z'))),
    } as unknown as ChartRepository;
    const done = await new ChartRollup(repository, resolve).runDue(
      'p1',
      new Date('2026-11-10T13:20:00Z'),
    );
    expect(done).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('HealthChartsService', () => {
  it('consulta apenas o gráfico pedido e rejeita identificadores de outro painel', async () => {
    const source: ChartSource = {
      query: vi.fn(async () => []),
      queryRangeBetween: vi.fn(async () => []),
    };
    const service = new HealthChartsService(authorize, async () => source, {} as ChartRepository);
    const result = await service.charts(actor, { panel: 'servers', chart: 'cpu', range: '24h' });
    expect(result.charts.map((item) => item.id)).toEqual(['cpu']);
    expect(source.queryRangeBetween).toHaveBeenCalledTimes(
      CHART_PANELS.servers.charts[0]!.queries.length,
    );
    await expect(
      service.charts(actor, { panel: 'servers', chart: 'db2_cpu' }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('recupera todo o histórico retido, refina o início e não compara antes da recolha', async () => {
    const now = new Date('2026-11-11T19:00:00Z');
    const first = Date.parse('2026-08-12T12:03:30Z') / 1000;
    const coarse = first + 37 * 60;
    const source: ChartSource = {
      query: vi.fn(async (promql: string): Promise<PromSeries[]> => {
        if (promql.includes('[95d:1h]'))
          return [{ labels: {}, points: [[now.getTime() / 1000, coarse]] }];
        if (promql.includes('[1h:30s]')) return [{ labels: {}, points: [[coarse, first]] }];
        return [];
      }),
      queryRangeBetween: vi.fn(
        async (
          _promql: string,
          _start: number,
          end: number,
          _step: number,
        ): Promise<PromSeries[]> => [
          {
            labels: { instance: 'db' },
            points: [
              [first + 120, 50],
              [first + 240, Number.NaN],
              [end, 0],
            ],
          },
        ],
      ),
    };
    const result = await new HealthChartsService(
      authorize,
      async () => source,
      {} as ChartRepository,
      () => now,
    ).charts(actor, { panel: 'servers', range: 'all', compare: '1' });

    expect(result.availableFrom).toBe('2026-08-12T12:03:30.000Z');
    expect(Date.parse(result.from)).toBeLessThanOrEqual(first * 1000);
    expect(Date.parse(result.from)).toBeGreaterThanOrEqual(now.getTime() - 95 * 86400000);
    expect(Date.parse(result.to) - Date.parse(result.from)).toBeGreaterThan(90 * 86400000);
    expect(source.query).toHaveBeenCalledWith(
      'min(min_over_time(timestamp(up)[1h:30s]))',
      new Date((coarse + 60) * 1000),
    );
    const points = result.charts[0]!.series[0]!.points;
    expect(points).toEqual([
      [first + 120, 50],
      [Date.parse(result.to) / 1000, 0],
    ]);
    expect(result.charts.flatMap((chart) => chart.series).every((series) => !series.previous)).toBe(
      true,
    );
    for (const [, start, end, step] of vi.mocked(source.queryRangeBetween).mock.calls) {
      expect((end - start) / step).toBeLessThanOrEqual(300);
      expect(start * 1000).toBeGreaterThanOrEqual(now.getTime() - 95 * 86400000);
    }
  });

  describe('eventos operacionais independentes de tickets', () => {
    let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
    let events: ChartEventsRepository;
    const projectId = randomUUID();
    const from = new Date('2026-11-14T01:00:00Z');
    const at = (minutes: number) => new Date(from.getTime() + minutes * 60000);
    const emailAlertId = randomUUID();
    const mysqlContext = alertmanagerChartContext('MysqlIndisponivel', { instance: 'db-host' });
    beforeAll(async () => {
      fixture = await startTestDatabase();
      await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [
        projectId,
        'Chart events',
      ]);
      events = new ChartEventsRepository(fixture.db);
    });
    afterAll(async () => fixture?.stop());

    it('confirma DB2 por observações consecutivas, conserva recuperação e não mistura ambientes', async () => {
      const observation = {
        cause: 'db2' as const,
        resource: 'db2-host',
        available: false,
        planned: true,
        confirmMinutes: 3,
      };
      await Promise.all([
        events.observe(projectId, 'production', observation, at(0)),
        events.observe(projectId, 'production', observation, at(0)),
      ]);
      expect(await events.events(projectId, 'production', from, at(10))).toEqual([]);
      for (const minute of [1, 2, 3])
        await events.observe(projectId, 'production', observation, at(minute));
      await events.observe(projectId, 'production', { ...observation, available: true }, at(4));
      expect(await events.events(projectId, 'production', from, at(10))).toMatchObject([
        {
          kind: 'db2',
          at: from.toISOString(),
          confirmedAt: at(3).toISOString(),
          recoveredAt: at(4).toISOString(),
          planned: true,
          observationGap: false,
        },
      ]);
      expect(await events.events(projectId, 'quality', from, at(10))).toEqual([]);
      await events.observe(projectId, 'production', observation, at(6));
      expect(
        (
          await fixture.db.query<{ count: number }>(
            'SELECT COUNT(*) AS count FROM health_chart_outages WHERE project_id=$1',
            [projectId],
          )
        ).rows[0]?.count,
      ).toBe(2);
    });

    it('não confirma uma falha com intervalo sem observações e exclui emails não enviados/relatórios', async () => {
      const observation = {
        cause: 'http' as const,
        resource: 'https://site.test/',
        available: false,
        planned: false,
        confirmMinutes: 3,
      };
      await events.observe(projectId, 'quality', observation, at(0));
      await events.observe(projectId, 'quality', observation, at(4));
      expect(await events.events(projectId, 'quality', from, at(10))).toEqual([]);
      for (const [state, kind, environment] of [
        ['sent', 'alert', 'quality'],
        ['failed', 'alert', 'quality'],
        ['pending', 'alert', 'quality'],
        ['sent', 'report', 'quality'],
        ['sent', 'alert', 'production'],
      ]) {
        await fixture.db.query(
          `INSERT INTO health_notifications(id,project_id,kind,channel,recipients,subject,body,state,sent_at,environment,alert_id,chart_context)
           VALUES($1,$2,$3,'email','fixture@example.test','Test','Test',$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            projectId,
            kind,
            state,
            at(1),
            environment,
            emailAlertId,
            JSON.stringify(mysqlContext),
          ],
        );
      }
      expect(await events.events(projectId, 'quality', from, at(10))).toMatchObject([
        { kind: 'email', at: at(1).toISOString(), count: 1 },
      ]);
    });

    it('regista uma janela planeada sem a apresentar como falha e conserva contagens de emails simultâneos', async () => {
      const window = {
        cause: 'maintenance' as const,
        resource: 'IBM i 01:00–07:00',
        available: false,
        planned: true,
        confirmMinutes: 0,
      };
      await events.observe(projectId, 'quality', window, at(5));
      await events.observe(projectId, 'quality', { ...window, available: true }, at(6));
      await fixture.db.query(
        `INSERT INTO health_notifications(id,project_id,kind,channel,recipients,subject,body,state,sent_at,environment,alert_id,chart_context)
         VALUES($1,$2,'alert','email','fixture@example.test','Test','Test','sent',$3,'quality',$4,$5)`,
        [randomUUID(), projectId, at(1), emailAlertId, JSON.stringify(mysqlContext)],
      );
      const history = await events.events(projectId, 'quality', from, at(10));
      expect(history.find((item) => item.kind === 'email')).toMatchObject({
        count: 2,
        at: at(1).toISOString(),
      });
      expect(history.find((item) => item.kind === 'maintenance')).toMatchObject({
        confirmedAt: null,
        recoveredAt: null,
        planned: true,
        at: at(5).toISOString(),
      });
    });

    it('mantém emails de ambiente desconhecido no histórico, sem linhas nem conteúdo privado nos gráficos', async () => {
      const repository = new HealthRepository(fixture.db);
      await fixture.db.query('INSERT INTO health_settings(project_id,config) VALUES($1,$2)', [
        projectId,
        JSON.stringify(healthSettingsSchema.parse({ sourceEnvironment: 'production' })),
      ]);
      const id = await repository.queueNotification({
        projectId,
        environment: null,
        chartContext: mysqlContext,
        alertId: null,
        kind: 'alert',
        channel: 'email',
        recipients: ['fixture@example.test'],
        subject: 'Private subject',
        body: 'Private body',
      });
      await fixture.db.query(
        "UPDATE health_notifications SET state='sent',sent_at=$2 WHERE id=$1",
        [id, at(7)],
      );
      const history = await events.events(projectId, 'quality', from, at(10));
      expect(history.some((item) => item.id === id)).toBe(false);
      expect(
        (
          await fixture.db.query(
            'SELECT subject,body,state FROM health_notifications WHERE id=$1',
            [id],
          )
        ).rows[0],
      ).toMatchObject({ subject: 'Private subject', body: 'Private body', state: 'sent' });
      expect(JSON.stringify(history)).not.toMatch(/Private body|Private subject|fixture@example/);
    });

    it('filtra antes de agrupar e conserva a origem histórica e as contagens por ocorrência/recurso', async () => {
      const scopedProject = randomUUID();
      await fixture.db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [
        scopedProject,
        'Scoped emails',
      ]);
      const repository = new HealthRepository(fixture.db);
      const context = alertmanagerChartContext('MysqlLigacoesElevadas', {
        instance: 'db-a',
        credential: 'must-not-be-copied',
      });
      const alertId = randomUUID();
      const enqueue = async (
        chartContext: HealthNotificationChartContext | undefined,
        sentAt: Date,
        occurrence = alertId,
        environment: 'production' | 'quality' = 'production',
      ) => {
        const id = await repository.queueNotification({
          projectId: scopedProject,
          environment,
          alertId: occurrence,
          chartContext,
          kind: 'alert',
          channel: 'email',
          recipients: ['fixture@example.test'],
          subject: 'Private subject',
          body: 'Private body',
        });
        await fixture.db.query(
          "UPDATE health_notifications SET state='sent',sent_at=$2 WHERE id=$1",
          [id, sentAt],
        );
        return id;
      };
      await enqueue(context, at(1));
      await enqueue(context, new Date(at(1).getTime() + 500));
      context.targets[0]!.instance = 'db-b';
      await enqueue(context, at(1));
      await enqueue(context, at(1), randomUUID());
      await enqueue(context, at(1), randomUUID(), 'quality');
      await enqueue(alertmanagerChartContext('CargaCpuElevada', { instance: 'db-a' }), at(1));
      await enqueue(alertmanagerChartContext('ServicoIndisponivel', { instance: 'db-a' }), at(1));
      await enqueue(alertmanagerChartContext('toString', { instance: 'db-a' }), at(1));
      await enqueue(undefined, at(1));

      const selected = await events.events(scopedProject, 'production', from, at(10), {
        chartIds: ['mysql_connections'],
        instance: 'db-a',
      });
      expect(selected).toMatchObject([
        {
          count: 2,
          alertId,
          at: at(1).toISOString(),
          lastAt: new Date(at(1).getTime() + 500).toISOString(),
          alertContext: {
            source: 'prometheus',
            key: 'MysqlLigacoesElevadas',
            targets: [{ chartId: 'mysql_connections', instance: 'db-a' }],
          },
        },
      ]);
      expect(selected).toHaveLength(1);
      expect(JSON.stringify(selected)).not.toMatch(
        /Private|credential|must-not-be-copied|fixture@example/,
      );
      expect(
        await events.events(scopedProject, 'production', from, at(10), {
          chartIds: ['cpu', 'db2_cpu'],
        }),
      ).toEqual([]);
      const all = await events.events(scopedProject, 'production', from, at(10));
      expect(all.map((event) => event.count).sort()).toEqual([1, 1, 1, 2]);
      expect(
        all.find((event) => event.alertContext?.key === 'CargaCpuElevada')?.alertContext?.targets,
      ).toEqual([{ chartId: 'load', instance: 'db-a', labels: {} }]);
      expect(
        (
          await fixture.db.query(
            'SELECT COUNT(*) AS n FROM health_notifications WHERE project_id=$1',
            [scopedProject],
          )
        ).rows[0]?.n,
      ).toBe(9);

      const source: ChartSource = {
        query: vi.fn(async (expression: string): Promise<PromSeries[]> => [
          {
            labels: { instance: 'db-a' },
            points: [
              [
                from.getTime() / 1000,
                expression.startsWith('min(min_over_time(timestamp(up)')
                  ? from.getTime() / 1000
                  : 1,
              ],
            ],
          },
        ]),
        queryRangeBetween: vi.fn(async () => []),
      };
      const service = new HealthChartsService(
        async () => ({ projectId: scopedProject }),
        async () => source,
        new ChartRepository(fixture.db),
        () => at(10),
        events,
      );
      for (const range of ['24h', 'all', '395d']) {
        const cpu = await service.charts(actor, { panel: 'servers', chart: 'cpu', range });
        expect(cpu.events?.filter((event) => event.kind === 'email')).toEqual([]);
        const mysql = await service.charts(actor, {
          panel: 'mysql',
          chart: 'mysql_connections',
          range,
          instance: 'db-a',
        });
        expect(
          mysql.events?.filter((event) => event.kind === 'email').map((event) => event.count),
        ).toEqual([2]);
      }
      const panel = await service.charts(actor, { panel: 'servers', range: '24h' });
      expect(panel.events?.map((event) => event.alertContext?.key)).toEqual(['CargaCpuElevada']);
      const sites = await enqueue(
        alertmanagerChartContext('SiteIndisponivel', { instance: 'https://site.test/' }),
        at(1),
      );
      expect(
        (await service.charts(actor, { panel: 'sites', range: '24h', instance: 'db-a' })).events,
      ).toMatchObject([
        {
          id: sites,
          alertContext: {
            targets: [{ chartId: 'site_availability', instance: 'https://site.test/' }],
          },
        },
      ]);
    });

    it('observa apenas sondas funcionais, respeita fins de semana e não cria eventos por ausência/exporter', async () => {
      const record = vi.fn();
      const repository = { observe: record, suspended: vi.fn(async () => false) };
      const source: ChartSource = {
        queryRangeBetween: vi.fn(async () => []),
        query: vi.fn(async (expression: string): Promise<PromSeries[]> =>
          expression.startsWith('zeroops_db2_up')
            ? [{ labels: { instance: 'db2-host' }, points: [[from.getTime() / 1000, 0]] }]
            : [],
        ),
      };
      const observer = new ChartAvailabilityObserver(repository, async (_project, environment) =>
        environment === 'production' ? source : null,
      );
      await observer.run(
        projectId,
        healthSettingsSchema.parse({
          quietWindows: [
            {
              name: 'IBM i',
              start: '01:00',
              end: '07:00',
              timezone: 'Europe/Lisbon',
              days: [0, 1, 2, 3, 4, 5, 6],
              checks: ['rule:Db2Indisponivel'],
            },
          ],
        }),
        from,
      );
      expect(record).toHaveBeenCalledTimes(3);
      expect(record).toHaveBeenCalledWith(
        projectId,
        'production',
        expect.objectContaining({
          cause: 'db2',
          available: false,
          planned: true,
          confirmMinutes: 3,
        }),
        from,
      );
      expect(source.query).toHaveBeenCalledWith(
        expect.stringContaining('node_textfile_mtime_seconds'),
        from,
      );
      record.mockClear();
      source.query = vi.fn(async () => []);
      await observer.run(projectId, healthSettingsSchema.parse({}), at(1));
      expect(record).not.toHaveBeenCalled();
      vi.mocked(source.query).mockClear();
      repository.suspended.mockResolvedValue(true);
      await observer.run(projectId, healthSettingsSchema.parse({}), at(2));
      expect(source.query).not.toHaveBeenCalled();
    });
  });

  it('indica que não há histórico sem inventar séries ou data de início', async () => {
    const source: ChartSource = {
      query: async () => [],
      queryRangeBetween: vi.fn(async () => []),
    };
    const result = await new HealthChartsService(
      authorize,
      async () => source,
      {} as ChartRepository,
    ).charts(actor, { range: 'all' });
    expect(result.availableFrom).toBeNull();
    expect(result.charts).toEqual([]);
    expect(result.unavailable).toContain('Não existem métricas históricas');
    expect(source.queryRangeBetween).not.toHaveBeenCalled();
  });

  it('não apresenta uma falha de descoberta do histórico como ausência de dados', async () => {
    const source: ChartSource = {
      query: async (promql) => {
        if (promql.includes('timestamp'))
          throw new DomainError('PROM_FAILED', 'Prometheus respondeu 503: unavailable', 400);
        return [];
      },
      queryRangeBetween: async () => [],
    };
    await expect(
      new HealthChartsService(authorize, async () => source, {} as ChartRepository).charts(actor, {
        range: 'all',
      }),
    ).rejects.toMatchObject({ code: 'PROM_FAILED' });
  });

  it('traduz falhas HTTP do Prometheus preservando o detalhe técnico', async () => {
    const source: ChartSource = {
      query: async () => [],
      queryRangeBetween: async () => {
        throw new DomainError('PROM_FAILED', 'Prometheus respondeu 503: unavailable', 400);
      },
    };
    const result = await new HealthChartsService(
      authorize,
      async () => source,
      {} as ChartRepository,
    ).charts(actor, { panel: 'servers' });
    expect(result.charts[0]?.errorEn).toBe('Prometheus returned 503: unavailable');
    expect(result.charts[0]?.error).toBe('Prometheus respondeu 503: unavailable');
  });

  it('devolve o erro de consulta em PT e EN sem impedir os restantes gráficos', async () => {
    const source: ChartSource = {
      query: async () => [],
      queryRangeBetween: async () => {
        throw new Error('upstream');
      },
    };
    const result = await new HealthChartsService(
      authorize,
      async () => source,
      {} as ChartRepository,
    ).charts(actor, { panel: 'servers' });
    expect(result.charts.length).toBeGreaterThan(1);
    for (const chart of result.charts) {
      expect(chart.error).toBe('A consulta ao Prometheus falhou.');
      expect(chart.errorEn).toBe('The Prometheus query failed.');
      expect(chart.series).toEqual([]);
    }
  });

  it('alinha o step e usa janela mínima de 2 minutos', () => {
    expect(rangeStep('1h', 1000)).toMatchObject({ step: 15, window: '120s' });
    expect(rangeStep('7d', 1_800_000_000)).toMatchObject({ step: 2025, window: '2025s' });
  });

  it('desloca o período anterior para o eixo do período atual', async () => {
    const queries: [number, number][] = [];
    const source: ChartSource = {
      query: async () => [{ labels: { instance: 'db', role: 'db' }, points: [[0, 1]] }],
      queryRangeBetween: async (_promql, start, end) => {
        queries.push([start, end]);
        return [{ labels: { instance: 'db' }, points: [[start, 50]] }];
      },
    };
    const service = new HealthChartsService(
      authorize,
      async () => source,
      {} as ChartRepository,
      () => new Date(3_600_000_000),
    );

    const result = await service.charts(actor, { panel: 'db2', range: '1h', compare: '1' });

    const cpu = result.charts.find((chart) => chart.id === 'db2_cpu')!;
    expect(cpu.series.map((series) => series.label)).toEqual(['IBM i', 'IBM i (período anterior)']);
    expect(cpu.series[1]!.labelEn).toBe('IBM i (previous period)');
    expect(cpu.series[1]!.points[0]![0]).toBe(cpu.series[0]!.points[0]![0]);
    expect([...new Set(result.charts.map((chart) => chart.group))]).toEqual([
      'Recursos do IBM i',
      'Disponibilidade e resposta',
      'Jobs e threads',
      'Filas DTQ (login dos clientes)',
    ]);
    const current = queries.reduce((a, b) => (b[0] > a[0] ? b : a));
    expect(queries).toContainEqual([current[0] - 3600, current[1] - 3600]);
    expect(result.instances).toEqual([{ instance: 'db', role: 'db' }]);
  });

  it('indica a integração em falta sem consultar', async () => {
    const result = await service().charts(actor, { panel: 'servers', env: 'quality' });
    expect(result.charts).toEqual([]);
    expect(result.unavailable).toContain('Qualidade');

    function service() {
      return new HealthChartsService(authorize, async () => null, {} as ChartRepository);
    }
  });

  it('agrupa o mapa de calor por dia da semana e hora de Lisboa', async () => {
    const repository = {
      instances: async () => ['web'],
      hourly: async () => [
        // Segunda-feira, 13 de julho de 2026, 08:00 UTC = 09:00 em Lisboa (verão).
        { hourStart: new Date('2026-07-13T08:00:00Z'), avg: 40 },
        { hourStart: new Date('2026-07-20T08:00:00Z'), avg: 60 },
      ],
    } as unknown as ChartRepository;
    const service = new HealthChartsService(
      authorize,
      async () => null,
      repository,
      () => new Date('2026-07-25T00:00:00Z'),
    );

    const result = await service.heatmap(actor, { metric: 'cpu', days: '28' });

    expect(result.instance).toBe('web');
    expect(result.cells[0]![9]).toBe(50);
    expect(result.cells[0]![8]).toBeNull();
    expect(result.byMonthDay[12]).toBe(40);
    expect(result.max).toBe(50);
    expect(result).toMatchObject({ warn: 80, crit: 90, higherIsBetter: false });

    const availability = await service.heatmap(actor, { metric: 'site_availability' });
    expect(availability).toMatchObject({ warn: 99.9, crit: 99, higherIsBetter: true });
    const redis = await service.heatmap(actor, { metric: 'redis_memory' });
    expect(redis).toMatchObject({ warn: null, crit: null });
  });

  it('rejeita filtros inválidos', async () => {
    const service = new HealthChartsService(authorize, async () => null, {} as ChartRepository);
    await expect(service.charts(actor, { range: '2y' })).rejects.toMatchObject({ status: 400 });
    await expect(service.heatmap(actor, { instance: 'a"b' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

void HOUR;

describe('catálogo de gráficos', () => {
  it('tem título, categoria e descrição em inglês em todos os gráficos', () => {
    const missing = Object.values(CHART_PANELS)
      .flatMap((panel) => panel.charts)
      .filter(
        (chart) => !chart.titleEn?.trim() || !chart.descriptionEn?.trim() || !chart.groupEn?.trim(),
      )
      .map((chart) => chart.id);
    expect(missing).toEqual([]);
  });

  it('só usa séries que o agente de Produção envia (write_relabel_configs)', () => {
    const agent = readFileSync(
      new URL('../../../../../../deploy/production-metrics/prometheus-agent.yml', import.meta.url),
      'utf8',
    );
    const keep = new RegExp(`^(?:${/regex: >-\s*\n\s*(\S+)/.exec(agent)![1]})$`);
    const missing = Object.entries(CHART_PANELS)
      // As sondas HTTP correm em Qualidade (blackbox), não passam pelo agente.
      .filter(([panel]) => panel !== 'sites')
      .flatMap(([, panel]) => panel.charts.flatMap((chart) => chart.queries))
      .flatMap((query) => query.expr.match(/\b(?:node|mysql|redis|zeroops)_\w+/g) ?? [])
      .filter((metric) => !keep.test(metric));
    expect([...new Set(missing)]).toEqual([]);
  });
});
