import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { User } from '../../../../packages/contracts/src/index.js';
import { IdentityService } from '../../../../packages/backend/src/modules/identity/identity.service.js';
import { countIdentityRequest } from '../../../../packages/backend/src/modules/identity/identity-security.js';
import { DomainError } from '../../../../packages/backend/src/errors.js';
import { sendError } from './errors.js';
import { MemoryRequestLimiter } from './memory-request-limiter.js';
import type { Database } from '../../../../packages/backend/src/database/database.js';

export interface AuthenticatedRequest extends Request {
  identity: User;
  csrfToken: string;
}

export function sessionToken(request: Request) {
  return (
    /(?:^|;\s*)zeroops_session=([a-zA-Z0-9_-]{32,256})(?:;|$)/.exec(
      request.headers.cookie ?? '',
    )?.[1] ?? ''
  );
}
export function challengeToken(request: Request) {
  return (
    /(?:^|;\s*)zeroops_challenge=([a-zA-Z0-9_-]{43})(?:;|$)/.exec(
      request.headers.cookie ?? '',
    )?.[1] ?? ''
  );
}

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const fallbackLimiter = new MemoryRequestLimiter();

/** IP do cliente; atras do proxy local usa a entrada que o proprio proxy acrescentou. */
export function clientAddress(request: Request, trustLoopbackProxy = false) {
  const socket = request.socket.remoteAddress ?? 'unknown';
  if (!trustLoopbackProxy || !loopback.has(socket)) return socket;
  const header = request.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return forwarded.at(-1) ?? socket;
}

export function sessionMiddleware(
  identity: IdentityService,
  publicUrl: string,
  db: Database,
  trustLoopbackProxy = false,
) {
  const origin = new URL(publicUrl).origin;
  return async (request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Request-Id', randomUUID());
    response.setHeader('Cache-Control', 'no-store');
    const path = request.path.toLowerCase().replace(/\/+$/, '');
    if (path !== '/api' && !path.startsWith('/api/')) return next();
    try {
      const mutation = !['GET', 'HEAD'].includes(request.method);
      // Agente de saude e relay de Producao: sem sessao/origem; o token Bearer e validado no servico.
      const tokenEndpoint =
        (path === '/api/monitoring/ingest' ||
          path === '/api/monitoring/agent-config' ||
          path === '/api/monitoring/alertmanager' ||
          path === '/api/monitoring/remote-write' ||
          path.startsWith('/api/relay/') ||
          /^\/api\/pipelines\/[^/]+\/callbacks$/.test(path)) &&
        request.method === 'POST';
      if (tokenEndpoint) {
        const remoteWrite = path === '/api/monitoring/remote-write';
        if (!request.is(remoteWrite ? 'application/x-protobuf' : 'application/json'))
          throw new DomainError(
            'invalid_origin',
            'Origem ou formato do pedido nao permitido.',
            403,
          );
        const key = createHash('sha256')
          .update(
            `${clientAddress(request, trustLoopbackProxy)}:${path.startsWith('/api/relay/') ? '/api/relay' : path}`,
          )
          .digest('hex');
        // Relay (long-poll) e remote write (lotes a cada ~30s) têm mais pedidos que o agente/webhook.
        const limit = path.startsWith('/api/relay/')
          ? 1200
          : remoteWrite
            ? 600
            : path.startsWith('/api/pipelines/')
              ? 300
              : 120;
        // Com a BD em baixo o pedido segue para o serviço (fila em disco), limitado em memória.
        const count = await countIdentityRequest(db, key).catch((error: unknown) => {
          if (error instanceof DomainError) throw error;
          return fallbackLimiter.hit(key);
        });
        if (count > limit)
          throw new DomainError('rate_limit', 'Demasiados pedidos. Tente mais tarde.', 429);
        return next();
      }
      if (mutation && (request.headers.origin !== origin || !request.is('application/json'))) {
        throw new DomainError('invalid_origin', 'Origem ou formato do pedido nao permitido.', 403);
      }
      const open =
        (path === '/api/health' && request.method === 'GET') ||
        ([
          '/api/auth/login',
          '/api/auth/activate',
          '/api/auth/reset/request',
          '/api/auth/reset/confirm',
          '/api/auth/email/confirm',
          '/api/auth/mfa-reset/confirm',
        ].includes(path) &&
          request.method === 'POST');
      const challenge = [
        '/api/auth/challenge',
        '/api/auth/enrollment',
        '/api/auth/enrollment/confirm',
      ].includes(path);
      if (
        mutation &&
        (open || challenge || path === '/api/account/reauth' || path === '/api/account/mfa/confirm')
      ) {
        const key = createHash('sha256')
          .update(`${clientAddress(request, trustLoopbackProxy)}:${path}`)
          .digest('hex');
        const count = await countIdentityRequest(db, key);
        const max = path.includes('/reset/request') ? 5 : 30;
        if (count > max)
          throw new DomainError('rate_limit', 'Demasiadas tentativas. Tente mais tarde.', 429);
      }
      if (challenge) {
        const state = await identity.authentication.challenge(challengeToken(request));
        if (mutation) {
          const received = request.headers['x-csrf-token'];
          if (
            typeof received !== 'string' ||
            !timingSafeEqual(
              createHash('sha256').update(received).digest(),
              createHash('sha256').update(state.csrfToken).digest(),
            )
          )
            throw new DomainError('csrf', 'Sessão inválida. Inicie sessão novamente.', 403);
        }
        return next();
      }
      if (open) {
        return next();
      }
      const session = await identity.authenticate(sessionToken(request));
      // Primeiro acesso com a palavra-passe temporária: só é possível definir a nova ou sair.
      if (
        mutation &&
        session.user.passwordChangeRequired &&
        !['/api/account/initial-password', '/api/auth/logout'].includes(path)
      )
        throw new DomainError(
          'PASSWORD_CHANGE_REQUIRED',
          'Defina uma nova palavra-passe antes de continuar.',
          403,
        );
      if (mutation) {
        const received = request.headers['x-csrf-token'];
        if (typeof received !== 'string')
          throw new DomainError('csrf', 'Sessao invalida. Recarregue a pagina.', 403);
        const hash = createHash('sha256').update(received).digest();
        const expected = Buffer.from(session.csrfHash, 'hex');
        if (hash.length !== expected.length || !timingSafeEqual(hash, expected))
          throw new DomainError('csrf', 'Sessao invalida. Recarregue a pagina.', 403);
      }
      const authenticated = request as AuthenticatedRequest;
      authenticated.identity = session.user;
      authenticated.csrfToken = session.csrfToken;
      next();
    } catch (error) {
      sendError(error, response);
    }
  };
}
