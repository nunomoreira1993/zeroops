import { randomUUID } from 'node:crypto';
import {
  evaluateIntervention,
  healthCriticalities,
  healthSettingsSchema,
  interventionActionLabels,
  parseIncidentReport,
  recoveryCriteria,
  recoveryCriterionFor,
  validationSettingsSchema,
  type FlowStepOutput,
  type HealthRecipientTarget,
  type IncidentEnvironmentKey,
  type IncidentPolicy,
  type IncidentReport,
  type IncidentResource,
  type InterventionAction,
  type InterventionParameter,
  type ProposedIntervention,
  type RecoveryCriterion,
  type ValidationSettings,
} from '../../../../contracts/src/index.js';
import {
  acquireResourceLock,
  healthResourceKey,
  releaseLocksOf,
} from '../../database/resource-locks.js';
import type {
  FlowActionContext,
  FlowActionExecutor,
  FlowActionRegistry,
} from '../flows/flow-actions.js';
import { parseLabels } from '../health/health-incident-lifecycle.js';
import { resolveRecipients } from '../health/health-recipients.js';
import type { Queryable } from '../identity/membership.js';
import { appendAutomatedComment } from '../tickets/ticket-comments.js';
import { activeSuspension } from './health-suspension.js';
import type { IncidentPolicyRepository } from './incident-policy.repository.js';
import { describeResource, resourceFromAlert } from './incident-resource.js';
import type { RecoveryMeasurement, RecoveryProbe } from './recovery-probe.js';

export interface IncidentActionDeps {
  policies: IncidentPolicyRepository;
  /** Sonda dos critérios de recuperação (sem ela valem só os alertas do incidente). */
  probe?: RecoveryProbe;
  /** URL pública da aplicação (ligação ao ticket nos e-mails). */
  publicUrl?: string;
  /** Janela em que o relay conta como ligado desde o último contacto. */
  relayOnlineSeconds?: number;
}

type IncidentOutput = NonNullable<FlowStepOutput['incident']>;

/** Prazo para o incidente da Saúde aparecer depois da criação do ticket. */
const INCIDENT_GRACE_MS = 2 * 60_000;
/** O relay só entrega pedidos recentes: depois disto a intervenção conta como falhada. */
const RELAY_DEADLINE_MS = 90_000;
/** Espera máxima por outra intervenção em curso no mesmo recurso. */
const BUSY_LIMIT_MS = 30 * 60_000;
/** Contrato versionado do pedido de intervenção enviado ao relay. */
export const INTERVENTION_CONTRACT = 'zeroops.intervention/2';
/** O lock do recurso cobre a intervenção e a validação seguinte (renovado em cada medição). */
const HEALTH_LOCK_SECONDS = 2 * 3600;
/** Resultado desconhecido: o recurso fica reservado até reconciliar ou alguém decidir. */
const UNCERTAIN_LOCK_SECONDS = 7 * 24 * 3600;

const RELAY_TOOLS: Record<InterventionAction, string> = {
  service_restart: 'restart',
  server_reboot: 'reboot',
  set_parameter: 'param',
};

const ROLE_STAGE: Record<string, { stage: string; label: string }> = {
  technical: { stage: 'technical', label: 'Equipa técnica' },
  admin: { stage: 'technical', label: 'Administração' },
  qa: { stage: 'qa', label: 'Qualidade' },
  release: { stage: 'release', label: 'Gestor de release' },
};

interface IncidentRow {
  ticket_id: string;
  project_id: string;
  environment: IncidentEnvironmentKey;
  state: string;
  root_title: string;
  opened_at: Date;
  recovered_at: Date | null;
  resource_kind: string | null;
  resource_engine: string | null;
  resource_host: string | null;
  resource_unit: string | null;
  resource_managed: boolean;
  alert_component: string | null;
  cause_component: string | null;
  cause_confirmed: boolean;
  demo_scenario: string | null;
  alert_name: string | null;
  alert_state: string | null;
  labels: string | Record<string, string> | null;
  criticality: string | null;
  alert_summary: string | null;
}

interface TrailStep {
  id: string;
  port: string | null;
  actor_id: string | null;
  step_output: FlowStepOutput | null;
}

interface InterventionRow {
  id: string;
  action: InterventionAction;
  target: string;
  parameter: string | null;
  previous_value: string | null;
  new_value: string | null;
  rollback_hint: string | null;
  decision: 'auto' | 'approval' | 'forbidden';
  status: string;
  relay_request_id: string | null;
  result_text: string | null;
  created_at: Date;
  resource_key?: string | null;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);
const elapsedMs = (context: FlowActionContext) =>
  context.now.getTime() - context.step.startedAt.getTime();
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

function positiveConfig(value: unknown, fallback: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.round(number), max) : fallback;
}

async function note(context: FlowActionContext, body: string) {
  await appendAutomatedComment(context.client, {
    ticketId: context.ticket.id,
    projectId: context.ticket.projectId,
    authorId: context.ticket.createdBy,
    visibility: 'internal',
    body,
    authorKind: 'system',
  });
}

async function loadIncident(client: Queryable, ticketId: string, lock = false) {
  return (
    await client.query<IncidentRow>(
      `SELECT h.ticket_id,h.project_id,h.environment,h.state,h.root_title,h.opened_at,h.recovered_at,
              h.resource_kind,h.resource_engine,h.resource_host,h.resource_unit,h.resource_managed,
              h.alert_component,h.cause_component,h.cause_confirmed,h.demo_scenario,
              a.alert_name,a.state AS alert_state,a.labels,a.criticality,a.summary AS alert_summary
         FROM health_incidents h LEFT JOIN health_external_alerts a ON a.id=h.root_alert_id
        WHERE h.ticket_id=$1${lock ? ' FOR UPDATE' : ''}`,
      [ticketId],
    )
  ).rows[0];
}

