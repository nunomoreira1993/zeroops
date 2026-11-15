import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  gitRepositoryArchiveSchema,
  gitRepositoryCredentialRevokeSchema,
  gitRepositoryInputSchema,
  type DevelopmentCommand,
  type GitRepositoryView,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import type { IdentityCipher } from '../identity/identity-security.js';
import { parseInput } from '../identity/identity.validation.js';
import type { Queryable } from '../identity/membership.js';
import {
  projectPermissionContext,
  requireProjectPermission,
} from '../identity/project-permissions.js';
import { GitHubCliCredentialError, inspectGitHubCliCredential } from './github-cli-credential.js';
import { GitCommandError, remoteBranchSha, repositoryUrlAllowed } from './git.js';

export interface GitRepositoryRow {
  id: string;
  project_id: string;
  name: string;
  url: string;
  base_branch: string;
  allowed_refs: unknown;
  setup_commands: unknown;
  test_commands: unknown;
  pr_provider: 'zeroops' | 'github';
  credential_ciphertext: string | null;
  credential_provider: 'token' | 'github_cli';
  credential_identity: string | null;
  version: number;
  archived: boolean;
  verified_at: Date | null;
  verified_base_sha: string | null;
  verification_error: string | null;
  updated_at: Date;
}

/** Colunas JSON guardadas como texto (fora de `JSON_COLUMNS`): aceita texto ou valor já lido. */
export function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Contexto da cifra: a credencial só decifra para o mesmo repositório do mesmo projeto. */
export const repositoryCredentialContext = (projectId: string, repositoryId: string) =>
  JSON.stringify({ kind: 'git_repository', projectId, repositoryId });

/** Vista pública do repositório (sem credencial; indica apenas se existe). */
export function repositoryView(row: GitRepositoryRow): GitRepositoryView {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    url: row.url,
    baseBranch: row.base_branch,
    allowedRefs: jsonValue<string[]>(row.allowed_refs, []),
    setupCommands: jsonValue<DevelopmentCommand[]>(row.setup_commands, []),
    testCommands: jsonValue<DevelopmentCommand[]>(row.test_commands, []),
    prProvider: row.pr_provider,
    hasCredential: Boolean(row.credential_ciphertext),
    credentialProvider: row.credential_provider === 'github_cli' ? 'github_cli' : 'token',
    credentialIdentity: row.credential_ciphertext ? row.credential_identity : null,
    version: Number(row.version),
    archived: Boolean(row.archived),
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    verifiedBaseSha: row.verified_base_sha,
    verificationError: row.verification_error,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Repositório ativo de um projeto (para o motor e para o executor). */
export async function activeRepository(
  db: Queryable,
  projectId: string,
  repositoryId: string,
  lock = false,
) {
  if (!z.uuid().safeParse(repositoryId).success) return null;
  return (
    (
      await db.query<GitRepositoryRow>(
        `SELECT * FROM project_git_repositories WHERE id=$1 AND project_id=$2 AND NOT archived${lock ? ' LOCK IN SHARE MODE' : ''}`,
        [repositoryId, projectId],
      )
    ).rows[0] ?? null
  );
}

/** Ids dos repositórios ativos do projeto (validação estrutural dos fluxos). */
export async function activeRepositoryIds(db: Queryable, projectId: string) {
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM project_git_repositories WHERE project_id=$1 AND NOT archived',
    [projectId],
  );
  return new Set(rows.rows.map((row) => row.id));
}

export interface GitRepositoriesOptions {
  /** Raízes de URL autorizadas (`ZEROOPS_DEV_ALLOWED_REPO_ROOTS`). */
  allowedRoots: readonly string[];
  /** Consulta remota da branch base (substituível em testes). */
  probe?: (url: string, branch: string, credential: string | null) => Promise<string | null>;
}

/**
 * Recursos Git de desenvolvimento por projeto. Gerir exige `repositories.manage`; consultar basta
 * ter acesso aos fluxos (para escolher o repositório numa etapa). A credencial fica vinculada ao
 * repositório e só é usada por operações Git/API autorizadas.
 */
export class GitRepositoriesService {
  constructor(
    private readonly db: Database,
    private readonly cipher: IdentityCipher,
    private readonly options: GitRepositoriesOptions,
  ) {}

