import { useState } from 'react';
import type { FlowDetail, FlowSummary } from '@zeroops/contracts';
import { EmptyState, Loading, Notice, ResourceError } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectSession } from '../../lib/project-admin';
import { FlowEditor } from './FlowEditor';
import { originLabels } from './flow-labels';

const templates = [
  {
    id: 'blank',
    pt: 'Em branco (descrever ao assistente)',
    en: 'Blank (describe to the assistant)',
  },
  {
    id: 'health',
    pt: 'Saúde (alerta → correção → verificação)',
    en: 'Health (alert → fix → verify)',
  },
  {
    id: 'maintenance',
    pt: 'Manutenção de cliente (análise → aprovação → desenvolvimento → QA)',
    en: 'Client maintenance (analysis → approval → development → QA)',
  },
  { id: 'general', pt: 'Geral (comportamento atual)', en: 'General (current behaviour)' },
] as const;

/** Fluxos do projeto: lista, criação a partir de modelos e editor. `basePath` é a rota da lista. */
export function FlowsTab({ basePath, flowId }: { basePath: string; flowId: string | null }) {
  const go = (id: string | null) => {
    window.location.hash = `${basePath}${id ? `/${encodeURIComponent(id)}` : ''}`;
  };
  if (flowId) return <FlowEditor key={flowId} flowId={flowId} onBack={() => go(null)} />;
  return <FlowList onOpen={go} />;
}

function FlowList({ onOpen }: { onOpen: (id: string) => void }) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const { request } = useProjectSession();
  const flows = useResource<FlowSummary[]>('/flows');
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<(typeof templates)[number]['id']>('blank');
  const mutation = useMutation();
  if (flows.loading) return <Loading label={t('A carregar fluxos…', 'Loading flows…')} />;
  if (flows.error) return <ResourceError error={flows.error} retry={flows.reload} />;
  const list = [...(flows.data ?? [])].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.priority - b.priority,
  );
  const rule = (flow: FlowSummary) => {
    if (flow.isDefault) return t('Por omissão (sem outra regra)', 'Default (no other rule)');
    const parts = [
      ...flow.match.origins.map((origin) => originLabels[origin]?.[lang] ?? origin),
      ...flow.match.categories,
      ...flow.match.environments,
      ...flow.match.priorities,
    ];
    return parts.length ? parts.join(', ') : t('Qualquer ticket', 'Any ticket');
  };
  return (
    <div className="stack flows-list">
      <section className="panel stack">
        <h2>{t('Fluxos de resolução', 'Resolution flows')}</h2>
        <p className="muted">
          {t(
            'Cada ticket novo entra no fluxo publicado cuja regra coincide (menor prioridade primeiro) ou no fluxo por omissão, e fica associado a essa versão até terminar.',
            'Each new ticket enters the published flow whose rule matches (lowest priority first) or the default flow, and stays on that version until it ends.',
          )}
        </p>
        {list.length ? (
          <table className="flow-table">
            <thead>
              <tr>
                <th>{t('Fluxo', 'Flow')}</th>
                <th>{t('Aplica-se a', 'Applies to')}</th>
                <th>{t('Prioridade', 'Priority')}</th>
                <th>{t('Versão publicada', 'Published version')}</th>
                <th>{t('Tickets em curso', 'Tickets in progress')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((flow) => (
                <tr key={flow.id}>
                  <td>
                    <button type="button" className="link-button" onClick={() => onOpen(flow.id)}>
                      {flow.name}
                    </button>
                    {flow.draftChanged && (
                      <span className="flow-chip">
                        {t('rascunho por publicar', 'unpublished draft')}
                      </span>
                    )}
                  </td>
                  <td>
                    {flow.alertKeys.length
                      ? t(
                          `Usado por ${flow.alertKeys.length} alerta${flow.alertKeys.length > 1 ? 's' : ''}`,
                          `Used by ${flow.alertKeys.length} alert${flow.alertKeys.length > 1 ? 's' : ''}`,
                        )
                      : rule(flow)}
                  </td>
                  <td>{flow.isDefault ? '—' : flow.priority}</td>
                  <td>{flow.published ? `v${flow.published.number}` : t('nenhuma', 'none')}</td>
                  <td>{flow.activeExecutions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState icon="settings" title={t('Sem fluxos.', 'No flows.')}>
            {t('Crie o primeiro fluxo abaixo.', 'Create the first flow below.')}
          </EmptyState>
        )}
      </section>
      <form
        className="panel stack"
        onSubmit={(event) => {
          event.preventDefault();
          void mutation.run(async () => {
            const created = await request<FlowDetail>('/flows', {
              method: 'POST',
              body: { name: name.trim(), template },
            });
            onOpen(created.id);
          });
        }}
      >
        <h3>{t('Novo fluxo', 'New flow')}</h3>
        <label>
          {t('Nome', 'Name')}
          <input
            value={name}
            minLength={2}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {t('Começar a partir de', 'Start from')}
          <select
            value={template}
            onChange={(event) => setTemplate(event.target.value as typeof template)}
          >
            {templates.map((item) => (
              <option key={item.id} value={item.id}>
                {item[lang]}
              </option>
            ))}
          </select>
        </label>
        {mutation.error && <Notice>{mutation.error}</Notice>}
        <button className="button button-primary align-start" disabled={mutation.busy}>
          {t('Criar fluxo', 'Create flow')}
        </button>
      </form>
    </div>
  );
}
