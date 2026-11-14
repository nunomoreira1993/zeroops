import { DomainError } from '../../errors.js';

const ALLOWED_START = /^(select|with|show|describe|desc|explain)\b/i;
const FORBIDDEN =
  /\b(into\s+(?:out|dump)file|load_file|for\s+update|lock\s+in\s+share\s+mode|sleep|benchmark|get_lock)\b/i;

/** Remove comentários e literais para que a validação não seja enganada pelo conteúdo de strings. */
function skeleton(sql: string) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--\s|#)[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``');
}

/**
 * Aceita apenas uma instrução de leitura. É uma segunda barreira: o utilizador da BD do site
 * usado pelos conectores só tem SELECT e a sessão corre numa transação READ ONLY.
 */
export function assertReadOnlySql(sql: string): string {
  const query = sql.trim().replace(/;\s*$/, '');
  if (!query || query.length > 8000)
    throw new DomainError('SQL_INVALID', 'A consulta tem de ter entre 1 e 8000 caracteres.', 400);
  const shape = skeleton(query);
  if (shape.includes(';'))
    throw new DomainError('SQL_MULTIPLE', 'Só é permitida uma instrução por chamada.', 400);
  if (!ALLOWED_START.test(shape.trim()))
    throw new DomainError('SQL_NOT_READ_ONLY', 'Só são permitidas consultas de leitura.', 400);
  const forbidden = FORBIDDEN.exec(shape);
  if (forbidden)
    throw new DomainError(
      'SQL_NOT_READ_ONLY',
      `Instrução não permitida em consultas de leitura: ${forbidden[1]?.toUpperCase()}.`,
      400,
    );
  return query;
}
