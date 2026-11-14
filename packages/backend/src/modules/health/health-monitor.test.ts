import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  healthSettingsSchema,
  type HealthStatus,
  type User,
} from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { catalogEntry } from './health-catalog.js';
import { decideAlert, HealthMonitor } from './health-monitor.js';
import { HealthNotifier } from './health-notifier.js';
import { HealthReporter } from './health-reporter.js';
import { HealthRepository } from './health.repository.js';
import { HealthService } from './health.service.js';
import { HealthTickets } from './health-tickets.js';
import { HostAgentCollector } from './collectors/host-agent.collector.js';
import { LogsCollector } from './collectors/logs.collector.js';
import { SiteDatabaseCollector } from './collectors/site-database.collector.js';
import { resolveRecipients } from './health-recipients.js';
import { activeQuietWindow, withinQuietWindow } from './health-quiet-windows.js';
import type { HealthCollector } from './collectors/collector.js';
import { autoInvestigateNewTicket } from '../agents/agent-auto-runs.js';
import { TicketsService } from '../tickets/tickets.service.js';

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 9, 10, 0) + minutes * 60000);

describe('decideAlert', () => {
  const urgent = catalogEntry('paid-not-integrated');
  const confirmed = catalogEntry('response-time');
  const open = {
    severity: 'critical' as const,
    acknowledgedAt: null,
    lastNotifiedAt: at(0),
    openedAt: at(0),
  };

  it('aguarda a confirmacao antes de abrir e ignora estados sem dados', () => {
    expect(decideAlert(confirmed, 'warning', at(0), null, at(5))).toEqual({ type: 'none' });
    expect(decideAlert(confirmed, 'warning', at(0), null, at(10))).toEqual({ type: 'open' });
    expect(decideAlert(urgent, 'unknown', at(0), open, at(60))).toEqual({ type: 'none' });
  });

  it('re-notifica urgentes sem rececao e para depois de confirmada', () => {
    expect(decideAlert(urgent, 'critical', at(0), open, at(14))).toMatchObject({ notify: false });
    expect(decideAlert(urgent, 'critical', at(0), open, at(15))).toMatchObject({
      notify: true,
      reason: 'reminder',
    });
    expect(
      decideAlert(urgent, 'critical', at(0), { ...open, acknowledgedAt: at(1) }, at(60)),
    ).toMatchObject({
      notify: false,
    });
    expect(decideAlert(urgent, 'ok', at(0), open, at(1))).toEqual({ type: 'resolve' });
  });

  it('notifica quando o alerta agrava de aviso para critico', () => {
    expect(
      decideAlert(urgent, 'critical', at(0), { ...open, severity: 'warning' }, at(1)),
    ).toMatchObject({
      notify: true,
      reason: 'escalated',
    });
  });
});

