import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  healthAgentSampleSchema,
  healthAssignSchema,
  healthHistoryQuerySchema,
  healthResumeInputSchema,
  healthSettingsSchema,
  healthSuspendInputSchema,
  healthProbes,
  incidentPolicyInputSchema,
  incidentDemoInputSchema,
  type HealthAlertHistoryEntry,
  type HealthHistory,
  type HealthOverview,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { requireInstanceAdmin, requireMember } from '../identity/membership.js';
import { HealthSuspensions, activeSuspension } from '../incidents/health-suspension.js';
import { IncidentPolicyRepository } from '../incidents/incident-policy.repository.js';
import { incidentDemoPayload } from '../incidents/incident-demo.js';
import type { AlertmanagerReceiver } from './alertmanager-receiver.js';
import type { AlertReconciler } from './alert-reconciler.js';
import type { AlertSpool } from './alert-spool.js';
import { CRITICALITY_ORDER, HEALTH_CATALOG } from './health-catalog.js';
import type { HealthIncidentLifecycle } from './health-incident-lifecycle.js';
import type { HealthMonitor } from './health-monitor.js';
import type { HealthNotifier } from './health-notifier.js';
import type { HealthReporter } from './health-reporter.js';
import type { HealthRepository } from './health.repository.js';
import type { PrometheusRulesSync } from './prometheus-rules-sync.js';
import type { RemoteWriteForwarder, RemoteWriteRequest } from './remote-write-forwarder.js';

const iso = (value: Date | null) => (value ? value.toISOString() : null);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** Valida o formato do Bearer `zoh_` e devolve o hash (a existência é verificada na BD). */
function agentTokenHash(authorization: string | undefined) {
  const token = /^Bearer\s+(zoh_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '')?.[1];
  if (!token) throw new DomainError('UNAUTHENTICATED', 'Token do agente inválido.', 401);
  return tokenHash(token);
}
const alertId = z.uuid();
const AGENT_TOKEN_FALLBACK_MS = 24 * 3600000;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Casos de uso da pagina Saude: consulta, configuracao, rececao/atribuicao de alertas e ingestao do agente. */
export class HealthService {
  constructor(
    private readonly db: Database,
    private readonly repository: HealthRepository,
    private readonly monitor: HealthMonitor,
    private readonly reporter: HealthReporter,
    private readonly notifier: HealthNotifier,
    private readonly alertmanager?: AlertmanagerReceiver,
    private readonly remoteWrite?: RemoteWriteForwarder,
    private readonly alertSpool?: AlertSpool,
    private readonly alertReconciler?: AlertReconciler,
    private readonly incidentLifecycle?: HealthIncidentLifecycle,
    private readonly rulesSync?: PrometheusRulesSync,
  ) {}

  /** Tokens do agente validados na BD; só usados quando a BD falha (revogação continua a valer). */
  private readonly agentTokens = new Map<string, { projectId: string; at: number }>();

  /** Equipa do projeto (qualquer papel exceto cliente); `manage` = administracao do projeto/instancia. */
  private async access(actor: User, manage = false) {
    const member = actor.instanceAdmin
      ? await requireInstanceAdmin(this.db, actor)
      : await requireMember(this.db, actor);
    const canManage = Boolean(actor.instanceAdmin) || member.role === 'admin';
    if (!actor.instanceAdmin && member.role === 'client')
      throw new DomainError('FORBIDDEN', 'A página Saúde é reservada à equipa.', 403);
    if (manage && !canManage)
      throw new DomainError('FORBIDDEN', 'Configuração reservada à administração do projeto.', 403);
    return { projectId: actor.projectId, canManage };
  }

  /** Autoriza a leitura da Saúde (equipa do projeto) para módulos auxiliares, como os gráficos. */
  async viewer(actor: User) {
    const { projectId } = await this.access(actor);
    return { projectId };
  }

