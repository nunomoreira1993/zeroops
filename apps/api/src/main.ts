import { resolve } from 'node:path';
import { Database } from '../../../packages/backend/src/database/database.js';
import { createApplication } from './application.js';
import { identityMailConfigFromEnv } from '../../../packages/backend/src/modules/notifications/identity-mail.js';
import { integrationRuntimeConfigFromEnv } from '../../../packages/backend/src/modules/integrations/integration-probe.js';

if (!process.env.ZEROOPS_DATABASE_URL)
  throw new Error('Configure ZEROOPS_DATABASE_URL num canal privado.');
const publicUrl = process.env.ZEROOPS_PUBLIC_URL ?? 'http://127.0.0.1:4311';
const port = Number(process.env.ZEROOPS_PORT ?? '4311');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ZEROOPS_PORT invalida.');
const db = new Database(process.env.ZEROOPS_DATABASE_URL);
const mailConfig = { ...identityMailConfigFromEnv(), publicUrl };
const integrationConfig = integrationRuntimeConfigFromEnv(process.env, publicUrl);
const app = await createApplication(
  db,
  {
    publicUrl,
    staticDirectory: resolve('apps/web/dist'),
    trustLoopbackProxy: process.env.ZEROOPS_TRUST_LOOPBACK_PROXY === 'true',
  },
  {
    encryptionKey: mailConfig.encryptionKey,
    mailConfig,
    ...integrationConfig,
    // Prometheus local (QA) que recebe o remote write de Produção; vazio desliga a receção.
    prometheusWriteUrl:
      process.env.ZEROOPS_PROMETHEUS_WRITE_URL ?? 'http://127.0.0.1:9090/api/v1/write',
    // Fila em disco dos webhooks do Alertmanager recebidos com a BD indisponível; vazio desliga.
    alertSpoolDir: process.env.ZEROOPS_ALERT_SPOOL_DIR || undefined,
    // Alertmanager local, para fechar alertas cuja resolução não chegou; vazio desliga.
    alertmanagerUrl: process.env.ZEROOPS_ALERTMANAGER_URL ?? 'http://127.0.0.1:9093',
    // Regras de alerta geradas a partir da Saúde (lidas pelo Prometheus); vazio desliga.
    prometheusRulesDir: process.env.ZEROOPS_PROMETHEUS_RULES_DIR || undefined,
    // Prometheus local, para recarregar as regras geradas; vazio só escreve os ficheiros.
    prometheusUrl: process.env.ZEROOPS_PROMETHEUS_URL ?? 'http://127.0.0.1:9090',
    agentSitesRoot: process.env.ZEROOPS_AGENT_SITES_ROOT,
  },
);
await app.listen(port, '127.0.0.1');
console.info(JSON.stringify({ event: 'zeroops.ready', url: publicUrl, automation: 'blocked' }));
const shutdown = async () => {
  await app.close();
  await db.close();
};
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
