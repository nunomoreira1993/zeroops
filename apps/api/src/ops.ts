import { chmod, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Database } from '../../../packages/backend/src/database/database.js';
import { createHealthMonitoring } from '../../../packages/backend/src/modules/health/health.module.js';
import { FlowEngine } from '../../../packages/backend/src/modules/flows/flow-engine.js';
import { FlowAdoptionService } from '../../../packages/backend/src/modules/flows/flow-adoption.js';
import { createFlowActionRegistry } from '../../../packages/backend/src/modules/incidents/incident.module.js';
import { IdentityCipher } from '../../../packages/backend/src/modules/identity/identity-security.js';
import {
  AuthorizedIntegrationProbe,
  integrationRuntimeConfigFromEnv,
} from '../../../packages/backend/src/modules/integrations/integration-probe.js';
import { IntegrationSettingsService } from '../../../packages/backend/src/modules/integrations/integration-settings.service.js';
import { OperatorSession } from '../../../packages/backend/src/modules/operations/operator-session.js';
import {
  RetentionService,
  retentionPolicyFromEnv,
} from '../../../packages/backend/src/modules/operations/retention.service.js';

const usage = `zeroops-ops <comando> --as <email-admin> [opcoes]

  smtp            --host H --port P --from E [--environment quality|production] [--loopback-plain]
                  Grava o SMTP de instancia (sem autenticacao) e testa-o.
  metrics         --url U [--matchers 'env="quality"'] [--environment quality|production]
                  Grava a integracao Metricas (Prometheus) do projeto do admin e testa-a.
  health-settings --file settings.json   Grava a configuracao da Saude do projeto do admin.
  agent-token     --out /caminho/ficheiro Gera o token do agente e escreve-o (modo 600); nunca o imprime.
  health-run                             Corre um ciclo de verificacoes e entrega alertas.
  health-report                          Envia ja o relatorio periodico.
  migration-inventory [--project ID]     Inventario de fluxos/execucoes/esperas/jobs com hashes (so leitura).
  flow-adoption   [--project ID] --disposition start|exclude [--tickets ID,ID] [--reason R]
                  [--apply --expect HASH]
                  Tickets antigos sem execucao: sem --apply mostra a selecao e o hash (dry-run);
                  com --apply regista a disposicao (auditada, uma vez por ticket). Nunca automatico.
  retention       [--project ID | --all-projects] [--apply --expect HASH]
                  Retencao de eventos de jobs, simulacoes, outbox entregue e deltas de runs
                  (ZEROOPS_RETENTION_*_DAYS; 0 desativa). Sem --apply: selecao e hash (dry-run).

Nao aceita passwords: atua em nome de um administrador existente e fica auditado (ops.cli).`;

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string' },
    from: { type: 'string' },
    environment: { type: 'string' },
    'loopback-plain': { type: 'boolean', default: false },
    file: { type: 'string' },
    out: { type: 'string' },
    url: { type: 'string' },
    matchers: { type: 'string' },
    project: { type: 'string' },
    disposition: { type: 'string' },
    reason: { type: 'string' },
    expect: { type: 'string' },
    tickets: { type: 'string' },
    apply: { type: 'boolean', default: false },
    'all-projects': { type: 'boolean', default: false },
  },
});
const command = positionals[0];
if (!command || !args.as) {
  console.error(usage);
  process.exit(2);
}
const env = process.env;
if (!env.ZEROOPS_DATABASE_URL) throw new Error('ZEROOPS_DATABASE_URL obrigatorio.');

const db = new Database(env.ZEROOPS_DATABASE_URL);
const config = integrationRuntimeConfigFromEnv(env, env.ZEROOPS_PUBLIC_URL ?? '');
const settings = new IntegrationSettingsService(
  db,
  new IdentityCipher(env.ZEROOPS_IDENTITY_KEY),
  new AuthorizedIntegrationProbe(config.smtpEndpoints, {
    connectorEndpoints: config.connectorEndpoints,
  }),
);
const flowEngine = new FlowEngine(
  db,
  createFlowActionRegistry(db, { settings, publicUrl: env.ZEROOPS_PUBLIC_URL || undefined }),
);
const health = createHealthMonitoring(
  db,
  settings,
  env.ZEROOPS_PUBLIC_URL,
  undefined,
  undefined,
  undefined,
  undefined,
  { ticketCreated: [flowEngine.onTicketCreated], incidentDelegate: flowEngine.incidentDelegate },
).service;
const adoption = new FlowAdoptionService(db, flowEngine);

