import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '../../errors.js';
import { AlertSpool } from './alert-spool.js';
import { HealthService } from './health.service.js';

describe('AlertSpool', () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('reprocessa por ordem, pára na falha da BD e descarta payloads inválidos', async () => {
    directory = await mkdtemp(join(tmpdir(), 'zeroops-spool-'));
    const spool = new AlertSpool(join(directory, 'queue'));
    expect(await spool.save('p1', { n: 1 }, new Date(1000))).toBe(true);
    expect(await spool.save('p1', { n: 2 }, new Date(2000))).toBe(true);
    expect(await spool.save('p1', { n: 3 }, new Date(3000))).toBe(true);

    const seen: number[] = [];
    const failing = async (_project: string, body: unknown) => {
      seen.push((body as { n: number }).n);
      throw new Error('BD indisponível');
    };
    expect(await spool.drain(failing)).toBe(0);
    expect(seen).toEqual([1]);

    seen.length = 0;
    const handled = await spool.drain(async (_project, body) => {
      const n = (body as { n: number }).n;
      seen.push(n);
      if (n === 2) throw new DomainError('VALIDATION', 'inválido', 400);
    });
    expect(handled).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(await readdir(join(directory, 'queue'))).toEqual([]);
  });

  it('recusa novos ficheiros quando a fila está cheia', async () => {
    directory = await mkdtemp(join(tmpdir(), 'zeroops-spool-'));
    const spool = new AlertSpool(directory, 1);
    expect(await spool.save('p1', {})).toBe(true);
    expect(await spool.save('p1', {})).toBe(false);
  });

  it('guarda o webhook com a BD em baixo e valida o token só ao reprocessar', async () => {
    directory = await mkdtemp(join(tmpdir(), 'zeroops-spool-'));
    let down = true;
    const received: unknown[] = [];
    const valid = `zoh_${'a'.repeat(43)}`;
    const repository = {
      projectByAgentToken: async (hash: string) => {
        if (down) throw new Error('ECONNREFUSED');
        return hash === createHash('sha256').update(valid).digest('hex') ? 'p1' : null;
      },
    };
    const receiver = {
      receive: async (projectId: string, body: unknown) => {
        received.push([projectId, body]);
        return { accepted: 1, notified: 0, opened: 0 };
      },
    };
    const service = new HealthService(
      {} as never,
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      receiver as never,
      undefined,
      new AlertSpool(directory),
    );
    await expect(service.receiveAlerts('Bearer nada', {})).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(await service.receiveAlerts(`Bearer ${valid}`, { n: 1 })).toMatchObject({
      spooled: true,
    });
    expect(await service.receiveAlerts(`Bearer zoh_${'b'.repeat(43)}`, { n: 2 })).toMatchObject({
      spooled: true,
    });
    expect(received).toEqual([]);
    down = false;
    expect(await service.drainAlerts()).toBe(2);
    expect(received).toEqual([['p1', { n: 1 }]]);
    expect(await readdir(directory)).toEqual([]);
  });
});
