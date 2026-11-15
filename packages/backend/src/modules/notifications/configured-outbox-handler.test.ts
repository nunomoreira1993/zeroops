import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, User } from '../../../../contracts/src/index.js';
import { IdentityService } from '../identity/identity.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { recordTicketMove } from '../tickets/ticket-move.js';
import type { SmtpConfig } from '../smtp/smtp-transport.js';
import {
  ConfiguredOutboxHandler,
  type NotificationMailSender,
} from './configured-outbox-handler.js';
import { startTestDatabase } from '../../../../../tests/helpers/test-database.js';

describe('configured outbox handler', () => {
  let fixture: Awaited<ReturnType<typeof startTestDatabase>>;
  let identity: IdentityService;
  let tickets: TicketsService;
  let admin: User;
  const users = new Map<Role, User>();
  const password = 'Fixture-only-strong-password-123!';

  beforeAll(async () => {
    fixture = await startTestDatabase();
    identity = new IdentityService(fixture.db);
    tickets = new TicketsService(fixture.db);
    await identity.createInitialAdmin({
      email: 'admin@example.test',
      displayName: 'Administrador de teste',
      password,
    });
    admin = (await identity.login('admin@example.test', password)).user;
    for (const role of ['client', 'technical', 'qa', 'release'] as const) {
      const { token } = await identity.invite(admin, {
        email: `${role}@example.test`,
        displayName: role,
        role,
      });
      users.set(role, (await identity.activate({ token, password, displayName: role })).user);
    }
  });

  afterAll(async () => {
    if (fixture) await fixture.stop();
  });

  function actor(role: Role) {
    const user = users.get(role);
    if (!user) throw new Error('Fixture ausente.');
    return user;
  }

  it('notifies only the assigned team about an internal comment, without its contents', async () => {
    const ticket = await tickets.create(actor('client'), {
      title: 'Consulta de teste de notificação',
      description: 'Pedido sintético para testar destinatários.',
      category: 'question',
      environment: 'quality',
      priority: 'medium',
    });
    await tickets.assign(admin, ticket.id, {
      expectedVersion: ticket.version,
      clientUserId: actor('client').id,
      technicalUserId: actor('technical').id,
      qaUserId: actor('qa').id,
      releaseUserId: actor('release').id,
    });
    await tickets.comment(actor('technical'), ticket.id, {
      body: 'conteúdo privado que não deve ir por email',
      visibility: 'internal',
    });
    const event = await fixture.db.query<{
      id: string;
      topic: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id,topic,payload FROM notification_outbox
       WHERE topic='ticket.comment_created'
         AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.ticketId'))=$1
       ORDER BY created_at DESC LIMIT 1`,
      [ticket.id],
    );
    const row = event.rows[0];
    if (!row) throw new Error('Evento de comentário não encontrado.');

    const sent: { to: string[]; subject: string; text: string }[] = [];
    const sender: NotificationMailSender = async (_smtp, message) => {
      sent.push(message);
    };
    const smtp: SmtpConfig = { host: 'smtp.example.test', port: 25, from: 'zeroops@example.test' };
    const handler = new ConfiguredOutboxHandler(
      fixture.db,
      { runtimeSmtp: async () => smtp },
      'quality',
      undefined,
      'https://tickets.example.test',
      sender,
    );
    await expect(handler.deliver(row.id, row.topic, row.payload)).resolves.toEqual({
      status: 'sent',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['qa@example.test', 'release@example.test']);
    expect(sent[0]?.text).toContain('recebeu uma nota interna');
    expect(sent[0]?.text).not.toContain('conteúdo privado');
    expect(sent[0]?.text).not.toContain('client@example.test');
  });

  it('blocks unsupported topics without invoking the mail sender', async () => {
    let sent = false;
    const handler = new ConfiguredOutboxHandler(
      fixture.db,
      { runtimeSmtp: async () => null },
      'quality',
      undefined,
      'https://tickets.example.test',
      async () => {
        sent = true;
      },
    );

    await expect(handler.deliver('event', 'execution.requested', {})).resolves.toEqual({
      status: 'blocked',
      errorCode: 'unsupported_topic',
    });
    expect(sent).toBe(false);
  });

  it('notifies the author about an automatic flow transition without an actor', async () => {
    const ticket = await tickets.create(actor('client'), {
      title: 'Encerramento automático de teste',
      description: 'O motor encerra o pedido depois da publicação confirmada.',
      category: 'improvement',
      environment: 'quality',
      priority: 'low',
    });
    await fixture.db.transaction((client) =>
      recordTicketMove(client, {
        ticketId: ticket.id,
        projectId: admin.projectId,
        from: ticket.status,
        to: 'resolved',
        version: ticket.version,
        actorId: null,
        action: 'flow.completed',
      }),
    );
    const row = (
      await fixture.db.query<{
        id: string;
        topic: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT id,topic,payload FROM notification_outbox
          WHERE topic='ticket.changed'
            AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.ticketId'))=$1`,
        [ticket.id],
      )
    ).rows[0]!;
    const sent: { to: string[]; text: string }[] = [];
    const smtp: SmtpConfig = { host: 'smtp.example.test', port: 25, from: 'zeroops@example.test' };
    const handler = new ConfiguredOutboxHandler(
      fixture.db,
      { runtimeSmtp: async () => smtp },
      'quality',
      undefined,
      'https://tickets.example.test',
      async (_smtp, message) => {
        sent.push(message);
      },
    );

    await expect(handler.deliver(row.id, row.topic, row.payload)).resolves.toEqual({
      status: 'sent',
    });
    expect(sent[0]?.to).toEqual(['client@example.test']);
    expect(sent[0]?.text).toContain('resolved');
    expect(sent[0]?.text).toContain(`#tickets/${ticket.id}`);
    await expect(
      handler.deliver(row.id, row.topic, { ...row.payload, actorId: 'invalid' }),
    ).resolves.toEqual({ status: 'blocked', errorCode: 'payload_invalid' });
    expect(sent).toHaveLength(1);
  });
});
