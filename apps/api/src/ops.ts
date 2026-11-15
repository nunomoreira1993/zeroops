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
import { repositoryCredentialContext } from '../../../packages/backend/src/modules/development/git-repositories.service.js';
import {
  allowedRepositoryRoots,
  GitCommandError,
  remoteBranchSha,
  repositoryUrlAllowed,
} from '../../../packages/backend/src/modules/development/git.js';
import { inspectGitHubCliCredential } from '../../../packages/backend/src/modules/development/github-cli-credential.js';
import { OperatorSession } from '../../../packages/backend/src/modules/operations/operator-session.js';
import { requireProjectPermission } from '../../../packages/backend/src/modules/identity/project-permissions.js';
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
  github-cli-credential --project ID --repository-name NAME
                  Lê um token GitHub CLI de stdin, valida-o e guarda-o cifrado no repositório indicado.
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
    'repository-name': { type: 'string' },
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
const cipher = new IdentityCipher(env.ZEROOPS_IDENTITY_KEY);
const settings = new IntegrationSettingsService(
  db,
  cipher,
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

async function readStdinCredential() {
  if (process.stdin.isTTY)
    throw new Error('O token GitHub deve ser recebido exclusivamente por stdin.');
  let value = '';
  for await (const chunk of process.stdin) {
    value += Buffer.from(chunk).toString('utf8');
    if (value.length > 512) throw new Error('Credencial GitHub demasiado longa.');
  }
  const token = value.trim();
  if (!token || token.length > 500 || !/^[\x21-\x7e]+$/.test(token))
    throw new Error('Não foi recebida uma credencial GitHub válida por stdin.');
  return token;
}

async function importGitHubCliCredential(operator: OperatorSession) {
  const projectId = args.project;
  const repositoryName = args['repository-name'];
  if (!projectId || !repositoryName)
    throw new Error('--project e --repository-name são obrigatórios.');

  const repository = await db.transaction(async (client) => {
    await requireProjectPermission(client, operator.actor, projectId, 'repositories.manage');
    const row = (
      await client.query<{
        id: string;
        url: string;
        base_branch: string;
        version: number;
      }>(
        `SELECT id,url,base_branch,version FROM project_git_repositories
         WHERE project_id=$1 AND name=$2 AND NOT archived`,
        [projectId, repositoryName],
      )
    ).rows[0];
    if (!row) throw new Error('Repositório ativo não encontrado no projeto indicado.');
    return row;
  });
  const repositoryId = repository.id;
  const expectedVersion = Number(repository.version);
  if (!repositoryUrlAllowed(repository.url, allowedRepositoryRoots(env)))
    throw new Error('O repositório não está nas origens autorizadas para desenvolvimento.');

  const token = await readStdinCredential();
  const credentialInfo = await inspectGitHubCliCredential(repository.url, token);
  let baseSha: string | null;
  try {
    baseSha = await remoteBranchSha(repository.url, repository.base_branch, { credential: token });
  } catch (error) {
    if (error instanceof GitCommandError) throw error;
    throw new Error('Não foi possível verificar a branch Git.', { cause: error });
  }
  if (!baseSha)
    throw new Error(`A branch base ${repository.base_branch} não existe no repositório.`);

  await db.transaction(async (client) => {
    await requireProjectPermission(client, operator.actor, projectId, 'repositories.manage', true);
    const current = (
      await client.query<{ version: number; archived: boolean }>(
        `SELECT version,archived FROM project_git_repositories
         WHERE id=$1 AND project_id=$2 FOR UPDATE`,
        [repositoryId, projectId],
      )
    ).rows[0];
    if (!current || current.archived)
      throw new Error('Repositório ativo não encontrado no projeto indicado.');
    if (Number(current.version) !== expectedVersion)
      throw new Error('A versão do repositório mudou durante a validação; repita a operação.');
    await client.query(
      `UPDATE project_git_repositories SET credential_ciphertext=$3,credential_provider='github_cli',
         credential_identity=$4,verified_at=NOW(3),verified_base_sha=$5,verification_error=NULL,
         version=version+1,updated_by=$6,updated_at=NOW(3) WHERE id=$1 AND project_id=$2`,
      [
        repositoryId,
        projectId,
        cipher.encrypt(token, repositoryCredentialContext(projectId, repositoryId)),
        credentialInfo.login,
        baseSha,
        operator.actor.id,
      ],
    );
  });
  return {
    projectId,
    repositoryId,
    provider: 'github_cli',
    account: credentialInfo.login,
    accountId: credentialInfo.accountId,
    accountType: credentialInfo.accountType,
    scopes: credentialInfo.scopes,
    permissions: credentialInfo.permissions,
    baseSha,
  };
}

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
    case 'github-cli-credential':
      return importGitHubCliCredential(operator);
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
