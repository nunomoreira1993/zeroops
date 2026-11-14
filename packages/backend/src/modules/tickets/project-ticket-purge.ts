import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database, SqlClient } from '../../database/database.js';
import {
  ticketPurgeProtocol,
  ticketPurgeRuntimeFingerprint,
  verifyTicketPurgeReadiness,
} from './ticket-purge-readiness.js';

const ticketSet = 'SELECT id FROM tickets WHERE project_id=$1';
const runSet = `SELECT id FROM agent_runs WHERE ticket_id IN (${ticketSet})`;
const executionSet = `SELECT id FROM flow_executions WHERE ticket_id IN (${ticketSet})`;
const outboxSet = `SELECT o.id FROM notification_outbox o JOIN tickets t
  ON t.id=JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.ticketId')) WHERE t.project_id=$1`;

// Child-first order, verified against information_schema on every invocation.
const deletions: ReadonlyArray<readonly [string, string]> = [
  [
    'identity_confirmations',
    `(project_id=$1 OR project_id IS NULL) AND EXISTS(SELECT 1 FROM tickets t WHERE t.project_id=$1 AND (identity_confirmations.target=t.id OR identity_confirmations.target LIKE CONCAT(t.id,':%')))`,
  ],
  ['notification_delivery_state', `outbox_id IN (${outboxSet})`],
  ['notification_outbox', `id IN (SELECT id FROM (${outboxSet}) purge_outbox)`],
  [
    'flow_decisions',
    `step_id IN (SELECT id FROM flow_execution_steps WHERE execution_id IN (${executionSet}))`,
  ],
  ['flow_execution_events', `execution_id IN (${executionSet})`],
  ['flow_execution_steps', `execution_id IN (${executionSet})`],
  ['flow_executions', `ticket_id IN (${ticketSet})`],
  ['flow_assistant_requests', `ticket_id IN (${ticketSet})`],
  ['connector_relay_requests', `run_id IN (${runSet})`],
  ['agent_run_inputs', `run_id IN (${runSet})`],
  ['agent_run_events', `run_id IN (${runSet})`],
  ['agent_run_tool_calls', `run_id IN (${runSet})`],
  ['agent_runs', `ticket_id IN (${ticketSet})`],
  [
    'ticket_comment_revisions',
    `comment_id IN (SELECT id FROM ticket_comments WHERE ticket_id IN (${ticketSet}))`,
  ],
  ...[
    'ticket_comments',
    'ticket_events',
    'ticket_revisions',
    'ticket_assignments',
    'ticket_participants',
    'ticket_resolutions',
    'ticket_dependency_invalidations',
    'proposals',
    'approvals',
    'execution_runs',
    'deployment_runs',
    'incident_interventions',
    'health_incidents',
    'audit_events',
  ].map((table) => [table, `ticket_id IN (${ticketSet})`] as const),
  ['tickets', 'project_id=$1'],
];
const healthTables = [
  'health_samples',
  'health_agent_samples',
  'health_metric_hourly',
  'health_alerts',
  'health_external_alerts',
  'health_alert_events',
  'health_notifications',
] as const;

export interface TicketPurgeTarget {
  projectId: string;
  projectName: string;
  databaseName: string;
  databaseHost: string;
  actorId: string;
}

export interface TicketPurgeReport {
  target: TicketPurgeTarget;
  tickets: number;
  deleteCounts: Record<string, number>;
  preservedCounts: Record<string, number>;
  blockers: string[];
  digest: string;
  applied: boolean;
  runtimeProtocol: string;
  runtimeFingerprint: string;
}

async function count(client: SqlClient, table: string, predicate: string, projectId: string) {
  const found = await client.query<{ total: number }>(
    `SELECT COUNT(*) AS total FROM \`${table}\` WHERE ${predicate}`,
    [projectId],
  );
  return Number(found.rows[0]!.total);
}

/** No external side effects: active/ambiguous work is rejected, never force-cancelled. */
export class ProjectTicketPurge {
  constructor(private readonly db: Database) {}

