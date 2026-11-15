import type {
  CorrelatedEvent,
  OperationsMetrics,
  QueueMetric,
  User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import type { Queryable } from '../identity/membership.js';
import { projectPermissionContext } from '../identity/project-permissions.js';

/**
 * P11 — métricas operacionais e correlação por projeto, só para a equipa. Lê apenas o que foi
 * registado (jobs, etapas, eventos de lease, uso/quota reportados pelo Copilot, ferramentas,
 * entregas, intervenções e incidentes); ausência de registo devolve `null`, nunca um valor estimado.
 */

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const maybe = (value: unknown) =>
  value === null || value === undefined ? null : Math.round(Number(value) * 100) / 100;
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

async function rows<T>(db: Queryable, sql: string, values: unknown[]) {
  return (await db.query<T & Record<string, unknown>>(sql, values)).rows;
}

type QueueRow = {
  pending: unknown;
  running: unknown;
  oldest: unknown;
  wait: unknown;
  started: unknown;
  succeeded: unknown;
  failed: unknown;
  cancelled: unknown;
};

/** Agregado de fila para uma tabela de jobs com `status`, `created_at` e `started_at`. */
function queueSql(table: string, extraStatus = '') {
  return `SELECT
    SUM(status='queued') AS pending, SUM(status='running') AS running,
    TIMESTAMPDIFF(SECOND, MIN(CASE WHEN status='queued' THEN created_at END), NOW(3)) AS oldest,
    AVG(CASE WHEN started_at >= NOW(3) - INTERVAL $2 DAY
      THEN TIMESTAMPDIFF(MICROSECOND, created_at, started_at)/1000000 END) AS wait,
    SUM(started_at >= NOW(3) - INTERVAL $2 DAY) AS started,
    SUM(status='succeeded' AND finished_at >= NOW(3) - INTERVAL $2 DAY) AS succeeded,
    SUM(status='failed' AND finished_at >= NOW(3) - INTERVAL $2 DAY) AS failed,
    SUM(status='cancelled' AND finished_at >= NOW(3) - INTERVAL $2 DAY) AS cancelled
    FROM ${table} WHERE project_id=$1${extraStatus}`;
}

const queueMetric = (kind: QueueMetric['kind'], row: QueueRow | undefined): QueueMetric => ({
  kind,
  pending: num(row?.pending),
  running: num(row?.running),
  oldestPendingSeconds: maybe(row?.oldest),
  meanWaitSeconds: maybe(row?.wait),
  started: num(row?.started),
  succeeded: num(row?.succeeded),
  failed: num(row?.failed),
  cancelled: num(row?.cancelled),
});

/**
 * P11 — métricas operacionais por projeto (filas, etapas, leases, intervenção humana, Copilot,
 * ferramentas, entregas e Health). Só agrega valores registados; nunca estima o que falta.
 */
export class OperationsMetricsService {
  constructor(private readonly db: Database) {}

  /** Resumo da janela (1..90 dias) com correlação de falhas; só equipa do projeto. */
  async summary(actor: User, projectId: string, days = 30): Promise<OperationsMetrics> {
    const context = await projectPermissionContext(this.db, actor, projectId);
    if (!context.isAdmin && context.actor.role === 'client')
      throw new DomainError('FORBIDDEN', 'Métricas operacionais só para a equipa.', 403);
    const windowDays = Math.min(90, Math.max(1, Math.trunc(Number(days) || 30)));
    const p = [projectId, windowDays];
    const db = this.db;

    const [agentQueue] = await rows<QueueRow>(db, queueSql('agent_runs'), p);
    const [assistantQueue] = await rows<QueueRow>(db, queueSql('flow_assistant_requests'), p);
    const [routingQueue] = await rows<QueueRow>(db, queueSql('ticket_routing_jobs'), p);
    const [deliveryQueue] = await rows<QueueRow>(
      db,
      `SELECT SUM(state='queued') AS pending,
        SUM(state IN ('integrating','starting','publishing')) AS running,
        TIMESTAMPDIFF(SECOND, MIN(CASE WHEN state='queued' THEN created_at END), NOW(3)) AS oldest,
        NULL AS wait, SUM(created_at >= NOW(3) - INTERVAL $2 DAY) AS started,
        SUM(state='published' AND finished_at >= NOW(3) - INTERVAL $2 DAY) AS succeeded,
        SUM(state IN ('failed','conflict') AND finished_at >= NOW(3) - INTERVAL $2 DAY) AS failed,
        SUM(state='cancelled' AND finished_at >= NOW(3) - INTERVAL $2 DAY) AS cancelled
       FROM delivery_runs WHERE project_id=$1`,
      p,
    );

    const steps = await rows<{
      flow_name: string;
      number: unknown;
      node_id: string;
      completed: unknown;
      failed: unknown;
      waiting: unknown;
      active: unknown;
      retries: unknown;
      mean_s: unknown;
      max_s: unknown;
    }>(
      db,
      `SELECT f.name AS flow_name, v.number, s.node_id,
        SUM(s.status='completed') AS completed, SUM(s.status='failed') AS failed,
        SUM(s.status='waiting') AS waiting, SUM(s.status='active') AS active,
        SUM(s.attempt > 1) AS retries,
        AVG(CASE WHEN s.finished_at IS NOT NULL
          THEN TIMESTAMPDIFF(MICROSECOND, s.started_at, s.finished_at)/1000000 END) AS mean_s,
        MAX(CASE WHEN s.finished_at IS NOT NULL
          THEN TIMESTAMPDIFF(MICROSECOND, s.started_at, s.finished_at)/1000000 END) AS max_s
       FROM flow_execution_steps s JOIN flow_executions e ON e.id=s.execution_id
       JOIN flow_versions v ON v.id=e.version_id JOIN flows f ON f.id=e.flow_id
       WHERE e.project_id=$1 AND (s.started_at >= NOW(3) - INTERVAL $2 DAY OR s.status IN ('active','waiting'))
       GROUP BY f.name, v.number, s.node_id ORDER BY f.name, v.number, s.node_id LIMIT 300`,
      p,
    );

    const leases = await rows<{ event_type: string; total: unknown }>(
      db,
      `SELECT event_type, COUNT(*) AS total FROM agent_job_events
       WHERE project_id=$1 AND created_at >= NOW(3) - INTERVAL $2 DAY
       GROUP BY event_type ORDER BY event_type`,
      p,
    );

    const [human] = await rows<{
      waiting: unknown;
      oldest: unknown;
      decisions: unknown;
      decision_s: unknown;
    }>(
      db,
      `SELECT
        (SELECT COUNT(*) FROM flow_execution_steps s JOIN flow_executions e ON e.id=s.execution_id
          WHERE e.project_id=$1 AND s.status='waiting') AS waiting,
        (SELECT TIMESTAMPDIFF(SECOND, MIN(s.started_at), NOW(3)) FROM flow_execution_steps s
          JOIN flow_executions e ON e.id=s.execution_id WHERE e.project_id=$1 AND s.status='waiting') AS oldest,
        COUNT(d.id) AS decisions,
        AVG(TIMESTAMPDIFF(MICROSECOND, s.started_at, d.created_at)/1000000) AS decision_s
       FROM flow_decisions d JOIN flow_execution_steps s ON s.id=d.step_id
       JOIN flow_executions e ON e.id=s.execution_id
       WHERE e.project_id=$1 AND d.created_at >= NOW(3) - INTERVAL $2 DAY`,
      p,
    );
    const [questions] = await rows<{ asked: unknown; pending: unknown; consumed: unknown }>(
      db,
      `SELECT
        (SELECT COUNT(*) FROM agent_run_events ev JOIN agent_runs r ON r.id=ev.run_id
          WHERE r.project_id=$1 AND ev.type='question' AND ev.created_at >= NOW(3) - INTERVAL $2 DAY) AS asked,
        (SELECT COUNT(*) FROM agent_run_inputs i JOIN agent_runs r ON r.id=i.run_id
          WHERE r.project_id=$1 AND i.consumed_at IS NULL) AS pending,
        (SELECT COUNT(*) FROM agent_run_inputs i JOIN agent_runs r ON r.id=i.run_id
          WHERE r.project_id=$1 AND i.consumed_at >= NOW(3) - INTERVAL $2 DAY) AS consumed`,
      p,
    );

    const usage = await rows<{
      model: string | null;
      runs: unknown;
      calls: unknown;
      input_tokens: unknown;
      output_tokens: unknown;
      credits: unknown;
      reported: unknown;
    }>(
      db,
      `SELECT JSON_VALUE(ev.payload,'$.model') AS model, COUNT(DISTINCT ev.run_id) AS runs,
        COUNT(*) AS calls,
        SUM(COALESCE(JSON_VALUE(ev.payload,'$.inputTokens'),0)) AS input_tokens,
        SUM(COALESCE(JSON_VALUE(ev.payload,'$.outputTokens'),0)) AS output_tokens,
        SUM(CASE WHEN JSON_TYPE(JSON_EXTRACT(ev.payload,'$.aiCredits')) IN ('INTEGER','DOUBLE')
          THEN JSON_VALUE(ev.payload,'$.aiCredits') END) AS credits,
        SUM(JSON_TYPE(JSON_EXTRACT(ev.payload,'$.aiCredits')) IN ('INTEGER','DOUBLE')) AS reported
       FROM agent_run_events ev JOIN agent_runs r ON r.id=ev.run_id
       WHERE r.project_id=$1 AND ev.type='usage' AND ev.created_at >= NOW(3) - INTERVAL $2 DAY
       GROUP BY JSON_VALUE(ev.payload,'$.model')`,
      p,
    );
    const [usageRuns] = await rows<{ runs: unknown }>(
      db,
      `SELECT COUNT(DISTINCT ev.run_id) AS runs FROM agent_run_events ev JOIN agent_runs r ON r.id=ev.run_id
       WHERE r.project_id=$1 AND ev.type='usage' AND ev.created_at >= NOW(3) - INTERVAL $2 DAY`,
      p,
    );
    const [quota] = await rows<{ payload: unknown; created_at: Date }>(
      db,
      `SELECT ev.payload, ev.created_at FROM agent_run_events ev JOIN agent_runs r ON r.id=ev.run_id
       WHERE r.project_id=$1 AND ev.type='quota' AND ev.created_at >= NOW(3) - INTERVAL $2 DAY
       ORDER BY ev.created_at DESC, ev.id DESC LIMIT 1`,
      p,
    );
    const reportedCalls = usage.reduce((sum, row) => sum + num(row.reported), 0);
    const quotaPayload = quota
      ? ((typeof quota.payload === 'string' ? JSON.parse(quota.payload) : quota.payload) as Record<
          string,
          unknown
        >)
      : null;

    const tools = await rows<{
      tool: string;
      ok: unknown;
      rejected: unknown;
      error: unknown;
      mean_ms: unknown;
    }>(
      db,
      `SELECT c.tool, SUM(c.outcome='ok') AS ok, SUM(c.outcome='rejected') AS rejected,
        SUM(c.outcome='error') AS error, AVG(c.duration_ms) AS mean_ms
       FROM agent_run_tool_calls c JOIN agent_runs r ON r.id=c.run_id
       WHERE r.project_id=$1 AND c.created_at >= NOW(3) - INTERVAL $2 DAY
       GROUP BY c.tool ORDER BY c.tool`,
      p,
    );
    const deliveries = await rows<{ state: string; total: unknown }>(
      db,
      `SELECT state, COUNT(*) AS total FROM delivery_runs
       WHERE project_id=$1 AND (created_at >= NOW(3) - INTERVAL $2 DAY OR finished_at IS NULL)
       GROUP BY state ORDER BY state`,
      p,
    );
    const interventions = await rows<{ status: string; total: unknown }>(
      db,
      `SELECT status, COUNT(*) AS total FROM incident_interventions
       WHERE project_id=$1 AND (created_at >= NOW(3) - INTERVAL $2 DAY OR finished_at IS NULL)
       GROUP BY status ORDER BY status`,
      p,
    );
    const [uncertain] = await rows<{ deliveries: unknown; interventions: unknown }>(
      db,
      `SELECT (SELECT COUNT(*) FROM delivery_runs WHERE project_id=$1 AND state='uncertain') AS deliveries,
        (SELECT COUNT(*) FROM incident_interventions WHERE project_id=$1 AND status='uncertain') AS interventions`,
      [projectId],
    );
    const [health] = await rows<{
      incidents: unknown;
      open: unknown;
      recovered: unknown;
      recovery_s: unknown;
      recurrences: unknown;
    }>(
      db,
      `SELECT COUNT(*) AS incidents, SUM(h.state='open') AS open,
        SUM(h.recovered_at IS NOT NULL) AS recovered,
        AVG(CASE WHEN h.recovered_at IS NOT NULL
          THEN TIMESTAMPDIFF(MICROSECOND, h.opened_at, h.recovered_at)/1000000 END) AS recovery_s,
        SUM(EXISTS(SELECT 1 FROM health_incidents prior WHERE prior.project_id=h.project_id
          AND prior.root_title=h.root_title AND prior.ticket_id<>h.ticket_id
          AND prior.opened_at < h.opened_at AND prior.opened_at >= h.opened_at - INTERVAL 7 DAY)) AS recurrences
       FROM health_incidents h WHERE h.project_id=$1 AND h.opened_at >= NOW(3) - INTERVAL $2 DAY`,
      p,
    );
    // Passos de validação Health (saída com critério): só a porta de sucesso confirma a recuperação.
    const [validation] = await rows<{
      confirmed: unknown;
      not_confirmed: unknown;
      unknown: unknown;
    }>(
      db,
      `SELECT SUM(s.port='success') AS confirmed,
        SUM(COALESCE(s.port,'')<>'success') AS not_confirmed,
        SUM(COALESCE(s.port,'')<>'success'
          AND JSON_EXTRACT(s.step_output,'$.incident.measurements[*].unknown') IS NOT NULL) AS unknown
       FROM flow_execution_steps s JOIN flow_executions e ON e.id=s.execution_id
       WHERE e.project_id=$1 AND s.status='completed' AND s.finished_at >= NOW(3) - INTERVAL $2 DAY
         AND JSON_EXTRACT(s.step_output,'$.incident.criterion') IS NOT NULL`,
      p,
    );

    return {
      projectId,
      windowDays,
      generatedAt: new Date().toISOString(),
      queues: [
        queueMetric('agent_run', agentQueue),
        queueMetric('flow_assistant', assistantQueue),
        queueMetric('ticket_routing', routingQueue),
        queueMetric('delivery', deliveryQueue),
      ],
      steps: steps.map((row) => ({
        flowName: row.flow_name,
        versionNumber: num(row.number),
        nodeId: row.node_id,
        completed: num(row.completed),
        failed: num(row.failed),
        waiting: num(row.waiting),
        active: num(row.active),
        retries: num(row.retries),
        meanDurationSeconds: maybe(row.mean_s),
        maxDurationSeconds: maybe(row.max_s),
      })),
      leases: leases.map((row) => ({ eventType: row.event_type, total: num(row.total) })),
      human: {
        waitingSteps: num(human?.waiting),
        oldestWaitingSeconds: maybe(human?.oldest),
        decisions: num(human?.decisions),
        meanDecisionSeconds: maybe(human?.decision_s),
        agentQuestions: num(questions?.asked),
        answersPending: num(questions?.pending),
        answersConsumed: num(questions?.consumed),
      },
      copilot: {
        runsWithUsage: num(usageRuns?.runs),
        modelCalls: usage.reduce((sum, row) => sum + num(row.calls), 0),
        inputTokens: usage.reduce((sum, row) => sum + num(row.input_tokens), 0),
        outputTokens: usage.reduce((sum, row) => sum + num(row.output_tokens), 0),
        aiCredits: reportedCalls
          ? maybe(usage.reduce((sum, row) => sum + num(row.credits), 0))
          : null,
        callsWithoutReportedCredits:
          usage.reduce((sum, row) => sum + num(row.calls), 0) - reportedCalls,
        models: usage
          .map((row) => row.model)
          .filter((model): model is string => Boolean(model))
          .sort(),
        quota:
          quota && quotaPayload
            ? {
                unlimited: Boolean(quotaPayload.unlimited),
                used: num(quotaPayload.used),
                entitlement: num(quotaPayload.entitlement),
                remainingPercentage: num(quotaPayload.remainingPercentage),
                overage: num(quotaPayload.overage),
                resetDate: (quotaPayload.resetDate as string | null) ?? null,
                reportedAt: iso(quota.created_at),
              }
            : null,
      },
      tools: tools.map((row) => ({
        tool: row.tool,
        ok: num(row.ok),
        rejected: num(row.rejected),
        error: num(row.error),
        meanMs: maybe(row.mean_ms),
      })),
      deliveries: deliveries.map((row) => ({ state: row.state, total: num(row.total) })),
      interventions: interventions.map((row) => ({ status: row.status, total: num(row.total) })),
      uncertain: {
        deliveries: num(uncertain?.deliveries),
        interventions: num(uncertain?.interventions),
      },
      health: {
        incidents: num(health?.incidents),
        open: num(health?.open),
        recovered: num(health?.recovered),
        meanRecoverySeconds: maybe(health?.recovery_s),
        recurrences: num(health?.recurrences),
        validationsConfirmed: num(validation?.confirmed),
        validationsNotConfirmed: num(validation?.not_confirmed),
        validationsUnknownTelemetry: num(validation?.unknown),
      },
      correlation: await this.correlation(projectId, windowDays),
    };
  }

  /** Falhas e operações incertas recentes ligadas a projeto, ticket, versão, execução, etapa e job. */
  private async correlation(projectId: string, windowDays: number): Promise<CorrelatedEvent[]> {
    const p = [projectId, windowDays];
    const base = (row: Record<string, unknown>) => ({
      projectId,
      ticketId: (row.ticket_id as string | null) ?? null,
      ticketKey: (row.ticket_key as string | null) ?? null,
      flowVersionId: (row.version_id as string | null) ?? null,
      executionId: (row.execution_id as string | null) ?? null,
      stepId: (row.step_id as string | null) ?? null,
      jobId: (row.job_id as string | null) ?? null,
      attempt: row.attempt === null || row.attempt === undefined ? null : Number(row.attempt),
      externalOperation: (row.external as string | null) ?? null,
    });
    const events: CorrelatedEvent[] = [];
    const push = (kind: CorrelatedEvent['kind'], list: Record<string, unknown>[]) =>
      list.forEach((row) =>
        events.push({ at: iso(row.at), kind, detail: String(row.detail ?? ''), ...base(row) }),
      );
    push(
      'step_failed',
      await rows(
        this.db,
        `SELECT s.finished_at AS at, CONCAT(s.node_id,' (tentativa ',s.attempt,')') AS detail,
          e.ticket_id, t.\`key\` AS ticket_key, e.version_id, e.id AS execution_id, s.id AS step_id,
          s.agent_run_id AS job_id, s.attempt, NULL AS external
         FROM flow_execution_steps s JOIN flow_executions e ON e.id=s.execution_id
         JOIN tickets t ON t.id=e.ticket_id
         WHERE e.project_id=$1 AND s.status='failed' AND s.finished_at >= NOW(3) - INTERVAL $2 DAY
         ORDER BY s.finished_at DESC LIMIT 20`,
        p,
      ),
    );
    push(
      'job_lease',
      await rows(
        this.db,
        `SELECT j.created_at AS at, CONCAT(j.job_kind,': ',j.event_type) AS detail, j.ticket_id,
          t.\`key\` AS ticket_key, e.version_id, e.id AS execution_id, j.flow_step_id AS step_id,
          j.job_id, j.attempt, NULL AS external
         FROM agent_job_events j LEFT JOIN tickets t ON t.id=j.ticket_id
         LEFT JOIN flow_executions e ON e.ticket_id=j.ticket_id
         WHERE j.project_id=$1 AND j.created_at >= NOW(3) - INTERVAL $2 DAY
           AND j.event_type IN ('lease_lost','lease_expired_requeued','lease_expired_failed',
             'lease_expired_cancelled','stale_attempt_rejected')
         ORDER BY j.created_at DESC LIMIT 20`,
        p,
      ),
    );
    push(
      'run_failed',
      await rows(
        this.db,
        `SELECT r.finished_at AS at, COALESCE(r.error_code,'falha') AS detail, r.ticket_id,
          t.\`key\` AS ticket_key, e.version_id, e.id AS execution_id, s.id AS step_id,
          r.id AS job_id, NULL AS attempt, NULL AS external
         FROM agent_runs r JOIN tickets t ON t.id=r.ticket_id
         LEFT JOIN flow_executions e ON e.ticket_id=r.ticket_id
         LEFT JOIN flow_execution_steps s ON s.agent_run_id=r.id
         WHERE r.project_id=$1 AND r.status='failed' AND r.finished_at >= NOW(3) - INTERVAL $2 DAY
         ORDER BY r.finished_at DESC LIMIT 20`,
        p,
      ),
    );
    for (const [kind, state] of [
      ['delivery_uncertain', 'uncertain'],
      ['delivery_failed', 'failed'],
    ] as const)
      push(
        kind,
        await rows(
          this.db,
          `SELECT d.updated_at AS at, COALESCE(d.state_reason,d.state) AS detail, d.ticket_id,
            t.\`key\` AS ticket_key, e.version_id, d.execution_id, d.step_id, d.id AS job_id,
            d.attempts AS attempt, d.external_id AS external
           FROM delivery_runs d JOIN tickets t ON t.id=d.ticket_id
           JOIN flow_executions e ON e.id=d.execution_id
           WHERE d.project_id=$1 AND d.state=$3 AND (d.state='uncertain' OR d.updated_at >= NOW(3) - INTERVAL $2 DAY)
           ORDER BY d.updated_at DESC LIMIT 20`,
          [...p, state],
        ),
      );
    for (const [kind, status] of [
      ['intervention_uncertain', 'uncertain'],
      ['intervention_failed', 'failed'],
    ] as const)
      push(
        kind,
        await rows(
          this.db,
          `SELECT COALESCE(i.finished_at,i.created_at) AS at,
            CONCAT(i.action,' → ',i.target,COALESCE(CONCAT(': ',LEFT(i.result_text,200)),'')) AS detail,
            i.ticket_id, t.\`key\` AS ticket_key, e.version_id, e.id AS execution_id, i.step_id,
            i.id AS job_id, NULL AS attempt, i.relay_request_id AS external
           FROM incident_interventions i JOIN tickets t ON t.id=i.ticket_id
           LEFT JOIN flow_executions e ON e.ticket_id=i.ticket_id
           WHERE i.project_id=$1 AND i.status=$3
             AND (i.status='uncertain' OR i.created_at >= NOW(3) - INTERVAL $2 DAY)
           ORDER BY i.created_at DESC LIMIT 20`,
          [...p, status],
        ),
      );
    push(
      'tool_error',
      await rows(
        this.db,
        `SELECT c.created_at AS at, CONCAT(c.tool,': ',COALESCE(c.error_code,c.outcome)) AS detail,
          r.ticket_id, t.\`key\` AS ticket_key, e.version_id, e.id AS execution_id, s.id AS step_id,
          r.id AS job_id, NULL AS attempt, NULL AS external
         FROM agent_run_tool_calls c JOIN agent_runs r ON r.id=c.run_id
         JOIN tickets t ON t.id=r.ticket_id
         LEFT JOIN flow_executions e ON e.ticket_id=r.ticket_id
         LEFT JOIN flow_execution_steps s ON s.agent_run_id=r.id
         WHERE r.project_id=$1 AND c.outcome='error' AND c.created_at >= NOW(3) - INTERVAL $2 DAY
         ORDER BY c.created_at DESC LIMIT 20`,
        p,
      ),
    );
    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
  }
}
