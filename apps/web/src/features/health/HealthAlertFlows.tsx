import {
  healthAlertKey,
  type FlowDetail,
  type FlowSummary,
  type HealthAlertFlowLink,
  type HealthCheckView,
} from '@zeroops/contracts';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectAdmin, useProjectSession } from '../../lib/project-admin';

export function useHealthAlertFlows(enabled: boolean) {
  const { request, session } = useProjectSession();
  const projectId = useProjectAdmin()?.project.id ?? session?.user.projectId ?? '';
  const base = `/project-admin/${encodeURIComponent(projectId)}/flows`;
  const links = useResource<HealthAlertFlowLink[]>(
    enabled && projectId ? `${base}/alert-links` : null,
  );
  const flows = useResource<FlowSummary[]>(enabled && projectId ? base : null);
  const mutation = useMutation();

  const link = (alertKey: string, flowId: string | null) =>
    mutation.run(async () => {
      await request(`${base}/alert-links/link`, { method: 'POST', body: { alertKey, flowId } });
      links.reload();
      flows.reload();
    });
  const create = (alertKey: string) =>
    mutation.run(async () => {
      const flow = await request<FlowDetail>(`${base}/alert-links/create`, {
        method: 'POST',
        body: { alertKey },
      });
      window.location.hash = `#flows/${encodeURIComponent(flow.id)}`;
    });

  return {
    enabled,
    loading: enabled && (links.loading || flows.loading),
    links: links.data ?? [],
    published: (flows.data ?? []).filter((flow) => flow.published),
    error: links.error ?? flows.error,
    mutation,
    link,
    create,
  };
}

export type HealthAlertFlowState = ReturnType<typeof useHealthAlertFlows>;

export function HealthCheckFlowControls({
  check,
  state,
}: {
  check: HealthCheckView;
  state: HealthAlertFlowState;
}) {
  const { t } = useIdentityLocale();
  const key = healthAlertKey('check', check.id);
  const association = state.links.find((item) => item.key === key);
  const flowId = association?.flowId ?? '';

  if (!state.enabled)
    return <span className="health-muted">{t('Fluxo por omissão', 'Default flow')}</span>;

  return (
    <select
      aria-label={`${t('Fluxo de', 'Flow for')} ${check.title}`}
      value={flowId}
      disabled={state.loading || state.mutation.busy}
      onChange={(event) => void state.link(key, event.target.value || null)}
    >
      <option value="">{t('Fluxo por omissão de incidentes', 'Default incident flow')}</option>
      {state.published.map((flow) => (
        <option key={flow.id} value={flow.id}>
          {flow.name}
        </option>
      ))}
    </select>
  );
}

export function HealthCheckFlowAction({
  check,
  state,
}: {
  check: HealthCheckView;
  state: HealthAlertFlowState;
}) {
  const { t } = useIdentityLocale();
  const association = state.links.find((item) => item.key === healthAlertKey('check', check.id));

  if (!state.enabled) return null;

  return association?.flowId ? (
    <a
      className="button button-secondary"
      href={`#flows/${encodeURIComponent(association.flowId)}`}
    >
      {t('Editar fluxo', 'Edit flow')}
    </a>
  ) : association?.pendingFlowId ? (
    <a
      className="button button-secondary"
      href={`#flows/${encodeURIComponent(association.pendingFlowId)}`}
      title={t(
        'O alerta só passa a usar este fluxo quando a versão for ativada.',
        'The alert only uses this flow once its version is activated.',
      )}
    >
      {t('Rascunho por ativar', 'Draft pending activation')}
    </a>
  ) : (
    <button
      type="button"
      className="button button-secondary"
      disabled={state.loading || state.mutation.busy}
      onClick={() => void state.create(healthAlertKey('check', check.id))}
    >
      {t('Criar fluxo próprio', 'Create own flow')}
    </button>
  );
}
