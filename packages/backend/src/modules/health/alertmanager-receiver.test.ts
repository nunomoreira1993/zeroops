import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthSettingsSchema } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { autoInvestigateNewTicket } from '../agents/agent-auto-runs.js';
import { AgentRunsService } from '../agents/agent-runs.service.js';
import type { PromSeries } from '../connectors/prometheus.connector.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { alertCriticality, AlertmanagerReceiver } from './alertmanager-receiver.js';
import { AlertReconciler } from './alert-reconciler.js';
import { HealthIncidentLifecycle } from './health-incident-lifecycle.js';
import {
  IncidentMetricReadings,
  measuredExpression,
  type IncidentMetricSource,
} from './health-incident-metrics.js';
import { HealthIncidents } from './health-incidents.js';
import { HealthTickets } from './health-tickets.js';
import { HealthRepository } from './health.repository.js';

type Status = 'firing' | 'resolved';
interface AlertOptions {
  severity?: string;
  name?: string;
  instance?: string;
  env?: string;
  startsAt?: string;
  title?: string;
}

describe('AlertmanagerReceiver', () => {
  let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
  let lifecycle: HealthIncidentLifecycle;
  let runs: AgentRunsService;

  const payload = (status: Status, fingerprint: string, options: AlertOptions = {}) => ({
    version: '4',
    status,
    alerts: [alertOf(status, fingerprint, options)],
  });
  const alertOf = (status: Status, fingerprint: string, options: AlertOptions = {}) => ({
    status,
    labels: {
      alertname: options.name ?? 'RedisDown',
      severity: options.severity ?? 'critical',
      instance: options.instance ?? 'web1',
      env: options.env ?? 'production',
    },
    annotations: {
      summary: `${options.name ?? 'RedisDown'} não responde`,
      ...(options.title ? { title: options.title } : {}),
    },
    startsAt: options.startsAt ?? '2026-01-01T10:00:00Z',
    endsAt: status === 'resolved' ? '2026-01-01T10:05:00Z' : '0001-01-01T00:00:00Z',
    fingerprint,
  });

  /** Projeto isolado por teste: os alertas do mesmo ambiente juntam-se num incidente. */
  async function project(
    options: {
      copilot?: boolean;
      recipients?: string[];
      metrics?: IncidentMetricSource;
      quietWindows?: object[];
    } = {},
  ) {
    const projectId = randomUUID();
    const adminId = randomUUID();
    await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [projectId, 'Alertas']);
    await fixture.db.query(
      'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [adminId, projectId, `${adminId}@example.test`, 'Admin', 'admin', 'unusable-test-hash'],
    );
    if (options.copilot)
      await fixture.db.query(
        `INSERT INTO integration_settings
           (id,project_id,environment,kind,version,state,values_ciphertext,public_values,secret_configured,updated_by)
         VALUES ($1,$2,'quality','copilot',1,'verified','cifrado','{}',1,$3)`,
        [randomUUID(), projectId, adminId],
      );
    const repository = new HealthRepository(fixture.db);
    if (options.recipients || options.quietWindows)
      await repository.saveSettings(
        projectId,
        healthSettingsSchema.parse({
          recipients: { critica: options.recipients ?? [] },
          quietWindows: options.quietWindows ?? [],
        }),
        adminId,
      );
    const receiver = new AlertmanagerReceiver(
      fixture.db,
      repository,
      new HealthIncidents(
        fixture.db,
        repository,
        new HealthTickets(
          fixture.db,
          new TicketsService(fixture.db, [], [autoInvestigateNewTicket]),
        ),
        lifecycle,
        options.metrics
          ? new IncidentMetricReadings(fixture.db, async () => options.metrics!)
          : undefined,
      ),
    );
    const ticketOf = async (fingerprint: string) => {
      const found = await fixture.db.query<{ status: string; ticket_id: string; title: string }>(
        `SELECT t.status, t.title, a.ticket_id FROM health_external_alerts a JOIN tickets t ON t.id=a.ticket_id
          WHERE a.project_id=$1 AND a.fingerprint=$2`,
        [projectId, fingerprint],
      );
      return found.rows[0];
    };
    return { projectId, receiver, ticketOf, repository, adminId };
  }

  const comments = async (ticketId: string) =>
    (
      await fixture.db.query<{ body: string; visibility: string; author_kind: string | null }>(
        'SELECT body,visibility,author_kind FROM ticket_comments WHERE ticket_id=$1 ORDER BY created_at',
        [ticketId],
      )
    ).rows;
  const incidentState = async (ticketId: string) =>
    (
      await fixture.db.query<{ state: string }>(
        'SELECT state FROM health_incidents WHERE ticket_id=$1',
        [ticketId],
      )
    ).rows[0]?.state;

  /** Alertas ainda ativos de outros projetos (o reconciliador é global). */
  const othersActive = async (projectId: string) =>
    (
      await fixture.db.query<{ fingerprint: string; labels: string }>(
        "SELECT fingerprint, labels FROM health_external_alerts WHERE state='firing' AND project_id<>$1",
        [projectId],
      )
    ).rows.map((row) => ({
      fingerprint: row.fingerprint,
      labels: JSON.parse(row.labels) as Record<string, string>,
      annotations: {},
      startsAt: '2026-01-01T10:00:00Z',
      state: 'active',
    }));

  beforeAll(async () => {
    fixture = await startTestDatabase();
    lifecycle = new HealthIncidentLifecycle(fixture.db);
    runs = new AgentRunsService(fixture.db, [lifecycle.onRunFinished]);
  });
  afterAll(async () => {
    await fixture?.stop();
  });

  it('mapeia a criticidade a partir das labels', () => {
    expect(alertCriticality({ severity: 'critical' })).toBe('critica');
    expect(alertCriticality({ severity: 'warning' })).toBe('preventiva');
    expect(alertCriticality({ criticality: 'urgente', severity: 'info' })).toBe('urgente');
    expect(alertCriticality({})).toBe('preventiva');
  });

  it('tira o limite da regra para medir o valor e ignora regras sem limite simples', () => {
    expect(measuredExpression('mysql_up == 0')).toBe('mysql_up');
    expect(measuredExpression('node_load5 / on(instance) count by(instance)(x) > 2')).toBe(
      'node_load5 / on(instance) count by(instance)(x)',
    );
    expect(measuredExpression('absent_over_time(up{env="production"}[5m])')).toBeNull();
    expect(measuredExpression('(a - b) / a * 100 > 5\nand\n(a - b) >= 10')).toBeNull();
  });

  it('mostra no fecho o valor da métrica no disparo e na recuperação', async () => {
    const at: Date[] = [];
    const { projectId, receiver, ticketOf } = await project({
      metrics: {
        alertRules: async () => [{ name: 'RedisDown', query: 'redis_up == 0' }],
        query: async (promql, time): Promise<PromSeries[]> => {
          at.push(time!);
          expect(promql).toBe('redis_up');
          const value = time!.getTime() < Date.parse('2026-01-01T10:05:00Z') ? 0 : 1;
          return [
            { labels: { instance: 'outro' }, points: [[0, 1]] },
            { labels: { instance: 'web1', env: 'production' }, points: [[0, value]] },
          ];
        },
      },
    });
    await receiver.receive(projectId, payload('firing', 'metric1'));
    await receiver.receive(projectId, payload('resolved', 'metric1'));
    const { ticket_id: ticketId } = (await ticketOf('metric1'))!;
    expect(at.map((date) => date.toISOString()).sort()).toEqual([
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T10:05:00.000Z',
    ]);
    const notes = await comments(ticketId);
    const report = notes.find((note) => note.body.startsWith('## Relatório do incidente'))!;
    expect(report.body).toContain('**Fim (recuperação):**');
    expect(report.body).toContain('antes Indisponível (0) · depois Disponível (1)');
    expect(report.body).toContain('| Indisponível (0) → Disponível (1) |');
    const message = notes.find((note) => note.visibility === 'public')!;
    expect(message.body).toContain(
      '**Valor medido:** no início Indisponível (0); depois da recuperação Disponível (1)',
    );
  });

  it('numa paragem planeada regista sem notificar e notifica se continuar ativo no fim', async () => {
    // Duas janelas cobrem o dia inteiro, todos os dias.
    const allDay = (checks: string[]) => [
      { name: 'IBM i', start: '00:00', end: '12:00', checks },
      { name: 'IBM i', start: '12:00', end: '00:00', checks },
    ];
    const { projectId, receiver, ticketOf, repository, adminId } = await project({
      recipients: ['ops@example.test'],
      quietWindows: allDay(['rule:DtqClientesTaxaFalhas']),
    });
    const dtq = { name: 'DtqClientesTaxaFalhas' };
    const sent = async () =>
      (
        await fixture.db.query<{ kind: string }>(
          'SELECT kind FROM health_notifications WHERE project_id=$1',
          [projectId],
        )
      ).rows.map((row) => row.kind);
    const muted = async (fingerprint: string) =>
      (
        await fixture.db.query<{ muted: boolean }>(
          'SELECT muted FROM health_external_alerts WHERE project_id=$1 AND fingerprint=$2',
          [projectId, fingerprint],
        )
      ).rows.map((row) => Number(row.muted))[0];

    expect(await receiver.receive(projectId, payload('firing', 'quiet1', dtq))).toMatchObject({
      notified: 0,
      opened: 0,
      muted: 1,
    });
    expect(await muted('quiet1')).toBe(1);
    await receiver.receive(projectId, payload('resolved', 'quiet1', dtq));
    expect(await muted('quiet1')).toBe(0);
    // Outras regras continuam a notificar durante a paragem.
    await receiver.receive(projectId, payload('firing', 'other1'));
    expect(await sent()).toEqual(['alert']);
    await receiver.receive(projectId, payload('resolved', 'other1'));

    await receiver.receive(projectId, payload('firing', 'quiet2', dtq));
    expect(await receiver.releaseMuted()).toBe(0);
    await repository.saveSettings(
      projectId,
      healthSettingsSchema.parse({ recipients: { critica: ['ops@example.test'] } }),
      adminId,
    );
    expect(await receiver.releaseMuted()).toBeGreaterThanOrEqual(1);
    expect(await muted('quiet2')).toBe(0);
    expect((await ticketOf('quiet2'))?.status).toBe('new');
    await receiver.receive(projectId, payload('resolved', 'quiet2', dtq));
    expect((await sent()).filter((kind) => kind === 'alert')).toHaveLength(2);
  });

  it('abre um incidente, fecha-o com relatório e mensagem ao cliente e abre outro se voltar a disparar', async () => {
    const { projectId, receiver, ticketOf } = await project({ recipients: ['ops@example.test'] });
    expect(await receiver.receive(projectId, payload('firing', 'abc123'))).toMatchObject({
      opened: 1,
    });
    expect(await receiver.receive(projectId, payload('firing', 'abc123'))).toMatchObject({
      opened: 0,
    });
    const first = await ticketOf('abc123');
    expect(first).toMatchObject({ status: 'new', title: '[Saúde][Produção] Redis down em web1' });
    await receiver.receive(projectId, payload('resolved', 'abc123'));
    expect(await ticketOf('abc123')).toMatchObject({ status: 'resolved' });
    expect(await incidentState(first!.ticket_id)).toBe('closed');

    const notes = await comments(first!.ticket_id);
    const report = notes.find((note) => note.body.startsWith('## Relatório do incidente'));
    expect(report).toMatchObject({ visibility: 'internal', author_kind: 'system' });
    expect(report!.body).toContain('### Causa provável');
    expect(report!.body).toContain('Redis down (web1)');
    expect(report!.body).toContain('### Cronologia');
    expect(report!.body).toContain('para ops@example.test');
    const message = notes.find((note) => note.visibility === 'public');
    expect(message).toMatchObject({ author_kind: 'system' });
    expect(message!.body).toContain('Olá');
    expect(message!.body).toContain('**Duração:** 5 min');
    expect(message!.body).not.toContain('web1');

    expect(await receiver.receive(projectId, payload('firing', 'abc123'))).toMatchObject({
      opened: 1,
    });
    const second = await ticketOf('abc123');
    expect(second).toMatchObject({ status: 'new' });
    expect(second!.ticket_id).not.toBe(first!.ticket_id);

    const stored = await fixture.db.query<{ id: string; state: string; fire_count: number }>(
      `SELECT id, state, fire_count FROM health_external_alerts
        WHERE project_id=$1 AND fingerprint='abc123'`,
      [projectId],
    );
    expect(stored.rows).toEqual([{ id: expect.any(String), state: 'firing', fire_count: 2 }]);
    const ticket = await fixture.db.query<{ priority: string; environment: string }>(
      'SELECT priority, environment FROM tickets WHERE id=$1',
      [second!.ticket_id],
    );
    expect(ticket.rows[0]).toMatchObject({ priority: 'high', environment: 'production' });
    const queued = await fixture.db.query<{ kind: string; subject: string; body: string }>(
      'SELECT kind, subject, body FROM health_notifications WHERE project_id=$1 AND alert_id=$2',
      [projectId, stored.rows[0]!.id],
    );
    expect(queued.rows.map((row) => row.kind).sort()).toEqual(['alert', 'alert', 'resolved']);
    const sent = queued.rows.find((row) => row.kind === 'alert')!;
    expect(sent.subject).toBe('[ZeroOps Saúde][CRÍTICA] Redis down (web1)');
    expect(sent.body).toContain('Início: 01/01/2026, 10:00 (hora de Lisboa)');
    expect(sent.body).toContain('Ambiente: Produção');
    expect(sent.body).not.toContain('severity');
    const events = await new HealthRepository(fixture.db).alertEvents(projectId, [
      stored.rows[0]!.id,
    ]);
    expect(events.map((event) => event.kind).sort()).toEqual([
      'opened',
      'refired',
      'resolved',
      'ticket',
      'ticket',
    ]);
  });

  it('junta a cascata do mesmo ambiente num só ticket e fecha só quando tudo recupera', async () => {
    const { projectId, receiver, ticketOf } = await project();
    const site = { name: 'SiteIndisponivel', instance: 'https://site.example/' };
    const mysql = { name: 'MysqlDown', instance: 'db1', title: 'MySQL indisponível' };
    expect(await receiver.receive(projectId, payload('firing', 'site1', site))).toMatchObject({
      opened: 1,
    });
    expect(await receiver.receive(projectId, payload('firing', 'mysql1', mysql))).toMatchObject({
      opened: 0,
    });
    // Outro ambiente é outro incidente.
    expect(
      await receiver.receive(projectId, payload('firing', 'qa1', { ...mysql, env: 'quality' })),
    ).toMatchObject({ opened: 1 });
    const incident = await ticketOf('site1');
    expect((await ticketOf('mysql1'))!.ticket_id).toBe(incident!.ticket_id);
    expect((await ticketOf('qa1'))!.ticket_id).not.toBe(incident!.ticket_id);
    expect(incident!.title).toBe('[Saúde][Produção] MySQL indisponível em db1 (+1 alerta)');
    // Falha que começa mais de 10 min depois (ex.: disco) é outro incidente, mesmo com a cascata ativa.
    expect(
      await receiver.receive(
        projectId,
        payload('firing', 'disk1', { name: 'DiscoCritico', startsAt: '2026-01-01T10:12:00Z' }),
      ),
    ).toMatchObject({ opened: 1 });
    expect((await ticketOf('disk1'))!.ticket_id).not.toBe(incident!.ticket_id);
    // Aviso de um disparo anterior do mesmo alerta (mesmo fingerprint) não entra no relatório.
    const mysqlId = (
      await fixture.db.query<{ id: string }>(
        `SELECT id FROM health_external_alerts WHERE project_id=$1 AND fingerprint='mysql1'`,
        [projectId],
      )
    ).rows[0]!.id;
    await fixture.db.query(
      `INSERT INTO health_notifications (id,project_id,alert_id,kind,channel,recipients,subject,body,state,created_at)
       VALUES ($1,$2,$3,'alert','email','antigo@example.test','antigo','antigo','sent','2025-12-01 10:00:00')`,
      [randomUUID(), projectId, mysqlId],
    );

    // A resolução por reconciliação não traz anotações: o título guardado é reutilizado.
    await receiver.receive(
      projectId,
      payload('resolved', 'mysql1', { ...mysql, title: undefined }),
    );
    expect(await ticketOf('site1')).toMatchObject({ status: 'new' });
    expect(await incidentState(incident!.ticket_id)).toBe('open');
    await receiver.receive(projectId, payload('resolved', 'site1', site));
    expect(await ticketOf('site1')).toMatchObject({ status: 'resolved' });
    const report = (await comments(incident!.ticket_id)).find((note) =>
      note.body.startsWith('## Relatório do incidente'),
    );
    expect(report!.body).toMatch(/### Causa provável\nMySQL indisponível \(db1\)/);
    expect(report!.body).toContain('Outros alertas no mesmo incidente');
    expect(report!.body).not.toContain('antigo@example.test');
    expect(
      (await comments(incident!.ticket_id)).some((note) =>
        note.body.includes('Recuperou: MySQL indisponível (db1)'),
      ),
    ).toBe(true);
  });

  it('com o Copilot investiga ao abrir e fecha com a análise pós-incidente', async () => {
    const { projectId, receiver, ticketOf } = await project({ copilot: true });
    await receiver.receive(projectId, payload('firing', 'cop1', { name: 'MysqlDown' }));
    const { ticket_id: ticketId } = (await ticketOf('cop1'))!;
    const triggers = async () =>
      (
        await fixture.db.query<{ run_trigger: string; status: string }>(
          'SELECT run_trigger,status FROM agent_runs WHERE ticket_id=$1 ORDER BY created_at',
          [ticketId],
        )
      ).rows;
    expect(await triggers()).toEqual([{ run_trigger: 'auto', status: 'queued' }]);

    // Recupera com a investigação ainda em fila: o fecho espera pelo fim do run.
    await receiver.receive(projectId, payload('resolved', 'cop1', { name: 'MysqlDown' }));
    expect(await incidentState(ticketId)).toBe('recovered');
    const first = await runs.claimNext();
    expect(first?.runId).toBeDefined();
    expect(first?.ticket.key).toBeDefined();
    await runs.complete(first!.lease, { summary: 'MySQL parado.', replyDraft: null, evidence: [] });
    expect(await incidentState(ticketId)).toBe('reviewing');
    expect((await triggers()).map((run) => run.run_trigger)).toEqual(['auto', 'incident_review']);

    const review = await runs.claimNext();
    await runs.complete(review!.lease, {
      summary: 'O MySQL parou e foi reiniciado.',
      replyDraft: 'A base de dados esteve indisponível e foi reposta.',
      evidence: [],
      clientQuestions: ['Não deve ser enviada'],
    });
    expect(await incidentState(ticketId)).toBe('closed');
    expect(await ticketOf('cop1')).toMatchObject({ status: 'resolved' });
    const message = (await comments(ticketId)).find(
      (note) => note.visibility === 'public' && note.author_kind === 'system',
    );
    expect(message!.body).toContain('A base de dados esteve indisponível e foi reposta.');
    expect(JSON.stringify(await comments(ticketId))).not.toContain('Não deve ser enviada');
  });

  it('retoma pelo sweep um incidente cuja análise terminou sem passar pelo hook', async () => {
    const { projectId, receiver, ticketOf } = await project({ copilot: true });
    await receiver.receive(projectId, payload('firing', 'sw1'));
    const { ticket_id: ticketId } = (await ticketOf('sw1'))!;
    await fixture.db.query("UPDATE agent_runs SET status='cancelled' WHERE ticket_id=$1", [
      ticketId,
    ]);
    await receiver.receive(projectId, payload('resolved', 'sw1'));
    expect(await incidentState(ticketId)).toBe('reviewing');
    await fixture.db.query("UPDATE agent_runs SET status='failed' WHERE ticket_id=$1", [ticketId]);
    expect(await lifecycle.sweep()).toBeGreaterThanOrEqual(1);
    expect(await incidentState(ticketId)).toBe('closed');
    expect(await ticketOf('sw1')).toMatchObject({ status: 'resolved' });
  });

  it('regista um alerta de que só chegou a resolução e fecha logo o ticket', async () => {
    const { projectId, receiver, ticketOf } = await project();
    expect(await receiver.receive(projectId, payload('resolved', 'missed1'))).toMatchObject({
      opened: 1,
    });
    const missed = await ticketOf('missed1');
    expect(missed).toMatchObject({ status: 'resolved' });
    const description = await fixture.db.query<{ description: string }>(
      'SELECT description FROM tickets WHERE id=$1',
      [missed!.ticket_id],
    );
    expect(description.rows[0]!.description).toContain('não foi recebido em tempo real');
    expect(await receiver.receive(projectId, payload('resolved', 'missed1'))).toMatchObject({
      opened: 0,
    });
  });

  it('não muda o estado quando o ticket já está em trabalho, mas deixa o relatório', async () => {
    const { projectId, receiver, ticketOf } = await project();
    await receiver.receive(projectId, payload('firing', 'busy1'));
    const busy = await ticketOf('busy1');
    await fixture.db.query("UPDATE tickets SET status='implementing' WHERE id=$1", [
      busy!.ticket_id,
    ]);
    await receiver.receive(projectId, payload('resolved', 'busy1'));
    expect(await ticketOf('busy1')).toMatchObject({ status: 'implementing' });
    const notes = await comments(busy!.ticket_id);
    expect(notes.some((note) => note.body.startsWith('## Relatório do incidente'))).toBe(true);
    expect(notes.some((note) => note.body.includes('trabalho em curso'))).toBe(true);
  });

  it('não abre ticket para alertas preventivos e rejeita payloads inválidos', async () => {
    const { projectId, receiver } = await project();
    expect(
      await receiver.receive(projectId, payload('firing', 'def456', { severity: 'warning' })),
    ).toMatchObject({ opened: 0 });
    await expect(receiver.receive(projectId, { alerts: [{ status: 'x' }] })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('reconcilia: fecha o alerta ausente do Alertmanager só depois da margem', async () => {
    const { projectId, receiver, ticketOf } = await project();
    await receiver.receive(projectId, payload('firing', 'gone1'));
    await receiver.receive(projectId, payload('firing', 'gone2', { name: 'MysqlDown' }));
    let now = 0;
    let active = ['gone1', 'gone2'];
    const others = await othersActive(projectId);
    const reconciler = new AlertReconciler(
      fixture.db,
      receiver,
      {
        activeAlerts: async () => [
          ...others,
          ...active.map((fingerprint) => ({
            ...alertOf('firing', fingerprint, fingerprint === 'gone2' ? { name: 'MysqlDown' } : {}),
            state: 'active',
          })),
        ],
      },
      60_000,
      () => now,
    );
    expect(await reconciler.run()).toBe(0);
    active = ['gone2'];
    expect(await reconciler.run()).toBe(0);
    now = 60_000;
    expect(await reconciler.run()).toBe(1);
    // O outro alerta do incidente continua ativo: o ticket fica aberto.
    expect(await ticketOf('gone1')).toMatchObject({ status: 'new' });
    active = [];
    now = 120_000;
    expect(await reconciler.run()).toBe(0);
    now = 180_000;
    expect(await reconciler.run()).toBe(1);
    expect(await ticketOf('gone1')).toMatchObject({ status: 'resolved' });
    const failing = new AlertReconciler(fixture.db, receiver, {
      activeAlerts: () => Promise.reject(new Error('Alertmanager em baixo')),
    });
    await expect(failing.run()).rejects.toThrow('Alertmanager em baixo');
  });

  it('reconcilia: regista o alerta ativo no Alertmanager cuja notificação não chegou', async () => {
    const { projectId, receiver, ticketOf } = await project();
    await receiver.receive(projectId, payload('firing', 'dedup1'));
    await receiver.receive(projectId, payload('resolved', 'dedup1'));
    const first = await ticketOf('dedup1');
    expect(first).toMatchObject({ status: 'resolved' });
    const startsAt = Date.parse('2026-01-01T11:00:00Z');
    let now = startsAt + 30_000;
    const at = { startsAt: '2026-01-01T11:00:00Z' };
    const otherSite = {
      ...alertOf('firing', 'outro1', at),
      labels: { alertname: 'SiteDown', severity: 'critical', project: 'outro' },
    };
    const others = await othersActive(projectId);
    const reconciler = new AlertReconciler(
      fixture.db,
      receiver,
      {
        activeAlerts: async () => [
          ...others,
          { ...alertOf('firing', 'dedup1', at), state: 'active' },
          { ...alertOf('firing', 'muted1', at), state: 'suppressed' },
          { ...alertOf('firing', 'fresh1', { ...at, name: 'MysqlDown' }), state: 'active' },
          { ...otherSite, state: 'active' },
        ],
      },
      3_600_000,
      () => now,
    );
    expect(await reconciler.run()).toBe(0);
    now = startsAt + 90_000;
    expect(await reconciler.run()).toBe(2);
    const second = await ticketOf('dedup1');
    expect(second).toMatchObject({ status: 'new' });
    expect(second!.ticket_id).not.toBe(first!.ticket_id);
    expect((await ticketOf('fresh1'))!.ticket_id).toBe(second!.ticket_id);
    expect(await ticketOf('muted1')).toBeUndefined();
    expect(await ticketOf('outro1')).toBeUndefined();
    expect(await reconciler.run()).toBe(0);
  });
});