const required = (name: 'host' | 'port' | 'from' | 'file' | 'out' | 'url') => {
  const value = args[name];
  if (!value) throw new Error(`--${name} obrigatorio para ${command}.`);
  return value;
};

async function saveSmtp(operator: OperatorSession) {
  const environment = args.environment === 'production' ? 'production' : 'quality';
  const values = {
    kind: 'smtp' as const,
    host: required('host'),
    port: Number(required('port')),
    from: required('from'),
    secure: false,
    requireTLS: !args['loopback-plain'],
    allowInsecureLoopback: Boolean(args['loopback-plain']),
    username: '',
  };
  const current = (await settings.list(operator.actor)).find(
    (item) => item.scope === 'instance' && item.kind === 'smtp' && item.environment === environment,
  );
  const saved = await settings.save(operator.actor, {
    scope: 'instance',
    environment,
    expectedVersion: current?.version ?? 0,
    values,
  });
  await settings.test(operator.actor, saved.id, { expectedVersion: saved.version });
  return { settingId: saved.id, version: saved.version, status: 'verified', host: values.host };
}

async function saveMetrics(operator: OperatorSession) {
  const environment = args.environment === 'production' ? 'production' : 'quality';
  const values = {
    kind: 'metrics' as const,
    url: required('url'),
    matchers: args.matchers ?? '',
  };
  const current = (await settings.list(operator.actor)).find(
    (item) =>
      item.scope === 'project' && item.kind === 'metrics' && item.environment === environment,
  );
  const saved = await settings.save(operator.actor, {
    scope: 'project',
    environment,
    expectedVersion: current?.version ?? 0,
    values,
  });
  await settings.test(operator.actor, saved.id, { expectedVersion: saved.version });
  return { settingId: saved.id, version: saved.version, status: 'verified', url: values.url };
}

async function run(operator: OperatorSession): Promise<Record<string, unknown>> {
  switch (command) {
    case 'smtp':
      return saveSmtp(operator);
    case 'metrics':
      return saveMetrics(operator);
    case 'health-settings': {
      const input: unknown = JSON.parse(await readFile(required('file'), 'utf8'));
      const overview = await health.saveSettings(operator.actor, input);
      return { enabled: overview.settings.enabled, lists: overview.settings.lists.length };
    }
    case 'agent-token': {
      const out = required('out');
      const { token } = await health.rotateAgentToken(operator.actor);
      await writeFile(out, `ZEROOPS_TOKEN=${token}\n`, { mode: 0o600 });
      await chmod(out, 0o600);
      return { written: out };
    }
    case 'health-run':
      return health.runNow(operator.actor);
    case 'health-report':
      return { ...(await health.reportNow(operator.actor)) };
    case 'migration-inventory':
      return adoption.inventory(operator.actor, args.project ?? operator.actor.projectId);
    case 'flow-adoption': {
      const projectId = args.project ?? operator.actor.projectId;
      if (!args.apply) return { dryRun: true, ...(await adoption.plan(operator.actor, projectId)) };
      return adoption.apply(operator.actor, {
        projectId,
        disposition: args.disposition,
        reason: args.reason,
        expect: args.expect,
        ...(args.tickets ? { ticketIds: args.tickets.split(',').map((id) => id.trim()) } : {}),
      });
    }
    case 'retention': {
      const projectId = args['all-projects'] ? null : (args.project ?? operator.actor.projectId);
      const service = new RetentionService(db, retentionPolicyFromEnv(env));
      if (!args.apply) return { dryRun: true, ...(await service.plan(operator.actor, projectId)) };
      if (!args.expect) throw new Error('--expect HASH obrigatorio com --apply (hash do dry-run).');
      return service.apply(operator.actor, { projectId, expect: args.expect });
    }
    default:
      throw new Error(`Comando desconhecido: ${command}\n\n${usage}`);
  }
}

try {
  const operator = await OperatorSession.forAdmin(db, args.as);
  const result = await run(operator);
  await operator.audit(command, { result });
  console.info(JSON.stringify({ command, ...result }));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
