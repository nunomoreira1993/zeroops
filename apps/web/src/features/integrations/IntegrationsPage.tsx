import type { Capabilities } from '@zeroops/contracts';
import { Icon, type IconName } from '../../components/Icon';
import { Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { IntegrationSettingsPanel } from './IntegrationSettingsPanel';
import { AgentSettingsPanel } from './AgentSettingsPanel';

const integrations: {
  key: 'investigation' | 'implementation' | 'deployment';
  title: string;
  description: string;
  icon: IconName;
}[] = [
  {
    key: 'investigation',
    title: 'Investigação assistida',
    description: 'Acesso controlado ao contexto técnico necessário para investigar cada pedido.',
    icon: 'search',
  },
  {
    key: 'implementation',
    title: 'Execução técnica',
    description: 'Ambiente de execução validado para implementar apenas a proposta aprovada.',
    icon: 'code',
  },
  {
    key: 'deployment',
    title: 'Publicação automática',
    description: 'Depende do pipeline e das aprovações definidos no fluxo associado ao pedido.',
    icon: 'external',
  },
];

export function IntegrationsPage() {
  const resource = useResource<Capabilities>('/capabilities');
  return (
    <>
      <PageHeader
        title="Integrações"
        description="Estado dos gates globais de automação; este estado não representa a disponibilidade da sua conta."
        action={
          <button
            className="button button-secondary"
            onClick={resource.reload}
            disabled={resource.loading}
          >
            <Icon name="refresh" size={17} /> Atualizar estado
          </button>
        }
      />
      {resource.loading && <Loading />}
      {resource.error && <ResourceError error={resource.error} retry={resource.reload} />}
      {resource.data && (
        <>
          <div className="integration-grid">
            {integrations.map((item) => (
              <article className="panel integration-card" key={item.key}>
                <div className="integration-card-top">
                  <span className="feature-icon">
                    <Icon name={item.icon} size={24} />
                  </span>
                  <span
                    className={`status-badge ${resource.data?.[item.key] ? 'status-resolved' : 'status-blocked'}`}
                  >
                    <span />
                    {resource.data?.[item.key] ? 'Gate aberto' : 'Gate fechado'}
                  </span>
                </div>
                <h2>{item.title}</h2>
                <p>{item.description}</p>
                <div className="integration-card-note">
                  <Icon name={resource.data?.[item.key] ? 'check' : 'warning'} size={16} />
                  {resource.data?.[item.key]
                    ? 'Capacidade confirmada pelo serviço.'
                    : 'O serviço mantém este gate fechado em modo seguro; consulte os conectores abaixo.'}
                </div>
              </article>
            ))}
          </div>
          {resource.data.blockers.length > 0 && (
            <section className="panel blockers-panel">
              <div className="section-heading">
                <span className="feature-icon feature-amber">
                  <Icon name="warning" />
                </span>
                <div>
                  <h2>O que precisa de atenção</h2>
                  <p>Bloqueios comunicados pelo serviço. Não representam execuções concluídas.</p>
                </div>
              </div>
              <ul className="blocker-list">
                {resource.data.blockers.map((blocker, index) => (
                  <li key={`${index}-${blocker}`}>{blocker}</li>
                ))}
              </ul>
            </section>
          )}
          <IntegrationSettingsPanel />
          <AgentSettingsPanel />
          <Notice tone="info">
            As aprovações não substituem a validação da infraestrutura. Uma ação bloqueada mantém o
            pedido pendente; não existe publicação simulada nem contorno de aprovações.
          </Notice>
        </>
      )}
    </>
  );
}
