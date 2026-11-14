-- MANUAL / DESTRUCTIVE reference only. NEVER place in sql/ root or migration runner.
-- Do NOT run against a live legacy runtime: its Health collector ignores suppression.
-- Execute ONLY via ProjectTicketPurge after reviewed dry-run, runtime verification and
-- transaction/row locks. $1 is its bound project UUID, NOT a SQL session variable.
-- Apply requires a matching ticket_purge_maintenance lease and fresh version/process/artifact
-- attestation. The service releases its own lease atomically only after successful postflight.
-- This file documents the exact child-first relational deletion; it deliberately cannot
-- be pasted as an unguarded standalone production deletion.
--
-- Preflight (read-only; replace only the project variable for an inventory):
SET @project_id = '00000000-0000-4000-8000-000000000001';
SELECT DATABASE() AS database_name, @@hostname AS database_host;
SELECT id,name FROM projects WHERE id=@project_id;
SELECT COUNT(*) AS tickets FROM tickets WHERE project_id=@project_id;
SELECT status,COUNT(*) AS total FROM agent_runs WHERE project_id=@project_id GROUP BY status;
SELECT status,COUNT(*) AS total FROM flow_executions WHERE project_id=@project_id GROUP BY status;
SELECT TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL;
--
-- Apply recipe below is commented intentionally: guarded service owns transaction,
-- schema verification, identity/admin checks, confirmation digest and postflight.
-- Preserve every health_samples, health_agent_samples, health_metric_hourly,
-- health_alerts, health_external_alerts, health_alert_events, health_notifications row.
--
-- INSERT INTO ticket_purge_health_occurrences(project_id,source,alert_id,occurrence_at)
-- SELECT project_id,'internal',id,opened_at FROM health_alerts
-- WHERE project_id=$1 AND resolved_at IS NULL
-- ON DUPLICATE KEY UPDATE occurrence_at=VALUES(occurrence_at);
-- INSERT INTO ticket_purge_health_occurrences(project_id,source,alert_id,occurrence_at)
-- SELECT project_id,'prometheus',id,starts_at FROM health_external_alerts
-- WHERE project_id=$1 AND state='firing'
-- ON DUPLICATE KEY UPDATE occurrence_at=VALUES(occurrence_at);
-- UPDATE health_alerts SET ticket_id=NULL
-- WHERE project_id=$1 AND ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
-- UPDATE health_external_alerts SET ticket_id=NULL
-- WHERE project_id=$1 AND ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
-- For each scoped ticket UUID/key: REPLACE only those references in health_alert_events.detail;
-- delete identity_confirmations targeting that ticket; keep all Health events and emails.
--
-- Child-first deletion predicates (all ticket scopes use SELECT id FROM tickets WHERE project_id=$1):
-- notification_delivery_state -> matching outbox payload.ticketId
-- notification_outbox -> matching payload.ticketId (derived subquery for MySQL)
-- flow_decisions -> flow_execution_steps -> flow_executions -> ticket
-- flow_execution_events -> flow_executions -> ticket
-- flow_execution_steps -> flow_executions -> ticket
-- flow_executions -> ticket
-- flow_assistant_requests -> ticket_id (no FK; explicitly scoped)
-- connector_relay_requests -> agent_runs -> ticket
-- agent_run_inputs -> agent_runs -> ticket
-- agent_run_events -> agent_runs -> ticket
-- agent_run_tool_calls -> agent_runs -> ticket
-- agent_runs -> ticket
-- ticket_comment_revisions -> ticket_comments -> ticket
-- ticket_comments, ticket_events, ticket_revisions, ticket_assignments, ticket_participants,
-- ticket_resolutions, ticket_dependency_invalidations, proposals, approvals, execution_runs,
-- deployment_runs, incident_interventions, health_incidents, audit_events -> ticket
-- DELETE FROM tickets WHERE project_id=$1;
-- Insert one project.tickets.purged audit_events row with actor/project/counts/result only.
-- Verify zero scoped tickets; unchanged Health counts; commit. Any failure rolls back.
-- NEVER reset ticket_key_counter, disable FK checks, delete shared flows/profiles, or rm broad paths.
--
-- Bound statements below are loaded/verified by the service, NEVER executed standalone.
-- $1 MUST remain a bound parameter; do not replace it manually.
-- BEGIN GUARDED DELETE
DELETE FROM `identity_confirmations` WHERE (project_id=$1 OR project_id IS NULL) AND EXISTS(SELECT 1 FROM tickets t WHERE t.project_id=$1 AND (identity_confirmations.target=t.id OR identity_confirmations.target LIKE CONCAT(t.id,':%')));
DELETE FROM `notification_delivery_state` WHERE outbox_id IN (SELECT o.id FROM notification_outbox o JOIN tickets t ON t.id=JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.ticketId')) WHERE t.project_id=$1);
DELETE FROM `notification_outbox` WHERE id IN (SELECT id FROM (SELECT o.id FROM notification_outbox o JOIN tickets t ON t.id=JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.ticketId')) WHERE t.project_id=$1) purge_outbox);
DELETE FROM `flow_decisions` WHERE step_id IN (SELECT id FROM flow_execution_steps WHERE execution_id IN (SELECT id FROM flow_executions WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1)));
DELETE FROM `flow_execution_events` WHERE execution_id IN (SELECT id FROM flow_executions WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1));
DELETE FROM `flow_execution_steps` WHERE execution_id IN (SELECT id FROM flow_executions WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1));
DELETE FROM `flow_executions` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `flow_assistant_requests` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `connector_relay_requests` WHERE run_id IN (SELECT id FROM agent_runs WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1));
DELETE FROM `agent_run_inputs` WHERE run_id IN (SELECT id FROM agent_runs WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1));
DELETE FROM `agent_run_events` WHERE run_id IN (SELECT id FROM agent_runs WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1));
DELETE FROM `agent_run_tool_calls` WHERE run_id IN (SELECT id FROM agent_runs WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1));
DELETE FROM `agent_runs` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `ticket_comment_revisions` WHERE comment_id IN (SELECT id FROM ticket_comments WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1));
DELETE FROM `ticket_comments` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `ticket_events` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `ticket_revisions` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `ticket_assignments` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `ticket_participants` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `ticket_resolutions` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `ticket_dependency_invalidations` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `proposals` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `approvals` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `execution_runs` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `deployment_runs` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `incident_interventions` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `health_incidents` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `audit_events` WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=$1);
DELETE FROM `tickets` WHERE project_id=$1;
