import type { InstanceProject } from '@zeroops/contracts';
import { Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { ProjectAdminProvider } from '../../lib/project-admin';
import { FlowsTab } from './FlowsTab';

export const FLOWS_ROUTE = 'flows';

/** `flows` ou `flows/<id>`; devolve o fluxo aberto, ou null na lista. */
export function parseFlowsRoute(route: string): string | null {
  const [, id] = route.split('/');
  return id ? decodeURIComponent(id) : null;
}

/** Fluxos de resolução do projeto ativo, acessíveis a partir do menu lateral. */
export function FlowsPage({ projectId, flowId }: { projectId: string; flowId: string | null }) {
  const { t } = useIdentityLocale();
  const resource = useResource<InstanceProject>(`/project-admin/${encodeURIComponent(projectId)}`);
  const project = resource.data;
  return (
    <div className="stack flows-page">
      {!flowId && (
        <PageHeader
          title={t('Fluxos de resolução', 'Resolution flows')}
          description={t(
            'Processo que cada pedido do projeto ativo segue, da entrada até à conclusão.',
            'Process each request of the active project follows, from intake to completion.',
          )}
        />
      )}
      {resource.loading ? (
        <Loading label={t('A carregar projeto…', 'Loading project…')} />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : !project || project.id !== projectId ? (
        <Notice>{t('Projeto indisponível.', 'Project unavailable.')}</Notice>
      ) : (
        <ProjectAdminProvider key={project.id} project={project}>
          <FlowsTab basePath={FLOWS_ROUTE} flowId={flowId} />
        </ProjectAdminProvider>
      )}
    </div>
  );
}
