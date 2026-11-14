import type {
  IncidentEnvironmentKey,
  IncidentInterventionView,
  InterventionAction,
  InterventionDecision,
  InterventionStatus,
  TicketIncidentView,
} from '../../../../contracts/src/index.js';
import type { Queryable } from '../identity/membership.js';

interface IncidentRow {
  environment: IncidentEnvironmentKey;
  state: string;
  opened_at: Date | string;
  recovered_at: Date | string | null;
  resource_kind: string | null;
  resource_engine: string | null;
  resource_host: string | null;
  resource_unit: string | null;
  resource_managed: number | boolean;
  alert_component: string | null;
  cause_component: string | null;
  cause_confirmed: number | boolean;
  demo_scenario: string | null;
}

interface InterventionRow {
  id: string;
  ticket_id: string;
  step_id: string | null;
  action: InterventionAction;
  target: string;
  parameter: string | null;
  previous_value: string | null;
  new_value: string | null;
  rollback_hint: string | null;
  decision: InterventionDecision;
  decision_reason: string;
  status: InterventionStatus;
  result_text: string | null;
  actor_kind: 'agent' | 'human';
  created_at: Date | string;
  finished_at: Date | string | null;
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

/** Recurso, componentes e intervenções de um ticket de incidente (null se não for incidente). */
export async function ticketIncidentView(
  db: Queryable,
  ticketId: string,
): Promise<TicketIncidentView | null> {
  const row = (
    await db.query<IncidentRow>(
      `SELECT environment,state,opened_at,recovered_at,resource_kind,resource_engine,resource_host,
              resource_unit,resource_managed,alert_component,cause_component,cause_confirmed,demo_scenario
         FROM health_incidents WHERE ticket_id=$1`,
      [ticketId],
    )
  ).rows[0];
  if (!row) return null;
  const interventions = (
    await db.query<InterventionRow>(
      `SELECT id,ticket_id,step_id,action,target,parameter,previous_value,new_value,rollback_hint,
              decision,decision_reason,status,result_text,actor_kind,created_at,finished_at
         FROM incident_interventions WHERE ticket_id=$1 ORDER BY created_at`,
      [ticketId],
    )
  ).rows;
  return {
    environment: row.environment,
    state: row.state,
    resource: row.resource_kind
      ? {
          kind: row.resource_kind,
          engine: row.resource_engine,
          host: row.resource_host,
          unit: row.resource_unit,
          environment: row.environment,
          managed: Boolean(row.resource_managed),
        }
      : null,
    alertComponent: row.alert_component,
    causeComponent: row.cause_component,
    causeConfirmed: Boolean(row.cause_confirmed),
    demoScenario: row.demo_scenario,
    openedAt: iso(row.opened_at)!,
    recoveredAt: iso(row.recovered_at),
    interventions: interventions.map((item): IncidentInterventionView => ({
      id: item.id,
      ticketId: item.ticket_id,
      stepId: item.step_id,
      action: item.action,
      target: item.target,
      parameter: item.parameter,
      previousValue: item.previous_value,
      newValue: item.new_value,
      rollback: item.rollback_hint,
      decision: item.decision,
      decisionReason: item.decision_reason,
      status: item.status,
      result: item.result_text,
      actor: item.actor_kind,
      createdAt: iso(item.created_at)!,
      finishedAt: iso(item.finished_at),
    })),
  };
}
