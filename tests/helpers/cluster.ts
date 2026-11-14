import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from '../../packages/backend/src/database/database.js';
import { migrateDatabase } from '../../packages/backend/src/database/migrate.js';

export async function availablePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Porta de teste indisponivel.');
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

function mariadbHome() {
  const configured = process.env.ZEROOPS_TEST_MARIADB_HOME;
  if (configured) return configured;
  const local = process.env.LOCALAPPDATA;
  return local ? join(local, 'zeroops-test', 'mariadb-10.3.39-winx64') : '';
}

async function waitForServer(url: string, server: ChildProcess) {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (server.exitCode !== null) throw new Error('MariaDB de teste terminou durante o arranque.');
    const probe = new Database(url);
    try {
      await probe.query('SELECT 1');
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 250));
    } finally {
      await probe.close();
    }
  }
}

/**
 * Servidor MariaDB efémero para os testes (pasta temporária e porta livre).
 * Alternativa: `ZEROOPS_TEST_DATABASE_URL=mysql://user:pass@host:port` para um servidor
 * dedicado a testes, onde o utilizador pode criar e apagar bases `zeroops_test_*`.
 */
export async function createTestCluster() {
  const external = process.env.ZEROOPS_TEST_DATABASE_URL;
  if (external) return startCluster(external, async () => undefined);

  const home = mariadbHome();
  const binary = (name: string) => join(home, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  if (!home || !existsSync(binary('mysqld')))
    throw new Error(
      'MariaDB de teste indisponivel: definir ZEROOPS_TEST_MARIADB_HOME ou ZEROOPS_TEST_DATABASE_URL.',
    );
  const directory = await mkdtemp(join(tmpdir(), 'zeroops-mariadb-'));
  const dataDir = join(directory, 'data');
  const password = randomBytes(18).toString('hex');
  const install = spawnSync(binary('mysql_install_db'), [`--datadir=${dataDir}`, `--password=${password}`], {
    encoding: 'utf8',
  });
  if (install.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`mysql_install_db falhou: ${install.stderr || install.stdout}`);
  }
  const port = await availablePort();
  const server = spawn(
    binary('mysqld'),
    [
      `--datadir=${dataDir}`,
      `--port=${port}`,
      '--bind-address=127.0.0.1',
      '--skip-networking=0',
      '--character-set-server=utf8mb4',
      '--collation-server=utf8mb4_unicode_ci',
      '--innodb-flush-log-at-trx-commit=0',
      '--innodb-doublewrite=0',
      '--sync-binlog=0',
      '--max-connections=500',
      '--console',
    ],
    { stdio: process.env.ZEROOPS_TEST_TRACE === '1' ? 'inherit' : 'ignore' },
  );
  const url = `mysql://root:${password}@127.0.0.1:${port}`;
  const stop = async () => {
    if (server.exitCode === null) {
      const exited = new Promise((done) => server.once('exit', done));
      server.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await waitForServer(url, server);
    return await startCluster(url, stop);
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startCluster(serverUrl: string, stopServer: () => Promise<void>) {
  const database = await createMigratedDatabase(serverUrl);
  const db = new Database(database.url);
  return {
    /** URL do servidor (sem base), usado pelos workers de teste para criar bases isoladas. */
    serverUrl,
    db,
    connectionString: database.url,
    async stop() {
      await db.close();
      await dropDatabase(serverUrl, database.name).catch(() => undefined);
      await stopServer();
    },
  };
}

/** Cria uma base `zeroops_test_*` isolada e aplica as migrações. */
export async function createMigratedDatabase(serverUrl: string) {
  const name = `zeroops_test_${randomBytes(8).toString('hex')}`;
  const admin = new Database(serverUrl);
  try {
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await admin.close();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  await migrateDatabase(url.href, resolve('sql'));
  return { name, url: url.href };
}

export async function dropDatabase(serverUrl: string, name: string) {
  if (!/^zeroops_test_[a-f0-9]+$/.test(name)) throw new Error('Base de teste invalida.');
  const admin = new Database(serverUrl);
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  } finally {
    await admin.close();
  }
}