import { Database } from '../../../packages/backend/src/database/database.js';
import {
  CompositeToolProvider,
  ConnectorGateway,
} from '../../../packages/backend/src/modules/connectors/connector-gateway.js';
import { IntegrationToolProvider } from '../../../packages/backend/src/modules/connectors/integration-tool-provider.js';
import { ProductionRelayQueue } from '../../../packages/backend/src/modules/connectors/production-relay.queue.js';
import { ProductionRelayToolProvider } from '../../../packages/backend/src/modules/connectors/production-relay.tools.js';
import { IdentityCipher } from '../../../packages/backend/src/modules/identity/identity-security.js';
import {
  AuthorizedIntegrationProbe,
  integrationRuntimeConfigFromEnv,
} from '../../../packages/backend/src/modules/integrations/integration-probe.js';
import { IntegrationSettingsService } from '../../../packages/backend/src/modules/integrations/integration-settings.service.js';
import { createConnectorServer } from './connector-server.js';

/**
 * Serviço dos conectores de leitura. As credenciais (BD do site, Loki) vêm da página Integrações,
 * cifradas na BD ZeroOps; o agente só recebe o URL deste serviço e o token do run.
 */
const env = process.env;
if (!env.ZEROOPS_DATABASE_URL) throw new Error('ZEROOPS_DATABASE_URL obrigatorio.');
const port = Number(env.ZEROOPS_CONNECTORS_PORT ?? '4312');
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('ZEROOPS_CONNECTORS_PORT invalida.');

const db = new Database(env.ZEROOPS_DATABASE_URL);
const config = integrationRuntimeConfigFromEnv(env, env.ZEROOPS_PUBLIC_URL ?? '');
const settings = new IntegrationSettingsService(
  db,
  new IdentityCipher(env.ZEROOPS_IDENTITY_KEY),
  new AuthorizedIntegrationProbe(config.smtpEndpoints, {
    connectorEndpoints: config.connectorEndpoints,
  }),
);
const provider = new IntegrationToolProvider(settings, config.environment);
// Produção não é acessível a partir do QA: as consultas seguem pela fila do relay de Produção.
const tools =
  config.environment === 'production'
    ? provider
    : new CompositeToolProvider([
        provider,
        new ProductionRelayToolProvider(new ProductionRelayQueue(db)),
      ]);
const server = createConnectorServer(new ConnectorGateway(db, tools));
server.listen(port, '127.0.0.1', () =>
  console.info(
    JSON.stringify({ event: 'connectors.ready', port, environment: config.environment }),
  ),
);

const stop = () => {
  server.close();
  void Promise.all([db.close(), provider.close()]).finally(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
