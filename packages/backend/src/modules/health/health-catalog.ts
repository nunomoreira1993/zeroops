import type {
  HealthChannel,
  HealthCheckDefinition,
  HealthCheckGroup,
  HealthCriticality,
} from '../../../../contracts/src/index.js';

/** Canais por criticidade (politica de alarmistica). */
export const CRITICALITY_CHANNELS: Record<HealthCriticality, HealthChannel[]> = {
  informativa: ['painel', 'relatorio'],
  preventiva: ['painel', 'email'],
  critica: ['painel', 'email', 'sms'],
  urgente: ['painel', 'email', 'sms', 'chamada'],
};

/** Intervalo de re-notificacao enquanto o alerta continuar aberto e sem rececao confirmada. */
export const RENOTIFY_MINUTES: Record<HealthCriticality, number | null> = {
  informativa: null,
  preventiva: 240,
  critica: 30,
  urgente: 15,
};

export const CRITICALITY_ORDER: Record<HealthCriticality, number> = {
  urgente: 0,
  critica: 1,
  preventiva: 2,
  informativa: 3,
};

export interface HealthCheckCatalogEntry extends HealthCheckDefinition {
  /** Minutos em estado nao-ok antes de abrir alerta (evita alertas por oscilacoes). */
  confirmMinutes: number;
}

function check(
  id: string,
  group: HealthCheckGroup,
  title: string,
  description: string,
  criticality: HealthCriticality,
  source: HealthCheckDefinition['source'],
  siteStatus: HealthCheckDefinition['siteStatus'],
  confirmMinutes = 0,
): HealthCheckCatalogEntry {
  return {
    id,
    group,
    title,
    description,
    criticality,
    channels: CRITICALITY_CHANNELS[criticality],
    source,
    siteStatus,
    confirmMinutes,
  };
}

/** As 21 verificacoes da lista de alarmistica do site Pizza Hut, por ordem da lista. */
export const HEALTH_CATALOG: readonly HealthCheckCatalogEntry[] = [
  check(
    'disk-space',
    'Servidores',
    'Espaço livre em disco abaixo do limite',
    'Percentagem livre por partição.',
    'informativa',
    'host_agent',
    'done',
  ),
  check(
    'log-growth',
    'Logs/Aplicação',
    'Crescimento anómalo de ficheiros de log',
    'MB/hora de crescimento dos ficheiros de log monitorizados.',
    'preventiva',
    'host_agent',
    'analysis',
  ),
  check(
    'cpu-memory',
    'Servidores',
    'Consumo elevado de CPU ou memória',
    'Carga por core e memória usada.',
    'critica',
    'host_agent',
    'done',
    5,
  ),
  check(
    'server-service',
    'Servidores',
    'Indisponibilidade do servidor ou serviço aplicacional',
    'Heartbeat do agente e serviços (Apache, PHP-FPM, MySQL).',
    'urgente',
    'host_agent',
    'analysis',
  ),
  check(
    'site-availability',
    'Disponibilidade do site',
    'Site indisponível',
    'Pedido HTTP externo à página principal.',
    'urgente',
    'http',
    'done',
    2,
  ),
  check(
    'app-api-availability',
    'Disponibilidade do site',
    'App ou APIs indisponíveis',
    'Pedidos HTTP externos à app e às APIs configuradas.',
    'urgente',
    'http',
    'analysis',
    2,
  ),
  check(
    'response-time',
    'Disponibilidade do site',
    'Degradação persistente dos tempos de resposta',
    'Tempo médio das sondas HTTP.',
    'critica',
    'http',
    'analysis',
    10,
  ),
  check(
    'session-growth',
    'Servidores',
    'Crescimento anómalo das sessões da aplicação',
    'Ficheiros de sessão PHP.',
    'preventiva',
    'host_agent',
    'analysis',
    10,
  ),
  check(
    'temp-files',
    'Servidores',
    'Acumulação anormal de ficheiros temporários',
    'Ficheiros nas pastas temporárias.',
    'preventiva',
    'host_agent',
    'analysis',
  ),
  check(
    'inodes',
    'Servidores',
    'Capacidade de criação de ficheiros/inodes próxima do limite',
    'Percentagem de inodes livres por partição.',
    'preventiva',
    'host_agent',
    'done',
  ),
  check(
    'database-saturation',
    'Serviços (MySQL, Redis)',
    'Queries lentas ou saturação da base de dados',
    'Ligações em uso e queries lentas desde a última verificação.',
    'critica',
    'site_database',
    'done',
    5,
  ),
  check(
    'redis',
    'Serviços (MySQL, Redis)',
    'Indisponibilidade do Redis',
    'PING ao Redis a partir do servidor.',
    'critica',
    'host_agent',
    'done',
  ),
  check(
    'support-storage',
    'Servidores',
    'Falha de acesso aos sistemas de suporte ou armazenamento',
    'Pontos de montagem e armazenamento partilhado.',
    'critica',
    'host_agent',
    'analysis',
  ),
  check(
    'payments-shift4',
    'Pagamentos',
    'Pagamentos Shift4: pendentes, erros ou recusas',
    'Taxa de falhas e pendentes na última hora.',
    'critica',
    'site_database',
    'analysis',
    10,
  ),
  check(
    'payments-wallet',
    'Pagamentos',
    'Pagamentos MEO Wallet/MB WAY: pendentes, erros ou recusas',
    'Taxa de falhas e pendentes na última hora.',
    'critica',
    'site_database',
    'analysis',
    10,
  ),
  check(
    'payments-divergence',
    'Pagamentos',
    'Divergência entre pagamentos confirmados e encomendas',
    'Pagamentos confirmados com encomenda não finalizada (24h).',
    'critica',
    'site_database',
    'analysis',
  ),
  check(
    'paid-not-integrated',
    'Pagamentos',
    'Encomenda paga mas não integrada/processada',
    'Encomendas pagas por integrar na loja além do limite.',
    'urgente',
    'site_database',
    'done',
  ),
  check(
    'scheduled-jobs',
    'Verificações internas',
    'Falha de processos automáticos ou tarefas agendadas',
    'Idade da última execução de cada cron reportado.',
    'critica',
    'host_agent',
    'analysis',
  ),
  check(
    'application-errors',
    'Logs/Aplicação',
    'Aumento anormal de erros aplicacionais',
    'Linhas de erro nos logs (última hora).',
    'critica',
    'logs',
    'analysis',
    10,
  ),
  check(
    'auth-failures',
    'Logs/Aplicação',
    'Aumento anormal de falhas de autenticação ou bloqueios',
    'Falhas de login e bloqueios nos logs (última hora).',
    'preventiva',
    'logs',
    'analysis',
    10,
  ),
  check(
    'periodic-report',
    'Relatórios',
    'Relatório periódico de disponibilidade e desempenho',
    'Envio diário do relatório por e-mail.',
    'informativa',
    'report',
    'done',
  ),
];

/** Devolve a definição de uma verificação ou falha explicitamente para identificadores desconhecidos. */
export function catalogEntry(checkId: string) {
  const entry = HEALTH_CATALOG.find((item) => item.id === checkId);
  if (!entry) throw new Error(`Verificacao desconhecida: ${checkId}`);
  return entry;
}
