import type { AgentModelOption, AgentRoutingTier } from '../../../packages/contracts/src/index.js';
import { toModelOptions, toRoutingTiers, type AgentClientFactory } from './copilot-sdk.adapter.js';
import { agentEnvironment, type AgentIdentity } from './copilot-process.js';

export interface ModelCatalogStore {
  claimRefresh(): Promise<string | null>;
  save(
    projectId: string,
    models: AgentModelOption[],
    defaultModel: string | null,
    routingTiers?: AgentRoutingTier[],
  ): Promise<void>;
  fail(projectId: string, errorCode: string): Promise<void>;
}

export interface ModelCatalogOptions {
  factory: AgentClientFactory;
  credentials: (projectId: string) => Promise<{ token: string; model?: string } | null>;
  workingDirectory: string;
  baseEnv?: NodeJS.ProcessEnv;
  identity?: AgentIdentity;
}

/**
 * Atualiza o catálogo de modelos pedido pela API: lê `listModels()` do SDK com o token da
 * integração Copilot do projeto e grava a lista. Uma falha fica registada sem apagar a anterior.
 */
export class ModelCatalogRefresher {
  constructor(
    private readonly store: ModelCatalogStore,
    private readonly options: ModelCatalogOptions,
  ) {}

  /** Trata no máximo um pedido; devolve `true` se havia trabalho. */
  async refreshOnce(): Promise<boolean> {
    const projectId = await this.store.claimRefresh();
    if (!projectId) return false;
    try {
      const credentials = await this.options.credentials(projectId);
      if (!credentials?.token) {
        await this.store.fail(projectId, 'copilot_not_configured');
        return true;
      }
      const catalog = await this.list(credentials.token);
      await this.store.save(
        projectId,
        catalog.models,
        credentials.model ?? null,
        catalog.routingTiers,
      );
    } catch {
      await this.store.fail(projectId, 'models_unavailable');
    }
    return true;
  }

  private async list(token: string) {
    const identity = this.options.identity;
    const client = this.options.factory({
      env: agentEnvironment(this.options.baseEnv ?? process.env, identity, {
        COPILOT_GITHUB_TOKEN: token,
        ...(identity
          ? { ZEROOPS_AGENT_UID: String(identity.uid), ZEROOPS_AGENT_GID: String(identity.gid) }
          : {}),
      }),
      gitHubToken: token,
      workingDirectory: this.options.workingDirectory,
    });
    try {
      await client.start();
      if (client.rpc?.models) {
        const catalog = await client.rpc.models.list({});
        return { models: toModelOptions(catalog.models), routingTiers: toRoutingTiers(catalog) };
      }
      if (!client.listModels) throw new Error('listModels indisponível.');
      return { models: toModelOptions(await client.listModels()), routingTiers: [] };
    } finally {
      await client.stop().catch(() => undefined);
    }
  }
}
