import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, TicketStatus, User } from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { MetricsService } from './metrics.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let metrics: MetricsService;
const base = new Date('2026-01-01T00:00:00Z').getTime();
const at = (seconds: number) => new Date(base + seconds * 1000);
beforeAll(async () => {
  fixture = await startTestDatabase();
  metrics = new MetricsService(fixture.db);
});
afterAll(async () => {
  await fixture?.stop();
});

async function member(role: Role = 'client', projectId: string = randomUUID()): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects (id,name) VALUES ($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, 'Metric test'],
  );
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    email: `${randomUUID()}@example.test`,
    displayName: 'Metric member',
  };
  await fixture.db.query(
    'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, 'unusable-test-hash'],
  );
  return actor;
}

async function ticket(actor: User, history: [number, TicketStatus][]) {
  const id = randomUUID();
  const latest = history.at(-1) ?? ([0, 'new'] as const);
  await fixture.db.query(
    `INSERT INTO tickets (id,project_id,created_by,title,description,category,environment,priority,status,created_at,updated_at)
     VALUES ($1,$2,$3,'A metric ticket','A ticket with measured history','bug','quality','medium',$4,$5,$6)`,
    [id, actor.projectId, actor.id, latest[1], at(0), at(latest[0])],
  );
  let previous: TicketStatus | null = null;
  for (const [seconds, status] of history) {
    await fixture.db.query(
      'INSERT INTO ticket_events (id,ticket_id,from_status,to_status,created_at) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), id, previous, status, at(seconds)],
    );
    previous = status;
  }
  return id;
}

async function comment(
  ticketId: string,
  author: User,
  seconds: number,
  visibility = 'public',
  automated = false,
) {
  await fixture.db.query(
    'INSERT INTO ticket_comments (id,ticket_id,author_id,body,visibility,automated,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), ticketId, author.id, 'Metric response', visibility, automated, at(seconds)],
  );
}

describe('MetricsService', () => {
  it('uses the first public human non-author staff response and only recorded resolved samples', async () => {
    const client = await member();
    const staff = await member('technical', client.projectId);
    const otherClient = await member('client', client.projectId);
    const id = await ticket(client, [
      [0, 'new'],
      [10, 'awaiting_information'],
      [30, 'investigating'],
      [60, 'resolved'],
    ]);
    await comment(id, client, 1);
    await comment(id, otherClient, 2);
    await comment(id, staff, 3, 'internal');
    await comment(id, staff, 4, 'public', true);
    await comment(id, staff, 20);
    await comment(id, staff, 25);
    await ticket(client, [[0, 'new']]);
    const inconsistent = await ticket(client, []);
    await fixture.db.query("UPDATE tickets SET status='resolved',updated_at=$2 WHERE id=$1", [
      inconsistent,
      at(15),
    ]);
    const summary = await metrics.summary(client);
    expect(summary).toMatchObject({
      total: 3,
      open: 1,
      resolved: 2,
      firstResponseCount: 1,
      firstResponseMeanMs: 20000,
      resolutionCount: 1,
      resolutionMeanMs: 60000,
    });
    expect(summary.tickets.find((row) => row.id === id)).toMatchObject({
      elapsedMs: 60000,
      waitingMs: 20000,
      activeStateMs: 40000,
      firstResponseMs: 20000,
    });
  });

  it('never counts a staff author answering their own ticket or comments arriving after resolution', async () => {
    const staff = await member('technical');
    const colleague = await member('qa', staff.projectId);
    const id = await ticket(staff, [
      [0, 'new'],
      [10, 'resolved'],
    ]);
    await comment(id, staff, 1);
    await comment(id, colleague, 11);
    expect(await metrics.summary(staff)).toMatchObject({
      firstResponseCount: 0,
      firstResponseMeanMs: null,
      resolutionCount: 1,
      resolutionMeanMs: 10000,
    });
  });

  it('keeps project metrics isolated and reports empty samples honestly', async () => {
    const first = await member();
    const other = await member();
    await ticket(first, [
      [0, 'new'],
      [20, 'resolved'],
    ]);
    expect(await metrics.summary(other)).toEqual({
      total: 0,
      open: 0,
      resolved: 0,
      firstResponseMeanMs: null,
      firstResponseCount: 0,
      resolutionMeanMs: null,
      resolutionCount: 0,
      tickets: [],
    });
    await expect(metrics.summary({ ...other, projectId: first.projectId })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('preserves resolved cycles when reopened and does not average open tickets as resolutions', async () => {
    const client = await member();
    const staff = await member('technical', client.projectId);
    const id = await ticket(client, [
      [0, 'new'],
      [10, 'resolved'],
      [100, 'investigating'],
      [110, 'awaiting_client'],
      [120, 'resolved'],
    ]);
    await comment(id, staff, 50);
    await comment(id, staff, 105);
    const summary = await metrics.summary(client);
    expect(summary).toMatchObject({
      resolutionCount: 1,
      resolutionMeanMs: 30000,
      firstResponseMeanMs: 105000,
    });
    expect(summary.tickets[0]).toMatchObject({
      id,
      elapsedMs: 30000,
      waitingMs: 10000,
      activeStateMs: 20000,
    });
    await fixture.db.query(
      "UPDATE tickets SET status='investigating',updated_at=NOW(3) WHERE id=$1",
      [id],
    );
    await fixture.db.query(
      "INSERT INTO ticket_events (id,ticket_id,from_status,to_status) VALUES ($1,$2,'resolved','investigating')",
      [randomUUID(), id],
    );
    expect(await metrics.summary(client)).toMatchObject({
      open: 1,
      resolved: 0,
      resolutionCount: 0,
      resolutionMeanMs: null,
    });
  });
});
