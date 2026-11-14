import { useState } from 'react';
import { siteProfiles, type InstanceProject } from '@zeroops/contracts';
import { EmptyState, Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { ProjectLogo, PROJECTS_CHANGED_EVENT } from '../../components/ProjectLogo';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { CreateProjectDialog } from './CreateProjectDialog';

export function InstanceProjectsPage() {
  const { t } = useIdentityLocale();
  const projects = useResource<InstanceProject[]>('/instance/projects');
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title={t('Projetos', 'Projects')}
        description={t(
          'Administre os dados, acessos, integrações e Saúde de cada projeto.',
          'Manage the details, access, integrations and Health of each project.',
        )}
        action={
          <button className="button button-primary" onClick={() => setCreating(true)}>
            {t('Criar projeto', 'Create project')}
          </button>
        }
      />
      {message && <Notice tone="success">{message}</Notice>}
      <section className="panel stack">
        <h2>{t('Projetos da instância', 'Instance projects')}</h2>
        {projects.loading ? (
          <Loading label={t('A carregar projetos…', 'Loading projects…')} />
        ) : projects.error ? (
          <ResourceError error={projects.error} retry={projects.reload} />
        ) : !projects.data?.length ? (
          <EmptyState title={t('Ainda não existem projetos', 'No projects yet')}>
            {t('Use Criar projeto para começar.', 'Use Create project to get started.')}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="identity-table">
              <thead>
                <tr>
                  <th>{t('Projeto', 'Project')}</th>
                  <th>{t('Cliente / organização', 'Client / organization')}</th>
                  <th>{t('Site', 'Site')}</th>
                  <th>{t('Utilizadores', 'Users')}</th>
                  <th>{t('Administradores', 'Administrators')}</th>
                  <th>{t('Estado', 'Status')}</th>
                  <th>{t('Ações', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {projects.data.map((project) => (
                  <tr key={project.id}>
                    <td>
                      <span className="project-name-cell">
                        <ProjectLogo project={project} name={project.name} />
                        <a href={`#projects/${encodeURIComponent(project.id)}/geral`}>
                          {project.name}
                        </a>
                      </span>
                    </td>
                    <td>{project.clientName ?? '—'}</td>
                    <td>{project.siteKey ? siteProfiles[project.siteKey].label : '—'}</td>
                    <td>{project.memberCount}</td>
                    <td>
                      {project.adminCount ?? '—'}
                      {Boolean(project.pendingAdminCount) && (
                        <span className="field-hint">
                          {' '}
                          · {project.pendingAdminCount}{' '}
                          {t('convite(s) pendente(s)', 'pending invitation(s)')}
                        </span>
                      )}
                    </td>
                    <td>{project.archived ? t('Arquivado', 'Archived') : t('Ativo', 'Active')}</td>
                    <td>
                      <a
                        className="text-button"
                        href={`#projects/${encodeURIComponent(project.id)}/geral`}
                      >
                        {t('Administrar', 'Manage')}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && (
        <CreateProjectDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            projects.reload();
            window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
            setMessage(
              t(
                'Projeto criado. O convite do administrador foi colocado na fila de email. Use Administrar para configurar o projeto.',
                'Project created. The administrator invitation was queued for email. Use Manage to configure the project.',
              ),
            );
          }}
        />
      )}
    </>
  );
}
