import type { IntegrationSetting, IntegrationValues } from '../../../../contracts/src/index.js';
import type {
  ConnectorIntegrationSource,
  ConnectorKind,
  ConnectorTool,
  ConnectorToolProvider,
} from './connector-gateway.js';
import { lokiTool, promTool, siteDatabaseTool } from './connector-tools.js';
import { LokiConnector } from './loki.connector.js';
import { PrometheusConnector } from './prometheus.connector.js';
import { SiteDatabaseConnector, siteDatabaseUrl } from './site-database.connector.js';

const KINDS: readonly ConnectorKind[] = ['database', 'telemetry', 'metrics'];
interface Entry {
  version: string;
  tool: ConnectorTool<never>;
  close(): Promise<void>;
}

/**
 * Ferramentas de cada projeto a partir das integrações verificadas na página Integrações.
 * Os conectores ficam em cache por `id:versão`: gravar, rodar ou revogar aplica-se no pedido
 * seguinte, sem reiniciar o serviço, e fecha as ligações antigas.
 */
export class IntegrationToolProvider implements ConnectorToolProvider {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly settings: ConnectorIntegrationSource,
    private readonly environment: IntegrationSetting['environment'],
  ) {}

  /** Devolve apenas ferramentas provenientes de integrações verificadas para o projeto. */
  async toolsFor(projectId: string) {
    const tools: ConnectorTool<never>[] = [];
    for (const kind of KINDS) {
      const tool = await this.resolve(projectId, kind);
      if (tool) tools.push(tool);
    }
    return tools;
  }

  private async resolve(projectId: string, kind: ConnectorKind) {
    const key = `${projectId}:${kind}`;
    let found: Awaited<ReturnType<IntegrationToolProvider['load']>>;
    try {
      found = await this.load(projectId, kind);
    } catch {
      found = null;
    }
    const cached = this.cache.get(key);
    if (!found) {
      if (cached) await this.evict(key, cached);
      return null;
    }
    const version = `${found.id}:${found.version}`;
    if (cached?.version === version) return cached.tool;
    if (cached) await this.evict(key, cached);
    const entry = this.build(found.values, version);
    this.cache.set(key, entry);
    return entry.tool;
  }

  private load(projectId: string, kind: ConnectorKind) {
    return this.settings.runtimeValues(projectId, this.environment, kind);
  }

  private build(
    values: Extract<IntegrationValues, { kind: ConnectorKind }>,
    version: string,
  ): Entry {
    if (values.kind === 'database') {
      const site = new SiteDatabaseConnector(siteDatabaseUrl(values));
      return {
        version,
        tool: { ...siteDatabaseTool(site), environment: this.environment } as ConnectorTool<never>,
        close: () => site.close(),
      };
    }
    if (values.kind === 'metrics') {
      const prom = new PrometheusConnector(
        values.url,
        {},
        values.token,
        values.matchers || undefined,
      );
      return {
        version,
        tool: promTool(prom, values.matchers || undefined) as ConnectorTool<never>,
        close: async () => undefined,
      };
    }
    const loki = new LokiConnector(values.url, undefined, values.token);
    return {
      version,
      tool: {
        ...lokiTool(loki, values.selector),
        environment: this.environment,
      } as ConnectorTool<never>,
      close: async () => undefined,
    };
  }

  private async evict(key: string, entry: Entry) {
    this.cache.delete(key);
    await entry.close().catch(() => undefined);
  }

  /** Fecha as ligações em cache quando o serviço de conectores termina. */
  async close() {
    await Promise.all([...this.cache.entries()].map(([key, entry]) => this.evict(key, entry)));
  }
}