function storedResource(row: IncidentRow): IncidentResource | null {
  if (!row.resource_kind) return null;
  return {
    kind: row.resource_kind,
    engine: row.resource_engine,
    host: row.resource_host,
    unit: row.resource_unit,
    environment: row.environment,
    managed: Boolean(row.resource_managed),
  };
}

function resourceOf(row: IncidentRow, policy: IncidentPolicy) {
  return (
    storedResource(row) ??
    resourceFromAlert(row.alert_name ?? row.root_title, labelsOf(row), row.environment, policy)
  );
}

function labelsOf(row: IncidentRow): Record<string, string> {
  return row.labels ? parseLabels(row.labels) : {};
}

function resourceOutput(resource: IncidentResource): IncidentOutput['resource'] {
  return {
    kind: resource.kind,
    engine: resource.engine,
    host: resource.host,
    unit: resource.unit,
    managed: resource.managed,
  };
}

/** Saída já gravada desta etapa (as esperas guardam o estado intermédio). */
async function stepIncident(context: FlowActionContext): Promise<IncidentOutput> {
  const row = (
    await context.client.query<{ step_output: FlowStepOutput | null }>(
      'SELECT step_output FROM flow_execution_steps WHERE id=$1',
      [context.step.id],
    )
  ).rows[0];
  return row?.step_output?.incident ?? {};
}

/** Etapas já percorridas nesta execução, pela ordem. */
async function trail(context: FlowActionContext): Promise<TrailStep[]> {
  return (
    await context.client.query<TrailStep>(
      `SELECT s.id,s.port,s.actor_id,s.step_output FROM flow_execution_steps s
        WHERE s.execution_id=(SELECT execution_id FROM flow_execution_steps WHERE id=$1)
        ORDER BY s.step_sequence`,
      [context.step.id],
    )
  ).rows;
}

/** Última decisão de autorização e se uma pessoa aprovou depois dela. */
function lastAuthorization(steps: TrailStep[]) {
  let index = -1;
  steps.forEach((step, position) => {
    const incident = step.step_output?.incident;
    if (incident?.decision !== undefined && !incident.interventionId && step.port) index = position;
  });
  if (index < 0) return null;
  const incident = steps[index]!.step_output!.incident!;
  const approval = steps
    .slice(index + 1)
    .find((step) => step.actor_id && (step.port === 'approve' || step.port === 'success'));
  return { incident, approved: Boolean(approval), approverId: approval?.actor_id ?? null };
}

/** O aprovador continua ativo no projeto (ou é administrador da instância) no momento de executar. */
async function approverStillActive(context: FlowActionContext, userId: string) {
  const row = (
    await context.client.query<{ id: string }>(
      `SELECT u.id FROM users u
         LEFT JOIN project_memberships m ON m.user_id=u.id AND m.project_id=$2
        WHERE u.id=$1 AND NOT u.disabled AND (u.instance_admin OR (m.user_id IS NOT NULL AND NOT m.disabled))`,
      [userId, context.ticket.projectId],
    )
  ).rows[0];
  return Boolean(row);
}

/** Lock do recurso real: o host (partilhado entre projetos); sem host, a unidade no ambiente. */
function healthLockKey(environment: string, host: string | null, target: string) {
  return host ? healthResourceKey(host, null) : healthResourceKey(`?${environment}`, target);
}

const lockHolder = (context: FlowActionContext) => ({
  kind: 'intervention' as const,
  id: context.ticket.id,
  projectId: context.ticket.projectId,
});

/** Liberta o recurso do ticket, salvo se houver uma intervenção com resultado desconhecido. */
async function releaseHealthLock(context: FlowActionContext) {
  const uncertain = (
    await context.client.query<{ id: string }>(
      "SELECT id FROM incident_interventions WHERE ticket_id=$1 AND status='uncertain' LIMIT 1",
      [context.ticket.id],
    )
  ).rows[0];
  if (!uncertain) await releaseLocksOf(context.client, lockHolder(context));
}

/** Relatório da investigação: o mais recente nas etapas ou o resumo do Copilot anterior. */
function latestReport(steps: TrailStep[], context: FlowActionContext): IncidentReport | null {
  const fromSummary = parseIncidentReport(context.previous.summary);
  if (fromSummary) return fromSummary;
  for (const step of [...steps].reverse()) {
    const report = step.step_output?.incident?.report;
    if (report) return parseIncidentReport(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``);
  }
  return null;
}

async function interventions(client: Queryable, ticketId: string) {
  return (
    await client.query<InterventionRow>(
      `SELECT id,action,target,parameter,previous_value,new_value,rollback_hint,decision,status,
              relay_request_id,result_text,created_at
         FROM incident_interventions WHERE ticket_id=$1 ORDER BY created_at`,
      [ticketId],
    )
  ).rows;
}

function rollbackHint(
  action: InterventionAction,
  target: string,
  parameter: string | null,
  previous: string | null,
) {
  if (action !== 'set_parameter')
    return 'Não aplicável: a ação não altera configuração (o serviço volta ao estado normal ao arrancar).';
  return previous
    ? `systemctl set-property ${target} ${parameter}=${previous}`
    : `Repor ${parameter} de ${target} para o valor anterior (não foi possível ler).`;
}

function interventionLine(row: InterventionRow) {
  const label = interventionActionLabels[row.action]?.pt ?? row.action;
  const change = row.parameter
    ? ` ${row.parameter}: ${row.previous_value ?? '?'} → ${row.new_value ?? '?'}`
    : '';
  const statusLabel: Record<string, string> = {
    succeeded: 'concluída',
    simulated: 'simulada (demonstração)',
    failed: 'falhou',
    refused: 'recusada pela política',
    cancelled: 'cancelada',
    running: 'em curso',
    pending: 'pendente',
    uncertain: 'resultado desconhecido (por reconciliar)',
  };
  const result = row.result_text ? ` — ${clip(row.result_text, 300)}` : '';
  return `${label} em ${row.target}${change}: ${statusLabel[row.status] ?? row.status}${result}`;
}