  /** Devolve o estado das verificações, alertas, configuração e equipa do projeto atual. */
  async overview(actor: User): Promise<HealthOverview> {
    const { projectId, canManage } = await this.access(actor);
    const record = await this.repository.settings(projectId);
    const [states, alerts, members, agent] = await Promise.all([
      this.repository.states(projectId),
      this.repository.recentAlerts(projectId, new Date(Date.now() - 7 * 86400000)),
      this.repository.teamMembers(projectId),
      this.repository.latestAgentSample(projectId),
    ]);
    const titles = new Map(HEALTH_CATALOG.map((entry) => [entry.id, entry.title]));
    return {
      settings: record?.settings ?? healthSettingsSchema.parse({}),
      configured: Boolean(record),
      canManage,
      agentTokenConfigured: Boolean(record?.agentTokenHash),
      lastCycleAt: iso(record?.lastCycleAt ?? null),
      lastReportAt: iso(record?.lastReportAt ?? null),
      lastAgentSampleAt: iso(agent?.receivedAt ?? null),
      checks: HEALTH_CATALOG.map(({ confirmMinutes: _confirm, ...entry }) => {
        const state = states.get(entry.id);
        return {
          ...entry,
          status: state?.status ?? 'unknown',
          value: state?.value ?? null,
          unit: state?.unit ?? null,
          summary: state?.summary ?? 'Ainda não verificado.',
          checkedAt: iso(state?.checkedAt ?? null),
          statusSince: iso(state?.statusSince ?? null),
        };
      }),
      alerts: alerts
        .sort(
          (a, b) =>
            Number(Boolean(a.resolvedAt)) - Number(Boolean(b.resolvedAt)) ||
            CRITICALITY_ORDER[a.criticality] - CRITICALITY_ORDER[b.criticality] ||
            b.openedAt.getTime() - a.openedAt.getTime(),
        )
        .map((alert) => ({
          id: alert.id,
          checkId: alert.checkId,
          title: titles.get(alert.checkId) ?? alert.checkId,
          criticality: alert.criticality,
          severity: alert.severity,
          state: alert.resolvedAt ? 'resolved' : alert.acknowledgedAt ? 'acknowledged' : 'open',
          summary: alert.summary,
          openedAt: alert.openedAt.toISOString(),
          acknowledgedAt: iso(alert.acknowledgedAt),
          acknowledgedBy: alert.acknowledgedBy,
          assignedTo: alert.assignedTo,
          assignedName: alert.assignedName,
          resolvedAt: iso(alert.resolvedAt),
          notifyCount: alert.notifyCount,
          emailState: alert.emailState,
          emailErrorCode: alert.emailErrorCode,
        })),
      members,
      alertRulesSync: this.rulesSync?.status() ?? {
        state: 'disabled',
        syncedAt: null,
        message: 'Geração das regras não configurada.',
      },
      suspension: await this.suspensions.state(projectId),
    };
  }

  private get suspensions() {
    return new HealthSuspensions(this.db);
  }

  /** Estado da suspensão manual da Saúde (equipa do projeto). */
  async suspension(actor: User) {
    const { projectId } = await this.access(actor);
    return this.suspensions.state(projectId);
  }

