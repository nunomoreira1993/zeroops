import { useState } from 'react';
import {
  siteKeys,
  siteProfiles,
  type HealthOverview,
  type InstanceProject,
  type SiteKey,
} from '@zeroops/contracts';
import { PROJECTS_CHANGED_EVENT, ProjectLogo } from '../../components/ProjectLogo';
import { Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { ProjectAdminProvider, useProjectSession } from '../../lib/project-admin';
import { useSession } from '../../lib/session';
import { ReauthDialog } from '../auth/IdentityForms';
import { HealthSettingsForm } from '../health/HealthSettingsForm';
import { HealthTabBar } from '../health/HealthTabs';
import { FlowsTab } from '../flows/FlowsTab';
import { AgentSettingsPanel } from '../integrations/AgentSettingsPanel';
import { IntegrationSettingsPanel } from '../integrations/IntegrationSettingsPanel';
import { TeamPage } from '../team/TeamPage';
import { ProjectLogoField } from './ProjectLogoField';

export type ProjectAdminTab = 'geral' | 'utilizadores' | 'integracoes' | 'saude' | 'fluxos';
const tabIds: ProjectAdminTab[] = ['geral', 'utilizadores', 'integracoes', 'saude', 'fluxos'];

export function parseProjectAdminRoute(route: string) {
  const [, id, tab, sub] = route.split('/');
  return {
    id: id ?? '',
    tab: tabIds.includes(tab as ProjectAdminTab) ? (tab as ProjectAdminTab) : 'geral',
    sub: sub ? decodeURIComponent(sub) : null,
  };
}

export function ProjectAdminPage({
  id,
  tab = 'geral',
  sub = null,
}: {
  id: string;
  tab?: ProjectAdminTab;
  sub?: string | null;
}) {
  return <ProjectDetail key={id} id={id} tab={tab} sub={sub} />;
}

function ProjectDetail({ id, tab, sub }: { id: string; tab: ProjectAdminTab; sub: string | null }) {
  const { t } = useIdentityLocale();
  const { session } = useSession();
  const resource = useResource<InstanceProject>(`/project-admin/${encodeURIComponent(id)}`);
  const [saved, setSaved] = useState(false);
  if (resource.loading) return <Loading label={t('A carregar projeto…', 'Loading project…')} />;
  if (resource.error) return <ResourceError error={resource.error} retry={resource.reload} />;
  const project = resource.data;
  if (!project || project.id !== id)
    return <Notice>{t('Projeto indisponível.', 'Project unavailable.')}</Notice>;
  const tabs = [
    { id: 'geral' as const, label: t('Geral', 'General') },
    { id: 'utilizadores' as const, label: t('Utilizadores e acessos', 'Users and access') },
    {
      id: 'integracoes' as const,
      label: t('Parâmetros e integrações', 'Parameters and integrations'),
    },
    { id: 'saude' as const, label: t('Saúde e notificações', 'Health and notifications') },
    { id: 'fluxos' as const, label: t('Fluxos de resolução', 'Resolution flows') },
  ];
  return (
    <ProjectAdminProvider key={project.id} project={project}>
      <div className="project-admin stack">
        <PageHeader
          title={t('Administrar projeto', 'Manage project')}
          description={t(
            'Configuração explícita deste projeto, sem mudar o projeto ativo da sessão.',
            'Explicit settings for this project without switching the active session project.',
          )}
          action={
            <a
              className="button button-secondary"
              href={session?.user.instanceAdmin ? '#instance-projects' : '#dashboard'}
            >
              {session?.user.instanceAdmin
                ? t('Voltar aos projetos', 'Back to projects')
                : t('Voltar ao projeto ativo', 'Back to active project')}
            </a>
          }
        />
        {saved && (
          <Notice tone="success">
            {t('Projeto atualizado e alteração auditada.', 'Project updated and change audited.')}
          </Notice>
        )}
        <header className="panel project-admin-heading">
          <ProjectLogo project={project} name={project.name} />
          <div>
            <h2>{project.name}</h2>
            <p>{project.clientName || t('Cliente por configurar', 'Client not configured')}</p>
          </div>
          <span
            className={`status-badge ${project.archived ? 'status-blocked' : 'status-resolved'}`}
          >
            {project.archived ? t('Arquivado', 'Archived') : t('Ativo', 'Active')}
          </span>
        </header>
        <HealthTabBar
          tabs={tabs}
          active={tab}
          onSelect={(next) => {
            window.location.hash = `projects/${encodeURIComponent(id)}/${next}`;
          }}
          idPrefix="project-admin"
          label={t('Administração do projeto', 'Project administration')}
        />
        <div
          key={`${project.id}:${tab}`}
          id={`project-admin-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`project-admin-tab-${tab}`}
          className="stack project-admin-tabpanel"
        >
          {tab === 'geral' && (
            <ProjectGeneralForm
              key={project.version}
              project={project}
              onSaved={() => {
                setSaved(true);
                resource.reload();
              }}
            />
          )}
          {tab === 'utilizadores' && <TeamPage />}
          {tab === 'integracoes' && (
            <>
              <IntegrationSettingsPanel />
              <AgentSettingsPanel />
            </>
          )}
          {tab === 'saude' && (
            <div className="stack health-page">
              <ProjectHealthSettings />
            </div>
          )}
          {tab === 'fluxos' && (
            <FlowsTab basePath={`projects/${encodeURIComponent(project.id)}/fluxos`} flowId={sub} />
          )}
        </div>
      </div>
    </ProjectAdminProvider>
  );
}

function ProjectGeneralForm({
  project,
  onSaved,
}: {
  project: InstanceProject;
  onSaved: () => void;
}) {
  const { session, request } = useProjectSession();
  const { t } = useIdentityLocale();
  const [pending, setPending] = useState<{
    name: string;
    clientName: string;
    siteKey: SiteKey | null;
    reason: string;
    archived?: boolean;
  } | null>(null);
  const lifecycle = pending?.archived !== undefined;
  return (
    <>
      <section className="panel stack">
        <h2>{t('Dados do projeto', 'Project details')}</h2>
        <p>
          {t('Administradores ativos', 'Active administrators')}: {project.adminCount ?? '—'}
          {' · '}
          {t('Convites de administrador pendentes', 'Pending administrator invitations')}:{' '}
          {project.pendingAdminCount ?? '—'}
        </p>
        <p className="muted">
          {t(
            'O projeto pode ter vários administradores. Um convite pendente não conta como administrador ativo.',
            'The project can have multiple administrators. Pending invitations do not count as active administrators.',
          )}
        </p>
        <ProjectLogoField project={project} onChanged={onSaved} />
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setPending({
              name: String(data.get('name') ?? '').trim(),
              clientName: String(data.get('clientName') ?? '').trim(),
              siteKey: siteKeys.find((key) => key === data.get('siteKey')) ?? null,
              reason: String(data.get('reason') ?? '').trim(),
            });
          }}
        >
          <label>
            {t('Nome do projeto', 'Project name')}
            <input name="name" required minLength={2} maxLength={50} defaultValue={project.name} />
          </label>
          <label>
            {t('Organização / cliente', 'Organization / client')}
            <input
              name="clientName"
              required
              minLength={2}
              maxLength={200}
              defaultValue={project.clientName ?? ''}
            />
          </label>
          <label>
            {t('Site', 'Site')}
            <select name="siteKey" defaultValue={project.siteKey ?? ''}>
              <option value="">{t('Sem site', 'No site')}</option>
              {siteKeys.map((key) => (
                <option key={key} value={key}>
                  {siteProfiles[key].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Motivo', 'Reason')}
            <textarea name="reason" required minLength={10} maxLength={1000} />
          </label>
          <button className="button button-primary align-start">
            {t('Confirmar alteração', 'Confirm change')}
          </button>
        </form>
      </section>
      {session?.user.instanceAdmin && (
        <section className="panel stack project-admin-lifecycle">
          <h2>
            {project.archived
              ? t('Reativar projeto', 'Reactivate project')
              : t('Arquivar projeto', 'Archive project')}
          </h2>
          <p>
            {t(
              'Arquivar preserva os dados, revoga convites e sessões do projeto e bloqueia o acesso. Execuções e releases têm de estar reconciliadas.',
              'Archiving preserves data, revokes project invitations and sessions, and blocks access. Runs and releases must be reconciled first.',
            )}
          </p>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setPending({
                name: project.name,
                clientName: project.clientName ?? '',
                siteKey: project.siteKey,
                reason: String(data.get('reason') ?? '').trim(),
                archived: !project.archived,
              });
            }}
          >
            <label>
              {t('Motivo da alteração de estado', 'Reason for status change')}
              <textarea name="reason" required minLength={10} maxLength={1000} />
            </label>
            <button className="button button-secondary align-start">
              {project.archived
                ? t('Confirmar reativação', 'Confirm reactivation')
                : t('Confirmar arquivo', 'Confirm archive')}
            </button>
          </form>
        </section>
      )}
      {pending && (
        <ReauthDialog
          action="project-update"
          target={project.id}
          title={
            lifecycle
              ? pending.archived
                ? t('Confirmar arquivo do projeto', 'Confirm project archive')
                : t('Confirmar reativação do projeto', 'Confirm project reactivation')
              : t('Confirmar alteração do projeto', 'Confirm project change')
          }
          onClose={() => setPending(null)}
          onConfirm={async (confirmationToken) => {
            await request(`/project-admin/${encodeURIComponent(project.id)}`, {
              method: 'POST',
              body: { ...pending, expectedVersion: project.version, confirmationToken },
            });
            setPending(null);
            window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
            onSaved();
          }}
        />
      )}
    </>
  );
}

function ProjectHealthSettings() {
  const { t } = useIdentityLocale();
  const overview = useResource<HealthOverview>('/monitoring');
  const [message, setMessage] = useState(false);
  if (overview.loading) return <Loading />;
  if (overview.error) return <ResourceError error={overview.error} retry={overview.reload} />;
  if (!overview.data) return null;
  return (
    <>
      {message && <Notice tone="success">{t('Configuração gravada.', 'Settings saved.')}</Notice>}
      {overview.data.canManage ? (
        <HealthSettingsForm
          overview={overview.data}
          onSaved={() => {
            setMessage(true);
            overview.reload();
          }}
        />
      ) : (
        <Notice tone="info">
          {t(
            'Sem permissão para configurar a Saúde.',
            'No permission to configure health settings.',
          )}
        </Notice>
      )}
    </>
  );
}