async function insertIntervention(
  context: FlowActionContext,
  incident: IncidentRow,
  values: {
    action: InterventionAction;
    target: string;
    parameter: string | null;
    previous: string | null;
    next: string | null;
    decision: 'auto' | 'approval' | 'forbidden';
    reason: string;
    status: string;
    relayRequestId?: string | null;
    result?: string | null;
    finished: boolean;
    resourceKey?: string | null;
  },
) {
  const id = randomUUID();
  await context.client.query(
    `INSERT INTO incident_interventions(id,ticket_id,project_id,environment,step_id,action,target,parameter,
       previous_value,new_value,rollback_hint,decision,decision_reason,status,relay_request_id,result_text,
       actor_kind,created_at,finished_at,resource_key,contract_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'agent',$17,$18,$19,$20)`,
    [
      id,
      context.ticket.id,
      context.ticket.projectId,
      incident.environment,
      context.step.id,
      values.action,
      clip(values.target, 160),
      values.parameter,
      values.previous,
      values.next,
      clip(rollbackHint(values.action, values.target, values.parameter, values.previous), 500),
      values.decision,
      clip(values.reason, 500),
      values.status,
      values.relayRequestId ?? null,
      values.result ? clip(values.result, 2000) : null,
      context.now,
      values.finished ? context.now : null,
      values.resourceKey ? clip(values.resourceKey, 300) : null,
      INTERVENTION_CONTRACT,
    ],
  );
  return id;
}

async function finishIntervention(
  context: FlowActionContext,
  id: string,
  status: string,
  result: string,
  values: { previous?: string | null; next?: string | null; rollback?: string | null } = {},
) {
  await context.client.query(
    `UPDATE incident_interventions SET status=$2,result_text=$3,finished_at=$4,
       previous_value=COALESCE($5,previous_value),new_value=COALESCE($6,new_value),
       rollback_hint=COALESCE($7,rollback_hint)
     WHERE id=$1`,
    [
      id,
      status,
      clip(result, 2000),
      context.now,
      values.previous ?? null,
      values.next ?? null,
      values.rollback ? clip(values.rollback, 500) : null,
    ],
  );
}

/**
 * Outra intervenção em curso no mesmo recurso (evita intervenções em simultâneo): intervenções
 * pendentes do projeto ou o lock durável do recurso real detido por outro ticket (de qualquer projeto).
 */
async function busyResource(context: FlowActionContext, incident: IncidentRow, target?: string) {
  const row = (
    await context.client.query<{ busy: number }>(
      `SELECT COUNT(*) AS busy FROM incident_interventions i
         JOIN health_incidents h ON h.ticket_id=i.ticket_id
        WHERE i.project_id=$1 AND i.environment=$2 AND i.ticket_id<>$3
          AND i.status IN ('pending','running','uncertain')
          AND (h.resource_host <=> $4)`,
      [context.ticket.projectId, incident.environment, context.ticket.id, incident.resource_host],
    )
  ).rows[0];
  if (Number(row?.busy ?? 0) > 0) return true;
  // Demonstrações não tocam no recurso real: não esperam pelo lock partilhado.
  if (incident.demo_scenario) return false;
  const key = healthLockKey(
    incident.environment,
    incident.resource_host,
    target ?? incident.resource_unit ?? '*',
  );
  const lock = (
    await context.client.query<{ holder_id: string }>(
      'SELECT holder_id FROM resource_locks WHERE lock_key=$1 AND holder_id<>$2 AND expires_at>NOW(3)',
      [key, context.ticket.id],
    )
  ).rows[0];
  return Boolean(lock);
}

// ---------------------------------------------------------------------------------------------
// Executores.

