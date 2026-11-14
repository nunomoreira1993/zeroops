import { randomBytes } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Database, PoolClient } from '../../database/database.js';
import {
  IdentityMailService,
  identityMailConfigFromEnv,
  type IdentityMailConfig,
  type IdentityMailInput,
} from './identity-mail.js';
import { renderIdentityMail } from './identity-mail.templates.js';

/** Isolated SMTP fixture. All sockets bind exclusively to loopback; recipients use .test. */
async function smtpFixture(mode: 'accept' | 'reject' | 'uncertain') {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 test.local ESMTP\r\n');
    let buffer = '';
    let data = false;
    let message = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            data = false;
            received.push(message);
            if (mode !== 'uncertain') socket.write('250 queued\r\n');
          } else message += `${line}\r\n`;
        } else if (/^(EHLO|HELO)/.test(line)) socket.write('250 test.local\r\n');
        else if (/^MAIL FROM/.test(line)) socket.write('250 sender ok\r\n');
        else if (/^RCPT TO/.test(line))
          socket.write(mode === 'reject' ? '550 rejected\r\n' : '250 recipient ok\r\n');
        else if (line === 'DATA') {
          socket.write('354 end with dot\r\n');
          data = true;
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
  return {
    port: address.port,
    received,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function queueFixture() {
  const rows: Record<string, unknown>[] = [];
  let referenceValid = true;
  let validations = 0;
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('INSERT INTO identity_mail')) {
      const [id, user_id, kind, token_hash, expires_at, payload_ciphertext] = values;
      rows.push({
        id,
        user_id,
        kind,
        token_hash,
        expires_at,
        payload_ciphertext,
        key_version: 1,
        state: 'pending',
        attempts: 0,
        lease_id: null,
      });
    } else if (sql.includes("error_code='lease_expired'")) {
      for (const row of rows)
        if (
          row.state === 'processing' &&
          row.lease_until instanceof Date &&
          row.lease_until < new Date()
        ) {
          row.state = 'uncertain';
          row.payload_ciphertext = null;
          row.lease_id = null;
          row.error_code = 'lease_expired';
        }
    } else if (sql.includes("error_code='message_expired'")) {
      for (const row of rows)
        if (
          row.expires_at instanceof Date &&
          row.expires_at <= new Date() &&
          row.state !== 'processing'
        ) {
          row.payload_ciphertext = null;
          if (row.state === 'pending') row.state = 'blocked';
          row.error_code = 'message_expired';
        }
    } else if (sql.includes("SELECT id FROM identity_mail WHERE state='pending'")) {
      const row = rows.find((item) => item.state === 'pending');
      return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    } else if (sql.includes("SET state='processing'")) {
      const row = rows.find((item) => item.id === values[1] && item.state === 'pending');
      if (row) {
        row.state = 'processing';
        row.lease_id = values[0];
        row.attempts = Number(row.attempts) + 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    } else if (sql.includes('SELECT * FROM identity_mail WHERE id=$1')) {
      const row = rows.find((item) => item.id === values[0] && item.lease_id === values[1]);
      return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
    } else if (sql.includes('SET state=$3')) {
      const row = rows.find((item) => item.id === values[0] && item.lease_id === values[1]);
      if (!row) return { rows: [], rowCount: 0 };
      row.state = values[2];
      row.error_code = values[3];
      row.lease_id = null;
      if (values[4]) row.payload_ciphertext = null;
    } else if (sql.includes("SET state='pending'")) {
      const row = rows.find(
        (item) =>
          item.id === values[0] &&
          item.user_id === values[1] &&
          ['failed', 'blocked'].includes(String(item.state)) &&
          item.payload_ciphertext &&
          Number(item.attempts) < 5 &&
          item.expires_at instanceof Date &&
          item.expires_at > new Date(),
      );
      if (!row) return { rows: [], rowCount: 0 };
      row.state = 'pending';
    } else if (sql.includes('LOCK IN SHARE MODE')) {
      validations++;
      return {
        rows: referenceValid ? [{ id: 'reference' }] : [],
        rowCount: referenceValid ? 1 : 0,
      };
    }
    return { rows: [], rowCount: 1 };
  };
  const client = { query } as unknown as PoolClient;
  const db = {
    query,
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) => operation(client),
  } as unknown as Database;
  return {
    db,
    client,
    rows,
    revoke: () => {
      referenceValid = false;
    },
    validations: () => validations,
  };
}

function config(port = 2525): IdentityMailConfig {
  return {
    publicUrl: 'https://zeroops.example.test',
    encryptionKey: randomBytes(32).toString('base64'),
    smtp: {
      host: '127.0.0.1',
      port,
      from: 'zeroops@example.test',
      requireTLS: false,
      allowInsecureLoopback: true,
      timeoutMs: 150,
    },
  };
}
const reset: IdentityMailInput = {
  userId: '00000000-0000-4000-8000-000000000002',
  recipient: 'recipient@example.test',
  locale: 'pt-PT',
  kind: 'reset',
  token: 'fixture-only-private-token',
};

