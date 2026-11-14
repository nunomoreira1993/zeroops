import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { InstanceProject } from '@zeroops/contracts';
import type { RequestOptions } from './api';
import { useSession } from './session';

interface ProjectAdminContext {
  project: InstanceProject;
}

const ProjectAdminContext = createContext<ProjectAdminContext | null>(null);

/** Only administrative endpoints can use the explicit project boundary. */
export function projectAdminPath(projectId: string, path: string): string {
  const pathname = path.split('?')[0] ?? '';
  const scoped =
    /^\/users(?:\/[^/]+(?:\/action)?)?$/.test(pathname) ||
    /^\/invitations(?:\/[^/]+\/action)?$/.test(pathname) ||
    pathname === '/auth/invite' ||
    /^\/agent-profiles(?:\/repository-resources|\/[^/]+\/(?:versions|archive))?$/.test(pathname) ||
    /^\/integration-settings(?:\/[^/]+(?:\/(?:test|revoke))?)?$/.test(pathname) ||
    /^\/agent\/(?:instructions|settings|relay(?:\/token)?)$/.test(pathname) ||
    /^\/monitoring(?:\/(?:settings|agent-token))?$/.test(pathname) ||
    /^\/flows(?:\/[^/]+(?:\/[a-z-]+(?:\/[^/]+(?:\/[a-z]+)?)?)?)?$/.test(pathname) ||
    pathname === '/account/reauth';
  return scoped ? `/project-admin/${encodeURIComponent(projectId)}${path}` : path;
}

/** The project supplied here has already been authorized by the detail endpoint. */
export function ProjectAdminProvider({
  project,
  children,
}: {
  project: InstanceProject;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ project }), [project]);
  return <ProjectAdminContext.Provider value={value}>{children}</ProjectAdminContext.Provider>;
}

export function useProjectAdmin() {
  return useContext(ProjectAdminContext);
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
