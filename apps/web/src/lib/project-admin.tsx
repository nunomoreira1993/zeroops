import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { projectPermissionKeys, type Project, type ProjectPermission } from '@zeroops/contracts';
import type { RequestOptions } from './api';
import { useSession } from './session';

interface ProjectAdminContext {
  project: Project;
  permissions: readonly ProjectPermission[];
}

const ProjectAdminContext = createContext<ProjectAdminContext | null>(null);

/** Scopes supported administrative and functional routes to an explicit project. */
export function projectAdminPath(projectId: string, path: string): string {
  const pathname = path.split('?')[0] ?? '';
  const scoped =
    /^\/users(?:\/[^/]+(?:\/action)?)?$/.test(pathname) ||
    /^\/invitations(?:\/[^/]+\/action)?$/.test(pathname) ||
    pathname === '/auth/invite' ||
    /^\/agent-profiles(?:\/repository-resources|\/import|\/[^/]+\/(?:versions|archive))?$/.test(
      pathname,
    ) ||
    /^\/skills(?:\/import|\/[^/]+\/(?:versions|archive|bindings))?$/.test(pathname) ||
    /^\/capability-shares(?:\/[^/]+\/(?:revoke|adopt))?$/.test(pathname) ||
    /^\/integration-settings(?:\/[^/]+(?:\/(?:test|revoke))?)?$/.test(pathname) ||
    /^\/agent\/(?:instructions|settings|relay(?:\/token)?)$/.test(pathname) ||
    /^\/monitoring(?:\/(?:settings|agent-token))?$/.test(pathname) ||
    /^\/flows(?:\/[^/]+(?:\/[a-z-]+(?:\/[^/]+(?:\/[a-z]+)?)?)?)?$/.test(pathname) ||
    /^\/flows\/[^/]+\/authoring\/operations\/[^/]+\/undo$/.test(pathname) ||
    pathname === '/account/reauth';
  return scoped ? `/project-admin/${encodeURIComponent(projectId)}${path}` : path;
}

/**
 * Receives an authorized project. Functional views supply explicit capabilities;
 * the default is reserved for callers of the administrative detail endpoint.
 */
export function ProjectAdminProvider({
  project,
  permissions = projectPermissionKeys,
  children,
}: {
  project: Project;
  permissions?: readonly ProjectPermission[];
  children: ReactNode;
}) {
  const value = useMemo(() => ({ project, permissions }), [project, permissions]);
  return <ProjectAdminContext.Provider value={value}>{children}</ProjectAdminContext.Provider>;
}

export function useProjectAdmin() {
  return useContext(ProjectAdminContext);
}

/** Capacidade da vista autorizada; o backend revalida os grants em cada operação. */
export function useProjectPermission(permission: ProjectPermission): boolean {
  const context = useProjectAdmin();
  const { session } = useSession();
  return context
    ? context.permissions.includes(permission)
    : Boolean(session?.user.role === 'admin' || session?.user.instanceAdmin);
}

export function useProjectSession(): ReturnType<typeof useSession> {
  const session = useSession();
  const context = useProjectAdmin();
  const projectId = context?.project.id;
  const originalRequest = session.request;
  const request = useCallback(
    <T,>(path: string, options?: RequestOptions) =>
      originalRequest<T>(projectId ? projectAdminPath(projectId, path) : path, options),
    [projectId, originalRequest],
  );
  return useMemo(
    () => (projectId ? { ...session, request } : session),
    [session, request, projectId],
  );
}
