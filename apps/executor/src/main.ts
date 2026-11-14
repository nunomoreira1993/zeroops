import { tmpdir } from 'node:os';
import { Database } from '../../../packages/backend/src/database/database.js';
import { AgentRunsService } from '../../../packages/backend/src/modules/agents/agent-runs.service.js';
import { AgentModelsService } from '../../../packages/backend/src/modules/agents/agent-models.service.js';
import { AgentRunEventsService } from '../../../packages/backend/src/modules/agents/agent-run-events.service.js';
import { HealthIncidentLifecycle } from '../../../packages/backend/src/modules/health/health-incident-lifecycle.js';
import { FlowEngine } from '../../../packages/backend/src/modules/flows/flow-engine.js';
import { FlowAssistantQueue } from '../../../packages/backend/src/modules/flows/flow-assistant.js';
import { createFlowActionRegistry } from '../../../packages/backend/src/modules/incidents/incident.module.js';
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

const db = new Database(env.ZEROOPS_DATABASE_URL);
const assistantQueue = new FlowAssistantQueue(db);
const events = new AgentRunEventsService(db);
/** O token Copilot vem da integração `copilot` do projeto (página Integrações), cifrado na BD. */
const integrationConfig = integrationRuntimeConfigFromEnv(env, env.ZEROOPS_PUBLIC_URL ?? '');
const settings = new IntegrationSettingsService(
  db,
  new IdentityCipher(env.ZEROOPS_IDENTITY_KEY),
  new AuthorizedIntegrationProbe(integrationConfig.smtpEndpoints, {
    connectorEndpoints: integrationConfig.connectorEndpoints,
  }),
);
const flowEngine = new FlowEngine(
  db,
  createFlowActionRegistry(db, { settings, publicUrl: env.ZEROOPS_PUBLIC_URL || undefined }),
);
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
const runner = new InvestigationRunner(runs, adapter, {
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
  conversation: (runId: string) =>
    new AgentRunConversation(runId, events, {
      questionTimeoutMs: Number(env.ZEROOPS_AGENT_QUESTION_TIMEOUT_MS ?? 600000),
      onError: (error) =>
        console.warn(
          JSON.stringify({
            event: 'agent.conversation_failed',
            runId,
            type: error instanceof Error ? error.name : 'UnknownError',
          }),
        ),
    }),
});

/** Assistente dos fluxos: respostas curtas, sem pastas nem conectores (contexto no prompt). */
const assistant = new FlowAssistantRunner(assistantQueue, adapter, {
  workspaceRoot: env.ZEROOPS_AGENT_WORKSPACE ?? tmpdir(),
  timeoutMs: Math.min(Number(env.ZEROOPS_AGENT_TIMEOUT_MS ?? 900000), 300000),
  outputLimitBytes: Number(env.ZEROOPS_AGENT_OUTPUT_LIMIT ?? 5242880),
  copilotCredentials,
  ...(identity ? { workspaceOwner: { uid: identity.uid, gid: identity.gid } } : {}),
});

const interrupted = await runs.failInterrupted();
if (interrupted) console.warn(JSON.stringify({ event: 'agent.runs_interrupted', interrupted }));
const assistantInterrupted = await assistantQueue.failInterrupted();
if (assistantInterrupted)
  console.warn(JSON.stringify({ event: 'flow_assistant.interrupted', assistantInterrupted }));

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

let stopping = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
process.once('SIGINT', () => (stopping = true));
process.once('SIGTERM', () => (stopping = true));
while (!stopping) {
  try {
    if (modelCatalog) await modelCatalog.refreshOnce();
    // O assistente responde entre runs (pedidos curtos e interativos têm prioridade).
    const answered = await assistant.runOnce();
    const ran = await runner.runOnce();
    if (!answered && !ran) await sleep(3000);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'agent.loop_failed',
        type: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    await sleep(10000);
  }
}
await db.close();
