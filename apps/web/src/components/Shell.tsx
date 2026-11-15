import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Capabilities, ProjectAccess, ProjectPermissionAccess } from '@zeroops/contracts';
import { useSession } from '../lib/session';
import { useResource } from '../lib/hooks';
import { roleLabels } from '../lib/format';
import { Avatar } from './Avatar';
import { useKtDropdowns } from '../lib/ktui';
import { Icon, type IconName } from './Icon';
import { PROJECTS_CHANGED_EVENT, ProjectLogo } from './ProjectLogo';
import { Notice } from './ui';
import { LocaleSwitcher } from './LocaleSwitcher';
import { useIdentityLocale, useIdentityMutation, type Locale } from '../lib/identity';

type NavItem = { route: string; label: string; icon: IconName };

export function Shell({ route, children }: { route: string; children: ReactNode }) {
  const { session, logout, request, completeAuthentication, refresh } = useSession();
  const { t, locale, setLocale } = useIdentityLocale();
  const mutation = useIdentityMutation();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 4);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);
  const capabilities = useResource<Capabilities>('/capabilities');
  const projects = useResource<ProjectAccess[]>('/projects');
  const access = useResource<ProjectPermissionAccess>(
    session ? `/projects/${encodeURIComponent(session.user.projectId)}/access` : null,
    15000,
  );
  const reloadProjects = projects.reload;
  useEffect(() => {
    window.addEventListener(PROJECTS_CHANGED_EVENT, reloadProjects);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, reloadProjects);
  }, [reloadProjects]);
  const main = useRef<HTMLElement>(null);
  const previousRoute = useRef(route);
  useEffect(() => {
    if (previousRoute.current !== route) main.current?.focus();
    previousRoute.current = route;
  }, [route]);
  useKtDropdowns([session?.user.id]);
  if (!session) return null;
  const user = session.user;
  const workspace: NavItem[] = [
    { route: 'dashboard', label: t('Visão geral', 'Overview'), icon: 'grid' },
    { route: 'tickets', label: t('Pedidos', 'Requests'), icon: 'ticket' },
    ...(user.role === 'admin' ||
    user.instanceAdmin ||
    access.data?.permissions.includes('flows.view')
      ? [
          { route: 'flows', label: t('Fluxos', 'Flows'), icon: 'flow' as const },
          {
            route: 'capabilities',
            label: t('Agentes e skills', 'Agents and skills'),
            icon: 'bot' as const,
          },
        ]
      : []),
    { route: 'integrations', label: t('Integrações', 'Integrations'), icon: 'plug' },
  ];
  const administration: NavItem[] = [
    ...(access.data?.permissions.includes('project.permissions.manage')
      ? [
          {
            route: `projects/${encodeURIComponent(user.projectId)}/permissoes`,
            label: t('Permissões do projeto', 'Project permissions'),
            icon: 'users' as const,
          },
        ]
      : []),
    ...(user.role === 'admin' ||
    user.instanceAdmin ||
    access.data?.permissions.includes('repositories.manage')
      ? [
          {
            route: `projects/${encodeURIComponent(user.projectId)}/repositorios`,
            label: t('Repositórios Git', 'Git repositories'),
            icon: 'folder' as const,
          },
          {
            route: `projects/${encodeURIComponent(user.projectId)}/pipelines`,
            label: t('Pipelines de entrega', 'Delivery pipelines'),
            icon: 'flow' as const,
          },
        ]
      : []),
    ...(user.role !== 'client'
      ? [
          { route: 'health', label: t('Saúde', 'Health'), icon: 'pulse' as const },
          {
            route: `projects/${encodeURIComponent(user.projectId)}/operacao`,
            label: t('Operação', 'Operations'),
            icon: 'pulse' as const,
          },
        ]
      : []),
    ...(user.role === 'admin' || user.instanceAdmin
      ? [{ route: 'team', label: t('Equipa e acessos', 'Team and access'), icon: 'users' as const }]
      : []),
    ...(user.instanceAdmin
      ? [{ route: 'instance-projects', label: t('Projetos', 'Projects'), icon: 'folder' as const }]
      : []),
    ...(user.role === 'admin'
      ? [
          {
            route: `projects/${encodeURIComponent(user.projectId)}`,
            label: t('Administrar projeto', 'Manage project'),
            icon: 'folder' as const,
          },
        ]
      : []),
  ];
  const groups = [
    { label: 'Workspace', items: workspace },
    ...(administration.length
      ? [{ label: t('Administração', 'Administration'), items: administration }]
      : []),
  ];
  const links = [...workspace, ...administration];
  const current =
    links.find((item) => route === item.route || route.startsWith(`${item.route}/`)) ??
    (route.startsWith('projects/')
      ? {
          route: user.instanceAdmin
            ? 'instance-projects'
            : `projects/${encodeURIComponent(user.projectId)}`,
          label: t('Administrar projeto', 'Manage project'),
          icon: 'folder' as const,
        }
      : route === 'account'
        ? { route: 'account', label: t('A minha conta', 'My account'), icon: 'user' as const }
        : undefined);
  const activeProject = projects.data?.find((project) => project.id === user.projectId);
  const projectName = activeProject?.name ?? 'Pizza Hut';
  const blocked =
    capabilities.data &&
    (!capabilities.data.investigation ||
      !capabilities.data.implementation ||
      !capabilities.data.deployment);
  // Muda já a interface e grava no perfil, para o idioma se manter noutras sessões.
  const changeLocale = (next: Locale) => {
    const previous = locale;
    setLocale(next);
    void mutation.run(async () => {
      try {
        await request('/account/profile', {
          method: 'POST',
          body: { displayName: user.displayName, locale: next },
        });
        await refresh();
      } catch (cause) {
        setLocale(previous);
        throw cause;
      }
    });
  };

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        {t('Saltar para o conteúdo', 'Skip to content')}
      </a>
      <aside className="sidebar">
        <div className="sidebar-header">
          <a
            className="brand"
            href="#dashboard"
            aria-label={t('ZeroOps, visão geral', 'ZeroOps, overview')}
          >
            <span className="brand-symbol">
              <Icon name="pulse" size={18} />
            </span>
            <span className="brand-name">
              zero<span className="brand-light">ops</span>
            </span>
          </a>
        </div>
        <nav aria-label={t('Navegação principal', 'Main navigation')} className="main-nav">
          {groups.map((group) => (
            <div key={group.label} className="nav-group">
              <p className="nav-caption">{group.label}</p>
              {group.items.map((item) => (
                <a
                  key={item.route}
                  href={`#${item.route}`}
                  className={current?.route === item.route ? 'nav-link active' : 'nav-link'}
                  aria-current={current?.route === item.route ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={18} />
                  <span>{item.label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <ProjectLogo project={activeProject} name={projectName} />
          <div>
            <strong>{projectName}</strong>
            <span>{t('Projeto ativo', 'Active project')}</span>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className={scrolled ? 'topbar topbar-scrolled' : 'topbar'}>
          <nav aria-label="Breadcrumb" className="breadcrumbs">
            <a href="#dashboard" className="breadcrumb-project">
              <ProjectLogo project={activeProject} name={projectName} className="project-mark-sm" />
              {projectName}
            </a>
            <Icon name="chevron" size={12} />
            {route.startsWith('projects/') && user.instanceAdmin && (
              <>
                <a href="#instance-projects">{t('Projetos', 'Projects')}</a>
                <Icon name="chevron" size={12} />
              </>
            )}
            <strong aria-current="page">{current?.label ?? t('Página', 'Page')}</strong>
          </nav>
          <div className="topbar-actions">
            {(projects.data?.length ?? 0) > 1 && (
              <label className="project-select">
                <span className="sr-only">{t('Projeto', 'Project')}</span>
                <select
                  className="kt-select"
                  aria-label={t('Projeto', 'Project')}
                  value={user.projectId}
                  disabled={mutation.busy}
                  onChange={(event) =>
                    void mutation.run(async () => {
                      const response = await request<{
                        status: 'authenticated';
                        user: typeof user;
                        csrfToken: string;
                      }>('/projects/select', {
                        method: 'POST',
                        body: { projectId: event.target.value },
                      });
                      completeAuthentication(response);
                    })
                  }
                >
                  {(projects.data ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <LocaleSwitcher
              locale={locale}
              disabled={mutation.busy}
              label={t('Idioma', 'Language')}
              onChange={changeLocale}
            />
            {user.role !== 'client' && (
              <a
                className="topbar-icon"
                href="#health"
                aria-label={t('Saúde da plataforma', 'Platform health')}
                title={t('Saúde da plataforma', 'Platform health')}
              >
                <Icon name="bell" size={18} />
              </a>
            )}
            <div
              className="user-menu"
              data-kt-dropdown="true"
              data-kt-dropdown-placement="bottom-end"
              data-kt-dropdown-trigger="click"
            >
              <button
                type="button"
                className="user-menu-toggle"
                data-kt-dropdown-toggle="true"
                aria-haspopup="menu"
                aria-label={t('Menu da conta', 'Account menu')}
                title={user.displayName}
              >
                <Avatar
                  name={user.displayName}
                  userId={user.id}
                  avatarVersion={user.avatarVersion ?? null}
                />
              </button>
              <div className="kt-dropdown-menu user-menu-panel" data-kt-dropdown-menu="true">
                <div className="user-menu-header">
                  <Avatar
                    name={user.displayName}
                    userId={user.id}
                    avatarVersion={user.avatarVersion ?? null}
                  />
                  <div>
                    <strong>{user.displayName}</strong>
                    <span>{user.email}</span>
                    <span className="kt-badge kt-badge-sm kt-badge-primary kt-badge-outline">
                      {roleLabels[user.role]}
                    </span>
                  </div>
                </div>
                <div className="kt-dropdown-menu-separator" />
                <a
                  className="kt-dropdown-menu-link"
                  href="#account"
                  data-kt-dropdown-dismiss="true"
                >
                  <Icon name="user" size={16} />
                  {t('A minha conta', 'My account')}
                </a>
                {administration.map((item) => (
                  <a
                    key={item.route}
                    className="kt-dropdown-menu-link"
                    href={`#${item.route}`}
                    data-kt-dropdown-dismiss="true"
                  >
                    <Icon name={item.icon} size={16} />
                    {item.label}
                  </a>
                ))}
                <div className="kt-dropdown-menu-separator" />
                <div className="user-menu-footer">
                  <button
                    type="button"
                    className="kt-btn kt-btn-outline kt-btn-sm w-full"
                    disabled={mutation.busy}
                    onClick={() => void mutation.run(logout)}
                  >
                    <Icon name="logout" size={16} />
                    {t('Terminar sessão', 'Sign out')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </header>
        <main id="main-content" ref={main} tabIndex={-1} className="page-content">
          {access.error && <Notice>{access.error}</Notice>}
          {mutation.error && <Notice>{mutation.error}</Notice>}
          {capabilities.error && (
            <Notice tone="warning">
              {t(
                'Disponibilidade das integrações por confirmar.',
                'Integration availability not yet confirmed.',
              )}{' '}
              {capabilities.error}{' '}
              <button className="text-button" onClick={capabilities.reload}>
                {t('Verificar novamente', 'Check again')}
              </button>
            </Notice>
          )}
          {blocked && (
            <a href="#integrations" className="integration-banner">
              <span className="banner-icon">
                <Icon name="warning" size={18} />
              </span>
              <div>
                <strong>
                  {t(
                    'Automatização com integrações pendentes',
                    'Automation has pending integrations',
                  )}
                </strong>
                <span>
                  {t(
                    'Análise, implementação ou publicação indisponíveis. Consulte os bloqueios antes de aprovar.',
                    'Analysis, implementation or deployment unavailable. Review the blockers before approving.',
                  )}
                </span>
              </div>
              <span className="banner-link">
                {t('Ver estado', 'View status')} <Icon name="arrow" size={16} />
              </span>
            </a>
          )}
          {children}
        </main>
        <footer className="workspace-footer">
          <span>© {new Date().getFullYear()} ZeroOps</span>
          <span>{projectName}</span>
        </footer>
      </div>
    </div>
  );
}
