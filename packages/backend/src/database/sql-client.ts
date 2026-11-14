// eslint-disable-next-line @typescript-eslint/no-explicit-any -- linhas tipadas pelo chamador, como no driver anterior.
export type QueryResultRow = Record<string, any>;

export interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number;
}

/** Contrato mínimo partilhado pela pool e pelas transações. */
export interface SqlClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

/** Mantido para compatibilidade com os serviços que tipam o cliente de transação. */
export type PoolClient = SqlClient;

/**
 * Lock exclusivo até ao fim da transação corrente (substitui pg_advisory_xact_lock).
 * Usa uma linha em `zeroops_locks`, libertada no COMMIT/ROLLBACK.
 */
export async function lockInTransaction(client: SqlClient, name: string) {
  await client.query(
    'INSERT INTO zeroops_locks (name) VALUES ($1) ON DUPLICATE KEY UPDATE name = name',
    [name],
  );
  await client.query('SELECT name FROM zeroops_locks WHERE name = $1 FOR UPDATE', [name]);
}

/**
 * Converte placeholders posicionais `$n` em `?` do mysql2, repetindo/reordenando os valores.
 * Ignora `$` dentro de literais entre aspas simples.
 */
export function toMysqlPlaceholders(text: string, values: unknown[]) {
  const ordered: unknown[] = [];
  let sql = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") quoted = !quoted;
    if (!quoted && char === '$' && /\d/.test(text[index + 1] ?? '')) {
      let end = index + 1;
      while (/\d/.test(text[end] ?? '')) end += 1;
      const position = Number(text.slice(index + 1, end));
      if (position < 1 || position > values.length)
        throw new Error(`Parametro SQL inexistente: $${position}`);
      ordered.push(values[position - 1]);
      sql += '?';
      index = end - 1;
      continue;
    }
    sql += char;
  }
  return { sql, values: ordered.map(normalizeValue) };
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}
