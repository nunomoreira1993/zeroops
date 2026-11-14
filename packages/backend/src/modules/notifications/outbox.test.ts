import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { dispatchOutbox } from './outbox.js';

describe('notification outbox delivery state', () => {
  let fixture: Awaited<ReturnType<typeof startTestDatabase>>;

  beforeAll(async () => {
    fixture = await startTestDatabase();
  });

  afterAll(async () => {
    if (fixture) await fixture.stop();
  });

  it('does not resend uncertain or interrupted deliveries', async () => {
    const sentId = randomUUID();
    const uncertainId = randomUUID();
    const interruptedId = randomUUID();
    for (const id of [sentId, uncertainId, interruptedId])
      await fixture.db.query('INSERT INTO notification_outbox(id,topic,payload) VALUES($1,$2,$3)', [
        id,
        'test.event',
        JSON.stringify({}),
      ]);
    await fixture.db.query(
      `INSERT INTO notification_delivery_state(outbox_id,state,lease_id,claimed_at)
       VALUES($1,'processing',$2,DATE_SUB(NOW(3),INTERVAL 11 MINUTE))`,
      [interruptedId, randomUUID()],
    );

    const delivered: string[] = [];
    const claimed = await dispatchOutbox(fixture.db, {
      async deliver(id) {
        delivered.push(id);
        if (id === uncertainId) throw new Error('SMTP result unknown');
        return { status: 'sent' };
      },
    });

    expect(claimed).toBe(2);
    expect(delivered).toContain(sentId);
    expect(delivered).toContain(uncertainId);
    expect(delivered).not.toContain(interruptedId);

    const states = await fixture.db.query<{ outbox_id: string; state: string }>(
      `SELECT outbox_id,state FROM notification_delivery_state
       WHERE outbox_id IN ($1,$2,$3)`,
      [sentId, uncertainId, interruptedId],
    );
    expect(
      Object.fromEntries(states.rows.map(({ outbox_id, state }) => [outbox_id, state])),
    ).toEqual({
      [sentId]: 'sent',
      [uncertainId]: 'uncertain',
      [interruptedId]: 'uncertain',
    });
    expect(
      await dispatchOutbox(fixture.db, {
        async deliver() {
          throw new Error('A terminal delivery was claimed again.');
        },
      }),
    ).toBe(0);
  });
});
