import type { Database } from '../../database/database.js';
import { PrometheusConnector } from '../connectors/prometheus.connector.js';
import { SiteDatabaseConnector, siteDatabaseUrl } from '../connectors/site-database.connector.js';
import { defaultFlowActions, type FlowActionRegistry } from '../flows/flow-actions.js';
import type { IntegrationSettingsService } from '../integrations/integration-settings.service.js';
import { createIncidentActions } from './incident-actions.js';
import { IncidentPolicyRepository } from './incident-policy.repository.js';
import { IntegrationRecoveryProbe } from './recovery-probe.js';

type Environment = 'quality' | 'production';

const environmentOf = (value: string): Environment =>
  value === 'quality' ? 'quality' : 'production';

/**
 * Ações do motor de fluxos com as do fluxo «Incidente (Health)». Sem `settings` (testes e
 * processos sem integrações) a validação usa só o estado dos alertas do incidente.
 */
export function createFlowActionRegistry(
  db: Database,
  options: { settings?: IntegrationSettingsService; publicUrl?: string } = {},
): FlowActionRegistry {
  const { settings } = options;
  const probe = settings
    ? new IntegrationRecoveryProbe({
        prometheus: async (projectId, environment) => {
          const found = await settings.runtimeValues(
            projectId,
            environmentOf(environment),
            'metrics',
          );
          if (!found) return null;
          const connector = new PrometheusConnector(
            found.values.url,
            { timeoutMs: 8000 },
            found.values.token,
            found.values.matchers,
          );
          return { query: (promql) => connector.query(promql) };
        },
        database: async (projectId, environment) => {
          const found = await settings.runtimeValues(
            projectId,
            environmentOf(environment),
            'database',
          );
          if (!found) return null;
          const connector = new SiteDatabaseConnector(siteDatabaseUrl(found.values), {
            maxRows: 1,
            timeoutSeconds: 8,
          });
          return { query: (sql) => connector.query(sql), close: () => connector.close() };
        },
        httpTimeoutMs: 8000,
      })
    : undefined;
  return {
    ...defaultFlowActions,
    ...createIncidentActions({
      policies: new IncidentPolicyRepository(db),
      probe,
      publicUrl: options.publicUrl,
    }),
  };
}