function createIntake(deps: IncidentActionDeps): FlowActionExecutor {
  return async (context) => {
    const incident = await loadIncident(context.client, context.ticket.id, true);
    if (!incident) {
      if (context.ticket.origin === 'health' && elapsedMs(context) < INCIDENT_GRACE_MS)
        return { wait: later(context.now, 30_000) };
      return {
        port: 'done',
        output: {
          reason: 'Pedido sem incidente da Saúde: o recurso fica por identificar na investigação.',
        },
      };
    }
    const policy = await deps.policies.get(context.ticket.projectId, context.client);
    const resource = resourceOf(incident, policy);
    const labels = labelsOf(incident);
    const alertComponent =
      incident.alert_component ??
      clip(
        labels.component ??
          `${resource.engine ?? resource.kind}${resource.host ? `@${resource.host}` : ''}`,
        160,
      );
    await context.client.query(
      `UPDATE health_incidents SET resource_kind=$2,resource_engine=$3,resource_host=$4,resource_unit=$5,
         resource_managed=$6,alert_component=$7 WHERE ticket_id=$1`,
      [
        context.ticket.id,
        resource.kind,
        resource.engine,
        resource.host,
        resource.unit,
        resource.managed,
        alertComponent,
      ],
    );
    const output: IncidentOutput = {
      resource: resourceOutput(resource),
      alertComponent,
      simulated: Boolean(incident.demo_scenario),
    };
    if (
      (await busyResource(context, { ...incident, resource_host: resource.host })) &&
      elapsedMs(context) < BUSY_LIMIT_MS
    )
      return {
        wait: later(context.now, 60_000),
        output: {
          incident: output,
          reason: 'Há outra intervenção em curso no mesmo recurso: aguarda que termine.',
        },
      };
    const summary = [
      `Alerta: ${incident.alert_name ?? incident.root_title}`,
      `Recurso: ${describeResource(resource)}`,
      `Ambiente: ${incident.environment}`,
      `Início: ${new Date(incident.opened_at).toISOString()}`,
      incident.alert_summary ? `Evidência: ${incident.alert_summary}` : '',
      incident.demo_scenario
        ? `Cenário de demonstração: ${incident.demo_scenario} (sem ações reais).`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    await note(context, `Incidente recebido.\n${summary}`);
    return { port: 'done', output: { summary, incident: output } };
  };
}

function createAuthorize(deps: IncidentActionDeps): FlowActionExecutor {
  return async (context) => {
    const report = parseIncidentReport(context.previous.summary);
    const incident = await loadIncident(context.client, context.ticket.id, true);
    const policy = await deps.policies.get(context.ticket.projectId, context.client);
    if (incident && report)
      await context.client.query(
        `UPDATE health_incidents SET cause_component=$2,cause_confirmed=$3,
           alert_component=COALESCE(alert_component,$4) WHERE ticket_id=$1`,
        [context.ticket.id, report.causeComponent, report.causeConfirmed, report.alertComponent],
      );
    const base: IncidentOutput = {
      report: report ?? null,
      alertComponent: report?.alertComponent ?? incident?.alert_component ?? null,
      causeComponent: report?.causeComponent ?? null,
      causeConfirmed: report?.causeConfirmed ?? false,
    };
    const decide = async (
      port: string,
      decision: IncidentOutput['decision'],
      reason: string,
      extra: IncidentOutput = {},
    ) => {
      await note(context, `Decisão: ${reason}`);
      return {
        port,
        output: { reason, incident: { ...base, ...extra, decision, decisionReason: reason } },
      };
    };
    if (!report)
      return decide(
        'no_action',
        null,
        'A investigação não devolveu o relatório estruturado: nenhuma ação automática.',
      );
    if (report.recoveredSpontaneously)
      return decide('no_action', null, 'O recurso recuperou sem intervenção: falta só validar.');
    const proposal = report.proposedAction;
    if (!proposal)
      return decide('no_action', null, 'A investigação não propôs nenhuma ação permitida.');
    const resource: IncidentResource = incident
      ? resourceOf(incident, policy)
      : {
          kind: 'other',
          engine: null,
          host: null,
          unit: null,
          environment: 'production',
          managed: true,
        };
    // A causa num recurso que não gerimos (ex.: DB2) proíbe a intervenção, mesmo que o alerta seja nosso.
    const evaluated = evaluateIntervention(
      policy,
      { ...resource, managed: resource.managed && report.causeManaged },
      proposal as ProposedIntervention,
    );
    let { decision, reason } = evaluated;
    const override = text(context.node.config.override);
    if (override === 'forbidden' && decision !== 'forbidden') {
      decision = 'forbidden';
      reason = 'Esta etapa do fluxo não permite intervenções.';
    } else if (override === 'approval' && decision === 'auto') {
      decision = 'approval';
      reason = 'Esta etapa do fluxo pede sempre aprovação humana.';
    }
    const extra: IncidentOutput = {
      action: proposal.action,
      target: proposal.target,
      parameter: proposal.parameter ?? null,
      newValue: proposal.value ?? null,
    };
    const label = interventionActionLabels[proposal.action].pt;
    const port =
      decision === 'auto' ? 'auto' : decision === 'approval' ? 'needs_approval' : 'forbidden';
    return decide(port, decision, `${label} em ${proposal.target}: ${reason}`, extra);
  };
}

function createRemediate(deps: IncidentActionDeps): FlowActionExecutor {
  const onlineSeconds = deps.relayOnlineSeconds ?? 120;
  return async (context) => {
    const incident = await loadIncident(context.client, context.ticket.id, true);
    if (!incident)
      return { port: 'failed', output: { reason: 'Sem incidente da Saúde associado ao pedido.' } };
    const current = await stepIncident(context);
    if (current.interventionId) return pollIntervention(context, current);
    const pendingUncertain = (
      await context.client.query<{ id: string }>(
        "SELECT id FROM incident_interventions WHERE ticket_id=$1 AND status='uncertain' LIMIT 1",
        [context.ticket.id],
      )
    ).rows[0];
    if (pendingUncertain) {
      const reason =
        'Há uma intervenção anterior com resultado desconhecido: reconciliar antes de repetir (nunca se repete automaticamente).';
      await note(context, reason);
      return { port: 'uncertain', output: { reason } };
    }

    const steps = await trail(context);
    const authorization = lastAuthorization(steps);
    const authorized = authorization?.incident;
    if (!authorization)
      return { port: 'forbidden', output: { reason: 'Não há ação autorizada para executar.' } };
    if (!authorized?.action || !authorized.target)
      return {
        port: 'no_action',
        output: { reason: 'A análise não propôs nenhuma intervenção: segue para validação.' },
      };
    const action = authorized.action as InterventionAction;
    const proposal: ProposedIntervention = {
      action,
      target: authorized.target,
      parameter: (authorized.parameter ?? null) as InterventionParameter | null,
      value: authorized.newValue ?? null,
      reason: authorized.decisionReason ?? '',
    };
    const policy = await deps.policies.get(context.ticket.projectId, context.client);
    const report = authorized.report
      ? parseIncidentReport(`\`\`\`json\n${JSON.stringify(authorized.report)}\n\`\`\``)
      : null;
    const resource = resourceOf(incident, policy);
    // Segunda barreira: a política volta a ser avaliada no momento de executar.
    const evaluation = evaluateIntervention(
      policy,
      { ...resource, managed: resource.managed && (report?.causeManaged ?? true) },
      proposal,
    );
    const needsApproval = authorized.decision !== 'auto' || evaluation.decision === 'approval';
    const approverGone =
      needsApproval &&
      authorization.approved &&
      authorization.approverId !== null &&
      !(await approverStillActive(context, authorization.approverId));
    const refusal =
      evaluation.decision === 'forbidden' || authorized.decision === 'forbidden'
        ? evaluation.reason
        : needsApproval && !authorization.approved
          ? 'A ação exige aprovação humana e não foi aprovada.'
          : approverGone
            ? 'Quem aprovou a ação já não tem acesso ativo ao projeto: a aprovação deixou de valer.'
            : null;
    const base: IncidentOutput = {
      action,
      target: proposal.target,
      parameter: proposal.parameter ?? null,
      newValue: proposal.value ?? null,
      decision: evaluation.decision,
      decisionReason: evaluation.reason,
    };
    const record = (
      status: string,
      result: string,
      extra: Partial<Parameters<typeof insertIntervention>[2]> = {},
    ) =>
      insertIntervention(context, incident, {
        action,
        target: proposal.target,
        parameter: proposal.parameter ?? null,
        previous: null,
        next: proposal.value ?? null,
        decision: evaluation.decision,
        reason: evaluation.reason,
        status,
        result,
        finished: status !== 'running',
        ...extra,
      });
    if (refusal) {
      const id = await record('refused', refusal);
      await note(context, `Intervenção recusada: ${refusal}`);
      return {
        port: 'forbidden',
        output: { reason: refusal, incident: { ...base, interventionId: id } },
      };
    }
    const suspension = await activeSuspension(
      context.client,
      context.ticket.projectId,
      incident.environment,
    );
    if (suspension) {
      const reason = `A Saúde está suspensa neste ambiente (${suspension.reason}): a intervenção não corre.`;
      const id = await record('cancelled', reason);
      return { port: 'failed', output: { reason, incident: { ...base, interventionId: id } } };
    }
    if (incident.demo_scenario) {
      const previous = action === 'set_parameter' ? 'infinity' : null;
      const result = `Simulado (cenário ${incident.demo_scenario}): ${interventionActionLabels[action].pt.toLowerCase()} em ${proposal.target} concluído.`;
      const id = await record('simulated', result, { previous });
      await note(context, `Intervenção (demonstração): ${result}`);
      return {
        port: 'done',
        output: {
          summary: result,
          incident: {
            ...base,
            interventionId: id,
            previousValue: previous,
            rollback: rollbackHint(action, proposal.target, proposal.parameter ?? null, previous),
            simulated: true,
          },
        },
      };
    }
    const lockHost = action === 'server_reboot' ? proposal.target : resource.host;
    const resourceKey = healthLockKey(incident.environment, lockHost, proposal.target);
    if (await busyResource(context, { ...incident, resource_host: lockHost }, proposal.target)) {
      if (elapsedMs(context) < BUSY_LIMIT_MS)
        return {
          wait: later(context.now, 60_000),
          output: { reason: 'Outra intervenção em curso no mesmo recurso.' },
        };
      const reason = 'Outra intervenção no mesmo recurso não terminou a tempo.';
      const id = await record('failed', reason);
      return { port: 'failed', output: { reason, incident: { ...base, interventionId: id } } };
    }
    const online = (
      await context.client.query<{ online: number; tools: string | null }>(
        `SELECT COUNT(*) AS online, MAX(tools) AS tools FROM connector_relays
          WHERE project_id=$1 AND last_seen_at > $2`,
        [context.ticket.projectId, new Date(context.now.getTime() - onlineSeconds * 1000)],
      )
    ).rows[0];
    if (!Number(online?.online ?? 0)) {
      const reason = `Sem canal de intervenção ligado para ${incident.environment}: o relay do servidor não contactou o ZeroOps nos últimos ${onlineSeconds} s.`;
      const id = await record('failed', reason);
      await note(context, `Intervenção não executada: ${reason}`);
      return { port: 'failed', output: { reason, incident: { ...base, interventionId: id } } };
    }
    if (!(online?.tools ?? '').split(',').includes(RELAY_TOOLS[action])) {
      const reason = `O relay do servidor não tem a intervenção "${RELAY_TOOLS[action]}" ativa (ALLOWED_UNITS/ALLOW_REBOOT no relay.env).`;
      const id = await record('refused', reason);
      await note(context, `Intervenção não executada: ${reason}`);
      return { port: 'forbidden', output: { reason, incident: { ...base, interventionId: id } } };
    }
    const lock = await acquireResourceLock(
      context.client,
      resourceKey,
      lockHolder(context),
      HEALTH_LOCK_SECONDS,
    );
    if (!lock.acquired)
      return {
        wait: later(context.now, 60_000),
        output: { reason: 'Outra intervenção (possivelmente de outro projeto) detém o recurso.' },
      };
    const requestId = randomUUID();
    const interventionId = await record('running', 'Enviado ao relay.', {
      relayRequestId: requestId,
      resourceKey,
    });
    const deadline = new Date(context.now.getTime() + RELAY_DEADLINE_MS);
    await context.client.query(
      'INSERT INTO connector_relay_requests(id,project_id,run_id,tool,payload,created_at) VALUES($1,$2,NULL,$3,$4,$5)',
      [
        requestId,
        context.ticket.projectId,
        RELAY_TOOLS[action],
        JSON.stringify({
          contractVersion: INTERVENTION_CONTRACT,
          interventionId,
          idempotencyKey: requestId,
          deadline: deadline.toISOString(),
          resourceKey,
          environment: incident.environment,
          unit: action === 'server_reboot' ? null : proposal.target,
          host: action === 'server_reboot' ? proposal.target : resource.host,
          property: proposal.parameter ?? null,
          value: proposal.value ?? null,
        }),
        context.now,
      ],
    );
    return { wait: later(context.now, 5000), output: { incident: { ...base, interventionId } } };
  };
}

async function pollIntervention(
  context: FlowActionContext,
  current: IncidentOutput,
): Promise<Awaited<ReturnType<FlowActionExecutor>>> {
  const row = (
    await context.client.query<InterventionRow>(
      `SELECT id,action,target,parameter,previous_value,new_value,rollback_hint,decision,status,
              relay_request_id,result_text,created_at,resource_key
         FROM incident_interventions WHERE id=$1 FOR UPDATE`,
      [current.interventionId],
    )
  ).rows[0];
  if (!row) return { port: 'failed', output: { reason: 'O registo da intervenção desapareceu.' } };
  const finished = (port: string, reason: string, extra: IncidentOutput = {}) => ({
    port,
    output: { reason, summary: reason, incident: { ...current, ...extra } },
  });
  if (row.status === 'cancelled') {
    await releaseHealthLock(context);
    return finished('failed', row.result_text ?? 'A intervenção foi cancelada.');
  }
  const request = row.relay_request_id
    ? (
        await context.client.query<{
          status: string;
          result: string | Record<string, unknown> | null;
          error_code: string | null;
          error_message: string | null;
        }>(
          'SELECT status,result,error_code,error_message FROM connector_relay_requests WHERE id=$1',
          [row.relay_request_id],
        )
      ).rows[0]
    : undefined;
  if (request?.status === 'done') {
    const result = (
      typeof request.result === 'string' ? JSON.parse(request.result) : request.result
    ) as {
      previous?: string | null;
      current?: string | null;
      message?: string | null;
    } | null;
    const previous = result?.previous ?? null;
    const rollback = rollbackHint(row.action, row.target, row.parameter, previous);
    const message =
      text(result?.message) || `${interventionActionLabels[row.action].pt} concluído.`;
    await finishIntervention(context, row.id, 'succeeded', message, {
      previous,
      next: result?.current ?? null,
      rollback,
    });
    await note(context, `Intervenção concluída: ${message}`);
    return finished('done', message, {
      previousValue: previous,
      newValue: result?.current ?? row.new_value,
      rollback,
    });
  }
  if (request?.status === 'failed' && request.error_code === 'UNCERTAIN') {
    const reason = `O relay foi interrompido durante a intervenção: ${request.error_message ?? 'resultado desconhecido'}. Não é repetida; o recurso fica reservado até alguém confirmar.`;
    await finishIntervention(context, row.id, 'uncertain', reason);
    if (row.resource_key)
      await acquireResourceLock(
        context.client,
        row.resource_key,
        lockHolder(context),
        UNCERTAIN_LOCK_SECONDS,
      );
    await note(context, `Intervenção com resultado desconhecido: ${reason}`);
    return finished('uncertain', reason);
  }
  if (request?.status === 'failed' || request?.status === 'expired') {
    const reason = `O relay recusou ou falhou a intervenção${request.error_code ? ` (${request.error_code})` : ''}: ${request.error_message ?? 'sem detalhe'}.`;
    await finishIntervention(context, row.id, 'failed', reason);
    await releaseHealthLock(context);
    await note(context, `Intervenção falhou: ${reason}`);
    return finished('failed', reason);
  }
  if (context.now.getTime() - new Date(row.created_at).getTime() > RELAY_DEADLINE_MS) {
    // Nunca entregue ao relay: é seguro dar por falhada (o relay recusa pedidos fora do prazo).
    const expired = row.relay_request_id
      ? await context.client.query(
          "UPDATE connector_relay_requests SET status='expired',finished_at=NOW(3) WHERE id=$1 AND status='pending'",
          [row.relay_request_id],
        )
      : { rowCount: 1 };
    if (expired.rowCount) {
      const reason = 'O relay não recolheu o pedido a tempo: a intervenção não foi executada.';
      await finishIntervention(context, row.id, 'failed', reason);
      await releaseHealthLock(context);
      await note(context, `Intervenção falhou: ${reason}`);
      return finished('failed', reason);
    }
    // Já recolhido pelo relay: o efeito é desconhecido. Não se repete; reconcilia-se mais tarde.
    const reason =
      'O relay recolheu o pedido mas não respondeu a tempo: resultado desconhecido. A intervenção não é repetida; o recurso fica reservado até reconciliar.';
    await finishIntervention(context, row.id, 'uncertain', reason);
    if (row.resource_key)
      await acquireResourceLock(
        context.client,
        row.resource_key,
        lockHolder(context),
        UNCERTAIN_LOCK_SECONDS,
      );
    await note(context, `Intervenção com resultado desconhecido: ${reason}`);
    return finished('uncertain', reason);
  }
  return { wait: later(context.now, 5000) };
}

function validationSettings(
  policy: IncidentPolicy,
  config: Record<string, unknown>,
): ValidationSettings {
  const base = validationSettingsSchema.parse(policy.validation ?? {});
  return {
    ...base,
    observationMinutes:
      config.observationMinutes === undefined || config.observationMinutes === ''
        ? base.observationMinutes
        : Math.max(0, Math.min(240, Math.round(Number(config.observationMinutes)) || 0)),
    timeoutMinutes: positiveConfig(config.timeoutMinutes, base.timeoutMinutes, 1440),
    maxAttempts: positiveConfig(config.maxAttempts, base.maxAttempts, 5),
  };
}

function createValidate(deps: IncidentActionDeps): FlowActionExecutor {
  return async (context) => {
    const incident = await loadIncident(context.client, context.ticket.id, true);
    if (!incident) {
      if (context.ticket.origin === 'health' && elapsedMs(context) < INCIDENT_GRACE_MS)
        return { wait: later(context.now, 30_000) };
      return {
        port: 'unknown',
        output: { reason: 'Sem incidente da Saúde: não foi possível validar.' },
      };
    }
    const policy = await deps.policies.get(context.ticket.projectId, context.client);
    const settings = validationSettings(policy, context.node.config);
    const resource = resourceOf(incident, policy);
    const configured = text(context.node.config.criterion);
    const criterion: RecoveryCriterion = (recoveryCriteria as readonly string[]).includes(
      configured,
    )
      ? (configured as RecoveryCriterion)
      : recoveryCriterionFor(resource);
    const demo = Boolean(incident.demo_scenario);
    const observationMs =
      (demo ? Math.min(settings.observationMinutes, 1) : settings.observationMinutes) * 60_000;
    const timeoutMs = settings.timeoutMinutes * 60_000;

    let measurement: RecoveryMeasurement;
    if (demo)
      measurement = { ok: true, detail: `Simulado: critério ${criterion} dentro do limite.` };
    else if (criterion !== 'alerts_resolved' && deps.probe)
      measurement = await deps.probe.measure({
        projectId: context.ticket.projectId,
        environment: incident.environment,
        criterion,
        resource,
        settings,
      });
    else if (criterion === 'alerts_resolved')
      measurement =
        incident.state !== 'open'
          ? { ok: true, detail: 'Os alertas do incidente recuperaram.' }
          : {
              ok: false,
              detail: `O alerta ${incident.alert_name ?? incident.root_title} continua ativo.`,
            };
    else measurement = { ok: null, detail: 'Sem sonda para o critério.' };
    // Sem telemetria recente o resultado é desconhecido: nunca conta como serviço saudável.
    const unknown = measurement.ok === null;
    if (unknown)
      measurement = {
        ok: null,
        detail: `Sem telemetria recente para ${criterion}: resultado desconhecido (${measurement.detail})`,
      };

    const current = await stepIncident(context);
    const measurements = [
      ...(current.measurements ?? []),
      {
        at: context.now.toISOString(),
        ok: measurement.ok === true,
        ...(unknown ? { unknown: true } : {}),
        detail: measurement.detail,
      },
    ].slice(-20);
    let okSince: string | null = null;
    for (const item of measurements) okSince = item.ok ? (okSince ?? item.at) : null;
    const done = await interventions(context.client, context.ticket.id);
    const attempts = done.filter((row) =>
      ['succeeded', 'simulated', 'failed'].includes(row.status),
    ).length;
    const output: IncidentOutput = { criterion, measurements, attempts, simulated: demo };

    if (okSince && context.now.getTime() - new Date(okSince).getTime() >= observationMs) {
      const summary = `Recuperação confirmada (${criterion}): ${measurement.detail}`;
      await releaseHealthLock(context);
      await note(context, summary);
      return { port: 'recovered', output: { summary, incident: output } };
    }
    if (elapsedMs(context) >= timeoutMs && !okSince) {
      if (unknown) {
        const reason = `Sem telemetria ao fim de ${settings.timeoutMinutes} min: recuperação por confirmar (${measurement.detail}).`;
        await releaseHealthLock(context);
        await note(context, `${reason} A escalar.`);
        return { port: 'unknown', output: { reason, incident: output } };
      }
      const intervened = done.some((row) => ['succeeded', 'simulated'].includes(row.status));
      const uncertain = done.some((row) => row.status === 'uncertain');
      const reason = `Sem recuperação ao fim de ${settings.timeoutMinutes} min: ${measurement.detail}`;
      if (intervened && !uncertain && attempts < settings.maxAttempts) {
        await note(context, `${reason} Nova tentativa (${attempts + 1}/${settings.maxAttempts}).`);
        return { port: 'retry', output: { reason, incident: output } };
      }
      await releaseHealthLock(context);
      await note(context, `${reason} A escalar.`);
      return { port: 'not_recovered', output: { reason, incident: output } };
    }
    const deadline = context.step.startedAt.getTime() + Math.max(timeoutMs, observationMs);
    const next = Math.min(
      context.now.getTime() + (demo ? 20_000 : 60_000),
      Math.max(deadline, context.now.getTime() + 5000),
    );
    // Renova a reserva do recurso enquanto a validação observa (impede remediações concorrentes).
    await context.client.query(
      "UPDATE resource_locks SET expires_at=GREATEST(expires_at,TIMESTAMPADD(SECOND,$2,NOW(3))) WHERE holder_kind='intervention' AND holder_id=$1",
      [context.ticket.id, HEALTH_LOCK_SECONDS],
    );
    return { wait: new Date(next), output: { incident: output } };
  };
}

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

async function recipientsFor(context: FlowActionContext, incident: IncidentRow | undefined) {
  const configured = text(context.node.config.recipients)
    .split(/[\s,;]+/)
    .filter((value) => EMAIL_PATTERN.test(value));
  if (configured.length) return [...new Set(configured)];
  const row = (
    await context.client.query<{ config: unknown }>(
      'SELECT config FROM health_settings WHERE project_id=$1',
      [context.ticket.projectId],
    )
  ).rows[0];
  if (!row) return [];
  const settings = healthSettingsSchema.parse(
    typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {}),
  );
  const target: HealthRecipientTarget = (healthCriticalities as readonly string[]).includes(
    incident?.criticality ?? '',
  )
    ? (incident!.criticality as HealthRecipientTarget)
    : 'critica';
  return resolveRecipients(settings, target);
}

