import { z } from 'zod';
import { siteLogTypes } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import type { ConnectorTool, ConnectorToolProvider } from './connector-gateway.js';
import type { ProductionRelayQueue } from './production-relay.queue.js';
import { assertReadOnlySql } from './read-only-sql.js';
import { redactText, redactValue } from './redaction.js';

const MAX_ROWS = 200;
const MAX_CELL = 2000;

const sqlInput = z.strictObject({ query: z.string().min(1).max(8000) });
const logInput = z.strictObject({
  type: z.enum(siteLogTypes),
  contains: z.string().max(200).optional(),
  lines: z.number().int().min(1).max(200).optional(),
  days: z.number().int().min(0).max(14).optional(),
});

const sqlResult = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  truncated: z.boolean(),
});
const logResult = z.object({
  lines: z.array(z.string()),
  files: z.array(z.string()),
  truncated: z.boolean(),
});

function parseRelay<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new DomainError('RELAY_INVALID', 'Resposta inválida do relay de Produção.', 502);
  return parsed.data;
}

const clipCell = (value: unknown) =>
  typeof value === 'string' && value.length > MAX_CELL ? `${value.slice(0, MAX_CELL)}…` : value;

/** SQL só de leitura na BD de Produção, executado pelo relay; a redação é aplicada aqui. */
export function relaySqlTool(
  queue: ProductionRelayQueue,
  projectId: string,
): ConnectorTool<z.infer<typeof sqlInput>> {
  return {
    name: 'sql',
    environment: 'production',
    input: sqlInput,
    describe: (input) => input.query,
    async run(input, context) {
      const query = assertReadOnlySql(input.query);
      const raw = await queue.execute(projectId, context.runId, 'sql', { query });
      const { columns, rows, truncated } = parseRelay(sqlResult, raw);
      const limited = rows
        .slice(0, MAX_ROWS)
        .map((row) =>
          row.map((value, index) => clipCell(redactValue(columns[index] ?? '', value))),
        );
      const result = { columns, rows: limited, truncated: truncated || rows.length > MAX_ROWS };
      return { result, rowCount: limited.length };
    },
  };
}

const DB2_WRITE =
  /\b(insert|update|delete|merge|call|truncate|alter|drop|create|grant|revoke|rename|set|refresh|declare|execute|prepare)\b/i;

/** Valida uma consulta DB2 só de leitura (SELECT/WITH/VALUES, sem escrita embutida). */
export function assertReadOnlyDb2(sql: string): string {
  const query = assertReadOnlySql(sql);
  const shape = query
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  if (!/^\s*(select|with|values)\b/i.test(shape))
    throw new DomainError('SQL_NOT_READ_ONLY', 'No DB2 só são permitidas consultas SELECT.', 400);
  const write = DB2_WRITE.exec(shape);
  if (write)
    throw new DomainError(
      'SQL_NOT_READ_ONLY',
      `Instrução não permitida no DB2 (só leitura): ${write[1]?.toUpperCase()}.`,
      400,
    );
  return query;
}

/** SQL só de leitura no DB2 de Produção (ODBC no servidor), executado pelo relay e redigido aqui. */
export function relayDb2Tool(
  queue: ProductionRelayQueue,
  projectId: string,
): ConnectorTool<z.infer<typeof sqlInput>> {
  return {
    name: 'db2',
    environment: 'production',
    input: sqlInput,
    describe: (input) => input.query,
    async run(input, context) {
      const query = assertReadOnlyDb2(input.query);
      const raw = await queue.execute(projectId, context.runId, 'db2', { query });
      const { columns, rows, truncated } = parseRelay(sqlResult, raw);
      const limited = rows
        .slice(0, MAX_ROWS)
        .map((row) =>
          row.map((value, index) => clipCell(redactValue(columns[index] ?? '', value))),
        );
      const result = { columns, rows: limited, truncated: truncated || rows.length > MAX_ROWS };
      return { result, rowCount: limited.length };
    },
  };
}

/** Leitura dos logs da aplicação em Produção (lista fechada de tipos), com texto redigido. */
export function relayLogTool(
  queue: ProductionRelayQueue,
  projectId: string,
): ConnectorTool<z.infer<typeof logInput>> {
  return {
    name: 'log',
    environment: 'production',
    input: logInput,
    describe: (input) =>
      `${input.type}${input.contains ? ` "${input.contains}"` : ''} [${input.lines ?? 100} linhas, ${input.days ?? 0} dias]`,
    async run(input, context) {
      const raw = await queue.execute(projectId, context.runId, 'log', {
        type: input.type,
        contains: input.contains ?? '',
        lines: input.lines ?? 100,
        days: input.days ?? 0,
      });
      const { lines, files, truncated } = parseRelay(logResult, raw);
      const redacted = lines.slice(-200).map((line) => String(clipCell(redactText(line))));
      return { result: { lines: redacted, files, truncated }, rowCount: redacted.length };
    },
  };
}

/** Ferramentas de Produção disponíveis enquanto o relay do projeto estiver ligado. */
export class ProductionRelayToolProvider implements ConnectorToolProvider {
  constructor(private readonly queue: ProductionRelayQueue) {}

  /** Devolve `sql` e `log` (e `db2` se o relay o anunciar) só quando o relay está ligado. */
  async toolsFor(projectId: string) {
    if (!(await this.queue.isOnline(projectId))) return [];
    const announced = await this.queue.tools(projectId);
    return [
      relaySqlTool(this.queue, projectId) as ConnectorTool<never>,
      relayLogTool(this.queue, projectId) as ConnectorTool<never>,
      ...(announced?.includes('db2')
        ? [relayDb2Tool(this.queue, projectId) as ConnectorTool<never>]
        : []),
    ];
  }
}
