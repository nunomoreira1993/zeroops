/** Comando de leitura exposto ao Copilot e descrito no prompt. */
export interface AgentCommand {
  tool: string;
  command: string;
  usage: string;
  description: string;
  /** Ambientes onde a ferramenta está disponível neste run (`quality`, `production`). */
  environments: string[];
}

const ENVIRONMENT_LABELS: Record<string, string> = {
  production: 'Produção (dados reais)',
  quality: 'QA (dados de teste)',
};

const CATALOG: Record<string, Omit<AgentCommand, 'tool' | 'environments'>> = {
  sql: {
    command: 'zo-sql',
    usage: 'zo-sql --env production "SELECT ... FROM ... WHERE ... LIMIT 50"',
    description:
      'Base de dados do site (MySQL/MariaDB, só leitura). Use SHOW TABLES / DESCRIBE para descobrir a estrutura. Máximo 200 linhas por consulta; colunas sensíveis são redigidas.',
  },
  db2: {
    command: 'zo-db2',
    usage: 'zo-db2 --env production "SELECT ... FROM ... WHERE ... FETCH FIRST 50 ROWS ONLY"',
    description:
      'Base de dados DB2 (ODBC do servidor, só leitura: SELECT/WITH/VALUES). Use SYSCAT.TABLES / SYSCAT.COLUMNS para descobrir a estrutura. Máximo 200 linhas; nunca altera dados.',
  },
  log: {
    command: 'zo-log',
    usage: 'zo-log --env production <tipo> ["texto"] [linhas] [dias]',
    description:
      'Logs da aplicação (ficheiros em httpdocs/log/<tipo>/<tipo>.log). Filtro por texto exato, até 200 linhas mais recentes; dias = 0 lê só o ficheiro atual, até 14 inclui os rodados.',
  },
  loki: {
    command: 'zo-loki',
    usage: 'zo-loki \'{job="php"} |= "texto"\' 24h 100',
    description:
      'Logs da aplicação no Loki (LogQL). Janela máxima 7d, máximo 200 linhas, mais recentes primeiro.',
  },
  prom: {
    command: 'zo-prom',
    usage: "zo-prom 'up' [janela: 30m|6h|2d]",
    description:
      'Métricas no Prometheus (PromQL). Sem janela devolve o valor atual; com janela devolve a série temporal.',
  },
};

/** Texto do ambiente para o prompt. */
export function environmentLabel(environment: string) {
  return ENVIRONMENT_LABELS[environment] ?? environment;
}

/** Agrupa as ferramentas por nome, juntando os ambientes e as indicações de cada uma. */
export function agentCommandsFrom(
  tools: { name: string; environment?: string; hint: string | null }[],
): AgentCommand[] {
  const commands = new Map<string, AgentCommand>();
  for (const { name, environment = 'quality', hint } of tools) {
    const entry = CATALOG[name];
    if (!entry) continue;
    const command = commands.get(name) ?? { tool: name, ...entry, environments: [] };
    if (!command.environments.includes(environment)) command.environments.push(environment);
    if (hint) command.description = `${command.description} ${hint}.`;
    commands.set(name, command);
  }
  return [...commands.values()].map((command) => ({
    ...command,
    environments: command.environments.sort((a, b) =>
      a === 'production' ? -1 : b === 'production' ? 1 : a.localeCompare(b),
    ),
  }));
}

/** Pergunta ao serviço de conectores que ferramentas estão configuradas para o projeto do run. */
export async function discoverAgentCommands(
  connectorUrl: string | undefined,
  runToken: string,
): Promise<AgentCommand[]> {
  if (!connectorUrl) return [];
  try {
    const response = await fetch(`${connectorUrl}/v1/tools`, {
      headers: { authorization: `Bearer ${runToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      tools?: { name: string; environment?: string; hint: string | null }[];
    };
    return agentCommandsFrom(body.tools ?? []);
  } catch {
    return [];
  }
}
