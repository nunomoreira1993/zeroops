import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from './database.js';

const LOCK_NAME = 'zeroops-migrations';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * O checksum ignora o fim de linha (o checkout Windows usa CRLF, o deploy por Git usa LF).
 * Os checksums antigos, calculados sobre o ficheiro em bruto, continuam aceites e sao migrados.
 */
export function migrationChecksums(sql: string) {
  const normalized = sql.replace(/\r\n/g, '\n');
  return {
    checksum: sha256(normalized),
    legacyChecksums: [sha256(sql), sha256(normalized.replace(/\n/g, '\r\n'))],
  };
}

/**
 * Aplica `sql/NNN_nome.sql` por ordem. Em MySQL o DDL faz commit implícito, por isso cada
 * ficheiro tem de ser idempotente; o checksum impede alterar migrações já aplicadas.
 */
export async function migrateDatabase(connectionString: string, directory: string) {
  const files = (await readdir(directory)).filter((name) => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('Nao existem migracoes SQL.');
  const db = new Database(connectionString, { multipleStatements: true });
  const connection = await db.pool.getConnection();
  try {
    await connection.query("SET time_zone='+00:00'");
    const [lock] = (await connection.query('SELECT GET_LOCK(?, 60) AS acquired', [LOCK_NAME])) as [
      Array<{ acquired: number }>,
      unknown,
    ];
    if (lock[0]?.acquired !== 1) throw new Error('Outra migracao esta em curso.');
    try {
      await connection.query(
        'CREATE TABLE IF NOT EXISTS zeroops_migrations (name VARCHAR(190) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
      );
      for (const name of files) {
        const sql = await readFile(resolve(directory, name), 'utf8');
        const { checksum, legacyChecksums } = migrationChecksums(sql);
        const [applied] = (await connection.query(
          'SELECT checksum FROM zeroops_migrations WHERE name=?',
          [name],
        )) as [Array<{ checksum: string }>, unknown];
        if (applied[0]) {
          if (applied[0].checksum === checksum) continue;
          if (!legacyChecksums.includes(applied[0].checksum))
            throw new Error(`Migracao ja aplicada foi alterada: ${name}`);
          await connection.query('UPDATE zeroops_migrations SET checksum=? WHERE name=?', [
            checksum,
            name,
          ]);
          continue;
        }
        await connection.query(sql);
        await connection.query('INSERT INTO zeroops_migrations (name,checksum) VALUES (?,?)', [
          name,
          checksum,
        ]);
      }
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    connection.release();
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.ZEROOPS_DATABASE_URL) throw new Error('ZEROOPS_DATABASE_URL obrigatorio.');
  await migrateDatabase(process.env.ZEROOPS_DATABASE_URL, resolve('sql'));
  console.info('Migracoes ZeroOps aplicadas.');
}
