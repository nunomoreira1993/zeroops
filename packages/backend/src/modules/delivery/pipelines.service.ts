import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  gitRepositoryArchiveSchema,
  projectPipelineInputSchema,
  type ProjectPipelineView,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { activeRepository, jsonValue } from '../development/git-repositories.service.js';
import type { IdentityCipher } from '../identity/identity-security.js';
import { parseInput } from '../identity/identity.validation.js';
import type { Queryable } from '../identity/membership.js';
import {
  projectPermissionContext,
  requireProjectPermission,
} from '../identity/project-permissions.js';

export interface PipelineRow {
  id: string;
  project_id: string;
  name: string;
  provider: 'webhook';
  repository_id: string;
  target_branch: string;
  environment: 'quality' | 'production';
  endpoint_url: string;
  secret_ciphertext: string;
  allow_integration: boolean;
  hold_policy: 'until_published' | 'until_flow_end';
  version: number;
  archived: boolean;
  updated_at: Date;
}

/** Contexto da cifra: o segredo só decifra para a mesma pipeline do mesmo projeto. */
export const pipelineSecretContext = (projectId: string, pipelineId: string) =>
  JSON.stringify({ kind: 'pipeline', projectId, pipelineId });

/** Origens autorizadas para endpoints de pipeline (`ZEROOPS_PIPELINE_ALLOWED_ORIGINS`). */
export function allowedPipelineOrigins(env: NodeJS.ProcessEnv = process.env) {
  return (env.ZEROOPS_PIPELINE_ALLOWED_ORIGINS ?? '')
    .split(/[;,\s]+/)
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** O endpoint pertence a uma origem autorizada (esquema, host e porta exatos). Sem lista, recusa. */
export function pipelineEndpointAllowed(url: string, origins: readonly string[]) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    return origins.some((origin) => {
      try {
        return new URL(origin).origin === parsed.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Ids das pipelines ativas do projeto (validação estrutural dos fluxos). */
export async function activePipelineIds(db: Queryable, projectId: string) {
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM project_pipelines WHERE project_id=$1 AND NOT archived',
    [projectId],
  );
  return new Set(rows.rows.map((row) => row.id));
}

/** Pipeline ativa de um projeto (motor e executor). */
export async function activePipeline(db: Queryable, projectId: string, pipelineId: string) {
  if (!z.uuid().safeParse(pipelineId).success) return null;
  return (
    (
      await db.query<PipelineRow>(
        'SELECT * FROM project_pipelines WHERE id=$1 AND project_id=$2 AND NOT archived',
        [pipelineId, projectId],
      )
    ).rows[0] ?? null
  );
}

/** URL da callback de uma pipeline (o fornecedor assina cada pedido com o segredo partilhado). */
export const pipelineCallbackUrl = (publicUrl: string, pipelineId: string) =>
  `${publicUrl.replace(/\/+$/, '')}/api/pipelines/${pipelineId}/callbacks`;

export interface PipelinesOptions {
  allowedOrigins: readonly string[];
  publicUrl: string;
}

/**
 * Pipelines de entrega por projeto. Gerir exige `repositories.manage` (mesma autoridade dos
 * recursos Git); consultar basta ter acesso aos fluxos. O segredo é só de escrita.
 */
export class PipelinesService {
  constructor(
    private readonly db: Database,
    private readonly cipher: IdentityCipher,
    private readonly options: PipelinesOptions,
  ) {}

  /** Lista as pipelines do projeto. */
  async list(actor: User, projectId: string): Promise<ProjectPipelineView[]> {
    const context = await projectPermissionContext(this.db, actor, projectId);
    if (
      !context.permissions.includes('repositories.manage') &&
      !context.permissions.includes('flows.view')
    )
      throw new DomainError('FORBIDDEN', 'Sem permissão para consultar pipelines.', 403);
    const rows = await this.db.query<PipelineRow & { repository_name: string }>(
      `SELECT p.*,r.name AS repository_name FROM project_pipelines p
         JOIN project_git_repositories r ON r.id=p.repository_id
        WHERE p.project_id=$1 ORDER BY p.archived,p.name`,
      [projectId],
    );
    return rows.rows.map((row) => this.toView(row));
  }

  /** Cria uma pipeline sobre um repositório ativo e uma branch autorizada do projeto. */
  async create(actor: User, projectId: string, raw: unknown): Promise<ProjectPipelineView> {
    const input = parseInput(projectPipelineInputSchema, raw);
    this.assertEndpoint(input.endpointUrl);
    if (!input.secret)
      throw new DomainError('INVALID_INPUT', 'Indique o segredo partilhado da pipeline.', 400);
    const secret = input.secret;
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'repositories.manage',
        true,
      );
      await this.assertTarget(client, projectId, input.repositoryId, input.targetBranch);
      const duplicate = await client.query(
        'SELECT id FROM project_pipelines WHERE project_id=$1 AND name=$2',
        [projectId, input.name],
      );
      if (duplicate.rowCount)
        throw new DomainError('DUPLICATE', 'Já existe uma pipeline com esse nome.', 409);
      const id = randomUUID();
      await client.query(
        `INSERT INTO project_pipelines(id,project_id,name,provider,repository_id,target_branch,
           environment,endpoint_url,secret_ciphertext,allow_integration,hold_policy,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [
          id,
          projectId,
          input.name,
          input.provider,
          input.repositoryId,
          input.targetBranch,
          input.environment,
          input.endpointUrl,
          this.cipher.encrypt(secret, pipelineSecretContext(projectId, id)),
          input.allowIntegration,
          input.holdPolicy,
          context.actor.id,
        ],
      );
      await this.audit(client, context.actor.id, 'pipeline.created', {
        projectId,
        pipelineId: id,
        repositoryId: input.repositoryId,
        targetBranch: input.targetBranch,
        environment: input.environment,
        endpointUrl: input.endpointUrl,
        allowIntegration: input.allowIntegration,
      });
      return this.view(client, projectId, id);
    });
  }

  /** Atualiza a pipeline (versão otimista). O segredo só muda quando é indicado. */
  async update(
    actor: User,
    projectId: string,
    pipelineId: string,
    raw: unknown,
  ): Promise<ProjectPipelineView> {
    const input = parseInput(projectPipelineInputSchema, raw);
    this.assertEndpoint(input.endpointUrl);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'repositories.manage',
        true,
      );
      const current = await this.locked(client, projectId, pipelineId);
      if (input.expectedVersion !== undefined && input.expectedVersion !== Number(current.version))
        throw new DomainError(
          'VERSION_CONFLICT',
          'A pipeline foi alterada entretanto. Recarregue antes de guardar.',
          409,
        );
      await this.assertTarget(client, projectId, input.repositoryId, input.targetBranch);
      await client.query(
        `UPDATE project_pipelines SET name=$3,repository_id=$4,target_branch=$5,environment=$6,
           endpoint_url=$7,secret_ciphertext=$8,allow_integration=$9,hold_policy=$10,
           version=version+1,updated_by=$11,updated_at=NOW(3)
         WHERE id=$1 AND project_id=$2`,
        [
          pipelineId,
          projectId,
          input.name,
          input.repositoryId,
          input.targetBranch,
          input.environment,
          input.endpointUrl,
          input.secret
            ? this.cipher.encrypt(input.secret, pipelineSecretContext(projectId, pipelineId))
            : current.secret_ciphertext,
          input.allowIntegration,
          input.holdPolicy,
          context.actor.id,
        ],
      );
      await this.audit(client, context.actor.id, 'pipeline.updated', {
        projectId,
        pipelineId,
        targetBranch: input.targetBranch,
        environment: input.environment,
        endpointUrl: input.endpointUrl,
        allowIntegration: input.allowIntegration,
        secretChanged: Boolean(input.secret),
      });
      return this.view(client, projectId, pipelineId);
    });
  }

  /** Arquiva a pipeline: novas entregas deixam de a poder usar; entregas em curso terminam. */
  async archive(actor: User, projectId: string, pipelineId: string, raw: unknown) {
    const input = parseInput(gitRepositoryArchiveSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'repositories.manage',
        true,
      );
      const current = await this.locked(client, projectId, pipelineId);
      if (input.expectedVersion !== Number(current.version))
        throw new DomainError('VERSION_CONFLICT', 'A pipeline foi alterada entretanto.', 409);
      await client.query(
        'UPDATE project_pipelines SET archived=1,version=version+1,updated_by=$3,updated_at=NOW(3) WHERE id=$1 AND project_id=$2',
        [pipelineId, projectId, context.actor.id],
      );
      await this.audit(client, context.actor.id, 'pipeline.archived', { projectId, pipelineId });
      return this.view(client, projectId, pipelineId);
    });
  }

  private assertEndpoint(url: string) {
    if (!pipelineEndpointAllowed(url, this.options.allowedOrigins))
      throw new DomainError(
        'PIPELINE_NOT_ALLOWED',
        'Este endpoint não está nas origens autorizadas para pipelines.',
        400,
      );
  }

  private async assertTarget(
    client: Queryable,
    projectId: string,
    repositoryId: string,
    branch: string,
  ) {
    const repository = await activeRepository(client, projectId, repositoryId, true);
    if (!repository)
      throw new DomainError('INVALID_INPUT', 'O repositório não existe neste projeto.', 400);
    if (!jsonValue<string[]>(repository.allowed_refs, []).includes(branch))
      throw new DomainError(
        'INVALID_INPUT',
        'A branch de destino tem de estar nas referências autorizadas do repositório.',
        400,
      );
  }

  private async locked(client: Queryable, projectId: string, pipelineId: string, lock = true) {
    if (!z.uuid().safeParse(pipelineId).success)
      throw new DomainError('INVALID_INPUT', 'Pipeline inválida.', 400);
    const row = (
      await client.query<PipelineRow & { repository_name: string }>(
        `SELECT p.*,r.name AS repository_name FROM project_pipelines p
           JOIN project_git_repositories r ON r.id=p.repository_id
          WHERE p.id=$1 AND p.project_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [pipelineId, projectId],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'Pipeline não encontrada.', 404);
    return row;
  }

  private async view(client: Queryable, projectId: string, pipelineId: string) {
    return this.toView(await this.locked(client, projectId, pipelineId, false));
  }

  private toView(row: PipelineRow & { repository_name: string }): ProjectPipelineView {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      provider: row.provider,
      repository: { id: row.repository_id, name: row.repository_name },
      targetBranch: row.target_branch,
      environment: row.environment,
      endpointUrl: row.endpoint_url,
      callbackUrl: pipelineCallbackUrl(this.options.publicUrl, row.id),
      allowIntegration: Boolean(row.allow_integration),
      holdPolicy: row.hold_policy,
      version: Number(row.version),
      archived: Boolean(row.archived),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private async audit(
    client: Queryable,
    actorId: string,
    action: string,
    details: Record<string, unknown>,
  ) {
    await client.query('INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      actorId,
      action,
      JSON.stringify(details),
    ]);
  }
}
