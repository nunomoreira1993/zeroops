import { createHash, randomUUID } from 'node:crypto';
import type { User } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import {
  requireInstanceAdmin,
  requireProjectAdmin,
  type Queryable,
} from '../identity/membership.js';

/**
 * P11 — retenção de entidades operacionais acumuladas pelos fluxos (eventos de leases, execuções
 * de simulação, outbox entregue e fragmentos de streaming do Copilot). Nunca corre sozinha:
 * dry-run com hash da seleção e aplicação explícita com `expect`. Cada predicado é reavaliado
 * com lock no momento da remoção, por isso trabalho que ficou ativo entretanto não é removido.
 *
 * Fora deste serviço (já existentes): workspaces de desenvolvimento (executor,
 * `ZEROOPS_DEV_WORKSPACE_RETENTION_DAYS`), amostras/eventos da Health (`HealthRepository.prune`),
 * backups do deploy (10 mais recentes) e logs em ficheiro (logrotate).
 */

export interface RetentionPolicy {
  /** `agent_job_events` de jobs terminados. 0 desativa. */
  jobEventsDays: number;
  /** Execuções de simulação terminadas sem ligação a versões/ativações nem ao manifesto atual. */
  simulationsDays: number;
  /** Notificações com entrega confirmada (`sent`); falhadas/incertas ficam para recuperação. */
  outboxDays: number;
  /** `assistant.delta` de runs terminados cuja mensagem final já está registada. */
  runDeltasDays: number;
}

export const defaultRetentionPolicy: RetentionPolicy = {
  jobEventsDays: 180,
  simulationsDays: 90,
  outboxDays: 180,
  runDeltasDays: 30,
};

const days = (value: string | undefined, fallback: number) => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650)
    throw new Error(`Retenção inválida: ${value} (dias inteiros 0..3650; 0 desativa).`);
  return parsed;
};

/** Política a partir de `ZEROOPS_RETENTION_*_DAYS` (0 desativa; valores inválidos falham). */
export function retentionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    jobEventsDays: days(
      env.ZEROOPS_RETENTION_JOB_EVENTS_DAYS,
      defaultRetentionPolicy.jobEventsDays,
    ),
    simulationsDays: days(
      env.ZEROOPS_RETENTION_SIMULATIONS_DAYS,
      defaultRetentionPolicy.simulationsDays,
    ),
    outboxDays: days(env.ZEROOPS_RETENTION_OUTBOX_DAYS, defaultRetentionPolicy.outboxDays),
    runDeltasDays: days(
      env.ZEROOPS_RETENTION_RUN_DELTAS_DAYS,
      defaultRetentionPolicy.runDeltasDays,
    ),
  };
}

type Entity = 'agent_job_events' | 'flow_simulation_runs' | 'notification_outbox' | 'run_deltas';

interface EntityRule {
  entity: Entity;
  table: string;
  policy: keyof RetentionPolicy;
  /** SELECT de ids elegíveis; `$1` = dias, `$2` = projeto ou NULL (todos). */
  select: string;
}

const ACTIVE_JOB = `EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=e.job_id AND r.status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM flow_assistant_requests f WHERE f.id=e.job_id AND f.status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM ticket_routing_jobs j WHERE j.id=e.job_id AND j.status IN ('queued','running'))
  OR EXISTS(SELECT 1 FROM flow_simulation_runs s WHERE s.id=e.job_id AND s.status IN ('queued','running'))`;

