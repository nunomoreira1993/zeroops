import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTicketSchema,
  type CreateTicket,
  type Role,
  type User,
} from '../../../../contracts/src/index.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';
import { TicketsService } from './tickets.service.js';
import { TicketGovernanceService } from './ticket-governance.service.js';

let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
let tickets: TicketsService;
const input: CreateTicket = {
  title: 'Checkout does not proceed',
  description: 'The checkout button does not open the next page.',
  category: 'bug',
  environment: 'quality',
  priority: 'high',
};
beforeAll(async () => {
  fixture = await startTestDatabase();
  tickets = new TicketsService(fixture.db);
});
afterAll(async () => {
  await fixture?.stop();
});

async function member(role: Role = 'client', projectId: string = randomUUID()): Promise<User> {
  await fixture.db.query(
    'INSERT INTO projects (id,name) VALUES ($1,$2) ON DUPLICATE KEY UPDATE id=id',
    [projectId, 'Ticket test'],
  );
  const actor: User = {
    id: randomUUID(),
    projectId,
    role,
    email: `${randomUUID()}@example.test`,
    displayName: `Test ${role}`,
  };
  await fixture.db.query(
    'INSERT INTO users (id,project_id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,$5,$6)',
    [actor.id, projectId, actor.email, actor.displayName, role, 'unusable-test-hash'],
  );
  return actor;
}

