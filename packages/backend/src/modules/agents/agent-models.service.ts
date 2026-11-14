import type {
  AgentModelCatalog,
  AgentModelOption,
  AgentRoutingTier,
  AgentExecutionMode,
  AgentFusionTier,
  User,
} from '../../../../contracts/src/index.js';
import {
  AGENT_EFFORT_HIGH,
  AGENT_MODEL_AUTO,
  isFusionModel,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { requireMember, type Queryable } from '../identity/membership.js';
import { findTicket } from '../tickets/tickets.queries.js';

/** A lista de modelos muda raramente: volta a pedi-la ao executor ao fim de 6 h (10 min se falhou). */
const FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const MAX_MODELS = 80;

interface CatalogRow {
  models: unknown;
  default_model: string | null;
  refreshed_at: Date | null;
  refresh_requested_at: Date | null;
  error_code: string | null;
  routing_tiers?: unknown;
}

const autoOption = (): AgentModelOption => ({
  id: AGENT_MODEL_AUTO,
  name: 'Auto',
  multiplier: null,
  efforts: [AGENT_EFFORT_HIGH],
  defaultEffort: null,
  fusion: false,
});

function parseModels(value: unknown): AgentModelOption[] {
  const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is AgentModelOption =>
        typeof item === 'object' && item !== null && typeof item.id === 'string',
    )
    .slice(0, MAX_MODELS);
}

function parseRoutingTiers(value: unknown): AgentRoutingTier[] {
  const raw: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is AgentRoutingTier =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        typeof item.enabled === 'boolean',
    )
    .slice(0, MAX_MODELS);
}

function isRefreshPending(row: CatalogRow | undefined) {
  if (!row?.refresh_requested_at) return false;
  return !row.refreshed_at || row.refresh_requested_at > row.refreshed_at;
}

function isStale(row: CatalogRow | undefined, now: number) {
  if (!row?.refreshed_at) return true;
  const age = now - row.refreshed_at.getTime();
  return age > (row.error_code ? RETRY_AFTER_FAILURE_MS : FRESH_MS);
}

/**
 * Catálogo de modelos Copilot de cada projeto. Só o executor tem o runtime do SDK e o token,
 * por isso a API marca um pedido de atualização e o executor grava a lista lida via SDK.
 */
export class AgentModelsService {
  constructor(private readonly db: Database) {}

  /** Lista os modelos para a equipa; pede ao executor uma atualização quando a cache envelhece. */
  async catalog(actor: User, ticketId: string, now = Date.now()): Promise<AgentModelCatalog> {
    const member = await requireMember(this.db, actor, true);
    if (member.role === 'client')
      throw new DomainError('FORBIDDEN', 'Os modelos do Copilot são reservados à equipa.', 403);
    const ticket = await findTicket(this.db, actor, ticketId);
    let row = await this.read(this.db, ticket.project_id);
    if (isStale(row, now) && !isRefreshPending(row)) {
      await this.db.query(
        `INSERT INTO agent_model_catalogs(project_id, refresh_requested_at) VALUES($1, NOW(3))
         ON DUPLICATE KEY UPDATE refresh_requested_at=NOW(3)`,
        [ticket.project_id],
      );
      row = await this.read(this.db, ticket.project_id);
    }
    return {
      models: [autoOption(), ...parseModels(row?.models)],
      routingTiers: parseRoutingTiers(row?.routing_tiers),
      defaultModel: row?.default_model ?? null,
      refreshedAt: row?.refreshed_at?.toISOString() ?? null,
      refreshing: isRefreshPending(row),
      errorCode: row?.error_code ?? null,
    };
  }

  /**
   * Valida o modelo e o esforço pedidos contra o catálogo do projeto. `auto` é sempre aceite;
   * um modelo concreto tem de constar da última lista lida e suportar o esforço indicado.
   */
  async validate(
    client: Queryable,
    projectId: string,
    model: string | null,
    effort: string | null,
    mode: AgentExecutionMode = 'copilot',
    fusionTier: AgentFusionTier | null = null,
  ) {
    if (mode === 'local' && model && isFusionModel(model))
      throw new DomainError('AGENT_MODEL_INVALID', 'Fusion exige o perfil Copilot.', 422);
    if (model === 'fusion') {
      if (mode !== 'copilot' || effort || !fusionTier)
        throw new DomainError('AGENT_MODEL_INVALID', 'Seleção Fusion inválida.', 422);
      const tiers = parseRoutingTiers((await this.read(client, projectId))?.routing_tiers);
      if (!tiers.some((tier) => tier.enabled && tier.visible && tier.fusionTier === fusionTier))
        throw new DomainError(
          'AGENT_MODEL_INVALID',
          'Fusion indisponível: escolha outro modelo.',
          422,
        );
      return;
    }
    if (fusionTier)
      throw new DomainError('AGENT_MODEL_INVALID', 'O nível Fusion exige Copilot Fusion.', 422);
    if (!model) {
      if (effort)
        throw new DomainError('AGENT_MODEL_INVALID', 'Escolha um modelo para o esforço.', 422);
      return;
    }
    if (model === AGENT_MODEL_AUTO) {
      if (effort && effort !== AGENT_EFFORT_HIGH)
        throw new DomainError('AGENT_MODEL_INVALID', 'Esforço não suportado.', 422);
      return;
    }
    const option = parseModels((await this.read(client, projectId))?.models).find(
      (item) => item.id === model,
    );
    if (!option)
      throw new DomainError('AGENT_MODEL_INVALID', 'Modelo indisponível neste projeto.', 422);
    if (effort && !option.efforts.includes(effort))
      throw new DomainError('AGENT_MODEL_INVALID', 'O modelo não suporta este esforço.', 422);
  }

  /** Executor: renova também caches sem tiers concluídas pelo runtime antigo durante o deploy. */
  async claimRefresh(): Promise<string | null> {
    const result = await this.db.query<{ project_id: string }>(
      `SELECT project_id FROM agent_model_catalogs
       WHERE refresh_requested_at IS NOT NULL
         AND (refreshed_at IS NULL OR refresh_requested_at > refreshed_at OR routing_tiers IS NULL)
       ORDER BY refresh_requested_at LIMIT 1`,
    );
    return result.rows[0]?.project_id ?? null;
  }

  /** Executor: grava a lista lida do SDK. */
  async save(
    projectId: string,
    models: AgentModelOption[],
    defaultModel: string | null,
    routingTiers: AgentRoutingTier[] = [],
  ) {
    await this.db.query(
      `UPDATE agent_model_catalogs SET models=$2, default_model=$3, routing_tiers=$4, refreshed_at=NOW(3),
         error_code=NULL WHERE project_id=$1`,
      [
        projectId,
        JSON.stringify(models.slice(0, MAX_MODELS)),
        defaultModel,
        JSON.stringify(routingTiers),
      ],
    );
  }

  /** Executor: regista a falha, mantendo a última lista boa. */
  async fail(projectId: string, errorCode: string) {
    await this.db.query(
      'UPDATE agent_model_catalogs SET refreshed_at=NOW(3), error_code=$2 WHERE project_id=$1',
      [projectId, errorCode.slice(0, 60)],
    );
  }

  private async read(client: Queryable, projectId: string) {
    return (
      await client.query<CatalogRow>(
        `SELECT models, default_model, refreshed_at, refresh_requested_at, error_code, routing_tiers
         FROM agent_model_catalogs WHERE project_id=$1`,
        [projectId],
      )
    ).rows[0];
  }
}
