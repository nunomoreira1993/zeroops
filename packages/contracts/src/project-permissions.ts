import { z } from 'zod';
import type { Project, Role } from './index.js';

export const projectPermissionKeys = [
  'flows.view',
  'flows.edit',
  'flows.simulate',
  'flows.activate',
  'agents.manage',
  'skills.manage',
  'repositories.manage',
  'capabilities.develop',
  'capabilities.publish',
  'project.permissions.manage',
] as const;
export const projectPermissionSchema = z.enum(projectPermissionKeys);
export type ProjectPermission = z.infer<typeof projectPermissionSchema>;
export const delegableProjectPermissions: readonly ProjectPermission[] =
  projectPermissionKeys.filter((key) => key !== 'project.permissions.manage');

export const projectPermissionUpdateSchema = z.strictObject({
  userId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(),
  permissions: z
    .array(projectPermissionSchema)
    .max(projectPermissionKeys.length)
    .refine((values) => new Set(values).size === values.length, 'Permissões repetidas.'),
});

export interface ProjectPermissionAccess {
  project: Project & { version: number };
  permissions: ProjectPermission[];
  isAdmin: boolean;
}

export interface ProjectPermissionsView {
  projectId: string;
  version: number;
  assignablePermissions: ProjectPermission[];
  members: {
    id: string;
    displayName: string;
    role: Role;
    isAdmin: boolean;
    canManage: boolean;
    permissions: ProjectPermission[];
  }[];
}