describe('TicketsService', () => {
  it('lists ticket creation metadata from the actual creator, including disabled identities, within project boundaries', async () => {
    const creator = await member();
    const viewer = await member('technical', creator.projectId);
    const outsider = await member();
    const ticket = await tickets.create(creator, input);
    const otherTicket = await tickets.create(outsider, input);
    const updatedAt = new Date('2026-11-12T15:30:00.000Z');
    await fixture.db.query('UPDATE tickets SET updated_at=$1 WHERE id=$2', [updatedAt, ticket.id]);
    await fixture.db.query('UPDATE users SET disabled=TRUE WHERE id=$1', [creator.id]);
    const listed = await tickets.list(viewer);
    expect(listed).toHaveLength(1);
    expect(listed).toMatchObject([
      {
        id: ticket.id,
        createdBy: creator.id,
        creatorName: creator.displayName,
        createdAt: ticket.createdAt,
        updatedAt: updatedAt.toISOString(),
      },
    ]);
    expect((await tickets.list(outsider)).map((item) => item.id)).toEqual([otherTicket.id]);
  });

  it('manages additional active participants without changing mandatory participants or project boundaries', async () => {
    const governance = new TicketGovernanceService(fixture.db);
    const client = await member();
    const technical = await member('technical', client.projectId);
    const qa = await member('qa', client.projectId);
    const outsider = await member();
    const ticket = await tickets.create(client, input);
    await expect(
      governance.changeParticipant(client, ticket.id, {
        expectedVersion: 0,
        userId: qa.id,
        action: 'add',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      governance.changeParticipant(technical, ticket.id, {
        expectedVersion: 0,
        userId: outsider.id,
        action: 'add',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await governance.changeParticipant(technical, ticket.id, {
        expectedVersion: 0,
        userId: qa.id,
        action: 'add',
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: client.id, required: true, role: 'client' }),
        expect.objectContaining({ userId: qa.id, required: false, role: 'qa' }),
      ]),
    );
    await expect(
      governance.changeParticipant(technical, ticket.id, {
        expectedVersion: 1,
        userId: client.id,
        action: 'remove',
      }),
    ).rejects.toMatchObject({ code: 'REQUIRED_PARTICIPANT' });
    await expect(governance.candidates(outsider, ticket.id)).rejects.toMatchObject({ status: 404 });
    await governance.changeParticipant(technical, ticket.id, {
      expectedVersion: 1,
      userId: qa.id,
      action: 'remove',
    });
    expect(
      (await governance.participants(client, ticket.id)).some((person) => person.userId === qa.id),
    ).toBe(false);
    expect(
      (
        await fixture.db.query(
          'SELECT active FROM ticket_participants WHERE ticket_id=$1 AND user_id=$2',
          [ticket.id, qa.id],
        )
      ).rows[0]?.active,
    ).toBe(false);
  });

  it('resolves a human response only after the assigned client confirms the exact version, without execution or QA', async () => {
    const governance = new TicketGovernanceService(fixture.db);
    const client = await member();
    const technical = await member('technical', client.projectId);
    const otherClient = await member('client', client.projectId);
    const ticket = await tickets.create(client, input);
    await governance.proposeResolution(technical, ticket.id, {
      expectedVersion: 0,
      body: 'A resposta foi verificada e não exige alteração de código.',
    });
    const resolution = await governance.resolution(client, ticket.id);
    expect(resolution).toMatchObject({ status: 'pending', clientId: client.id });
    const decision = {
      expectedVersion: 1,
      artifactHash: resolution!.hash,
      decision: 'approve',
      notes: 'Confirmo a resolução.',
    };
    await expect(
      governance.decideResolution(otherClient, ticket.id, decision),
    ).rejects.toMatchObject({ status: 403 });
    await expect(governance.decideResolution(technical, ticket.id, decision)).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(
      governance.decideResolution(client, ticket.id, { ...decision, artifactHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'STALE_ARTIFACT' });
    await governance.decideResolution(client, ticket.id, decision);
    expect((await tickets.get(client, ticket.id)).status).toBe('resolved');
    expect(await governance.resolution(client, ticket.id)).toMatchObject({
      status: 'accepted',
      notes: decision.notes,
    });
    expect(
      (await fixture.db.query('SELECT id FROM execution_runs WHERE ticket_id=$1', [ticket.id]))
        .rows,
    ).toEqual([]);
    expect(
      (await fixture.db.query('SELECT id FROM deployment_runs WHERE ticket_id=$1', [ticket.id]))
        .rows,
    ).toEqual([]);
    const detail = await tickets.detail(client, ticket.id);
    expect(detail.comments[0]).toMatchObject({ authorKind: 'human', authorRole: 'technical' });
    expect(detail.commentRevisions).toHaveLength(2);
  });

  it('preserves but invalidates prior approvals, proposals and queued work after a material correction', async () => {
    const governance = new TicketGovernanceService(fixture.db);
    const client = await member();
    const ticket = await tickets.create(client, input);
    const comment = await tickets.comment(client, ticket.id, {
      body: 'Contexto a corrigir.',
      visibility: 'public',
    });
    const hash = 'a'.repeat(64);
    await fixture.db.query(
      `INSERT INTO proposals(id,ticket_id,version,hash,summary,steps,acceptance_criteria,risks,created_by)
       VALUES($1,$2,0,$3,'Proposta anterior','[]','[]','[]',$4)`,
      [randomUUID(), ticket.id, hash, client.id],
    );
    await fixture.db.query(
      `INSERT INTO approvals(id,ticket_id,ticket_version,stage,artifact_hash,actor_id,decision,notes)
       VALUES($1,$2,0,'awaiting_client',$3,$4,'approve','Aprovação anterior')`,
      [randomUUID(), ticket.id, hash, client.id],
    );
    await fixture.db.query(
      "INSERT INTO execution_runs(id,ticket_id,ticket_version,proposal_hash,status) VALUES($1,$2,0,$3,'pending')",
      [randomUUID(), ticket.id, hash],
    );
    await fixture.db.query("UPDATE tickets SET status='awaiting_technical' WHERE id=$1", [
      ticket.id,
    ]);
    await tickets.reviseComment(client, ticket.id, comment.id, {
      expectedVersion: 0,
      body: 'Contexto material corrigido.',
    });
    expect(await tickets.get(client, ticket.id)).toMatchObject({
      status: 'investigating',
      version: 1,
    });
    expect(
      (
        await fixture.db.query('SELECT invalidated_at FROM approvals WHERE ticket_id=$1', [
          ticket.id,
        ])
      ).rows[0]?.invalidated_at,
    ).toBeInstanceOf(Date);
    expect(
      (
        await fixture.db.query('SELECT invalidated_at FROM proposals WHERE ticket_id=$1', [
          ticket.id,
        ])
      ).rows[0]?.invalidated_at,
    ).toBeInstanceOf(Date);
    expect(
      (
        await fixture.db.query(
          'SELECT status,error_code,invalidated_at FROM execution_runs WHERE ticket_id=$1',
          [ticket.id],
        )
      ).rows[0],
    ).toMatchObject({
      status: 'blocked',
      error_code: 'material_change',
      invalidated_at: expect.any(Date),
    });
    expect(await governance.invalidations(client, ticket.id)).toMatchObject([
      { ticketVersion: 1, reason: 'comment_correction' },
    ]);
  });

  it('does not edit content while an uncertain operation needs reconciliation and rejects agent impersonation', async () => {
    const client = await member();
    const ticket = await tickets.create(client, input);
    const comment = await tickets.comment(client, ticket.id, {
      body: 'Mensagem original.',
      visibility: 'public',
    });
    await fixture.db.query(
      "INSERT INTO deployment_runs(id,ticket_id,ticket_version,candidate_hash,status) VALUES($1,$2,0,$3,'uncertain')",
      [randomUUID(), ticket.id, 'a'.repeat(64)],
    );
    await expect(
      tickets.reviseComment(client, ticket.id, comment.id, {
        expectedVersion: 0,
        body: 'Alteração não autorizada.',
      }),
    ).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    expect((await tickets.detail(client, ticket.id)).comments[0]?.body).toBe('Mensagem original.');
    const forged = {
      body: 'Resposta atribuída ao agente.',
      visibility: 'public' as const,
      authorKind: 'agent',
    };
    await expect(tickets.comment(client, ticket.id, forged)).rejects.toMatchObject({ status: 400 });
  });

  it('atomically creates a ticket, initial event, and durable notification', async () => {
    const actor = await member();
    const ticket = await tickets.create(actor, input);
    expect(ticket).toMatchObject({
      ...input,
      createdBy: actor.id,
      projectId: actor.projectId,
      status: 'new',
      version: 0,
    });
    const detail = await tickets.detail(actor, ticket.id);
    expect(detail.creatorName).toBe(actor.displayName);
    expect(detail.comments).toHaveLength(0);
    expect(detail.events).toMatchObject([{ fromStatus: null, toStatus: 'new' }]);
    expect(detail.assignments.client).toMatchObject({
      userId: actor.id,
      displayName: actor.displayName,
    });
    const outbox = await fixture.db.query<{ payload: { ticketId: string } }>(
      "SELECT payload FROM notification_outbox WHERE topic='ticket.created' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.ticketId'))=$1",
      [ticket.id],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]?.payload.ticketId).toBe(ticket.id);
    expect(await tickets.detail(actor, ticket.id)).toMatchObject({
      revisions: [
        {
          ticketVersion: 0,
          actorName: actor.displayName,
          before: null,
          after: { title: input.title, description: input.description },
        },
      ],
    });
  });

  it('rejects new development tickets while preserving historical ones', async () => {
    const actor = await member();
    expect(createTicketSchema.safeParse({ ...input, environment: 'development' }).success).toBe(
      false,
    );
    const newTicket = await tickets.create(actor, input);
    await expect(
      fixture.db.query('UPDATE tickets SET environment=$2 WHERE id=$1', [
        newTicket.id,
        'development',
      ]),
    ).rejects.toMatchObject({ sqlState: '23514' });
    await expect(
      fixture.db.query(
        `INSERT INTO tickets
         (id,project_id,created_by,title,description,category,environment,priority)
         VALUES ($1,$2,$3,'Legacy ticket','Historical development ticket','bug','development','medium')`,
        [randomUUID(), actor.projectId, actor.id],
      ),
    ).rejects.toMatchObject({ sqlState: '23514' });

    const legacyId = randomUUID();
    await fixture.db.query(
      `INSERT INTO tickets
       (id,project_id,created_by,title,description,category,environment,priority)
       VALUES ($1,$2,$3,'Legacy ticket','Historical development ticket','bug','quality','medium')`,
      [legacyId, actor.projectId, actor.id],
    );
    const guard = await fixture.db.query<{ 'SQL Original Statement': string }>(
      'SHOW CREATE TRIGGER tickets_before_update',
    );
    await fixture.db.query('DROP TRIGGER tickets_before_update');
    try {
      await fixture.db.query("UPDATE tickets SET environment='development' WHERE id=$1", [
        legacyId,
      ]);
    } finally {
      await fixture.db.query(guard.rows[0]!['SQL Original Statement']);
    }

    expect((await tickets.get(actor, legacyId)).environment).toBe('development');
    await fixture.db.query('UPDATE tickets SET title=$2 WHERE id=$1', [
      legacyId,
      'Preserved legacy ticket',
    ]);
    expect((await tickets.get(actor, legacyId)).title).toBe('Preserved legacy ticket');
    const updatedLegacy = await tickets.update(actor, legacyId, {
      title: 'Preserved legacy ticket',
      description: 'Updated historical context without changing its environment.',
      category: 'bug',
      environment: 'development',
      priority: 'medium',
      expectedVersion: 0,
    });
    expect(updatedLegacy.environment).toBe('development');
    expect((await tickets.detail(actor, legacyId)).revisions[0]?.before?.environment).toBe(
      'development',
    );
  });

  it('records material edits, bumps the version and limits pre-analysis edits to the author', async () => {
    const author = await member();
    const otherClient = await member('client', author.projectId);
    const ticket = await tickets.create(author, input);
    const revised = await tickets.update(author, ticket.id, {
      ...input,
      title: 'Checkout validation issue',
      expectedVersion: ticket.version,
    });
    expect(revised).toMatchObject({
      title: 'Checkout validation issue',
      status: 'new',
      version: 1,
    });
    expect((await tickets.detail(author, ticket.id)).revisions[1]).toMatchObject({
      ticketVersion: 1,
      actorName: author.displayName,
      before: { title: input.title },
      after: { title: 'Checkout validation issue' },
    });
    await expect(
      tickets.update(otherClient, ticket.id, {
        ...input,
        expectedVersion: revised.version,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      tickets.update(author, ticket.id, {
        ...input,
        expectedVersion: ticket.version,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await fixture.db.query("UPDATE tickets SET status='investigating' WHERE id=$1", [ticket.id]);
    await expect(
      tickets.update(author, ticket.id, {
        ...input,
        expectedVersion: revised.version,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('assigns four distinct active role holders and audits changes', async () => {
    const client = await member();
    const admin = await member('admin', client.projectId);
    const technical = await member('technical', client.projectId);
    const qa = await member('qa', client.projectId);
    const release = await member('release', client.projectId);
    const ticket = await tickets.create(client, input);
    const assignments = {
      expectedVersion: ticket.version,
      clientUserId: client.id,
      technicalUserId: technical.id,
      qaUserId: qa.id,
      releaseUserId: release.id,
    };
    const result = await tickets.assign(admin, ticket.id, assignments);
    expect(result).toMatchObject({
      client: { userId: client.id },
      technical: { userId: technical.id },
      qa: { userId: qa.id },
      release: { userId: release.id },
    });
    expect((await tickets.get(client, ticket.id)).version).toBe(ticket.version + 1);
    await expect(
      tickets.assign(admin, ticket.id, {
        ...assignments,
        expectedVersion: ticket.version + 1,
        qaUserId: technical.id,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(tickets.assign(technical, ticket.id, assignments)).rejects.toMatchObject({
      status: 403,
    });
    const audit = await fixture.db.query<{ details: { changedStages: string[] } }>(
      "SELECT details FROM audit_events WHERE ticket_id=$1 AND action='ticket.assignments_changed'",
      [ticket.id],
    );
    expect(audit.rows[0]?.details.changedStages).toEqual(['technical', 'qa', 'release']);
  });

  it('preserves comment history and allows only the author to correct a human message', async () => {
    const client = await member();
    const technical = await member('technical', client.projectId);
    const ticket = await tickets.create(client, input);
    const comment = await tickets.comment(client, ticket.id, {
      body: 'Primeira resposta do cliente.',
      visibility: 'public',
    });
    const revised = await tickets.reviseComment(client, ticket.id, comment.id, {
      expectedVersion: comment.version,
      body: 'Resposta corrigida com mais contexto.',
    });
    expect(revised).toMatchObject({ version: 1, body: 'Resposta corrigida com mais contexto.' });
    await expect(
      tickets.reviseComment(technical, ticket.id, comment.id, {
        expectedVersion: revised.version,
        body: 'Alteração feita por outra pessoa.',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      tickets.reviseComment(client, ticket.id, comment.id, {
        expectedVersion: comment.version,
        body: 'Versão obsoleta.',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await tickets.detail(client, ticket.id)).toMatchObject({
      comments: [{ id: comment.id, body: 'Resposta corrigida com mais contexto.', version: 1 }],
      commentRevisions: [
        {
          commentId: comment.id,
          version: 0,
          before: null,
          after: 'Primeira resposta do cliente.',
        },
        {
          commentId: comment.id,
          version: 1,
          before: 'Primeira resposta do cliente.',
          after: 'Resposta corrigida com mais contexto.',
        },
      ],
    });
    await fixture.db.query("UPDATE tickets SET status='implementing' WHERE id=$1", [ticket.id]);
    await expect(
      tickets.reviseComment(client, ticket.id, comment.id, {
        expectedVersion: revised.version,
        body: 'Alteração durante a execução.',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not disclose internal comment revisions to clients', async () => {
    const client = await member();
    const technical = await member('technical', client.projectId);
    const ticket = await tickets.create(client, input);
    const internal = await tickets.comment(technical, ticket.id, {
      body: 'Nota interna original.',
      visibility: 'internal',
    });
    await tickets.reviseComment(technical, ticket.id, internal.id, {
      expectedVersion: internal.version,
      body: 'Nota interna corrigida.',
    });
    const clientDetail = await tickets.detail(client, ticket.id);
    expect(clientDetail.comments).toEqual([]);
    expect(clientDetail.commentRevisions).toEqual([]);
  });

  it('enforces project isolation for list, get, detail, comments, and forged creation actors', async () => {
    const first = await member();
    const second = await member();
    const ticket = await tickets.create(first, input);
    expect(await tickets.list(second)).toEqual([]);
    await expect(tickets.get(second, ticket.id)).rejects.toMatchObject({ status: 404 });
    await expect(tickets.detail(second, ticket.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      tickets.comment(second, ticket.id, { body: 'Cross-project attempt', visibility: 'public' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      tickets.create({ ...second, projectId: first.projectId }, input),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('hides internal comments from clients even when the caller forges its role', async () => {
    const client = await member();
    const staff = await member('technical', client.projectId);
    const ticket = await tickets.create(client, input);
    await tickets.comment(staff, ticket.id, {
      body: 'Private investigation notes',
      visibility: 'internal',
    });
    await tickets.comment(staff, ticket.id, { body: 'Public reply', visibility: 'public' });
    expect((await tickets.detail(staff, ticket.id)).creatorName).toBe(client.displayName);
    expect(
      (await tickets.detail(client, ticket.id)).comments.map((comment) => comment.body),
    ).toEqual(['Public reply']);
    expect((await tickets.detail(staff, ticket.id)).comments).toHaveLength(2);
    expect((await tickets.detail({ ...client, role: 'admin' }, ticket.id)).comments).toHaveLength(
      1,
    );
    await expect(
      tickets.comment({ ...client, role: 'admin' }, ticket.id, {
        body: 'Forbidden internal comment',
        visibility: 'internal',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects malformed inputs and disabled membership rather than returning undefined', async () => {
    const actor = await member();
    await expect(tickets.get(actor, 'not-a-uuid')).rejects.toMatchObject({ status: 400 });
    await expect(tickets.create(actor, { ...input, title: 'x' })).rejects.toMatchObject({
      status: 400,
    });
    const ticket = await tickets.create(actor, input);
    await expect(
      tickets.comment(actor, ticket.id, { body: '   ', visibility: 'public' }),
    ).rejects.toMatchObject({ status: 400 });
    await fixture.db.query('UPDATE users SET disabled=true WHERE id=$1', [actor.id]);
    await expect(tickets.list(actor)).rejects.toMatchObject({ status: 403 });
    await expect(tickets.create(actor, input)).rejects.toMatchObject({ status: 403 });
    await expect(tickets.get(actor, ticket.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rolls back ticket and event writes if a durable notification cannot be queued', async () => {
    const actor = await member();
    await fixture.db
      .query(`CREATE TRIGGER reject_test_notification BEFORE INSERT ON notification_outbox
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test notification unavailable'`);
    try {
      await expect(tickets.create(actor, input)).rejects.toThrow('test notification unavailable');
      expect(await tickets.list(actor)).toHaveLength(0);
    } finally {
      await fixture.db.query('DROP TRIGGER reject_test_notification');
    }
  });
});
