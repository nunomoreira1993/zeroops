import { createTestCluster } from './helpers/cluster.js';

export default async function setup(project: {
  provide(key: 'zeroopsDatabaseServer', value: string): void;
}) {
  console.info('Preparando MariaDB temporaria para os testes.');
  const fixture = await createTestCluster();
  project.provide('zeroopsDatabaseServer', fixture.serverUrl);
  console.info('MariaDB pronta; cada suite usa uma base isolada.');
  return async () => fixture.stop();
}