const rules: EntityRule[] = [
  {
    entity: 'agent_job_events',
    table: 'agent_job_events',
    policy: 'jobEventsDays',
    select: `SELECT e.id FROM agent_job_events e
      WHERE e.created_at < NOW(3) - INTERVAL $1 DAY AND ($2 IS NULL OR e.project_id=$2)
        AND NOT (${ACTIVE_JOB})`,
  },
  {
    // Protege a evidência de versões/ativações e o manifesto mais recente de cada fluxo (rascunho
    // em preparação). Entregas de ensaio (`flow_trial_deliveries`) caem em cascata.
    entity: 'flow_simulation_runs',
    table: 'flow_simulation_runs',
    policy: 'simulationsDays',
    select: `SELECT s.id FROM flow_simulation_runs s
      WHERE s.status IN ('completed','failed','cancelled')
        AND s.created_at < NOW(3) - INTERVAL $1 DAY AND ($2 IS NULL OR s.project_id=$2)
        AND NOT EXISTS(SELECT 1 FROM flow_versions v WHERE v.flow_id=s.flow_id
          AND s.manifest_hash IS NOT NULL AND v.manifest_hash=s.manifest_hash)
        AND NOT EXISTS(SELECT 1 FROM flow_activations a WHERE a.flow_id=s.flow_id
          AND ((s.manifest_hash IS NOT NULL AND a.manifest_hash=s.manifest_hash)
            OR a.activation_details LIKE CONCAT('%',s.id,'%')))
        AND NOT (s.manifest_hash <=> (SELECT l.manifest_hash FROM flow_simulation_runs l
          WHERE l.flow_id=s.flow_id ORDER BY l.created_at DESC, l.id DESC LIMIT 1))`,
  },
  {
    entity: 'notification_outbox',
    table: 'notification_outbox',
    policy: 'outboxDays',
    select: `SELECT o.id FROM notification_outbox o
      JOIN notification_delivery_state d ON d.outbox_id=o.id
      LEFT JOIN tickets t ON t.id=JSON_UNQUOTE(JSON_EXTRACT(o.payload,'$.ticketId'))
      WHERE o.status='sent' AND d.state='sent'
        AND o.created_at < NOW(3) - INTERVAL $1 DAY AND ($2 IS NULL OR t.project_id=$2)`,
  },
  {
    entity: 'run_deltas',
    table: 'agent_run_events',
    policy: 'runDeltasDays',
    select: `SELECT ev.id FROM agent_run_events ev JOIN agent_runs r ON r.id=ev.run_id
      WHERE ev.type='assistant.delta' AND r.status IN ('succeeded','failed','cancelled')
        AND r.finished_at < NOW(3) - INTERVAL $1 DAY AND ($2 IS NULL OR r.project_id=$2)
        AND EXISTS(SELECT 1 FROM agent_run_events m WHERE m.run_id=ev.run_id
          AND m.type='assistant.message'
          AND JSON_UNQUOTE(JSON_EXTRACT(m.payload,'$.messageId'))=JSON_UNQUOTE(JSON_EXTRACT(ev.payload,'$.messageId')))`,
  },
];

/** Máximo por entidade e aplicação (lotes curtos; repetir o dry-run para continuar). */
const BATCH = 5000;

export interface RetentionPlanItem {
  entity: Entity;
  days: number;
  disabled: boolean;
  eligible: number;
  selected: number;
  sample: string[];
}

export interface RetentionPlan {
  scope: string;
  policy: RetentionPolicy;
  items: RetentionPlanItem[];
  /** Fora deste serviço: só reportado (o executor limpa os checkouts). */
  workspaceCandidates: number;
  digest: string;
}

async function ids(db: Queryable, rule: EntityRule, d: number, projectId: string | null) {
  return (
    await db.query<{ id: string | number }>(`${rule.select} ORDER BY 1 LIMIT ${BATCH}`, [
      d,
      projectId,
    ])
  ).rows.map((row) => String(row.id));
}

/** Dry-run e aplicação confirmada da retenção, por projeto (admin) ou instância. */
export class RetentionService {
  constructor(
    private readonly db: Database,
    private readonly policy: RetentionPolicy = defaultRetentionPolicy,
  ) {}

  private async authorize(actor: User, projectId: string | null) {
    if (projectId) await requireProjectAdmin(this.db, actor, projectId);
    else await requireInstanceAdmin(this.db, actor);
  }