  /** Establishes an expiring ticket-only project lease; does not cancel existing work or stop Health. */
  async quiesce(target: TicketPurgeTarget) {
    return this.db.transaction(async (client) => {
      await this.guardTarget(client, target);
      const existing = await client.query(
        'SELECT lease_id FROM ticket_purge_maintenance WHERE project_id=$1 AND lease_until>NOW(3) FOR UPDATE',
        [target.projectId],
      );
      if (existing.rowCount)
        throw new Error('A live ticket maintenance lease already exists; do not replace it.');
      const leaseId = randomUUID();
      const runtimeFingerprint = await ticketPurgeRuntimeFingerprint();
      await client.query(
        `INSERT INTO ticket_purge_maintenance(project_id,lease_id,actor_id,lease_until,runtime_fingerprint)
         VALUES($1,$2,$3,DATE_ADD(NOW(3),INTERVAL 10 MINUTE),$4)
         ON DUPLICATE KEY UPDATE lease_id=VALUES(lease_id),actor_id=VALUES(actor_id),
           lease_until=VALUES(lease_until),runtime_fingerprint=VALUES(runtime_fingerprint)`,
        [target.projectId, leaseId, target.actorId, runtimeFingerprint],
      );
      const lease = (
        await client.query<{ lease_until: Date }>(
          'SELECT lease_until FROM ticket_purge_maintenance WHERE project_id=$1',
          [target.projectId],
        )
      ).rows[0]!;
      return { target, leaseId, heldUntil: lease.lease_until.toISOString(), runtimeFingerprint };
    });
  }

  /** Releases only this administrator's exact lease, including after an aborted purge. */
  async resume(target: TicketPurgeTarget, leaseId: string) {
    return this.db.transaction(async (client) => {
      await this.guardTarget(client, target);
      const result = await client.query(
        'DELETE FROM ticket_purge_maintenance WHERE project_id=$1 AND lease_id=$2 AND actor_id=$3',
        [target.projectId, leaseId, target.actorId],
      );
      if (!result.rowCount)
        throw new Error('Maintenance lease does not belong to this operator/target.');
      return { target, resumed: true };
    });
  }

  /** Reports scope, unsafe work and the exact runtime fingerprint without deleting data. */
  dryRun(target: TicketPurgeTarget) {
    return this.run(target);
  }

  /** Applies only a fresh scoped attestation backed by a live project maintenance lease. */
  async apply(
    target: TicketPurgeTarget,
    expectedDigest: string,
    confirmation: string,
    readiness?: unknown,
  ) {
    if (confirmation !== `DELETE ALL TICKETS ${target.projectName} ${target.projectId}`)
      throw new Error('Exact destructive confirmation required.');
    return this.run(target, expectedDigest, readiness);
  }