function createEmail(deps: IncidentActionDeps): FlowActionExecutor {
  return async (context) => {
    const template = text(context.node.config.template) === 'escalation' ? 'escalation' : 'closure';
    const incident = await loadIncident(context.client, context.ticket.id);
    const ticket = (
      await context.client.query<{ key: string; title: string }>(
        'SELECT `key`,title FROM tickets WHERE id=$1',
        [context.ticket.id],
      )
    ).rows[0];
    const steps = await trail(context);
    const report = latestReport(steps, context);
    const done = await interventions(context.client, context.ticket.id);
    const policy = await deps.policies.get(context.ticket.projectId, context.client);
    const resource = incident ? resourceOf(incident, policy) : null;
    const validation = [...steps]
      .reverse()
      .find((step) => step.step_output?.incident?.measurements?.length)?.step_output?.incident;
    const lastReason = [...steps].reverse().find((step) => step.step_output?.reason)
      ?.step_output?.reason;
    const recipients = await recipientsFor(context, incident);
    const demo = incident?.demo_scenario ? ' (demonstração)' : '';
    const title = `${incident?.root_title ?? ticket?.title ?? 'Incidente'}${demo}`;
    const ticketLine = ticket
      ? `Ticket: ${ticket.key}${deps.publicUrl ? ` ${deps.publicUrl.replace(/\/$/, '')}/#tickets/${context.ticket.id}` : ''}`
      : '';
    const facts = [
      resource ? `Recurso: ${describeResource(resource)}` : '',
      incident ? `Ambiente: ${incident.environment}` : '',
      incident
        ? `Início: ${new Date(incident.opened_at).toISOString().replace('T', ' ').slice(0, 16)} UTC`
        : '',
      ticketLine,
    ];
    const section = (heading: string, items: string[]) =>
      items.length ? [`${heading}:`, ...items.map((item) => `- ${item}`)] : [];
    const intervened = done.filter((row) => ['succeeded', 'simulated'].includes(row.status));
    const cause =
      report?.causeConfirmed && report.causeComponent
        ? [`Causa confirmada em ${report.causeComponent}.`]
        : [
            `Causa por apurar${report?.causeComponent ? ` (suspeita: ${report.causeComponent})` : ''}.`,
          ];
    if (
      report?.alertComponent &&
      report.causeComponent &&
      report.alertComponent !== report.causeComponent
    )
      cause.push(
        `O alerta veio de ${report.alertComponent}, mas a causa está em ${report.causeComponent}.`,
      );
    const evidence = (validation?.measurements ?? [])
      .slice(-5)
      .map((item) => `${item.at.slice(11, 16)} ${item.detail}`);
    const lines =
      template === 'closure'
        ? [
            'O incidente recuperou e o ticket foi fechado.',
            ...facts,
            ...section('Impacto', [report?.impact || 'Não indicado pela investigação.']),
            ...section('O que aconteceu', report?.observations ?? []),
            ...section('Causa', cause),
            ...section(
              'Intervenção',
              intervened.length
                ? intervened.map(interventionLine)
                : ['Nenhuma: o recurso recuperou espontaneamente, sem intervenção.'],
            ),
            ...section(
              'Evidência de recuperação',
              evidence.length ? evidence : ['Os alertas do incidente recuperaram.'],
            ),
          ]
        : [
            'O incidente continua aberto e precisa de intervenção humana.',
            ...facts,
            ...section('Impacto atual', [report?.impact || 'Por apurar.']),
            ...section('Evidência', [...(report?.observations ?? []), ...evidence]),
            ...section('Causa', cause),
            ...section(
              'O que foi tentado',
              done.length ? done.map(interventionLine) : ['Nenhuma intervenção automática.'],
            ),
            ...section('Resultados', [lastReason ?? 'Sem recuperação confirmada.']),
            ...section('Próximo passo recomendado', [
              report?.nextStep || 'Rever a evidência no ticket e decidir a intervenção.',
            ]),
          ];
    const subject = `[ZeroOps][${template === 'closure' ? 'Resolvido' : 'Escalado'}] ${clip(title, 200)}`;
    const body = lines.filter(Boolean).join('\n');
    const output: IncidentOutput = {
      recipients,
      template,
      simulated: Boolean(incident?.demo_scenario),
    };
    if (!recipients.length)
      return {
        port: 'failed',
        output: {
          reason: 'Sem destinatários configurados na Saúde nem na etapa.',
          incident: output,
        },
      };
    await context.client.query(
      `INSERT INTO health_notifications(id,project_id,alert_id,kind,channel,recipients,subject,body,state)
       VALUES($1,$2,NULL,$3,'email',$4,$5,$6,'pending')`,
      [
        randomUUID(),
        context.ticket.projectId,
        template === 'closure' ? 'resolved' : 'alert',
        recipients.join(','),
        subject.slice(0, 300),
        body,
      ],
    );
    await note(
      context,
      `E-mail de ${template === 'closure' ? 'fecho' : 'escalada'} enviado para ${recipients.join(', ')}.`,
    );
    // Na demonstração nada falhou de facto: o fecho resolve os alertas sintéticos.
    if (template === 'closure' && incident?.demo_scenario)
      await context.client.query(
        "UPDATE health_external_alerts SET state='resolved', resolved_at=$1 WHERE ticket_id=$2 AND state='firing'",
        [context.now, context.ticket.id],
      );
    return { port: 'done', output: { summary: subject, incident: output } };
  };
}

