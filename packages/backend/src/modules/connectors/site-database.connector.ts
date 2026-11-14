import { createPool, type FieldPacket, type Pool } from 'mysql2/promise';
import type { IntegrationValues } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import { assertReadOnlySql } from './read-only-sql.js';
import { redactValue } from './redaction.js';

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** Cria a URL mysql:// da integração de BD com as credenciais codificadas para URL. */
export function siteDatabaseUrl(values: Extract<IntegrationValues, { kind: 'database' }>) {
  const credentials = `${encodeURIComponent(values.username)}:${encodeURIComponent(values.password ?? '')}`;
  return `mysql://${credentials}@${values.host}:${values.port}/${encodeURIComponent(values.database)}`;
}

/**
 * Consultas de leitura à BD do site com um utilizador só de SELECT. Cada consulta corre numa
 * transação READ ONLY, com tempo máximo e limite de linhas aplicados pelo próprio servidor.
 */
export class SiteDatabaseConnector {
  private readonly pool: Pool;

  constructor(
    url: string,
    private readonly limits = { maxRows: 200, timeoutSeconds: 15 },
  ) {
    if (!url.startsWith('mysql://')) throw new Error('A BD do site tem de usar mysql://');
    this.pool = createPool({
      uri: url,
      connectionLimit: 2,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    });
  }

  /** Executa uma consulta read-only com limites de tempo/linhas e redação dos resultados. */
  async query(sql: string): Promise<SqlResult> {
    const query = assertReadOnlySql(sql);
    const { maxRows, timeoutSeconds } = this.limits;
    const statement = /^(select|with)\b/i.test(query)
      ? `SET STATEMENT max_statement_time=${timeoutSeconds}, sql_select_limit=${maxRows + 1} FOR ${query}`
      : query;
    const connection = await this.pool.getConnection();
    try {
      await connection.query('START TRANSACTION READ ONLY');
      const [rows, fields] = (await connection.query({ sql: statement, rowsAsArray: true })) as [
        unknown[][],
        FieldPacket[],
      ];
      const columns = (fields ?? []).map((field) => field.name);
      const limited = rows.slice(0, maxRows);
      return {
        columns,
        rows: limited.map((row) =>
          row.map((value, index) => redactValue(columns[index] ?? '', value)),
        ),
        truncated: rows.length > maxRows,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const message = error instanceof Error ? error.message : 'Erro desconhecido.';
      throw new DomainError('SQL_FAILED', message.slice(0, 500), 400);
    } finally {
      await connection.query('ROLLBACK').catch(() => undefined);
      connection.release();
    }
  }

  /** Fecha o pool MySQL do conector. */
  close() {
    return this.pool.end();
  }
}
