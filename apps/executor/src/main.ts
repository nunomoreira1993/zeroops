import { tmpdir } from 'node:os';
import { Database } from '../../../packages/backend/src/database/database.js';
import { AgentRunsService } from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import { AgentModelsService } from '../../../packages/backend/src/modules/agents/agent-models.service.js';
import { AgentRunEventsService } from '../../../packages/backend/src/modules/agents/agent-run-events.service.js';
import { HealthIncidentLifecycle } from '../../../packages/backend/src/modules/health/health-incident-lifecycle.js';
import { FlowEngine } from '../../../packages/backend/src/modules/flows/flow-engine.js';
import { FlowAssistantQueue } from '../../../packages/backend/src/modules/flows/flow-assistant.js';
import { FlowSimulationQueue } from '../../../packages/backend/src/modules/flows/flow-simulation-queue.js';
import { TicketRouter } from '../../../packages/backend/src/modules/flows/ticket-routing.js';
import { TicketRoutingQueue } from '../../../packages/backend/src/modules/flows/ticket-routing-queue.js';
import { createFlowActionRegistry } from '../../../packages/backend/src/modules/incidents/incident.module.js';
import { reconcileUncertainInterventions } from '../../../packages/backend/src/modules/incidents/incident-reconcile.js';
import { IdentityCipher } from '../../../packages/backend/src/modules/identity/identity-security.js';
import {
  AuthorizedIntegrationProbe,
  integrationRuntimeConfigFromEnv,
} from '../../../packages/backend/src/modules/integrations/integration-probe.js';
import { IntegrationSettingsService } from '../../../packages/backend/src/modules/integrations/integration-settings.service.js';
import { discoverAgentCommands } from './agent-commands.js';
import { CopilotCliAdapter } from './copilot.adapter.js';
import { CopilotSdkAdapter, sdkClientFactory } from './copilot-sdk.adapter.js';
import { CopilotProcess, type AgentIdentity } from './copilot-process.js';
import { InvestigationRunner } from './investigation-runner.js';
import { FlowAssistantRunner } from './flow-assistant-runner.js';
import { ModelCatalogRefresher } from './model-catalog.js';
import { AgentRunConversation } from './run-conversation.js';
import { executorJobConfig, JobPool } from './job-pools.js';
import { DevelopmentStore } from '../../../packages/backend/src/modules/development/development.store.js';
import { DevelopmentRunner } from './development-runner.js';
import { DeliveryStore } from '../../../packages/backend/src/modules/delivery/delivery.store.js';
import { allowedPipelineOrigins } from '../../../packages/backend/src/modules/delivery/pipelines.service.js';
import { DeliveryRunner } from './delivery-runner.js';
import { RuntimeDrainWatcher } from './runtime-drain.js';
import { CapabilityDevelopmentService } from '../../../packages/backend/src/modules/capabilities/capability-development.service.js';
import { GithubPullRequestProvider } from './pr-providers.js';
import { WorkspaceManager } from './workspace-manager.js';