function createAssignTeam(deps: IncidentActionDeps): FlowActionExecutor {
  return async (context) => {
    const configured = text(context.node.config.role);
    const role =
      configured && configured !== 'policy'
        ? configured
        : (await deps.policies.get(context.ticket.projectId, context.client)).escalationRole;
    const target = ROLE_STAGE[role] ?? ROLE_STAGE.technical!;
    const existing = (
      await context.client.query<{ display_name: string }>(
        `SELECT u.display_name FROM ticket_assignments a JOIN users u ON u.id=a.user_id
          WHERE a.ticket_id=$1 AND a.stage=$2`,
        [context.ticket.id, target.stage],
      )
    ).rows[0];
    let assignee = existing?.display_name ?? null;
    if (!assignee) {
      const member = (
        await context.client.query<{ user_id: string; display_name: string }>(
          `SELECT m.user_id,u.display_name FROM project_memberships m JOIN users u ON u.id=m.user_id
            WHERE m.project_id=$1 AND m.role=$2 AND NOT m.disabled AND NOT u.disabled
              AND m.user_id NOT IN (SELECT user_id FROM ticket_assignments WHERE ticket_id=$3)
            ORDER BY u.display_name LIMIT 1`,
          [context.ticket.projectId, role, context.ticket.id],
        )
      ).rows[0];
      if (member) {
        await context.client.query(
          `INSERT IGNORE INTO ticket_assignments(ticket_id,project_id,stage,user_id,assigned_by)
           VALUES($1,$2,$3,$4,$5)`,
          [
            context.ticket.id,
            context.ticket.projectId,
            target.stage,
            member.user_id,
            context.ticket.createdBy,
          ],
        );
        assignee = member.display_name;
      }
    }
    const summary = assignee
      ? `Incidente atribuído a ${target.label}: ${assignee}.`
      : `Incidente encaminhado para ${target.label} (sem membro ativo com este papel).`;
    await note(context, summary);
    return { port: 'done', output: { summary } };
  };
}

/** Ações do fluxo «Incidente (Health)», independentes do tipo de recurso. */
export function createIncidentActions(deps: IncidentActionDeps): FlowActionRegistry {
  return {
    incident_intake: createIntake(deps),
    authorize_intervention: createAuthorize(deps),
    remediate: createRemediate(deps),
    validate_recovery: createValidate(deps),
    email_notify: createEmail(deps),
    assign_team: createAssignTeam(deps),
  };
}