  /** Lista os repositórios do projeto (gestão ou consulta de fluxos). */
  async list(actor: User, projectId: string): Promise<GitRepositoryView[]> {
    const context = await projectPermissionContext(this.db, actor, projectId);
    if (
      !context.permissions.includes('repositories.manage') &&
      !context.permissions.includes('flows.view')
    )
      throw new DomainError('FORBIDDEN', 'Sem permissão para consultar repositórios.', 403);
    const rows = await this.db.query<GitRepositoryRow>(
      'SELECT * FROM project_git_repositories WHERE project_id=$1 ORDER BY archived, name',
      [projectId],
    );
    return rows.rows.map(repositoryView);
  }

  /** Cria um repositório numa raiz autorizada; a credencial fica cifrada e nunca é devolvida. */
  async create(actor: User, projectId: string, raw: unknown): Promise<GitRepositoryView> {
    const input = parseInput(gitRepositoryInputSchema, raw);
    this.assertAllowed(input.url);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'repositories.manage',
        true,
      );
      const id = randomUUID();
      const duplicate = await client.query(
        'SELECT id FROM project_git_repositories WHERE project_id=$1 AND name=$2',
        [projectId, input.name],
      );
      if (duplicate.rowCount)
        throw new DomainError('DUPLICATE', 'Já existe um repositório com esse nome.', 409);
      await client.query(
        `INSERT INTO project_git_repositories(id,project_id,name,url,base_branch,allowed_refs,
           setup_commands,test_commands,pr_provider,credential_ciphertext,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [
          id,
          projectId,
          input.name,
          input.url,
          input.baseBranch,
          JSON.stringify(input.allowedRefs),
          JSON.stringify(input.setupCommands),
          JSON.stringify(input.testCommands),
          input.prProvider,
          input.credential
            ? this.cipher.encrypt(input.credential, repositoryCredentialContext(projectId, id))
            : null,
          context.actor.id,
        ],
      );
      await this.audit(client, context.actor.id, 'git_repository.created', {
        projectId,
        repositoryId: id,
        url: input.url,
        credential: Boolean(input.credential),
      });
      return this.view(client, projectId, id);
    });
  }

  /** Atualiza o repositório (versão otimista); mudar URL/base/credencial obriga a nova verificação. */
  async update(
    actor: User,
    projectId: string,
    repositoryId: string,
    raw: unknown,
  ): Promise<GitRepositoryView> {
    const input = parseInput(gitRepositoryInputSchema, raw);
    this.assertAllowed(input.url);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'repositories.manage',
        true,
      );
      const current = await this.locked(client, projectId, repositoryId);
      if (input.expectedVersion !== undefined && input.expectedVersion !== Number(current.version))
        throw new DomainError(
          'VERSION_CONFLICT',
          'O repositório foi alterado entretanto. Recarregue antes de guardar.',
          409,
        );
      const credential =
        input.credential === undefined
          ? current.credential_ciphertext
          : input.credential === null
            ? null
            : this.cipher.encrypt(
                input.credential,
                repositoryCredentialContext(projectId, repositoryId),
              );
      const credentialProvider =
        input.credential === undefined ? current.credential_provider : 'token';
      const credentialIdentity =
        input.credential === undefined ? current.credential_identity : null;
      const changedTarget = current.url !== input.url || current.base_branch !== input.baseBranch;
      await client.query(
        `UPDATE project_git_repositories SET name=$3,url=$4,base_branch=$5,allowed_refs=$6,
           setup_commands=$7,test_commands=$8,pr_provider=$9,credential_ciphertext=$10,
           credential_provider=$11,credential_identity=$12,
           version=version+1,updated_by=$13,updated_at=NOW(3)
           ${changedTarget || input.credential !== undefined ? ',verified_at=NULL,verified_base_sha=NULL,verification_error=NULL' : ''}
         WHERE id=$1 AND project_id=$2`,
        [
          repositoryId,
          projectId,
          input.name,
          input.url,
          input.baseBranch,
          JSON.stringify(input.allowedRefs),
          JSON.stringify(input.setupCommands),
          JSON.stringify(input.testCommands),
          input.prProvider,
          credential,
          credentialProvider,
          credentialIdentity,
          context.actor.id,
        ],
      );
      await this.audit(client, context.actor.id, 'git_repository.updated', {
        projectId,
        repositoryId,
        url: input.url,
        credentialChanged: input.credential !== undefined,
      });
      return this.view(client, projectId, repositoryId);
    });
  }

  /** Arquiva o repositório: deixa de poder ser usado em novas etapas; o histórico mantém-se. */
  async archive(actor: User, projectId: string, repositoryId: string, raw: unknown) {
    const input = parseInput(gitRepositoryArchiveSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'repositories.manage',
        true,
      );
      const current = await this.locked(client, projectId, repositoryId);
      if (input.expectedVersion !== Number(current.version))
        throw new DomainError('VERSION_CONFLICT', 'O repositório foi alterado entretanto.', 409);
      await client.query(
        'UPDATE project_git_repositories SET archived=1,version=version+1,updated_by=$3,updated_at=NOW(3) WHERE id=$1 AND project_id=$2',
        [repositoryId, projectId, context.actor.id],
      );
      await this.audit(client, context.actor.id, 'git_repository.archived', {
        projectId,
        repositoryId,
      });
      return this.view(client, projectId, repositoryId);
    });
  }

  /** Remove a cópia cifrada da credencial sem revogar a sessão correspondente no GitHub. */
  async revokeCredential(actor: User, projectId: string, repositoryId: string, raw: unknown) {
    const input = parseInput(gitRepositoryCredentialRevokeSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'repositories.manage',
        true,
      );
      const current = await this.locked(client, projectId, repositoryId);
      if (input.expectedVersion !== Number(current.version))
        throw new DomainError(
          'VERSION_CONFLICT',
          'O repositório foi alterado entretanto. Recarregue antes de remover a credencial.',
          409,
        );
      await client.query(
        `UPDATE project_git_repositories SET credential_ciphertext=NULL,credential_provider='token',
           credential_identity=NULL,verified_at=NULL,verified_base_sha=NULL,verification_error=NULL,
           version=version+1,updated_by=$3,updated_at=NOW(3) WHERE id=$1 AND project_id=$2`,
        [repositoryId, projectId, context.actor.id],
      );
      await this.audit(client, context.actor.id, 'git_repository.credential_revoked', {
        projectId,
        repositoryId,
      });
      return this.view(client, projectId, repositoryId);
    });
  }

  /** Valida a credencial e o acesso GitHub (quando aplicável) e fixa o SHA da branch base. */
  async verify(actor: User, projectId: string, repositoryId: string) {
    const row = await this.db.transaction(async (client) => {
      await requireProjectPermission(client, actor, projectId, 'repositories.manage');
      return this.locked(client, projectId, repositoryId, false);
    });
    this.assertAllowed(row.url);
    let sha: string | null = null;
    let error: string | null = null;
    let credentialIdentity = row.credential_identity;
    try {
      const credential = row.credential_ciphertext
        ? this.cipher.decrypt(
            row.credential_ciphertext,
            repositoryCredentialContext(projectId, repositoryId),
          )
        : null;
      if (row.credential_provider === 'github_cli') {
        if (!credential) throw new Error('GitHub CLI credential is missing; authenticate again.');
        credentialIdentity = (await inspectGitHubCliCredential(row.url, credential)).login;
      }
      sha = await (this.options.probe ?? defaultProbe)(row.url, row.base_branch, credential);
      if (!sha) error = `A branch base ${row.base_branch} não existe no repositório.`;
    } catch (failure) {
      error =
        failure instanceof GitCommandError
          ? failure.message
          : failure instanceof GitHubCliCredentialError
            ? failure.message
            : 'Não foi possível contactar o repositório.';
    }
    await this.db.query(
      `UPDATE project_git_repositories SET verified_at=${sha ? 'NOW(3)' : 'NULL'},
         verified_base_sha=$3,verification_error=$4,credential_identity=$5
         WHERE id=$1 AND project_id=$2`,
      [repositoryId, projectId, sha, error ? error.slice(0, 500) : null, credentialIdentity],
    );
    return this.view(this.db, projectId, repositoryId);
  }

  private assertAllowed(url: string) {
    if (!repositoryUrlAllowed(url, this.options.allowedRoots))
      throw new DomainError(
        'REPOSITORY_NOT_ALLOWED',
        'Este repositório não está nas origens autorizadas para desenvolvimento.',
        400,
      );
  }

  private async locked(client: Queryable, projectId: string, repositoryId: string, lock = true) {
    if (!z.uuid().safeParse(repositoryId).success)
      throw new DomainError('INVALID_INPUT', 'Repositório inválido.', 400);
    const row = (
      await client.query<GitRepositoryRow>(
        `SELECT * FROM project_git_repositories WHERE id=$1 AND project_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [repositoryId, projectId],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'Repositório não encontrado.', 404);
    return row;
  }

  private async view(client: Queryable, projectId: string, repositoryId: string) {
    return repositoryView(await this.locked(client, projectId, repositoryId, false));
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

const defaultProbe = (url: string, branch: string, credential: string | null) =>
  remoteBranchSha(url, branch, { credential });
