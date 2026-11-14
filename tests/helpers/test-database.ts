import { inject } from 'vitest';
import { Database } from '../../packages/backend/src/database/database.js';
import { createMigratedDatabase, dropDatabase } from './cluster.js';

declare module 'vitest' {
  export interface ProvidedContext {
    zeroopsDatabaseServer: string;
  }
}

/** Base MySQL isolada e migrada para uma suite de testes. */
export async function startTestDatabase() {
  const serverUrl = inject('zeroopsDatabaseServer');
  const created = await createMigratedDatabase(serverUrl);
  const db = new Database(created.url);
  return {
    db,
    url: created.url,
    async stop() {
      await db.close();
      await dropDatabase(serverUrl, created.name);
    },
  };
}
