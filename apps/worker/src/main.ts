import { Database } from '../../../packages/backend/src/database/database.js';
import { dispatchOutbox } from '../../../packages/backend/src/modules/notifications/outbox.js';
import { ConfiguredOutboxHandler } from '../../../packages/backend/src/modules/notifications/configured-outbox-handler.js';
import { identityMailConfigFromEnv } from '../../../packages/backend/src/modules/notifications/identity-mail.js';
import { ConfiguredIdentityMail } from '../../../packages/backend/src/modules/notifications/configured-identity-mail.js';
import { MailBranding } from '../../../packages/backend/src/modules/smtp/mail-branding.js';
import { IntegrationSettingsService } from '../../../packages/backend/src/modules/integrations/integration-settings.service.js';
import {
  AuthorizedIntegrationProbe,
  integrationRuntimeConfigFromEnv,
} from '../../../packages/backend/src/modules/integrations/integration-probe.js';
import { IdentityCipher } from '../../../packages/backend/src/modules/identity/identity-security.js';
import { createHealthMonitoring } from '../../../packages/backend/src/modules/health/health.module.js';
import { FlowEngine } from '../../../packages/backend/src/modules/flows/flow-engine.js';
import { TicketRouter } from '../../../packages/backend/src/modules/flows/ticket-routing.js';
import { createFlowActionRegistry } from '../../../packages/backend/src/modules/incidents/incident.module.js';

if (!process.env.ZEROOPS_DATABASE_URL) throw new Error('ZEROOPS_DATABASE_URL obrigatorio.');
const db = new Database(process.env.ZEROOPS_DATABASE_URL);
const mailConfig = identityMailConfigFromEnv();
const integrationConfig = integrationRuntimeConfigFromEnv(process.env, mailConfig.publicUrl);
const settings = new IntegrationSettingsService(
  db,
  new IdentityCipher(mailConfig.encryptionKey),
  new AuthorizedIntegrationProbe(integrationConfig.smtpEndpoints, {
    connectorEndpoints: integrationConfig.connectorEndpoints,
  }),
);
const identityMail = new ConfiguredIdentityMail(
  db,
  settings,
  integrationConfig.environment,
  mailConfig,
);
const branding = new MailBranding(db);
const outboxHandler = new ConfiguredOutboxHandler(
  db,
  settings,
  integrationConfig.environment,
  mailConfig.smtp,
  mailConfig.publicUrl,
  undefined,
  (projectId) => branding.forProject(projectId),
);
let stopping = false;
let active = false;
const pump = async () => {
  if (stopping || active) return;
  active = true;
  try {
    await identityMail.deliverPending();
    await dispatchOutbox(db, outboxHandler);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'outbox.failed',
        type: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  } finally {
    active = false;
  }
};
const timer = setInterval(() => {
  void pump();
}, 3000);
await pump();

const flowEngine = new FlowEngine(
  db,
  createFlowActionRegistry(db, { settings, publicUrl: mailConfig.publicUrl }),
);
const ticketRouter = new TicketRouter(db, flowEngine);
const health = createHealthMonitoring(
  db,
  settings,
  mailConfig.publicUrl,
  undefined,
  undefined,
  undefined,
  undefined,
  {
    ticketCreated: [flowEngine.onTicketCreated],
    incidentDelegate: flowEngine.incidentDelegate,
  },
);
let healthActive = false;
let lastPrune = 0;
/** Ciclo da pagina Saude: verificacoes, alertas, relatorio diario e envio de e-mails. */
const healthCycle = async () => {
  if (stopping || healthActive) return;
  healthActive = true;
  try {
    const now = new Date();
    for (const projectId of await health.repository.enabledProjects()) {
      if (stopping) break;
      try {
        const outcome = await health.monitor.runCycle(projectId, now);
        await health.reporter.sendIfDue(projectId, now);
        for (const done of await health.charts.rollup.runDue(projectId, now))
          console.warn(JSON.stringify({ event: 'health.charts_rollup', projectId, ...done }));
        const healthSettings = (await health.repository.settings(projectId))?.settings;
        if (healthSettings) await health.charts.events.run(projectId, healthSettings, now);
        if (outcome.opened || outcome.resolved)
          console.warn(
            JSON.stringify({
              event: 'health.cycle',
              projectId,
              opened: outcome.opened,
              resolved: outcome.resolved,
            }),
          );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'health.cycle_failed',
            projectId,
            type: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
      }
    }
    await health.notifier.deliverPending();
    if (now.getTime() - lastPrune > 3600000) {
      await health.repository.prune(now);
      await health.charts.repository.prune(now);
      lastPrune = now.getTime();
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'health.failed',
        type: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  } finally {
    healthActive = false;
  }
};
const healthTimer = setInterval(() => {
  void healthCycle();
}, 60000);
void healthCycle();

let flowActive = false;
/** Etapas dos fluxos com prazo (verificações, novo pedido ao Copilot) e runs terminados sem hook. */
const flowCycle = async () => {
  if (stopping || flowActive) return;
  flowActive = true;
  try {
    for (let round = 0; round < 10 && !stopping; round += 1) if (!(await flowEngine.tick())) break;
    // Perguntas de encaminhamento sem resposta no prazo seguem o fallback configurado.
    if (!stopping) await ticketRouter.expireOverdue();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'flows.tick_failed',
        type: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  } finally {
    flowActive = false;
  }
};
// Fluxos de modelo não personalizados passam para o modelo atual (tickets em curso mantêm a versão).
try {
  const upgraded = await flowEngine.upgradeTemplates();
  if (upgraded) console.warn(JSON.stringify({ event: 'flows.templates_upgraded', upgraded }));
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'flows.template_upgrade_failed',
      type: error instanceof Error ? error.name : 'UnknownError',
    }),
  );
}
// P11: tickets antigos sem execução já não entram automaticamente no fluxo (sem backfill no
// arranque); a adoção é explícita e auditada (`zeroops-ops flow-adoption`).
const flowTimer = setInterval(() => {
  void flowCycle();
}, 15000);
void flowCycle();
const stop = async () => {
  stopping = true;
  clearInterval(timer);
  clearInterval(healthTimer);
  clearInterval(flowTimer);
  while (active || healthActive || flowActive)
    await new Promise((resolve) => setTimeout(resolve, 50));
  await db.close();
};
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