describe('private identity mail', () => {
  it('fails closed without key/relay and rejects insecure non-loopback SMTP', () => {
    const fixture = queueFixture();
    expect(() =>
      new IdentityMailService(fixture.db, identityMailConfigFromEnv({})).assertConfigured(),
    ).toThrow('indisponível');
    const settings = config();
    settings.smtp!.host = 'mail.example.test';
    expect(() => new IdentityMailService(fixture.db, settings).assertConfigured()).toThrow(
      'indisponível',
    );
    settings.smtp!.requireTLS = true;
    expect(() => new IdentityMailService(fixture.db, settings).assertConfigured()).not.toThrow();
  });

  it('stores only authenticated ciphertext and blocks tampered metadata before SMTP', async () => {
    const fixture = queueFixture();
    const service = new IdentityMailService(fixture.db, config());
    await service.enqueue(fixture.client, reset);
    const serialized = JSON.stringify(fixture.rows);
    expect(serialized).not.toContain(reset.token);
    expect(serialized).not.toContain(reset.recipient);
    fixture.rows[0]!.kind = 'invite';
    await service.deliverPending();
    expect(fixture.rows[0]).toMatchObject({
      state: 'blocked',
      error_code: 'payload_invalid',
      payload_ciphertext: null,
    });
    expect(fixture.validations()).toBe(0);
  });

  it('validates token hash/expiration before enqueue and never renders a lock bypass', async () => {
    const fixture = queueFixture();
    const service = new IdentityMailService(fixture.db, config());
    await expect(service.enqueue(fixture.client, { ...reset, tokenHash: 'wrong' })).rejects.toThrow(
      'inválida',
    );
    await expect(
      service.enqueue(fixture.client, { ...reset, expiresAt: new Date(0).toISOString() }),
    ).rejects.toThrow('expirada');
    const mail = renderIdentityMail(
      'lock',
      { recipient: reset.recipient, locale: 'en' },
      config().publicUrl,
    );
    expect(mail.text).toContain('15 minutes');
    expect(mail.text).not.toContain('https:');
    const template = renderIdentityMail('invite', { ...reset, locale: 'en' }, config().publicUrl);
    expect(template.text).toContain('/activate#token=');
    expect(template.text).not.toContain('?token=');
    const notice = renderIdentityMail(
      'email-change',
      { recipient: reset.recipient, locale: 'pt-PT' },
      config().publicUrl,
    );
    expect(notice.text).toContain('apenas um aviso');
    expect(notice.text).not.toContain('Confirme');
    expect(notice.text).not.toContain('https:');
  });

  it('o convite de conta nova traz a palavra-passe temporária e aponta para o login', () => {
    const invite = {
      displayName: 'Pedro Teste',
      role: 'client' as const,
      organization: 'client' as const,
      projectName: 'Pizza Hut',
      invitedBy: 'Nuno Moreira',
    };
    const mail = renderIdentityMail(
      'invite',
      {
        recipient: 'pedro@example.test',
        locale: 'pt-PT',
        token: 'tok',
        temporaryPassword: 'Abcd-Efgh-Jkmn-Pqrs',
      },
      'https://tickets.example.test',
      new Date('2026-11-12T15:00:00Z'),
      { invite },
    );
    expect(mail.text).toContain('Palavra-passe temporária: Abcd-Efgh-Jkmn-Pqrs');
    expect(mail.text).toContain('Entrar no ZeroOps: https://tickets.example.test/login');
    expect(mail.text).not.toContain('/activate');
    expect(mail.text).not.toContain('tok');
    expect(mail.html).toContain('Abcd-Efgh-Jkmn-Pqrs');
    const existing = renderIdentityMail(
      'invite',
      { recipient: 'pedro@example.test', locale: 'pt-PT', token: 'tok' },
      'https://tickets.example.test',
      undefined,
      { invite: { ...invite, existingAccount: true } },
    );
    expect(existing.text).toContain('palavra-passe atual');
    expect(existing.text).not.toContain('temporária');
  });

  it('o convite explica a preparação da máquina, a ativação e anexa a CA do portal', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const invite = {
      displayName: 'Artur Teste',
      role: 'technical' as const,
      organization: 'deloitte' as const,
      projectName: 'Pizza Hut',
      invitedBy: 'Nuno Moreira',
    };
    const mail = renderIdentityMail(
      'invite',
      { recipient: 'artur@example.test', locale: 'pt-PT', token: 'tok' },
      'https://tickets.example.test',
      new Date('2026-11-12T15:00:00Z'),
      { invite, access: { hostsIp: '192.168.90.79', caCertificatePem: ca } },
    );
    expect(mail.subject).toBe('Convite para o ZeroOps');
    expect(mail.text).toContain('Nuno Moreira convidou-o');
    expect(mail.text).toContain('192.168.90.79 tickets.example.test');
    expect(mail.text).toContain('Test-NetConnection 192.168.90.79 -Port 443');
    expect(mail.text).toContain('Autoridades de Certificação de Raiz Fidedignas');
    expect(mail.text).toContain('Perfil: Técnico');
    expect(mail.text).toContain('aplicação autenticadora');
    expect(mail.text).toContain('https://tickets.example.test/login');
    expect(mail.text).toContain('/activate#token=tok');
    expect(mail.text).toContain('12/11/2026, 15:00 (hora de Lisboa)');
    expect(mail.html).toContain('Passo 3: ativar a conta');
    expect('attachments' in mail && mail.attachments).toEqual([
      expect.objectContaining({ filename: 'zeroops-ca.crt', content: ca }),
    ]);

    const client = renderIdentityMail(
      'invite',
      { recipient: 'cliente@example.test', locale: 'pt-PT', token: 'tok' },
      'https://tickets.example.test',
      undefined,
      { invite: { ...invite, role: 'client', organization: 'client' } },
    );
    expect(client.text).not.toContain('hosts');
    expect(client.text).not.toContain('aplicação autenticadora');
    expect(client.text).toContain('Passo 1: ativar a conta');
    expect('attachments' in client).toBe(false);
  });

  it('lê o acesso do convite do ambiente e ignora valores inválidos', () => {
    const access = identityMailConfigFromEnv({
      ZEROOPS_ACCESS_HOSTS_IP: 'not-an-ip',
      ZEROOPS_ACCESS_CA_FILE: '/nonexistent/ca.crt',
    }).access;
    expect(access).toEqual({ hostsIp: undefined, caCertificatePem: undefined });
  });

  it('a refused SMTP connection is a definite failure, not accepted delivery', async () => {
    const smtp = await smtpFixture('accept');
    await smtp.stop();
    const fixture = queueFixture();
    const service = new IdentityMailService(fixture.db, config(smtp.port));
    await service.enqueue(fixture.client, reset);
    await service.deliverPending();
    expect(fixture.rows[0]!.state).toBe('failed');
  });

  it.each(['accept', 'reject', 'uncertain'] as const)(
    'SMTP %s uses a real isolated relay and stable sanitized outcome',
    async (mode) => {
      const smtp = await smtpFixture(mode);
      try {
        const fixture = queueFixture();
        const service = new IdentityMailService(fixture.db, config(smtp.port));
        const { id } = await service.enqueue(fixture.client, reset);
        expect(await service.deliverPending()).toBe(1);
        const state = { accept: 'delivered', reject: 'failed', uncertain: 'uncertain' }[mode];
        expect(fixture.rows[0]!.state).toBe(state);
        expect(fixture.validations()).toBe(1);
        if (mode !== 'reject') {
          expect(smtp.received).toHaveLength(1);
          expect(smtp.received[0]).toContain(`Message-ID: <${id}@zeroops.example.test>`);
          expect(fixture.rows[0]!.payload_ciphertext).toBeNull();
        }
        expect(await service.retry(fixture.client, id, reset.userId!)).toBe(mode === 'reject');
        expect(JSON.stringify(fixture.rows)).not.toContain(reset.token);
      } finally {
        await smtp.stop();
      }
    },
  );

  it('does not contact SMTP for revoked or expired tokens, and never reclaims ambiguous leases', async () => {
    const fixture = queueFixture();
    const service = new IdentityMailService(fixture.db, config());
    const { id } = await service.enqueue(fixture.client, reset);
    fixture.revoke();
    await service.deliverPending();
    expect(fixture.rows[0]).toMatchObject({
      state: 'blocked',
      error_code: 'identity_reference_invalid',
      payload_ciphertext: null,
    });
    expect(await service.retry(fixture.client, id, reset.userId!)).toBe(false);
    await service.enqueue(fixture.client, reset);
    fixture.rows[1]!.expires_at = new Date(0);
    await service.deliverPending();
    expect(fixture.rows[1]!.error_code).toBe('message_expired');
    await service.enqueue(fixture.client, reset);
    fixture.rows[2]!.state = 'processing';
    fixture.rows[2]!.lease_id = 'old-worker';
    fixture.rows[2]!.lease_until = new Date(0);
    await service.deliverPending();
    expect(fixture.rows[2]).toMatchObject({
      state: 'uncertain',
      error_code: 'lease_expired',
      payload_ciphertext: null,
    });
  });

  it('blocks queued mail without falsely claiming delivery after configuration disappears', async () => {
    const fixture = queueFixture();
    const settings = config();
    const service = new IdentityMailService(fixture.db, settings);
    await service.enqueue(fixture.client, reset);
    settings.smtp = undefined;
    await service.deliverPending();
    expect(fixture.rows[0]).toMatchObject({ state: 'blocked', error_code: 'mail_not_configured' });
  });
});
