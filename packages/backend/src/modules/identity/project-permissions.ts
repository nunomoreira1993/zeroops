import { z } from 'zod';
import {
  projectPermissionKeys,
  projectPermissionSchema,
  type ProjectPermission,
  type ProjectPermissionAccess,
  type User,
} from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import { toUser, type UserRow } from './identity.rows.js';
import { validateActor, type Queryable } from './membership.js';

export interface ProjectPermissionContext extends ProjectPermissionAccess {
  actor: User;
}

/** Valida grants persistidos; dados desconhecidos não concedem nem ocultam permissões. */
export function parseProjectPermissions(rows: { permission: string }[]): ProjectPermission[] {
  return rows.map((row) => {
    const parsed = projectPermissionSchema.safeParse(row.permission);
    if (!parsed.success)
      throw new DomainError('PROJECT_PERMISSIONS_INVALID', 'Permissões do projeto inválidas.', 500);
    return parsed.data;
  });
}

/**
 * Resolve permissões atuais sem promover o papel do membro nem alterar a sessão.
 * Em mutações, o lock de projeto serializa grants/revogação com a operação autorizada.
 */
export async function projectPermissionContext(
  db: Queryable,
  actor: User,
  projectId: string,
  lock = false,
): Promise<ProjectPermissionContext> {
  validateActor(actor);
  if (!z.uuid().safeParse(projectId).success)
    throw new DomainError('INVALID_INPUT', 'Projeto inválido.', 400);
  const project = (
    await db.query<ProjectPermissionAccess['project']>(
      `SELECT id,name,archived,version,
        CASE WHEN logo_mime IS NULL THEN NULL ELSE logo_version END AS "logoVersion"
       FROM projects WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [projectId],
    )
  ).rows[0];
  if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Projeto não encontrado.', 404);
  const row = (
    await db.query<UserRow & { membership_role: User['role'] | null }>(
      `SELECT u.*,COALESCE(m.role,u.role) AS role,
        CASE WHEN m.user_id IS NULL THEN u.organization ELSE m.organization END AS organization,
        m.role AS membership_role
       FROM users u LEFT JOIN project_memberships m ON m.user_id=u.id AND m.project_id=$2
       WHERE u.id=$1 AND NOT u.disabled
         AND (u.instance_admin OR (m.user_id IS NOT NULL AND NOT m.disabled))
       ${lock ? 'LOCK IN SHARE MODE' : ''}`,
      [actor.id, projectId],
    )
  ).rows[0];
  if (!row) throw new DomainError('FORBIDDEN', 'Sem acesso a este projeto.', 403);
  if (project.archived)
    throw new DomainError('PROJECT_ARCHIVED', 'Reative o projeto antes de continuar.', 409);
  const isAdmin = Boolean(row.instance_admin || row.membership_role === 'admin');
  const permissions = isAdmin
    ? [...projectPermissionKeys]
    : parseProjectPermissions(
        (
          await db.query<{ permission: string }>(
            `SELECT permission FROM project_permission_grants WHERE user_id=$1 AND project_id=$2
             ORDER BY permission${lock ? ' LOCK IN SHARE MODE' : ''}`,
            [actor.id, projectId],
          )
        ).rows,
      );
  // As capacidades que usam o editor podem ler o fluxo, sem ganhar outras operações.
  if (
    permissions.some(
      (key) =>
        key.startsWith('flows.') ||
        key.startsWith('capabilities.') ||
        key === 'agents.manage' ||
        key === 'skills.manage',
    ) &&
    !permissions.includes('flows.view')
  )
    permissions.push('flows.view');
  return {
    project: { ...project, version: Number(project.version) },
    permissions,
    isAdmin,
    actor: { ...toUser(row), projectId },
  };
}

/** Exige uma capacidade atual no projeto, revalidada na mesma transação da mutação. */
export async function requireProjectPermission(
  db: Queryable,
  actor: User,
  projectId: string,
  permission: ProjectPermission,
  lock = false,
): Promise<ProjectPermissionContext> {
  const context = await projectPermissionContext(db, actor, projectId, lock);
  if (!context.permissions.includes(permission))
    throw new DomainError('FORBIDDEN', `Sem permissão ${permission} neste projeto.`, 403);
  return context;
}

/**
 * Revalida uma permissão de OUTRO utilizador (ex.: quem autorizou uma publicação) sem sessão:
 * conta desativada, pertença removida ou grant revogado devolvem false.
 */
export async function userHasProjectPermission(
  db: Queryable,
  userId: string,
  projectId: string,
  permission: ProjectPermission,
): Promise<boolean> {
  const row = (await db.query<UserRow>('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
  if (!row) return false;
  try {
    const context = await projectPermissionContext(db, toUser(row), projectId);
    return context.permissions.includes(permission);
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}