describe('janelas de silêncio', () => {
  const window = healthSettingsSchema.parse({
    quietWindows: [{ name: 'IBM i', start: '00:55', end: '07:30', checks: ['site-availability'] }],
  }).quietWindows[0]!;

  it('atravessa a meia-noite e segue a hora de Lisboa (inverno e verão)', () => {
    expect(withinQuietWindow(window, new Date('2026-11-10T00:54:00Z'))).toBe(false);
    expect(withinQuietWindow(window, new Date('2026-11-10T00:55:00Z'))).toBe(true);
    expect(withinQuietWindow(window, new Date('2026-11-10T07:29:00Z'))).toBe(true);
    expect(withinQuietWindow(window, new Date('2026-11-10T07:30:00Z'))).toBe(false);
    // Verão (UTC+1): 00:30 UTC = 01:30 em Lisboa; 06:45 UTC = 07:45.
    expect(withinQuietWindow(window, new Date('2026-07-01T00:30:00Z'))).toBe(true);
    expect(withinQuietWindow(window, new Date('2026-07-01T06:45:00Z'))).toBe(false);
  });

  it('só se aplica às verificações escolhidas e valida a configuração', () => {
    const settings = { quietWindows: [window] };
    const night = new Date('2026-11-10T03:00:00Z');
    expect(activeQuietWindow(settings, 'site-availability', night)?.name).toBe('IBM i');
    expect(activeQuietWindow(settings, 'disk-space', night)).toBeUndefined();
    const parse = (value: object) =>
      healthSettingsSchema.safeParse({
        quietWindows: [{ name: 'x', start: '01:00', end: '07:00', checks: ['redis'], ...value }],
      }).success;
    expect(parse({ end: '01:00' })).toBe(false);
    expect(parse({ timezone: 'Lua/Base' })).toBe(false);
    expect(parse({ checks: [] })).toBe(false);
    expect(parse({ days: [] })).toBe(false);
    expect(parse({ checks: ['rule:DtqErrosNoLog', 'probe:dtq'] })).toBe(true);
    expect(parse({ checks: ['rule:x y'] })).toBe(false);
  });

  it('respeita os dias da semana pelo dia em que a janela começa (inclui fim de semana)', () => {
    expect(window.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Janela 23:00–07:00 só à sexta: sábado 01:00 ainda pertence à noite de sexta.
    const fridayOnly = { ...window, start: '23:00', end: '07:00', days: [5] };
    expect(withinQuietWindow(fridayOnly, new Date('2026-11-13T23:30:00Z'))).toBe(true); // sex 23:30
    expect(withinQuietWindow(fridayOnly, new Date('2026-11-14T01:00:00Z'))).toBe(true); // sáb 01:00
    expect(withinQuietWindow(fridayOnly, new Date('2026-11-14T23:30:00Z'))).toBe(false); // sáb 23:30
    expect(withinQuietWindow(fridayOnly, new Date('2026-11-15T01:00:00Z'))).toBe(false); // dom 01:00
    const sameDay = { ...window, start: '01:00', end: '07:00', days: [0, 6] };
    expect(withinQuietWindow(sameDay, new Date('2026-11-15T03:00:00Z'))).toBe(true); // domingo
    expect(withinQuietWindow(sameDay, new Date('2026-11-16T03:00:00Z'))).toBe(false); // segunda
  });
});

describe('HostAgentCollector', () => {
  const settings = healthSettingsSchema.parse({});
  const context = (now: Date) => ({ projectId: 'p', settings, now, previous: () => undefined });
  const sample = {
    host: 'web1',
    disks: [{ mount: '/', usedPercent: 92, inodesUsedPercent: 40 }],
    cpu: { load1: 1, load5: 1, cores: 2 },
    memory: { totalKb: 1000, availableKb: 30 },
    services: [{ name: 'apache2', active: true }],
    redis: { ok: false },
    logs: [{ path: '/log/php.log', sizeBytes: 500 * 1048576 }],
  };

  it('avalia limites e calcula o crescimento dos logs face a uma hora antes', async () => {
    const collector = new HostAgentCollector({
      latest: async () => [{ receivedAt: at(60), sample }],
      latestBefore: async () => ({
        receivedAt: at(0),
        sample: { ...sample, logs: [{ path: '/log/php.log', sizeBytes: 0 }] },
      }),
    });
    const results = new Map(
      (await collector.collect(context(at(61)))).map((item) => [item.checkId, item]),
    );
    expect(results.get('disk-space')).toMatchObject({ status: 'warning', value: 8 });
    expect(results.get('cpu-memory')).toMatchObject({ status: 'critical', value: 97 });
    expect(results.get('redis')?.status).toBe('critical');
    expect(results.get('log-growth')).toMatchObject({ status: 'warning', value: 500 });
    expect(results.get('server-service')?.status).toBe('ok');
  });

  it('marca o servidor como indisponivel quando o heartbeat esta atrasado', async () => {
    const collector = new HostAgentCollector({
      latest: async () => [{ receivedAt: at(0), sample }],
      latestBefore: async () => null,
    });
    const results = await collector.collect(context(at(10)));
    expect(results.find((item) => item.checkId === 'server-service')?.status).toBe('critical');
    expect(results.find((item) => item.checkId === 'disk-space')?.status).toBe('unknown');
  });

  it('junta varios hosts: pior estado entre os que tem dados e resumo por host', async () => {
    const web = {
      host: 'web2',
      disks: [{ mount: '/', usedPercent: 50, inodesUsedPercent: 10 }],
      services: [{ name: 'nginx', active: false }],
    };
    const collector = new HostAgentCollector({
      latest: async () => [
        { receivedAt: at(60), sample },
        { receivedAt: at(60), sample: web },
      ],
      latestBefore: async () => null,
    });
    const results = new Map(
      (await collector.collect(context(at(61)))).map((item) => [item.checkId, item]),
    );
    expect(results.get('server-service')).toMatchObject({ status: 'critical' });
    expect(results.get('server-service')?.summary).toContain(
      '[web2] Serviços parados em web2: nginx.',
    );
    expect(results.get('disk-space')).toMatchObject({ status: 'warning', value: 8 });
    // web2 nao reporta Redis: prevalece o host com dados.
    expect(results.get('redis')?.summary).toBe('[web1] Redis não responde a PING.');
  });
});

describe('resolveRecipients', () => {
  const settings = healthSettingsSchema.parse({
    lists: [
      { id: 'tecnica', name: 'Equipa técnica', emails: ['a@example.test', 'B@example.test'] },
      { id: 'pagamentos', name: 'Pagamentos', emails: ['b@example.test', 'p@example.test'] },
    ],
    defaults: { critica: ['tecnica'], report: ['tecnica'] },
    routes: { 'payments-shift4': ['pagamentos', 'tecnica'] },
    recipients: { critica: ['legacy@example.test'] },
  });

  it('usa a rota do alarme, senao o defeito da criticidade, sem repetidos', () => {
    expect(resolveRecipients(settings, 'critica', 'payments-shift4')).toEqual([
      'b@example.test',
      'p@example.test',
      'a@example.test',
      'legacy@example.test',
    ]);
    expect(resolveRecipients(settings, 'critica', 'redis')).toEqual([
      'a@example.test',
      'B@example.test',
      'legacy@example.test',
    ]);
    expect(resolveRecipients(settings, 'urgente', 'redis')).toEqual([]);
  });

  it('rejeita rotas para listas inexistentes', () => {
    expect(healthSettingsSchema.safeParse({ routes: { redis: ['nao-existe'] } }).success).toBe(
      false,
    );
  });
});

describe('metricas enviadas pelo agente', () => {
  const settings = healthSettingsSchema.parse({});
  const context = { projectId: 'p', settings, now: at(0), previous: () => undefined };

  it('avalia a BD do site a partir do bloco "site" quando nao ha ligacao direta', async () => {
    const collector = new SiteDatabaseCollector(
      async () => null,
      async () => ({
        host: 'db1',
        metrics: {
          saturation: { connected: 10, max: 100, running: 2, slowQueriesTotal: 5 },
          shift4: { total: 40, failed: 20, pending: 0 },
          paidNotIntegrated: {
            count: 2,
            firstOrderId: 99,
            oldestMinutes: 40,
            failed: 1,
            thresholdMinutes: 15,
          },
          errors: ['wallet:ER_NO_SUCH_TABLE'],
        },
      }),
    );
    const results = new Map((await collector.collect(context)).map((item) => [item.checkId, item]));
    expect(results.get('database-saturation')).toMatchObject({ status: 'ok', value: 10 });
    expect(results.get('payments-shift4')).toMatchObject({ status: 'critical', value: 50 });
    expect(results.get('payments-wallet')?.summary).toBe(
      'Consulta falhou (ER_NO_SUCH_TABLE) via agente db1.',
    );
    expect(results.get('payments-divergence')?.status).toBe('unknown');
    expect(results.get('paid-not-integrated')).toMatchObject({ status: 'critical', value: 2 });
  });

  it('usa as contagens de logs do agente, normalizadas por hora', async () => {
    const collector = new LogsCollector(
      async () => null,
      async () => ({
        hosts: ['db1'],
        windowMinutes: 30,
        applicationErrors: 150,
        authFailures: 1,
        sample: ['PHP Fatal error'],
      }),
    );
    const results = await collector.collect(context);
    expect(results.find((item) => item.checkId === 'application-errors')).toMatchObject({
      status: 'warning',
      value: 300,
    });
    expect(results.find((item) => item.checkId === 'auth-failures')?.status).toBe('ok');
  });
});

describe('HealthMonitor com BD', () => {
  let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
  let repository: HealthRepository;
  const projectId = randomUUID();
  let admin: User;
  let status: HealthStatus = 'critical';
  const fake: HealthCollector = {
    name: 'fake',
    checks: ['paid-not-integrated'],
    collect: async () => [
      {
        checkId: 'paid-not-integrated',
        status,
        value: 3,
        unit: 'encomendas',
        summary: '3 por integrar',
      },
    ],
  };
  const sent: { to: string[]; subject: string }[] = [];

  beforeAll(async () => {
    fixture = await startTestDatabase();
    repository = new HealthRepository(fixture.db);
    await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [projectId, 'Saude']);
    admin = {
      id: randomUUID(),
      projectId,
      role: 'admin',
      email: `${randomUUID()}@example.test`,
      displayName: 'Admin',
    };
    await fixture.db.query(
      'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [admin.id, projectId, admin.email, admin.displayName, 'admin', 'unusable-test-hash'],
    );
  });
  afterAll(async () => {
    await fixture?.stop();
  });

  it('cria um ticket único para scheduled-jobs quando o alerta atinge crítico', async () => {
    const cronProjectId = randomUUID();
    const cronAdmin: User = {
      id: randomUUID(),
      projectId: cronProjectId,
      role: 'admin',
      email: `${randomUUID()}@example.test`,
      displayName: 'Admin de tarefas',
    };
    await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [
      cronProjectId,
      'Tarefas agendadas',
    ]);
    await fixture.db.query(
      'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        cronAdmin.id,
        cronProjectId,
        cronAdmin.email,
        cronAdmin.displayName,
        'admin',
        'unusable-test-hash',
      ],
    );
    let cronStatus: HealthStatus = 'warning';
    const cron: HealthCollector = {
      name: 'cron-test',
      checks: ['scheduled-jobs'],
      collect: async () => [
        {
          checkId: 'scheduled-jobs',
          status: cronStatus,
          value: cronStatus === 'critical' ? 2 : 1,
          unit: 'tarefas',
          summary:
            cronStatus === 'critical'
              ? '23 tarefas; 2 fora do prazo, 2 com falha.'
              : '23 tarefas; 1 fora do prazo.',
          details: {
            crons:
              cronStatus === 'critical'
                ? [
                    { status: 'critical', summary: 'syncCampanhasRelatorios: HTTP 504.' },
                    { status: 'critical', summary: 'gestaoPeriodicidades: HTTP 504.' },
                  ]
                : [{ status: 'warning', summary: 'syncCampanhasRelatorios: atrasada.' }],
          },
        },
      ],
    };
    const ticketGateway = new HealthTickets(
      fixture.db,
      new TicketsService(fixture.db, [], [autoInvestigateNewTicket]),
    );
    const monitor = new HealthMonitor(repository, [cron], undefined, ticketGateway);
    await repository.saveSettings(
      cronProjectId,
      healthSettingsSchema.parse({
        enabled: true,
        sourceEnvironment: 'production',
        quietWindows: [
          {
            name: 'Janela de manutenção',
            start: '09:00',
            end: '10:30',
            timezone: 'Europe/Lisbon',
            checks: ['scheduled-jobs'],
          },
        ],
      }),
      cronAdmin.id,
    );

    expect((await monitor.runCycle(cronProjectId, at(0))).opened).toBe(0);
    expect(await repository.openAlert(cronProjectId, 'scheduled-jobs')).toBeNull();
    expect(
      (await fixture.db.query('SELECT id FROM tickets WHERE project_id=$1', [cronProjectId]))
        .rowCount,
    ).toBe(0);

    expect((await monitor.runCycle(cronProjectId, at(31))).opened).toBe(1);
    const openedAlert = await repository.openAlert(cronProjectId, 'scheduled-jobs');
    expect(openedAlert?.ticketId).toBeNull();
    expect(
      (await fixture.db.query('SELECT id FROM tickets WHERE project_id=$1', [cronProjectId]))
        .rowCount,
    ).toBe(0);

    cronStatus = 'critical';
    await monitor.runCycle(cronProjectId, at(63));
    const alert = await repository.openAlert(cronProjectId, 'scheduled-jobs');
    expect(alert?.ticketId).toBeTruthy();
    const created = await fixture.db.query<{
      title: string;
      description: string;
      category: string;
      environment: string;
      priority: string;
      origin: string;
    }>('SELECT title,description,category,environment,priority,origin FROM tickets WHERE id=$1', [
      alert?.ticketId,
    ]);
    expect(created.rows[0]).toMatchObject({
      title: '[Saúde][Produção] Falhas em tarefas agendadas',
      category: 'incident',
      environment: 'production',
      priority: 'high',
      origin: 'health',
    });
    expect(created.rows[0]?.description).toContain('syncCampanhasRelatorios: HTTP 504.');
    expect(created.rows[0]?.description).toContain('gestaoPeriodicidades: HTTP 504.');

    await monitor.runCycle(cronProjectId, at(32));
    expect(
      (await fixture.db.query('SELECT id FROM tickets WHERE project_id=$1', [cronProjectId]))
        .rowCount,
    ).toBe(1);

    cronStatus = 'ok';
    await monitor.runCycle(cronProjectId, at(64));
    const comments = await fixture.db.query<{ body: string; visibility: string }>(
      'SELECT body,visibility FROM ticket_comments WHERE ticket_id=$1',
      [alert?.ticketId],
    );
    expect(comments.rows).toContainEqual(
      expect.objectContaining({
        body: expect.stringContaining('recuperou'),
        visibility: 'internal',
      }),
    );
    const historyService = new HealthService(
      fixture.db,
      repository,
      monitor,
      new HealthReporter(repository),
      new HealthNotifier(repository, async () => null),
    );
    await expect(
      historyService.history(cronAdmin, { days: 90, check: 'scheduled-jobs' }),
    ).resolves.toMatchObject({
      alerts: [expect.objectContaining({ ticketId: alert?.ticketId })],
    });
  });

  it('abre o alerta, envia e-mail, bloqueia SMS/chamada e resolve', async () => {
    const monitor = new HealthMonitor(repository, [fake]);
    const notifier = new HealthNotifier(
      repository,
      async () => ({ host: 'smtp.test', port: 587, from: 'zeroops@example.test' }),
      async (_smtp, message) => {
        sent.push(message);
      },
    );
    const service = new HealthService(
      fixture.db,
      repository,
      monitor,
      new HealthReporter(repository),
      notifier,
    );
    await service.saveSettings(admin, {
      enabled: true,
      recipients: { urgente: ['ops@example.test'], report: ['report@example.test'] },
    });
    await expect(repository.enabledProjects()).resolves.toContain(projectId);

    expect((await monitor.runCycle(projectId, at(0))).opened).toBe(1);
    await notifier.deliverPending();
    expect(sent.map((item) => item.subject)).toEqual([
      '[ZeroOps Saúde][URGENTE] Encomenda paga mas não integrada/processada',
    ]);
    const channels = await fixture.db.query<{
      channel: string;
      state: string;
      error_code: string | null;
    }>(
      'SELECT channel, state, error_code FROM health_notifications WHERE project_id=$1 ORDER BY channel',
      [projectId],
    );
    expect(channels.rows).toEqual([
      { channel: 'chamada', state: 'blocked', error_code: 'channel_not_configured' },
      { channel: 'email', state: 'sent', error_code: null },
      { channel: 'sms', state: 'blocked', error_code: 'channel_not_configured' },
    ]);

    const overview = await service.overview(admin);
    const alert = overview.alerts[0]!;
    expect(alert.emailState).toBe('sent');
    expect(overview.checks.find((item) => item.id === 'paid-not-integrated')?.status).toBe(
      'critical',
    );
    await service.acknowledge(admin, alert.id);
    const assigned = await service.assign(admin, alert.id, { userId: admin.id });
    expect(assigned.alerts[0]).toMatchObject({ state: 'acknowledged', assignedName: 'Admin' });

    await monitor.runCycle(projectId, at(30));
    await notifier.deliverPending();
    expect(sent).toHaveLength(1);

    status = 'ok';
    expect((await monitor.runCycle(projectId, at(31))).resolved).toBe(1);
    await notifier.deliverPending();
    expect(sent.at(-1)?.subject).toContain('[RESOLVIDO]');

    const history = await service.history(admin, { days: '90', check: 'paid-not-integrated' });
    const entry = history.alerts.find((item) => item.id === alert.id)!;
    expect(entry).toMatchObject({ state: 'resolved', acknowledgedName: 'Admin' });
    const kinds = entry.events.map((event) => [event.kind, event.actorName]);
    expect(kinds).toHaveLength(4);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['opened', null],
        ['acknowledged', 'Admin'],
        ['assigned', 'Admin'],
        ['resolved', null],
      ]),
    );
    expect(entry.notifications.map((item) => [item.kind, item.channel, item.state])).toEqual(
      expect.arrayContaining([
        ['alert', 'email', 'sent'],
        ['resolved', 'email', 'sent'],
        ['alert', 'sms', 'blocked'],
      ]),
    );
    const email = entry.notifications.find(
      (item) => item.kind === 'alert' && item.channel === 'email',
    );
    expect(email?.recipients).toEqual(['ops@example.test']);
    await expect(service.history(admin, { days: '0' })).rejects.toThrow('Filtro');
  });

  it('aceita amostras do agente apenas com o token gerado', async () => {
    const service = new HealthService(
      fixture.db,
      repository,
      new HealthMonitor(repository, []),
      new HealthReporter(repository),
      new HealthNotifier(repository, async () => null),
    );
    const { token } = await service.rotateAgentToken(admin);
    await expect(service.ingest('Bearer zoh_invalid', { host: 'web1' })).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      service.ingest(`Bearer ${token}`, { host: 'web1', tempFiles: 10 }),
    ).resolves.toEqual({ accepted: true });
    expect((await repository.latestAgentSample(projectId))?.sample).toEqual({
      host: 'web1',
      tempFiles: 10,
    });
    await service.ingest(`Bearer ${token}`, { host: 'db1', tempFiles: 1 });
    await service.ingest(`Bearer ${token}`, { host: 'web1', tempFiles: 11 });
    const hosts = await repository.latestAgentSamples(projectId);
    expect(hosts.map((item) => item.sample).sort((a, b) => a.host.localeCompare(b.host))).toEqual([
      { host: 'db1', tempFiles: 1 },
      { host: 'web1', tempFiles: 11 },
    ]);
  });

  it('entrega aos coletores só as paragens que suspendem cada sonda', async () => {
    const service = new HealthService(
      fixture.db,
      repository,
      new HealthMonitor(repository, []),
      new HealthReporter(repository),
      new HealthNotifier(repository, async () => null),
    );
    const { token } = await service.rotateAgentToken(admin);
    const night = { start: '00:30', end: '07:30', timezone: 'Europe/Lisbon', days: [1, 2] };
    await repository.saveSettings(
      projectId,
      healthSettingsSchema.parse({
        quietWindows: [
          { name: 'IBM i', ...night, checks: ['probe:dtq', 'rule:Db2Indisponivel'] },
          { name: 'Site', ...night, checks: ['site-availability'] },
        ],
      }),
      null,
    );
    await expect(service.agentConfig('Bearer zoh_invalid')).rejects.toMatchObject({ status: 401 });
    await expect(service.agentConfig(`Bearer ${token}`)).resolves.toEqual({
      probes: { dtq: { windows: [{ name: 'IBM i', ...night }] } },
    });
  });

  it('reporta explicitamente quando o envio do relatorio fica bloqueado por falta de SMTP', async () => {
    await repository.saveSettings(
      projectId,
      healthSettingsSchema.parse({
        enabled: true,
        recipients: { report: ['report@example.test'] },
      }),
      admin.id,
    );
    const service = new HealthService(
      fixture.db,
      repository,
      new HealthMonitor(repository, []),
      new HealthReporter(repository),
      new HealthNotifier(repository, async () => null),
    );

    await expect(service.reportNow(admin)).resolves.toEqual({
      state: 'blocked',
      errorCode: 'smtp_not_configured',
    });
  });

  it('não abre alertas durante a paragem planeada e abre ao fechar a janela', async () => {
    await repository.saveSettings(
      projectId,
      healthSettingsSchema.parse({
        enabled: true,
        recipients: { urgente: ['ops@example.test'] },
        quietWindows: [
          { name: 'IBM i', start: '00:55', end: '07:30', checks: ['paid-not-integrated'] },
        ],
      }),
      admin.id,
    );
    const monitor = new HealthMonitor(repository, [fake]);
    const night = (hours: number, minutes = 0) => new Date(Date.UTC(2026, 10, 10, hours, minutes));
    status = 'critical';
    expect((await monitor.runCycle(projectId, night(2))).opened).toBe(0);
    expect((await monitor.runCycle(projectId, night(7, 29))).opened).toBe(0);
    expect(await repository.openAlert(projectId, 'paid-not-integrated')).toBeNull();
    expect((await monitor.runCycle(projectId, night(7, 30))).opened).toBe(1);
    status = 'ok';
    expect((await monitor.runCycle(projectId, night(7, 31))).resolved).toBe(1);
  });

  it('a política de intervenção grava com versão e recusa conflitos, dados inválidos e clientes', async () => {
    const service = new HealthService(
      fixture.db,
      repository,
      new HealthMonitor(repository, []),
      new HealthReporter(repository),
      new HealthNotifier(repository, async () => null),
    );
    const initial = await service.incidentPolicy(admin);
    expect(initial.version).toBe(0);
    const policy = {
      ...initial.policy,
      services: [{ unit: 'php-fpm.service', engine: null, environment: 'any' as const }],
    };
    const saved = await service.saveIncidentPolicy(admin, { policy, expectedVersion: 0 });
    expect(saved.version).toBe(1);
    expect((await service.incidentPolicy(admin)).policy.services).toEqual(policy.services);
    await expect(
      service.saveIncidentPolicy(admin, { policy, expectedVersion: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.saveIncidentPolicy(admin, { policy: { rules: 'x' }, expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 400 });
    const client: User = {
      id: randomUUID(),
      projectId,
      role: 'client',
      email: `${randomUUID()}@example.test`,
      displayName: 'Cliente',
    };
    await fixture.db.query(
      'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [client.id, projectId, client.email, client.displayName, 'client', 'unusable-test-hash'],
    );
    await expect(service.incidentPolicy(client)).rejects.toMatchObject({ status: 403 });
  });
});
