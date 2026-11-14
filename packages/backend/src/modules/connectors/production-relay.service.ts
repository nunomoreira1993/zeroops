import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  relayPollSchema,
  relayResultSchema,
  type ProductionRelayStatus,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { requireInstanceAdmin, requireMember } from '../identity/membership.js';
import { suspendedEnvironments } from '../incidents/health-suspension.js';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RESULT_BYTES = 1_500_000;
const INTERVENTION_TOOLS = new Set(['restart', 'reboot', 'param']);

function payloadEnvironment(payload: unknown): string {
  const value = typeof payload === 'string' ? safeJson(payload) : payload;
  const environment = (value as { environment?: unknown } | null)?.environment;
  return typeof environment === 'string' ? environment : '';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface RelayServiceOptions {
  /** Duração máxima de um long-poll do relay. */
  pollWaitMs: number;
  pollIntervalMs: number;
  /** Pedidos mais antigos do que isto já não são entregues (o conector desistiu). */
  pendingMaxAgeSeconds: number;
  batchSize: number;
  retentionDays: number;
}

/**
 * Lado ZeroOps do relay de Produção: gestão do token (página Integrações > Agente) e os endpoints
 * chamados pelo relay, autenticados apenas pelo token Bearer `zor_…` (só o hash fica guardado).
 */
export class ProductionRelayService {
  private readonly options: RelayServiceOptions;

  constructor(
    private readonly db: Database,
    options: Partial<RelayServiceOptions> = {},
  ) {
    this.options = {
      pollWaitMs: 20000,
      pollIntervalMs: 500,
      pendingMaxAgeSeconds: 60,
      batchSize: 4,
      retentionDays: 7,
      ...options,
    };
  }

  private async access(actor: User, manage = false) {
    const member = actor.instanceAdmin
      ? await requireInstanceAdmin(this.db, actor)
      : await requireMember(this.db, actor);
    const canManage = Boolean(actor.instanceAdmin) || member.role === 'admin';
    if (!actor.instanceAdmin && member.role === 'client')
      throw new DomainError('FORBIDDEN', 'O relay de Produção é reservado à equipa.', 403);
    if (manage && !canManage)
      throw new DomainError('FORBIDDEN', 'Configuração reservada à administração do projeto.', 403);
    return { projectId: actor.projectId, canManage };
  }

  /** Estado do relay do projeto atual e contagem de pedidos nas últimas 24 h. */
  async status(actor: User): Promise<ProductionRelayStatus> {
    const { projectId, canManage } = await this.access(actor);
    const relay = (
      await this.db.query<{
        hostname: string | null;
        version: string | null;
        last_seen_at: Date | null;
        rotated_at: Date;
        online: number;
      }>(
        `SELECT hostname, version, last_seen_at, rotated_at,
                (last_seen_at > NOW(3) - INTERVAL 120 SECOND) AS online
         FROM connector_relays WHERE project_id=$1`,
        [projectId],
      )
    ).rows[0];
    const counts = await this.db.query<{ status: string; total: number }>(
      `SELECT status, COUNT(*) AS total FROM connector_relay_requests
       WHERE project_id=$1 AND created_at > NOW(3) - INTERVAL 1 DAY GROUP BY status`,
      [projectId],
    );
    const count = (status: string) =>
      Number(counts.rows.find((row) => row.status === status)?.total ?? 0);
    return {
      configured: Boolean(relay),
      online: Boolean(Number(relay?.online ?? 0)),
      hostname: relay?.hostname ?? null,
      version: relay?.version ?? null,
      lastSeenAt: relay?.last_seen_at?.toISOString() ?? null,
      rotatedAt: relay?.rotated_at.toISOString() ?? null,
      canManage,
      pending: count('pending') + count('claimed'),
      lastDay: { done: count('done'), failed: count('failed'), expired: count('expired') },
    };
  }

  /** Gera um novo token (mostrado uma única vez); o relay antigo deixa de ser aceite. */
  async rotateToken(actor: User) {
    const { projectId } = await this.access(actor, true);
    const token = `zor_${randomBytes(32).toString('base64url')}`;
    await this.db.query(
      `INSERT INTO connector_relays(project_id,token_hash,rotated_by,rotated_at) VALUES($1,$2,$3,NOW(3))
       ON DUPLICATE KEY UPDATE token_hash=VALUES(token_hash), rotated_by=VALUES(rotated_by),
         rotated_at=NOW(3), last_seen_at=NULL, hostname=NULL, version=NULL`,
      [projectId, tokenHash(token), actor.id],
    );
    await this.db.query(
      'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,$2,NULL,$3,$4)',
      [randomUUID(), actor.id, 'agent.relay.token_rotated', { projectId }],
    );
    return { token };
  }

  private async authenticate(authorization: string | undefined) {
    const token = /^Bearer\s+(zor_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '')?.[1];
    const row = token
      ? (
          await this.db.query<{ project_id: string }>(
            'SELECT project_id FROM connector_relays WHERE token_hash=$1',
            [tokenHash(token)],
          )
        ).rows[0]
      : undefined;
    if (!row) throw new DomainError('UNAUTHENTICATED', 'Token do relay inválido.', 401);
    return row.project_id;
  }

  /** Long-poll do relay: devolve até `batchSize` pedidos pendentes, já marcados como `claimed`. */
  async poll(authorization: string | undefined, body: unknown) {
    const projectId = await this.authenticate(authorization);
    const info = relayPollSchema.safeParse(body ?? {});
    const meta = info.success ? info.data : {};
    await this.db.query(
      'UPDATE connector_relays SET last_seen_at=NOW(3), hostname=COALESCE($2,hostname), version=COALESCE($3,version), tools=COALESCE($4,tools) WHERE project_id=$1',
      [projectId, meta.hostname ?? null, meta.version ?? null, meta.tools?.join(',') ?? null],
    );
    await this.db.query(
      `DELETE FROM connector_relay_requests
       WHERE project_id=$1 AND created_at < NOW(3) - INTERVAL ${this.options.retentionDays} DAY LIMIT 500`,
      [projectId],
    );
    const deadline = Date.now() + this.options.pollWaitMs;
    for (;;) {
      const suspended = await suspendedEnvironments(this.db, projectId);
      const claimed = await this.claim(projectId, suspended);
      if (claimed.length || Date.now() >= deadline)
        return { requests: claimed, suspendedEnvironments: suspended };
      await sleep(this.options.pollIntervalMs);
    }
  }

  /** Intervenções num ambiente com a Saúde suspensa nunca são entregues: falham no momento. */
  private async claim(projectId: string, suspended: string[]) {
    const pending = await this.db.query<{ id: string; tool: string; payload: unknown }>(
      `SELECT id, tool, payload FROM connector_relay_requests
       WHERE project_id=$1 AND status='pending'
         AND created_at > NOW(3) - INTERVAL ${this.options.pendingMaxAgeSeconds} SECOND
       ORDER BY created_at LIMIT ${this.options.batchSize}`,
      [projectId],
    );
    const claimed: { id: string; tool: string; payload: unknown }[] = [];
    for (const row of pending.rows) {
      if (INTERVENTION_TOOLS.has(row.tool) && suspended.includes(payloadEnvironment(row.payload))) {
        await this.db.query(
          `UPDATE connector_relay_requests SET status='failed', error_code='SUSPENDED',
             error_message='A Saúde está suspensa neste ambiente: intervenção recusada.', finished_at=NOW(3)
           WHERE id=$1 AND status='pending'`,
          [row.id],
        );
        continue;
      }
      const update = await this.db.query(
        "UPDATE connector_relay_requests SET status='claimed', claimed_at=NOW(3) WHERE id=$1 AND status='pending'",
        [row.id],
      );
      if (update.rowCount) claimed.push(row);
    }
    return claimed;
  }

  /** Resultado de um pedido; ignora pedidos que já expiraram do lado do conector. */
  async complete(authorization: string | undefined, requestId: string, body: unknown) {
    const projectId = await this.authenticate(authorization);
    if (!/^[0-9a-f-]{36}$/.test(requestId))
      throw new DomainError('NOT_FOUND', 'Pedido inexistente.', 404);
    const parsed = relayResultSchema.safeParse(body);
    if (!parsed.success) throw new DomainError('VALIDATION', 'Resultado do relay inválido.', 400);
    const data = parsed.data;
    const result = data.ok ? JSON.stringify(data.result ?? null) : null;
    if (result && Buffer.byteLength(result) > MAX_RESULT_BYTES)
      throw new DomainError('TOO_LARGE', 'Resultado do relay demasiado grande.', 413);
    const update = await this.db.query(
      `UPDATE connector_relay_requests
       SET status=$3, result=$4, error_code=$5, error_message=$6, finished_at=NOW(3)
       WHERE id=$1 AND project_id=$2 AND status='claimed'`,
      [
        requestId,
        projectId,
        data.ok ? 'done' : 'failed',
        result,
        data.ok ? null : data.code,
        data.ok ? null : data.message,
      ],
    );
    if (!update.rowCount)
      throw new DomainError('EXPIRED', 'O pedido já não está à espera de resultado.', 409);
    return { status: 'accepted' };
  }
}
