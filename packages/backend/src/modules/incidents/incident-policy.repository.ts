import {
  defaultIncidentPolicy,
  incidentPolicySchema,
  type IncidentPolicy,
  type IncidentPolicyView,
} from '../../../../contracts/src/index.js';
import type { Queryable } from '../identity/membership.js';
import { DomainError } from '../../errors.js';

interface PolicyRow {
  policy: string | IncidentPolicy;
  version: number;
  updated_by: string | null;
  updated_at: Date | string | null;
}

function parsePolicy(raw: PolicyRow['policy']): IncidentPolicy {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const parsed = incidentPolicySchema.safeParse(value);
  // Uma política corrompida não pode desligar as proibições: volta à política conservadora.
  return parsed.success ? parsed.data : defaultIncidentPolicy();
}

/** Política de intervenção do projeto (uma linha por projeto; sem linha vale a omissão). */
export class IncidentPolicyRepository {
  constructor(private readonly db: Queryable) {}

  async view(projectId: string, client: Queryable = this.db): Promise<IncidentPolicyView> {
    const result = await client.query<PolicyRow>(
      'SELECT policy, version, updated_by, updated_at FROM incident_policies WHERE project_id=$1',
      [projectId],
    );
    const row = result.rows[0];
    if (!row)
      return { policy: defaultIncidentPolicy(), version: 0, updatedBy: null, updatedAt: null };
    return {
      policy: parsePolicy(row.policy),
      version: Number(row.version),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  async get(projectId: string, client: Queryable = this.db) {
    return (await this.view(projectId, client)).policy;
  }

  /** Grava com controlo de concorrência otimista (`expectedVersion` 0 = ainda sem linha). */
  async save(
    projectId: string,
    policy: IncidentPolicy,
    expectedVersion: number,
    actorId: string,
    client: Queryable = this.db,
  ) {
    const value = JSON.stringify(incidentPolicySchema.parse(policy));
    const result =
      expectedVersion === 0
        ? await client.query(
            `INSERT IGNORE INTO incident_policies(project_id, policy, version, updated_by, updated_at)
             VALUES ($1, $2, 1, $3, NOW(3))`,
            [projectId, value, actorId],
          )
        : await client.query(
            `UPDATE incident_policies SET policy=$2, version=version+1, updated_by=$3, updated_at=NOW(3)
             WHERE project_id=$1 AND version=$4`,
            [projectId, value, actorId, expectedVersion],
          );
    if (!result.rowCount)
      throw new DomainError(
        'INCIDENT_POLICY_CONFLICT',
        'A política foi alterada entretanto. Recarregue e tente de novo.',
        409,
      );
    return this.view(projectId, client);
  }
}