const env = process.env;
if (!env.ZEROOPS_DATABASE_URL) throw new Error('ZEROOPS_DATABASE_URL obrigatorio.');
const list = (value?: string) =>
  (value ?? '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);

/** Em contentor, o executor corre como root apenas para lançar o Copilot com outro uid. */
const identity: AgentIdentity | undefined = env.ZEROOPS_AGENT_UID
  ? {
      uid: Number(env.ZEROOPS_AGENT_UID),
      gid: Number(env.ZEROOPS_AGENT_GID ?? env.ZEROOPS_AGENT_UID),
      home: env.ZEROOPS_AGENT_HOME ?? '/home/node',
    }
  : undefined;
if (identity && (!Number.isInteger(identity.uid) || identity.uid < 1))
  throw new Error('ZEROOPS_AGENT_UID invalido.');
const connectorUrl = env.ZEROOPS_CONNECTOR_URL;

const jobs = executorJobConfig(env);
const worker = { workerId: jobs.workerId, leaseSeconds: jobs.leaseSeconds };
const db = new Database(env.ZEROOPS_DATABASE_URL);
const assistantQueue = new FlowAssistantQueue(db);
const events = new AgentRunEventsService(db);
const cipher = new IdentityCipher(env.ZEROOPS_IDENTITY_KEY);
/** P08: workspaces Git persistentes (sem raiz configurada, os runs de desenvolvimento falham). */
const developmentStore = new DevelopmentStore(db, cipher);
const development = env.ZEROOPS_DEV_WORKSPACES
  ? new DevelopmentRunner(
      developmentStore,
      new WorkspaceManager(
        env.ZEROOPS_DEV_WORKSPACES,
        identity ? { uid: identity.uid, gid: identity.gid } : undefined,
      ),
      {
        pullRequests: { github: new GithubPullRequestProvider() },
        log: (event) => console.info(JSON.stringify(event)),
      },
    )
  : null;
/** P09: entregas (integração coordenada + pipeline do projeto) sobre os mesmos workspaces. */
const deliveryStore = new DeliveryStore(db, cipher);
const delivery =
  env.ZEROOPS_DEV_WORKSPACES && env.ZEROOPS_PUBLIC_URL
    ? new DeliveryRunner(
        deliveryStore,
        new WorkspaceManager(
          env.ZEROOPS_DEV_WORKSPACES,
          identity ? { uid: identity.uid, gid: identity.gid } : undefined,
        ),
        {
          workerId: worker.workerId,
          allowedOrigins: allowedPipelineOrigins(env),
          publicUrl: env.ZEROOPS_PUBLIC_URL,
          log: (event) => console.info(JSON.stringify(event)),
        },
      )
    : null;
const workspaceRetentionDays = Number(env.ZEROOPS_DEV_WORKSPACE_RETENTION_DAYS ?? 14);
/** O token Copilot vem da integração `copilot` do projeto (página Integrações), cifrado na BD. */
const integrationConfig = integrationRuntimeConfigFromEnv(env, env.ZEROOPS_PUBLIC_URL ?? '');
const settings = new IntegrationSettingsService(
  db,
  cipher,
  new AuthorizedIntegrationProbe(integrationConfig.smtpEndpoints, {
    connectorEndpoints: integrationConfig.connectorEndpoints,
  }),
);
const flowEngine = new FlowEngine(
  db,
  createFlowActionRegistry(db, { settings, publicUrl: env.ZEROOPS_PUBLIC_URL || undefined }),
);
const routingQueue = new TicketRoutingQueue(db, new TicketRouter(db, flowEngine));
const simulationQueue = new FlowSimulationQueue(db);
/** No fim de cada run, a Saúde e o fluxo do ticket avançam na mesma transação. */
const runs = new AgentRunsService(db, [
  new HealthIncidentLifecycle(db, flowEngine.incidentDelegate).onRunFinished,
  flowEngine.onRunFinished,
]);
const copilotCredentials = async (projectId: string) => {
  const found = await settings.runtimeValues(projectId, integrationConfig.environment, 'copilot');
  if (!found?.values.token) return null;
  return {
    token: found.values.token,
    ...(found.values.model ? { model: found.values.model } : {}),
  };
};
const adapter =
  env.ZEROOPS_COPILOT_TRANSPORT === 'cli'
    ? new CopilotCliAdapter(
        new CopilotProcess(env.ZEROOPS_COPILOT_COMMAND ?? 'copilot', process.env, identity),
      )
    : new CopilotSdkAdapter(sdkClientFactory(env.ZEROOPS_COPILOT_CLI_PATH || undefined), {
        baseEnv: process.env,
        ...(identity ? { identity } : {}),
        followUpWindowMs: Number(env.ZEROOPS_AGENT_FOLLOWUP_MS ?? 120000),
      });
/** Cada executor reclama com o seu worker e respeita o limite de runs simultâneos por projeto. */
const runQueue = {
  claimNext: () => runs.claimNext(worker, { perProject: jobs.projectRunLimit }),
  heartbeat: runs.heartbeat.bind(runs),
  reportProgress: runs.reportProgress.bind(runs),
  recordEffectiveTools: runs.recordEffectiveTools.bind(runs),
  isCancelRequested: runs.isCancelRequested.bind(runs),
  complete: runs.complete.bind(runs),
  fail: runs.fail.bind(runs),
  release: runs.release.bind(runs),
};
const runner = new InvestigationRunner(runQueue, adapter, {
  workspaceRoot: env.ZEROOPS_AGENT_WORKSPACE ?? tmpdir(),
  readOnlyDirectories: list(env.ZEROOPS_AGENT_SOURCE_DIRS),
  sources: list(env.ZEROOPS_AGENT_SOURCES),
  ...(env.ZEROOPS_AGENT_SITES_ROOT ? { siteSourcesRoot: env.ZEROOPS_AGENT_SITES_ROOT } : {}),
  timeoutMs: Number(env.ZEROOPS_AGENT_TIMEOUT_MS ?? 900000),
  outputLimitBytes: Number(env.ZEROOPS_AGENT_OUTPUT_LIMIT ?? 5242880),
  cancelPollMs: 5000,
  ...(connectorUrl
    ? {
        connectors: {
          url: connectorUrl,
          shellTool: env.ZEROOPS_COPILOT_SHELL_TOOL ?? 'bash',
          discover: (runToken: string) => discoverAgentCommands(connectorUrl, runToken),
        },
      }
    : {}),
  ...(identity ? { workspaceOwner: { uid: identity.uid, gid: identity.gid } } : {}),
  copilotCredentials,
  ...(development ? { development } : {}),
  conversation: (runId, lease) =>
    new AgentRunConversation(
      runId,
      {
        // Só a tentativa com o lease atual escreve na conversa ou consome respostas da equipa.
        append: async (id, payload) => {
          await events.append(id, payload, lease);
        },
        claimInputs: (id) => events.claimInputs(id, lease),
      },
      {
        questionTimeoutMs: Number(env.ZEROOPS_AGENT_QUESTION_TIMEOUT_MS ?? 600000),
        onError: (error) =>
          console.warn(
            JSON.stringify({
              event: 'agent.conversation_failed',
              runId,
              type: error instanceof Error ? error.name : 'UnknownError',
            }),
          ),
      },
    ),
});

/** Assistente dos fluxos: respostas curtas, sem pastas nem conectores (contexto no prompt). */
const assistant = new FlowAssistantRunner(
  {
    claimNext: () => assistantQueue.claimNext(worker),
    heartbeat: assistantQueue.heartbeat.bind(assistantQueue),
    complete: assistantQueue.complete.bind(assistantQueue),
    fail: assistantQueue.fail.bind(assistantQueue),
    release: assistantQueue.release.bind(assistantQueue),
    authoringTool: assistantQueue.authoringTool.bind(assistantQueue),
  },
  adapter,
  {
    workspaceRoot: env.ZEROOPS_AGENT_WORKSPACE ?? tmpdir(),
    timeoutMs: Math.min(Number(env.ZEROOPS_AGENT_TIMEOUT_MS ?? 900000), 300000),
    outputLimitBytes: Number(env.ZEROOPS_AGENT_OUTPUT_LIMIT ?? 5242880),
    copilotCredentials,
    ...(identity ? { workspaceOwner: { uid: identity.uid, gid: identity.gid } } : {}),
  },
);

/** Classificador do encaminhamento: mesmo runner do assistente (sem conectores), com pool próprio. */
const routing = new FlowAssistantRunner(
  {
    claimNext: () => routingQueue.claimNext(worker),
    heartbeat: routingQueue.heartbeat.bind(routingQueue),
    complete: routingQueue.complete.bind(routingQueue),
    fail: routingQueue.fail.bind(routingQueue),
    release: routingQueue.release.bind(routingQueue),
  },
  adapter,
  {
    workspaceRoot: env.ZEROOPS_AGENT_WORKSPACE ?? tmpdir(),
    timeoutMs: Math.min(Number(env.ZEROOPS_AGENT_TIMEOUT_MS ?? 900000), 180000),
    outputLimitBytes: Number(env.ZEROOPS_AGENT_OUTPUT_LIMIT ?? 5242880),
    copilotCredentials,
    ...(identity ? { workspaceOwner: { uid: identity.uid, gid: identity.gid } } : {}),
  },
);

/** Avaliações do simulador com o Copilot real (P07): mesmo runner, pool e fila próprios. */
const simulation = new FlowAssistantRunner(
  {
    claimNext: () => simulationQueue.claimNext(worker),
    heartbeat: simulationQueue.heartbeat.bind(simulationQueue),
    complete: simulationQueue.complete.bind(simulationQueue),
    fail: simulationQueue.fail.bind(simulationQueue),
    release: simulationQueue.release.bind(simulationQueue),
  },
  adapter,
  {
    workspaceRoot: env.ZEROOPS_AGENT_WORKSPACE ?? tmpdir(),
    timeoutMs: Math.min(Number(env.ZEROOPS_AGENT_TIMEOUT_MS ?? 900000), 180000),
    outputLimitBytes: Number(env.ZEROOPS_AGENT_OUTPUT_LIMIT ?? 5242880),
    copilotCredentials,
    ...(identity ? { workspaceOwner: { uid: identity.uid, gid: identity.gid } } : {}),
  },
);

/** O catálogo de modelos só existe com o SDK (o CLI não expõe a lista). */
const modelCatalog =
  env.ZEROOPS_COPILOT_TRANSPORT === 'cli'
    ? null
    : new ModelCatalogRefresher(new AgentModelsService(db), {
        factory: sdkClientFactory(env.ZEROOPS_COPILOT_CLI_PATH || undefined),
        credentials: copilotCredentials,
        workingDirectory: env.ZEROOPS_AGENT_WORKSPACE ?? tmpdir(),
        baseEnv: process.env,
        ...(identity ? { identity } : {}),
      });

const logError = (event: string) => (error: unknown) =>
  console.error(
    JSON.stringify({ event, type: error instanceof Error ? error.name : 'UnknownError' }),
  );

/**
 * Reconciliação por lease (substitui a falha global de runs no arranque): só recupera tentativas
 * com lease expirado; jobs vivos de outros executores não são tocados.
 */
async function recover() {
  const recovered = await runs.recoverExpired(jobs.maxAttempts);
  const assistantRecovered = await assistantQueue.recoverExpired(jobs.maxAttempts);
  const routingRecovered = await routingQueue.recoverExpired(jobs.maxAttempts);
  const simulationRecovered = await simulationQueue.recoverExpired(jobs.maxAttempts);
  if (simulationRecovered.requeued || simulationRecovered.failed)
    console.warn(JSON.stringify({ event: 'flow_simulation.recovered', ...simulationRecovered }));
  if (recovered.requeued || recovered.failed || recovered.cancelled)
    console.warn(JSON.stringify({ event: 'agent.runs_recovered', ...recovered }));
  if (assistantRecovered.requeued || assistantRecovered.failed)
    console.warn(JSON.stringify({ event: 'flow_assistant.recovered', ...assistantRecovered }));
  if (routingRecovered.requeued || routingRecovered.failed)
    console.warn(JSON.stringify({ event: 'ticket_routing.recovered', ...routingRecovered }));
}

console.info(JSON.stringify({ event: 'executor.started', ...jobs }));
await recover();

/** P10: drenagem pedida pelo rollout (deixa de reclamar jobs novos até ser libertada/expirar). */
const drain = new RuntimeDrainWatcher(db, {
  intervalMs: 3000,
  onChange: (draining) =>
    console.info(
      JSON.stringify({ event: draining ? 'executor.drain_started' : 'executor.drain_released' }),
    ),
});
await drain.refresh();
drain.start();
const paused = () => drain.active;
/** Só sincroniza estados (o executor não cria tickets de capacidades). */
const capabilities = new CapabilityDevelopmentService(db, {
  createTicket: () => Promise.reject(new Error('Indisponível no executor.')),
  runtimeVersion: () => env.ZEROOPS_VERSION,
});

/** Pools separados: um run longo nunca bloqueia o assistente interativo. */
const pools = [
  new JobPool('assistant', (shutdown) => assistant.runOnce(shutdown), {
    concurrency: jobs.assistantConcurrency,
    idleMs: jobs.idleMs,
    paused,
    onError: logError('flow_assistant.loop_failed'),
  }).start(),
  new JobPool('routing', (shutdown) => routing.runOnce(shutdown), {
    concurrency: jobs.routingConcurrency,
    idleMs: jobs.idleMs,
    paused,
    onError: logError('ticket_routing.loop_failed'),
  }).start(),
  new JobPool('simulation', (shutdown) => simulation.runOnce(shutdown), {
    concurrency: jobs.routingConcurrency,
    idleMs: jobs.idleMs,
    paused,
    onError: logError('flow_simulation.loop_failed'),
  }).start(),
  new JobPool('runs', (shutdown) => runner.runOnce(shutdown), {
    concurrency: jobs.runConcurrency,
    idleMs: jobs.idleMs,
    paused,
    onError: logError('agent.loop_failed'),
  }).start(),
  ...(delivery
    ? [
        new JobPool('delivery', (shutdown) => delivery.runOnce(shutdown), {
          concurrency: 2,
          idleMs: jobs.idleMs,
          paused,
          onError: logError('delivery.loop_failed'),
        }).start(),
      ]
    : []),
];

let stopping = false;
const maintenance = setInterval(() => {
  if (stopping) return;
  void recover().catch(logError('agent.recovery_failed'));
  if (development)
    void developmentStore
      .cleanupCandidates(workspaceRetentionDays)
      .then((candidates) =>
        development.cleanup(candidates, (id) => developmentStore.markCleaned(id)),
      )
      .catch(logError('development.cleanup_failed'));
  void deliveryStore.maintenance().catch(logError('delivery.maintenance_failed'));
  void reconcileUncertainInterventions(db).catch(logError('health.reconcile_failed'));
  void capabilities.syncActive().catch(logError('capability.sync_failed'));
  if (modelCatalog) void modelCatalog.refreshOnce().catch(logError('agent.models_refresh_failed'));
}, jobs.recoveryMs);
if (modelCatalog) void modelCatalog.refreshOnce().catch(logError('agent.models_refresh_failed'));

/** Paragem ordenada: deixa de reclamar, espera pelos jobs e devolve à fila os que não terminaram. */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenance);
  drain.stop();
  console.info(JSON.stringify({ event: 'executor.draining', signal, drainMs: jobs.drainMs }));
  await Promise.all(pools.map((pool) => pool.drain(jobs.drainMs)));
  await db.close();
  console.info(JSON.stringify({ event: 'executor.stopped', signal }));
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
