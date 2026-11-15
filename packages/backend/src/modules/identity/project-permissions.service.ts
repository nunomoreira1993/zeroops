import { randomUUID } from 'node:crypto';
import {
  delegableProjectPermissions,
  projectPermissionKeys,
  projectPermissionUpdateSchema,
  type ProjectPermission,
  type ProjectPermissionAccess,
  type ProjectPermissionsView,
  type Role,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { parseInput } from './identity.validation.js';
import {
  parseProjectPermissions,
  projectPermissionContext,
  requireProjectPermission,
} from './project-permissions.js';
import type { Queryable } from './membership.js';

/** Gestão de grants por projeto, sem elevação de papéis nem revogação em cascata. */
export class ProjectPermissionsService {
  constructor(private readonly db: Database) {}

  /** Contexto mínimo do projeto e capacidades atuais, sem contas, integrações ou segredos. */
  async access(actor: User, projectId: string): Promise<ProjectPermissionAccess> {
    const { project, permissions, isAdmin } = await projectPermissionContext(
      this.db,
      actor,
      projectId,
    );
    return { project, permissions, isAdmin };
  }

  /** Lista os grants e limites de gestão numa revisão consistente do projeto. */
  async list(actor: User, projectId: string): Promise<ProjectPermissionsView> {
    return this.db.transaction((client) => this.view(client, actor, projectId));
  }

  /** Aplica diferenças de grants sob revisão/locks, auditando ator, destinatário e projeto. */
  async update(actor: User, projectId: string, raw: unknown): Promise<ProjectPermissionsView> {
    const input = parseInput(projectPermissionUpdateSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'project.permissions.manage',
        true,
      );
      const target = (
        await client.query<{ role: Role; instance_admin: boolean }>(
          `SELECT m.role,u.instance_admin FROM project_memberships m JOIN users u ON u.id=m.user_id
           WHERE m.user_id=$1 AND m.project_id=$2 AND NOT m.disabled AND NOT u.disabled
           LOCK IN SHARE MODE`,
          [input.userId, projectId],
        )
      ).rows[0];
      if (!target) throw new DomainError('NOT_FOUND', 'Membro indisponível neste projeto.', 404);
      if (
        !context.isAdmin &&
        (input.userId === actor.id || target.role === 'admin' || target.instance_admin)
      )
        throw new DomainError(
          'FORBIDDEN',
          'Um delegado não pode gerir as próprias permissões ou administradores.',
          403,
        );
      if (context.project.version !== input.expectedVersion)
        throw new DomainError('STALE_VERSION', 'O projeto mudou. Recarregue as permissões.', 409);
      const before = parseProjectPermissions(
        (
          await client.query<{ permission: string }>(
            'SELECT permission FROM project_permission_grants WHERE user_id=$1 AND project_id=$2 ORDER BY permission',
            [input.userId, projectId],
          )
        ).rows,
      );
      const granted = input.permissions.filter((key) => !before.includes(key));
      const revoked = before.filter((key) => !input.permissions.includes(key));
      const changed = [...granted, ...revoked];
      if (
        !context.isAdmin &&
        changed.some(
          (key) => !delegableProjectPermissions.includes(key) || !context.permissions.includes(key),
        )
      )
        throw new DomainError('FORBIDDEN', 'Não pode delegar ou revogar estas permissões.', 403);
      if (changed.length) {
        for (const key of revoked)
          await client.query(
            'DELETE FROM project_permission_grants WHERE user_id=$1 AND project_id=$2 AND permission=$3',
            [input.userId, projectId, key],
          );
        for (const key of granted)
          await client.query(
            'INSERT INTO project_permission_grants(user_id,project_id,permission,granted_by) VALUES($1,$2,$3,$4)',
            [input.userId, projectId, key, actor.id],
          );
        await client.query('UPDATE projects SET version=version+1 WHERE id=$1', [projectId]);
        await client.query(
          'INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,$3,$4)',
          [
            randomUUID(),
            actor.id,
            'identity.project.permissions.changed',
            {
              projectId,
              userId: input.userId,
              before,
              after: input.permissions,
              granted,
              revoked,
              version: context.project.version + 1,
            },
          ],
        );
      }
      return this.view(client, actor, projectId);
    });
  }

  private async view(
    client: Queryable,
    actor: User,
    projectId: string,
  ): Promise<ProjectPermissionsView> {
    const context = await requireProjectPermission(
      client,
      actor,
      projectId,
      'project.permissions.manage',
      true,
    );
    const members = (
      await client.query<{
        id: string;
        display_name: string;
        role: Role;
        instance_admin: boolean;
      }>(
        `SELECT u.id,u.display_name,m.role,u.instance_admin FROM project_memberships m
         JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 AND NOT m.disabled AND NOT u.disabled
         ORDER BY u.display_name,u.id`,
        [projectId],
      )
    ).rows;
    const grants = (
      await client.query<{ user_id: string; permission: string }>(
        'SELECT user_id,permission FROM project_permission_grants WHERE project_id=$1 ORDER BY permission',
        [projectId],
      )
    ).rows;
    const assignablePermissions: ProjectPermission[] = context.isAdmin
      ? [...projectPermissionKeys]
      : delegableProjectPermissions.filter((key) => context.permissions.includes(key));
    return {
      projectId,
      version: context.project.version,
      assignablePermissions,
      members: members.map((member) => {
        const isAdmin = Boolean(member.instance_admin || member.role === 'admin');
        return {
          id: member.id,
          displayName: member.display_name,
          role: member.role,
          isAdmin,
          canManage: context.isAdmin || (!isAdmin && member.id !== actor.id),
          permissions: parseProjectPermissions(grants.filter((row) => row.user_id === member.id)),
        };
      }),
    };
  }
}
