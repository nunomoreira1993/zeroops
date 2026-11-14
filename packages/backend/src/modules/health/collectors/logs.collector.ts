import type { HealthSettings } from '../../../../../contracts/src/index.js';
import type { LogLine } from '../../connectors/loki.connector.js';
import {
  above,
  errorCode,
  unknown,
  type CheckResult,
  type CollectorContext,
  type HealthCollector,
} from './collector.js';

export interface LogSearch {
  query(input: { query: string; since?: string; limit?: number }): Promise<LogLine[]>;
}

export type LogSearchOpener = (
  projectId: string,
  environment: HealthSettings['sourceEnvironment'],
) => Promise<LogSearch | null>;

/** Contagens agregadas pelo agente de host (soma dos hosts com dados recentes). */
export type AgentLogEventsSource = (context: CollectorContext) => Promise<{
  hosts: string[];
  windowMinutes: number;
  applicationErrors: number;
  authFailures: number;
  sample: string[];
} | null>;

/** Maximo de linhas lidas por pesquisa; acima disto o valor e reportado como ">=". */
export const LOG_SAMPLE_LIMIT = 5000;

const PATTERNS = {
  'application-errors':
    '(?i)(php (fatal|parse) error|uncaught|fatal error|"level"\\s*:\\s*"(error|critical|alert|emergency)"|\\[(error|crit|alert|emerg)\\])',
  'auth-failures':
    '(?i)((login|auth\\w*|password|senha).{0,60}(fail\\w*|inv[aá]lid\\w*|incorrect\\w*|errad\\w*)|bloque\\w*|blocked|locked out|too many attempts)',
} as const;

/** Erros aplicacionais e falhas de autenticacao na ultima hora: Loki ou, sem ele, o agente. */
export class LogsCollector implements HealthCollector {
  readonly name = 'logs';
  readonly checks = ['application-errors', 'auth-failures'] as const;

  constructor(
    private readonly open: LogSearchOpener,
    private readonly agentEvents?: AgentLogEventsSource,
  ) {}

  /** Conta padrões de erro no Loki ou usa a janela declarada pelo agente quando Loki não está disponível. */
  async collect(context: CollectorContext): Promise<CheckResult[]> {
    const logs = await this.open(context.projectId, context.settings.sourceEnvironment);
    if (!logs) return this.fromAgent(context);
    const t = context.settings.thresholds;
    const limits = {
      'application-errors': t.appErrorsPerHour,
      'auth-failures': t.authFailuresPerHour,
    };
    const results: CheckResult[] = [];
    for (const checkId of this.checks) {
      try {
        const lines = await logs.query({
          query: `${context.settings.logSelector} |~ \`${PATTERNS[checkId]}\``,
          since: '1h',
          limit: LOG_SAMPLE_LIMIT,
        });
        const capped = lines.length >= LOG_SAMPLE_LIMIT;
        results.push({
          checkId,
          status: above(lines.length, limits[checkId], 3),
          value: lines.length,
          unit: 'linhas/h',
          summary: `${capped ? '≥' : ''}${lines.length} ocorrências na última hora (limite ${limits[checkId]}).`,
          details: {
            sample: lines
              .slice(0, 5)
              .map((line) => ({ time: line.time, line: line.line.slice(0, 300) })),
          },
        });
      } catch (error) {
        results.push(unknown(checkId, `Pesquisa no Loki falhou (${errorCode(error)}).`));
      }
    }
    return results;
  }

  private async fromAgent(context: CollectorContext): Promise<CheckResult[]> {
    const events = await this.agentEvents?.(context);
    if (!events)
      return this.checks.map((id) =>
        unknown(id, 'Sem Loki verificado e o agente não enviou contagens de logs.'),
      );
    const t = context.settings.thresholds;
    const values = {
      'application-errors': [events.applicationErrors, t.appErrorsPerHour],
      'auth-failures': [events.authFailures, t.authFailuresPerHour],
    } as const;
    // Normaliza para "por hora" quando a janela do agente difere de 60 minutos.
    const perHour = (value: number) => Math.round((value * 60) / events.windowMinutes);
    return this.checks.map((checkId) => {
      const [raw, limit] = values[checkId];
      const value = perHour(raw);
      return {
        checkId,
        status: above(value, limit, 3),
        value,
        unit: 'linhas/h',
        summary: `${value} ocorrências/h nos logs de ${events.hosts.join(', ')} (janela ${events.windowMinutes} min; limite ${limit}).`,
        details: {
          origin: 'agente',
          hosts: events.hosts,
          sample: checkId === 'application-errors' ? events.sample : [],
        },
      };
    });
  }
}