  /** Suspende a Saúde num ambiente: só regista os alertas e cancela o trabalho em curso. */
  async suspend(actor: User, input: unknown) {
    const { projectId } = await this.access(actor, true);
    const parsed = healthSuspendInputSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        'VALIDATION',
        'Indique o ambiente e um motivo (5 a 500 caracteres).',
        400,
      );
    await this.suspensions.suspend(
      projectId,
      parsed.data.environment,
      parsed.data.reason,
      actor.id,
    );
    return this.suspensions.state(projectId);
  }

  /** Retoma a Saúde: sondas, notificações e fluxos de incidente voltam a correr. */
  async resume(actor: User, input: unknown) {
    const { projectId } = await this.access(actor, true);
    const parsed = healthResumeInputSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('VALIDATION', 'Ambiente inválido.', 400);
    await this.suspensions.resume(projectId, parsed.data.environment, actor.id);
    return this.suspensions.state(projectId);
  }

  /** Política de intervenção dos incidentes (equipa vê; administração altera). */
  async incidentPolicy(actor: User) {
    const { projectId } = await this.access(actor);
    return new IncidentPolicyRepository(this.db).view(projectId);
  }

  async saveIncidentPolicy(actor: User, input: unknown) {
    const { projectId } = await this.access(actor, true);
    const parsed = incidentPolicyInputSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        'VALIDATION',
        `Política inválida: ${parsed.error.issues[0]?.path.join('.') || 'formato'}.`,
        400,
      );
    return new IncidentPolicyRepository(this.db).save(
      projectId,
      parsed.data.policy,
      parsed.data.expectedVersion,
      actor.id,
    );
  }

  /** Injeta um alerta sintético no recetor real; o incidente fica no QA com ações simuladas. */
  async startIncidentDemo(actor: User, input: unknown) {
    const { projectId } = await this.access(actor, true);
    const parsed = incidentDemoInputSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError('VALIDATION', 'Cenário de demonstração inválido.', 400);
    if (!this.alertmanager)
      throw new DomainError('UNAVAILABLE', 'Receção de alertas indisponível.', 503);
    const payload = incidentDemoPayload(parsed.data.scenario);
    const result = await this.alertmanager.receive(projectId, payload);
    if (!result.opened)
      throw new DomainError(
        'INCIDENT_DEMO_NOT_OPENED',
        'O incidente de demonstração não foi aberto (Saúde suspensa no QA ou paragem planeada ativa).',
        409,
      );
    const stored = (
      await this.db.query<{ ticket_id: string | null }>(
        'SELECT ticket_id FROM health_external_alerts WHERE project_id=$1 AND fingerprint=$2',
        [projectId, payload.alerts[0]!.fingerprint],
      )
    ).rows[0];
    return { scenario: parsed.data.scenario, ticketId: stored?.ticket_id ?? null };
  }

  /** Valida e guarda a configuração de saúde do projeto; restrito à administração. */
  async saveSettings(actor: User, input: unknown) {
    const { projectId } = await this.access(actor, true);
    const parsed = healthSettingsSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        'VALIDATION',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    await this.repository.saveSettings(projectId, parsed.data, actor.id);
    // As regras de alerta vão para os ficheiros do Prometheus; o estado fica na resposta.
    await this.rulesSync?.sync();
    return this.overview(actor);
  }

  /** Gera um novo token do agente; so o hash fica guardado e o valor e mostrado uma unica vez. */
  async rotateAgentToken(actor: User) {
    const { projectId } = await this.access(actor, true);
    if (!(await this.repository.settings(projectId)))
      await this.repository.saveSettings(projectId, healthSettingsSchema.parse({}), actor.id);
    const token = `zoh_${randomBytes(32).toString('base64url')}`;
    await this.repository.setAgentTokenHash(projectId, tokenHash(token));
    return { token };
  }

  /** Confirma a receção de um alerta aberto por um membro da equipa. */
  async acknowledge(actor: User, id: string) {
    const { projectId } = await this.access(actor);
    const alert = await this.repository.alert(projectId, alertId.parse(id));
    if (!alert || !(await this.repository.acknowledge(projectId, alert.id, actor.id)))
      throw new DomainError('NOT_FOUND', 'Alerta não encontrado.', 404);
    if (!alert.acknowledgedAt)
      await this.repository.recordAlertEvent({
        projectId,
        alertId: alert.id,
        kind: 'acknowledged',
        actorId: actor.id,
      });
    return this.overview(actor);
  }

  /** Atribui ou remove o responsável de um alerta entre membros ativos da equipa. */
  async assign(actor: User, id: string, input: unknown) {
    const { projectId } = await this.access(actor);
    const { userId } = healthAssignSchema.parse(input);
    const member = userId
      ? (await this.repository.teamMembers(projectId)).find((item) => item.id === userId)
      : null;
    if (userId && !member)
      throw new DomainError(
        'VALIDATION',
        'Só é possível atribuir a membros da equipa do projeto.',
        400,
      );
    const alert = await this.repository.alert(projectId, alertId.parse(id));
    if (!alert || !(await this.repository.assign(projectId, alert.id, userId)))
      throw new DomainError('NOT_FOUND', 'Alerta não encontrado.', 404);
    if (alert.assignedTo !== userId)
      await this.repository.recordAlertEvent({
        projectId,
        alertId: alert.id,
        kind: member ? 'assigned' : 'unassigned',
        actorId: actor.id,
        detail: member?.displayName ?? alert.assignedName,
      });
    return this.overview(actor);
  }

  /** Histórico dos alarmes do período: cronologia de eventos e registo de notificações enviadas. */
  async history(actor: User, query: unknown): Promise<HealthHistory> {
    const { projectId } = await this.access(actor);
    const parsed = healthHistoryQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new DomainError('VALIDATION', 'Filtro do histórico inválido.', 400);
    const { days, check } = parsed.data;
    const since = new Date(Date.now() - days * 86400000);
    const titles = new Map(HEALTH_CATALOG.map((entry) => [entry.id, entry.title]));
    const [internal, external] = await Promise.all([
      this.repository.historyAlerts(projectId, since, check),
      check ? Promise.resolve([]) : this.repository.historyExternalAlerts(projectId, since),
    ]);
    const ids = [...internal.map((alert) => alert.id), ...external.map((alert) => alert.id)];
    const [events, notifications] = await Promise.all([
      this.repository.alertEvents(projectId, ids),
      this.repository.notificationLog(projectId, since, ids),
    ]);
    const notificationViews = notifications.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      sentAt: iso(item.sentAt),
    }));
    const eventsOf = (id: string) =>
      events
        .filter((event) => event.alertId === id)
        .map(({ alertId: _alert, at, ...event }) => ({ ...event, at: at.toISOString() }));
    const notificationsOf = (id: string) =>
      notificationViews.filter((item) => item.alertId === id).reverse();
    const alerts: HealthAlertHistoryEntry[] = [
      ...internal.map((alert) => ({
        id: alert.id,
        source: 'internal' as const,
        checkId: alert.checkId,
        title: titles.get(alert.checkId) ?? alert.checkId,
        criticality: alert.criticality,
        state: alert.resolvedAt
          ? ('resolved' as const)
          : alert.acknowledgedAt
            ? ('acknowledged' as const)
            : ('open' as const),
        summary: alert.summary,
        openedAt: alert.openedAt.toISOString(),
        resolvedAt: iso(alert.resolvedAt),
        acknowledgedAt: iso(alert.acknowledgedAt),
        acknowledgedName: alert.acknowledgedName,
        assignedName: alert.assignedName,
        ticketId: alert.ticketId,
        events: eventsOf(alert.id),
        notifications: notificationsOf(alert.id),
      })),
      ...external.map((alert) => ({
        id: alert.id,
        source: 'prometheus' as const,
        checkId: null,
        title: `Prometheus: ${alert.alertName}`,
        criticality: alert.criticality,
        state: alert.state === 'resolved' ? ('resolved' as const) : ('open' as const),
        summary: alert.summary,
        openedAt: alert.startsAt.toISOString(),
        resolvedAt: iso(alert.resolvedAt),
        acknowledgedAt: null,
        acknowledgedName: null,
        assignedName: null,
        ticketId: alert.ticketId,
        events: eventsOf(alert.id),
        notifications: notificationsOf(alert.id),
      })),
    ].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    return {
      since: since.toISOString(),
      days,
      alerts,
      notifications: notificationViews.filter(
        (item) => item.createdAt >= since.toISOString() && (!check || ids.includes(item.alertId!)),
      ),
    };
  }

  /** Executa um ciclo de verificação e tenta entregar notificações já enfileiradas. */
  async runNow(actor: User) {
    const { projectId } = await this.access(actor, true);
    if (!(await this.repository.settings(projectId)))
      throw new DomainError(
        'NOT_CONFIGURED',
        'Grave primeiro a configuração da monitorização.',
        409,
      );
    const outcome = await this.monitor.runCycle(projectId);
    await this.notifier.deliverPending();
    return { opened: outcome.opened, resolved: outcome.resolved, notified: outcome.notified };
  }

  /** Enfileira um relatório manual e devolve o estado efetivo da tentativa de entrega. */
  async reportNow(actor: User) {
    const { projectId } = await this.access(actor, true);
    if (!(await this.repository.settings(projectId)))
      throw new DomainError(
        'NOT_CONFIGURED',
        'Grave primeiro a configuração da monitorização.',
        409,
      );
    const notificationId = await this.reporter.sendIfDue(projectId, new Date(), true);
    if (!notificationId) return { status: 'not_queued' as const, errorCode: null };
    await this.notifier.deliverPending();
    const delivery = await this.repository.notificationDelivery(projectId, notificationId);
    if (!delivery) throw new Error('Relatório enfileirado sem registo de entrega.');
    return delivery;
  }

  /** Recebe a amostra do agente do servidor; autenticado apenas pelo token (Bearer). */
  async ingest(authorization: string | undefined, body: unknown) {
    const projectId = await this.projectForAgent(authorization);
    const parsed = healthAgentSampleSchema.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION', 'Amostra do agente inválida.', 400);
    await this.repository.insertAgentSample(projectId, parsed.data);
    return { accepted: true };
  }

  /**
   * Configuração para os coletores dos servidores (token do agente): janelas em que cada sonda
   * fica suspensa. O coletor avalia-as localmente e guarda a última cópia para quando o ZeroOps
   * não responder.
   */
  async agentConfig(authorization: string | undefined) {
    const projectId = await this.projectForAgent(authorization);
    const settings = (await this.repository.settings(projectId))?.settings;
    const windows = settings?.quietWindows ?? [];
    const suspension = await activeSuspension(
      this.db,
      projectId,
      settings?.sourceEnvironment ?? 'production',
    );
    // Suspensa: duas janelas que juntas cobrem o dia inteiro, para todas as sondas.
    const suspendedWindows = suspension
      ? [
          {
            name: 'Saúde suspensa',
            start: '00:00',
            end: '12:00',
            timezone: 'Europe/Lisbon',
            days: ALL_DAYS,
          },
          {
            name: 'Saúde suspensa',
            start: '12:00',
            end: '00:00',
            timezone: 'Europe/Lisbon',
            days: ALL_DAYS,
          },
        ]
      : [];
    return {
      ...(suspension ? { suspended: { reason: suspension.reason } } : {}),
      probes: Object.fromEntries(
        healthProbes.map((probe) => [
          probe.id,
          {
            windows: [
              ...suspendedWindows,
              ...windows
                .filter((window) => window.checks.includes(`probe:${probe.id}`))
                .map(({ name, start, end, timezone, days }) => ({
                  name,
                  start,
                  end,
                  timezone,
                  days,
                })),
            ],
          },
        ]),
      ),
    };
  }

  /**
   * Webhook do Alertmanager, autenticado com o mesmo token do agente do servidor. Se a BD do
   * ZeroOps falhar (incluindo na validação do token), o webhook fica na fila em disco e é
   * reprocessado — e o token validado — quando a BD voltar.
   */
  async receiveAlerts(authorization: string | undefined, body: unknown) {
    const receiver = this.alertmanager;
    if (!receiver) throw new DomainError('UNAVAILABLE', 'Receção de alertas não configurada.', 503);
    const hash = agentTokenHash(authorization);
    if (!this.alertSpool) return receiver.receive(await this.projectForHash(hash), body);
    // Os webhooks em fila são mais antigos e têm de ser tratados primeiro.
    await this.drainAlerts().catch(() => 0);
    try {
      return await receiver.receive(await this.projectForHash(hash), body);
    } catch (error) {
      if (error instanceof DomainError || !(await this.alertSpool.save(hash, body))) throw error;
      return { accepted: 0, notified: 0, opened: 0, spooled: true };
    }
  }

  /** Reprocessa os webhooks em fila (chamado também periodicamente pela API). */
  async drainAlerts() {
    const receiver = this.alertmanager;
    if (!this.alertSpool || !receiver) return 0;
    return this.alertSpool.drain(async (hash, body) =>
      receiver.receive(await this.projectForHash(hash), body),
    );
  }

  /**
   * Tarefa periódica da API: reprocessa a fila e fecha os alertas que já não estão ativos no
   * Alertmanager (resolução perdida). A reconciliação só corre com a fila vazia.
   */
  async maintainAlerts() {
    const drained = await this.drainAlerts();
    const incidents = await this.sweepIncidents();
    // Repõe as regras do Prometheus se os ficheiros faltarem ou divergirem (ex.: volume novo).
    await this.rulesSync?.sync();
    if (!this.alertReconciler || (this.alertSpool && (await this.alertSpool.pending()) > 0))
      return { drained, reconciled: 0, incidents };
    return { drained, reconciled: await this.alertReconciler.run(), incidents };
  }

  /** Retoma o fecho de incidentes parados (ex.: executor reiniciado a meio da análise). */
  private async sweepIncidents() {
    if (!this.incidentLifecycle) return 0;
    try {
      return await this.incidentLifecycle.sweep();
    } catch {
      return 0;
    }
  }

  /** Métricas do Prometheus de Produção (remote write), autenticadas com o token do agente. */
  async receiveMetrics(
    authorization: string | undefined,
    readRequest: () => Promise<RemoteWriteRequest>,
  ) {
    await this.projectForAgent(authorization);
    if (!this.remoteWrite)
      throw new DomainError('UNAVAILABLE', 'Receção de métricas não configurada.', 503);
    return this.remoteWrite.forward(await readRequest());
  }

  private projectForAgent(authorization: string | undefined) {
    return this.projectForHash(agentTokenHash(authorization));
  }

  private async projectForHash(hash: string) {
    let projectId: string | null;
    try {
      projectId = await this.repository.projectByAgentToken(hash);
    } catch (error) {
      // BD indisponível: aceita só um token já validado recentemente, para não perder alertas/métricas.
      const cached = this.agentTokens.get(hash);
      if (cached && Date.now() - cached.at < AGENT_TOKEN_FALLBACK_MS) return cached.projectId;
      throw error;
    }
    if (!projectId) {
      this.agentTokens.delete(hash);
      throw new DomainError('UNAUTHENTICATED', 'Token do agente inválido.', 401);
    }
    if (this.agentTokens.size > 100) this.agentTokens.clear();
    this.agentTokens.set(hash, { projectId, at: Date.now() });
    return projectId;
  }
}
