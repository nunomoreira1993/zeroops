import mysql, { type FieldPacket, type Pool, type PoolConnection } from 'mysql2/promise';
import {
  toMysqlPlaceholders,
  type QueryResult,
  type QueryResultRow,
  type SqlClient,
} from './sql-client.js';

export type { PoolClient, QueryResult, QueryResultRow, SqlClient } from './sql-client.js';
export { lockInTransaction } from './sql-client.js';

/**
 * Colunas JSON. Em MariaDB 10.3 `JSON` é um alias de `LONGTEXT`, pelo que o protocolo
 * não as distingue de texto: o adaptador converte-as pelo nome (ou alias) da coluna.
 */
export const JSON_COLUMNS = new Set([
  'flow_definition',
  'flow_match',
  'step_assignee',
  'step_input',
  'step_output',
  'event_details',
  'execution_context',
  'assistant_context',
  'assistant_response',
  'proposed_tests',
  'steps',
  'acceptance_criteria',
  'acceptanceCriteria',
  'risks',
  'manifest',
  'payload',
  'details',
  'before_data',
  'after_data',
  'public_values',
  'publicValues',
  'evidence',
  'client_questions',
  'config',
  'definition',
  'agent_profile_snapshot',
  'repository_resources',
  'allowed_tools',
  'effective_tools',
  'chart_context',
]);

type TypeCastHandler = Exclude<mysql.PoolOptions['typeCast'], boolean | undefined>;
type TypeCastField = Parameters<TypeCastHandler>[0];
type TypeCastNext = Parameters<TypeCastHandler>[1];

function typeCast(field: TypeCastField, next: TypeCastNext) {
  if (field.type === 'TINY' && field.length === 1) {
    const value = field.string();
    return value === null ? null : value === '1';
  }
  if (
    JSON_COLUMNS.has(field.name) &&
    ['BLOB', 'VAR_STRING', 'STRING', 'JSON'].includes(field.type)
  ) {
    const value = field.string('utf8');
    return value === null ? null : JSON.parse(value);
  }
  return next();
}

function toResult<T extends QueryResultRow>(raw: unknown): QueryResult<T> {
  if (Array.isArray(raw)) {
    // Multi-statement devolve um array de resultados: usa o último conjunto de linhas.
    const sets = raw.filter((item) => Array.isArray(item));
    const rows = (sets.length ? sets.at(-1) : raw) as T[];
    return { rows, rowCount: rows.length };
  }
  const header = raw as { affectedRows?: number };
  return { rows: [], rowCount: header.affectedRows ?? 0 };
}

async function run<T extends QueryResultRow>(
  target: Pool | PoolConnection,
  text: string,
  values: unknown[],
): Promise<QueryResult<T>> {
  const prepared = toMysqlPlaceholders(text, values);
  const [raw] = (await target.query(prepared.sql, prepared.values)) as [unknown, FieldPacket[]];
  return toResult<T>(raw);
}

class TransactionClient implements SqlClient {
  constructor(private readonly connection: PoolConnection) {}

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return run<T>(this.connection, text, values);
  }
}

export class Database implements SqlClient {
  readonly pool: Pool;

  constructor(connectionString: string, options: { multipleStatements?: boolean } = {}) {
    const url = new URL(connectionString);
    if (!['mysql:', 'mariadb:'].includes(url.protocol))
      throw new Error('ZEROOPS_DATABASE_URL tem de usar mysql://');
    this.pool = mysql.createPool({
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, '') || undefined,
      connectionLimit: 5,
      connectTimeout: 10000,
      charset: 'utf8mb4_unicode_ci',
      timezone: 'Z',
      dateStrings: false,
      decimalNumbers: true,
      flags: ['+FOUND_ROWS'],
      multipleStatements: options.multipleStatements ?? false,
      typeCast,
    });
    // Todas as datas são guardadas e calculadas em UTC (NOW(3), CURRENT_TIMESTAMP(3)).
    // ANSI_QUOTES/PIPES_AS_CONCAT: "identificador" e || com a mesma semântica do SQL standard.
    this.pool.pool.on('connection', (connection) => {
      connection.query(
        "SET time_zone='+00:00', SESSION sql_mode=CONCAT(@@sql_mode, ',STRICT_ALL_TABLES,ANSI_QUOTES,PIPES_AS_CONCAT')",
      );
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return run<T>(this.pool, text, values);
  }

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(new TransactionClient(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  close() {
    return this.pool.end();
  }
}
