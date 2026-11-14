import type { IntegrationKind } from '@zeroops/contracts';
import type { IconName } from '../../components/Icon';

export interface IntegrationCatalogEntry {
  label: { pt: string; en: string };
  purpose: { pt: string; en: string };
  /** Explica o que cada ambiente significa nas integrações com Qualidade/Produção. */
  environments?: { quality: { pt: string; en: string }; production: { pt: string; en: string } };
  icon: IconName;
  /** Falso quando ainda não existe conector real: guardar é possível, testar não. */
  connector: boolean;
}

/** Textos e metadados de apresentação das integrações, separados da lógica do formulário. */
export const integrationCatalog: Record<IntegrationKind, IntegrationCatalogEntry> = {
  smtp: {
    label: { pt: 'SMTP', en: 'SMTP' },
    purpose: {
      pt: 'Servidor de email usado pelo ZeroOps para convites, recuperação de acesso e alertas da Saúde.',
      en: 'Mail server ZeroOps uses for invitations, access recovery and Health alerts.',
    },
    icon: 'message',
    connector: true,
  },
  database: {
    label: { pt: 'Base de dados', en: 'Database' },
    purpose: {
      pt: 'Leitura da base de dados do site para investigar tickets e medir a saúde.',
      en: 'Site database reads used to investigate tickets and measure health.',
    },
    environments: {
      quality: {
        pt: 'Usada pelo agente nas investigações e implementações.',
        en: 'Used by the agent for investigations and implementations.',
      },
      production: {
        pt: 'Usada pela Saúde para os alarmes de Produção. O agente consulta Produção através do relay (secção «Agente de investigação»), com o utilizador só de leitura zeroops_agent.',
        en: 'Used by Health for Production alerts. The agent reads Production through the relay (Investigation agent section).',
      },
    },
    icon: 'grid',
    connector: true,
  },
  telemetry: {
    label: { pt: 'Telemetria', en: 'Telemetry' },
    purpose: {
      pt: 'Logs centralizados (Loki) consultados pelo agente e pela Saúde.',
      en: 'Centralized logs (Loki) queried by the agent and by Health.',
    },
    environments: {
      quality: {
        pt: 'Logs do site de Qualidade, consultados pelo agente.',
        en: 'Quality site logs, queried by the agent.',
      },
      production: {
        pt: 'Logs do site de Produção, usados pela Saúde.',
        en: 'Production site logs, used by Health.',
      },
    },
    icon: 'pulse',
    connector: true,
  },
  metrics: {
    label: { pt: 'Métricas', en: 'Metrics' },
    purpose: {
      pt: 'Prometheus com métricas do servidor (CPU, memória, disco, Redis, MySQL, sondas HTTP), usado pela Saúde, pelos gráficos e pelo agente (zo-prom).',
      en: 'Prometheus with server metrics (CPU, memory, disk, Redis, MySQL, HTTP probes), used by Health, charts and the agent (zo-prom).',
    },
    environments: {
      quality: {
        pt: 'Métricas do servidor de Qualidade, consultadas pelo agente.',
        en: 'Quality server metrics, queried by the agent.',
      },
      production: {
        pt: 'Métricas do servidor de Produção, usadas pela Saúde e pelos gráficos.',
        en: 'Production server metrics, used by Health and charts.',
      },
    },
    icon: 'pulse',
    connector: true,
  },
  copilot: {
    label: { pt: 'Copilot', en: 'Copilot' },
    purpose: {
      pt: 'Token GitHub (fine-grained, permissão "Copilot Requests") usado pelo agente e pelo chat interativo.',
      en: 'GitHub token (fine-grained, "Copilot Requests" permission) used by the agent and the interactive chat.',
    },
    icon: 'code',
    connector: true,
  },
  svn: {
    label: { pt: 'SVN', en: 'SVN' },
    purpose: {
      pt: 'Repositório do site para o agente ler histórico e preparar commits.',
      en: 'Site repository for the agent to read history and prepare commits.',
    },
    icon: 'ticket',
    connector: false,
  },
  documentation: {
    label: { pt: 'Documentação', en: 'Documentation' },
    purpose: {
      pt: 'Pasta ou espaço de documentação funcional que o agente pode consultar.',
      en: 'Functional documentation folder or space the agent may read.',
    },
    icon: 'search',
    connector: false,
  },
  deployment: {
    label: { pt: 'Publicação', en: 'Deployment' },
    purpose: {
      pt: 'Destino de publicação usado depois das aprovações de cliente, técnica, QA e release.',
      en: 'Deployment target used after client, technical, QA and release approvals.',
    },
    icon: 'external',
    connector: false,
  },
};

/** Ordem das tabs: primeiro as integrações com conector real. */
export const integrationTabOrder: IntegrationKind[] = [
  'smtp',
  'database',
  'telemetry',
  'metrics',
  'copilot',
  'svn',
  'documentation',
  'deployment',
];
