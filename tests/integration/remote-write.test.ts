import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../../apps/api/src/application.js';
import { HealthRepository } from '../../packages/backend/src/modules/health/health.repository.js';
import { healthSettingsSchema } from '../../packages/contracts/src/index.js';
import { startTestDatabase } from '../helpers/test-database.js';

describe('remote write do Prometheus de Produção', () => {
  let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
  let app: INestApplication;
  let prometheus: Server;
  let base: string;
  let upstreamStatus = 204;
  const received: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const token = `zoh_${randomBytes(32).toString('base64url')}`;
  const payload = randomBytes(2048);
  const send = (headers: Record<string, string>, body: Uint8Array = payload) =>
    fetch(`${base}/api/monitoring/remote-write`, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
    });
  const valid = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/x-protobuf',
    'Content-Encoding': 'snappy',
    'X-Prometheus-Remote-Write-Version': '0.1.0',
  };

  beforeAll(async () => {
    prometheus = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(upstreamStatus).end(upstreamStatus === 204 ? '' : 'out of order sample');
      });
    });
    await new Promise<void>((done) => prometheus.listen(0, '127.0.0.1', done));
    const port = (prometheus.address() as AddressInfo).port;
    fixture = await startTestDatabase();
    const projectId = randomUUID();
    await fixture.db.query('INSERT INTO projects (id,name) VALUES ($1,$2)', [projectId, 'Prod']);
    const repository = new HealthRepository(fixture.db);
    await repository.saveSettings(projectId, healthSettingsSchema.parse({}), null);
    await repository.setAgentTokenHash(projectId, createHash('sha256').update(token).digest('hex'));
    app = await createApplication(
      fixture.db,
      { publicUrl: 'http://127.0.0.1' },
      {
        encryptionKey: randomBytes(32).toString('base64'),
        prometheusWriteUrl: `http://127.0.0.1:${port}/api/v1/write`,
      },
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
    if (fixture) await fixture.stop();
    prometheus?.close();
  });

  it('encaminha o corpo snappy intacto sem sessão nem CSRF', async () => {
    const response = await send(valid);
    expect(response.status).toBe(204);
    expect(received).toHaveLength(1);
    expect(received[0]!.body.equals(payload)).toBe(true);
    expect(received[0]!.headers['content-encoding']).toBe('snappy');
    expect(received[0]!.headers['content-type']).toBe('application/x-protobuf');
    expect(received[0]!.headers['x-prometheus-remote-write-version']).toBe('0.1.0');
    expect(received[0]!.headers.authorization).toBeUndefined();
  });

  it('recusa token inválido, formato errado e corpo grande sem chegar ao Prometheus', async () => {
    received.length = 0;
    const wrongToken = await send({
      ...valid,
      Authorization: `Bearer zoh_${randomBytes(32).toString('base64url')}`,
    });
    expect(wrongToken.status).toBe(401);
    expect((await send({ ...valid, 'Content-Type': 'application/json' })).status).toBe(403);
    expect((await send({ ...valid, 'Content-Encoding': 'gzip' })).status).toBe(415);
    expect((await send(valid, new Uint8Array(4 * 1024 * 1024 + 1))).status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it('devolve o erro 4xx do Prometheus para o agente descartar o lote', async () => {
    upstreamStatus = 400;
    const response = await send(valid);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('out of order');
    upstreamStatus = 204;
  });
});