  private async selection(projectId: string | null) {
    const selected = new Map<Entity, string[]>();
    const items: RetentionPlanItem[] = [];
    for (const rule of rules) {
      const d = this.policy[rule.policy];
      const list = d > 0 ? await ids(this.db, rule, d, projectId) : [];
      const eligible =
        d > 0
          ? Number(
              (
                await this.db.query<{ total: number }>(
                  `SELECT COUNT(*) AS total FROM (${rule.select}) eligible`,
                  [d, projectId],
                )
              ).rows[0]?.total ?? 0,
            )
          : 0;
      selected.set(rule.entity, list);
      items.push({
        entity: rule.entity,
        days: d,
        disabled: d === 0,
        eligible,
        selected: list.length,
        sample: list.slice(0, 5),
      });
    }
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          projectId,
          policy: this.policy,
          ids: rules.map((rule) => [rule.entity, selected.get(rule.entity)]),
        }),
      )
      .digest('hex');
    return { items, selected, digest };
  }

  /** Dry-run: o que seria removido agora, com hash a confirmar na aplicação. */
  async plan(actor: User, projectId: string | null = null): Promise<RetentionPlan> {
    await this.authorize(actor, projectId);
    const { items, digest } = await this.selection(projectId);
    const workspaces = await this.db.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM development_workspaces w
        WHERE w.state IN ('idle','failed','pending','active') AND ($1 IS NULL OR w.project_id=$1)
          AND w.updated_at < TIMESTAMPADD(DAY,-$2,NOW(3))
          AND NOT EXISTS(SELECT 1 FROM flow_executions e WHERE e.ticket_id=w.ticket_id AND e.status IN ('running','waiting'))
          AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.development_workspace_id=w.id AND r.status IN ('queued','running'))
          AND NOT EXISTS(SELECT 1 FROM delivery_runs d WHERE d.workspace_id=w.id AND d.finished_at IS NULL)`,
      [projectId, days(process.env.ZEROOPS_DEV_WORKSPACE_RETENTION_DAYS, 14)],
    );
    return {
      scope: projectId ?? 'all',
      policy: this.policy,
      items,
      workspaceCandidates: Number(workspaces.rows[0]?.total ?? 0),
      digest,
    };
  }

  /**
   * Remove a seleção confirmada. Cada entidade numa transação curta que volta a filtrar os ids
   * pelo predicado atual com lock (trabalho reativado ou novas referências ficam protegidos).
   */
  async apply(actor: User, input: { projectId?: string | null; expect: string }) {
    const projectId = input.projectId ?? null;
    await this.authorize(actor, projectId);
    const { selected, digest } = await this.selection(projectId);
    if (digest !== input.expect)
      throw new DomainError(
        'STALE_SELECTION',
        'A seleção mudou desde o dry-run. Repita o dry-run e confirme o novo hash.',
        409,
      );
    const removed: Record<string, number> = {};
    for (const rule of rules) {
      const list = selected.get(rule.entity) ?? [];
      removed[rule.entity] = 0;
      for (let offset = 0; offset < list.length; offset += 500) {
        const chunk = list.slice(offset, offset + 500);
        removed[rule.entity]! += await this.db.transaction(async (client) => {
          await client.query(
            `SELECT id FROM ${rule.table} WHERE id IN (${chunk.map((_, i) => `$${i + 1}`).join(',')}) FOR UPDATE`,
            chunk,
          );
          const placeholders = chunk.map((_, index) => `$${index + 3}`).join(',');
          const still = (
            await client.query<{ id: string | number }>(
              `SELECT id FROM (${rule.select}) eligible WHERE id IN (${placeholders})`,
              [this.policy[rule.policy], projectId, ...chunk],
            )
          ).rows.map((row) => String(row.id));
          if (!still.length) return 0;
          const result = await client.query(
            `DELETE FROM ${rule.table} WHERE id IN (${still.map((_, i) => `$${i + 1}`).join(',')})`,
            still,
          );
          return result.rowCount;
        });
      }
    }
    await this.db.query(
      `INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,$2,NULL,'ops.retention',$3)`,
      [randomUUID(), actor.id, JSON.stringify({ projectId, policy: this.policy, digest, removed })],
    );
    return { scope: projectId ?? 'all', digest, removed };
  }
}