  private async run(
    target: TicketPurgeTarget,
    expectedDigest?: string,
    readiness?: unknown,
  ): Promise<TicketPurgeReport> {
    return this.db.transaction(async (client) => {
      await this.guardTarget(client, target);
      await this.verifySchema(client);
      const manualSql = await readFile(resolve('sql/manual/purge_project_tickets.sql'), 'utf8');
      const deletionSql = manualSql
        .replace(/\r\n/g, '\n')
        .split('-- BEGIN GUARDED DELETE\n')[1]
        ?.split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
      const expectedSql = deletions.map(
        ([table, predicate]) => `DELETE FROM \`${table}\` WHERE ${predicate}`,
      );
      const normalize = (statement: string) => statement.replace(/\s+/g, ' ').trim();
      if (
        !deletionSql ||
        JSON.stringify(deletionSql.map(normalize)) !== JSON.stringify(expectedSql.map(normalize))
      )
        throw new Error('Manual SQL deletion contract differs from reviewed service.');
      const tickets = (
        await client.query<{ id: string; key: string }>(
          'SELECT id,`key` FROM tickets WHERE project_id=$1 ORDER BY id FOR UPDATE',
          [target.projectId],
        )
      ).rows;
      // Claims use these same row locks. A committed running claim becomes a blocker;
      // an uncommitted claim is waited for, never mistaken for a queued item.
      for (const [table, predicate] of deletions)
        if (table !== 'tickets')
          await client.query(`SELECT 1 FROM \`${table}\` WHERE ${predicate} FOR UPDATE`, [
            target.projectId,
          ]);
      for (const table of ['health_alerts', 'health_external_alerts'])
        await client.query(`SELECT id FROM ${table} WHERE project_id=$1 FOR UPDATE`, [
          target.projectId,
        ]);

      const deleteCounts: Record<string, number> = {};
      for (const [table, predicate] of deletions)
        deleteCounts[table] = await count(client, table, predicate, target.projectId);
      const preservedCounts: Record<string, number> = {};
      for (const table of healthTables)
        preservedCounts[table] = await count(client, table, 'project_id=$1', target.projectId);
      const blockers: string[] = [];
      for (const table of [
        'flow_assistant_requests',
        'health_incidents',
        'health_alerts',
        'health_external_alerts',
      ]) {
        const total = await count(
          client,
          table,
          `ticket_id IN (${ticketSet}) AND project_id<>$1`,
          target.projectId,
        );
        if (total) blockers.push(`${table}: ${total} cross-project references`);
      }
      const crossRunLinks: ReadonlyArray<readonly [string, string]> = [
        ['ticket_comments', `agent_run_id IN (${runSet}) AND ticket_id NOT IN (${ticketSet})`],
        [
          'flow_execution_steps',
          `agent_run_id IN (${runSet}) AND execution_id NOT IN (${executionSet})`,
        ],
        ['health_incidents', `review_run_id IN (${runSet}) AND ticket_id NOT IN (${ticketSet})`],
      ];
      for (const [table, predicate] of crossRunLinks) {
        const total = await count(client, table, predicate, target.projectId);
        if (total) blockers.push(`${table}: ${total} cross-project run references`);
      }
      const unsafe: ReadonlyArray<readonly [string, string]> = [
        ['agent_runs', `ticket_id IN (${ticketSet}) AND status='running'`],
        ['flow_assistant_requests', `ticket_id IN (${ticketSet}) AND status='running'`],
        ['execution_runs', `ticket_id IN (${ticketSet}) AND status IN ('pending','running')`],
        [
          'deployment_runs',
          `ticket_id IN (${ticketSet}) AND status IN ('pending','running','uncertain')`,
        ],
        ['connector_relay_requests', `run_id IN (${runSet}) AND status='claimed'`],
        [
          'notification_delivery_state',
          `outbox_id IN (${outboxSet}) AND state IN ('processing','uncertain')`,
        ],
      ];
      for (const [table, predicate] of unsafe) {
        const total = await count(client, table, predicate, target.projectId);
        if (total) blockers.push(`${table}: ${total} active/uncertain`);
      }
      const digest = createHash('sha256')
        .update(JSON.stringify({ target, tickets, deleteCounts }))
        .digest('hex');
      const runtimeFingerprint = await ticketPurgeRuntimeFingerprint();
      const report: TicketPurgeReport = {
        target,
        tickets: tickets.length,
        deleteCounts,
        preservedCounts,
        blockers,
        digest,
        applied: false,
        runtimeProtocol: ticketPurgeProtocol,
        runtimeFingerprint,
      };
      if (expectedDigest === undefined) return report;
      if (digest !== expectedDigest) throw new Error('Scope changed; review a fresh dry-run.');
      if (blockers.length)
        throw new Error(`Unsafe work must finish/reconcile first: ${blockers.join('; ')}`);
      const verified = verifyTicketPurgeReadiness(readiness, target, digest, runtimeFingerprint);
      const lease = (
        await client.query<{ lease_until: Date; runtime_fingerprint: string }>(
          `SELECT lease_until,runtime_fingerprint FROM ticket_purge_maintenance
           WHERE project_id=$1 AND lease_id=$2 AND actor_id=$3 AND lease_until>NOW(3) FOR UPDATE`,
          [target.projectId, verified.proof.quiescence.leaseId, target.actorId],
        )
      ).rows[0];
      if (
        !lease ||
        lease.runtime_fingerprint !== runtimeFingerprint ||
        lease.lease_until.getTime() < Date.parse(verified.proof.validUntil)
      )
        throw new Error(
          'Verified project ticket quiescence lease is absent, expired, or for a different runtime.',
        );

      for (const [table, source, timestamp, active] of [
        ['health_alerts', 'internal', 'opened_at', 'resolved_at IS NULL'],
        ['health_external_alerts', 'prometheus', 'starts_at', "state='firing'"],
      ]) {
        // All currently active occurrences, including those not yet linked to a ticket.
        await client.query(
          `INSERT INTO ticket_purge_health_occurrences(project_id,source,alert_id,occurrence_at)
           SELECT project_id,'${source}',id,${timestamp} FROM ${table}
           WHERE project_id=$1 AND ${active}
           ON DUPLICATE KEY UPDATE occurrence_at=VALUES(occurrence_at)`,
          [target.projectId],
        );
        await client.query(
          `UPDATE ${table} SET ticket_id=NULL WHERE project_id=$1 AND ticket_id IN (${ticketSet})`,
          [target.projectId],
        );
      }
      // Keep every Health event, including its chronology and evidence; remove ticket links only.
      const events = (
        await client.query<{ id: number; detail: string }>(
          'SELECT id,detail FROM health_alert_events WHERE project_id=$1 AND detail IS NOT NULL FOR UPDATE',
          [target.projectId],
        )
      ).rows;
      const references = tickets.flatMap((ticket) => [ticket.id, ticket.key]);
      for (const event of events) {
        let detail = event.detail;
        for (const reference of references) {
          const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          detail = detail.replace(
            new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?=$|[^A-Za-z0-9-])`, 'g'),
            '$1∅',
          );
        }
        if (detail !== event.detail)
          await client.query('UPDATE health_alert_events SET detail=$2 WHERE id=$1', [
            event.id,
            detail,
          ]);
      }
      for (const statement of deletionSql) await client.query(statement, [target.projectId]);
      if (await count(client, 'tickets', 'project_id=$1', target.projectId))
        throw new Error('Postflight failed: tickets remain.');
      for (const table of healthTables)
        if (
          (await count(client, table, 'project_id=$1', target.projectId)) !== preservedCounts[table]
        )
          throw new Error(`Postflight failed: Health count changed (${table}).`);
      await client.query(
        `INSERT INTO audit_events(id,actor_id,action,details)
         VALUES($1,$2,'project.tickets.purged',$3)`,
        [
          randomUUID(),
          target.actorId,
          JSON.stringify({
            projectId: target.projectId,
            counts: deleteCounts,
            result: 'completed',
            digest,
            attestationDigest: verified.attestationDigest,
            approvedRevision: verified.proof.approvedRevision,
            runtimeFingerprint,
            quiescenceLeaseId: verified.proof.quiescence.leaseId,
          }),
        ],
      );
      verifyTicketPurgeReadiness(readiness, target, digest, await ticketPurgeRuntimeFingerprint());
      await client.query(
        'DELETE FROM ticket_purge_maintenance WHERE project_id=$1 AND lease_id=$2 AND actor_id=$3',
        [target.projectId, verified.proof.quiescence.leaseId, target.actorId],
      );
      return { ...report, applied: true };
    });
  }

  private async guardTarget(client: SqlClient, target: TicketPurgeTarget) {
    const identity = (
      await client.query<{ name: string; host: string }>(
        'SELECT DATABASE() AS name, @@hostname AS host',
      )
    ).rows[0]!;
    if (identity.name !== target.databaseName || identity.host !== target.databaseHost)
      throw new Error('Database identity does not match the reviewed target.');
    const project = (
      await client.query<{ name: string }>('SELECT name FROM projects WHERE id=$1 FOR UPDATE', [
        target.projectId,
      ])
    ).rows[0];
    if (!project || project.name !== target.projectName)
      throw new Error('Project ID/name guard failed.');
    const actor = await client.query(
      `SELECT u.id FROM users u LEFT JOIN project_memberships m ON m.user_id=u.id AND m.project_id=$2
       WHERE u.id=$1 AND NOT u.disabled AND (u.instance_admin OR (m.role='admin' AND NOT m.disabled))
       LOCK IN SHARE MODE`,
      [target.actorId, target.projectId],
    );
    if (!actor.rowCount) throw new Error('Active project/instance administrator required.');
  }

  private async verifySchema(client: SqlClient) {
    const edges = (
      await client.query<{ child: string; parent: string }>(
        `SELECT DISTINCT TABLE_NAME AS child,REFERENCED_TABLE_NAME AS parent
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
      )
    ).rows;
    const order = new Map(deletions.map(([table], index) => [table, index]));
    const logicalDependencies = (
      await client.query<{ table_name: string; column_name: string }>(
        `SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE()
       AND COLUMN_NAME IN ('ticket_id','run_id','agent_run_id','review_run_id','execution_id','comment_id','step_id')`,
      )
    ).rows;
    for (const column of logicalDependencies)
      if (
        !order.has(column.table_name) &&
        !['health_alerts', 'health_external_alerts'].includes(column.table_name)
      )
        throw new Error(
          `Unreviewed logical dependency: ${column.table_name}.${column.column_name}; purge refused.`,
        );
    for (const { child, parent } of edges) {
      const parentIndex = order.get(parent);
      if (parentIndex === undefined) continue;
      if (parent === 'tickets' && ['health_alerts', 'health_external_alerts'].includes(child))
        continue;
      const childIndex = order.get(child);
      if (childIndex === undefined || childIndex >= parentIndex)
        throw new Error(`Unreviewed dependency: ${child} -> ${parent}; purge refused.`);
    }
  }
}
