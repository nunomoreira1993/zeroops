import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/lib/api.ts';

test('authenticated mutations send JSON, same-origin cookies and the session CSRF token', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  const body = { body: 'Informação adicional', visibility: 'public' };
  await api('/tickets/example/comments', { method: 'POST', body }, 'csrf-from-session');
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, '/api/tickets/example/comments');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['X-CSRF-Token'], 'csrf-from-session');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), body);
});

test('missing CSRF prevents mutation before network access but allows explicit authentication', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  await assert.rejects(api('/tickets', { method: 'POST', body: {} }), {
    code: 'CSRF_MISSING',
    status: 401,
  });
  assert.equal(fetch.mock.callCount(), 0);
  await api('/auth/activate', { method: 'POST', body: { token: 'invite-token' } });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(fetch.mock.calls[0].arguments[1].headers['X-CSRF-Token'], undefined);
});

test('blocked infrastructure is an error, preserving service explanation and request reference', async (context) => {
  context.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        error: {
          code: 'executor_unavailable',
          message: 'Executor não validado.',
          requestId: 'request-reference',
        },
      },
      { status: 503 },
    ),
  );
  await assert.rejects(
    api('/tickets/example/decisions', { method: 'POST', body: {} }, 'csrf-token'),
    (error) =>
      error instanceof ApiError &&
      error.status === 503 &&
      error.code === 'executor_unavailable' &&
      error.requestId === 'request-reference' &&
      error.message === 'Executor não validado.',
  );
});

test('only explicit public identity endpoints skip session CSRF; challenge endpoints require it', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  for (const path of [
    '/auth/reset/request',
    '/auth/reset/confirm',
    '/auth/email/confirm',
    '/auth/mfa-reset/confirm',
  ]) {
    await api(path, { method: 'POST', body: {} });
  }
  assert.equal(fetch.mock.callCount(), 4);
  for (const path of [
    '/auth/challenge',
    '/auth/enrollment',
    '/auth/enrollment/confirm',
    '/account/reauth',
  ]) {
    await assert.rejects(api(path, { method: 'POST', body: {} }), { code: 'CSRF_MISSING' });
  }
  assert.equal(fetch.mock.callCount(), 4);
  await api('/auth/challenge', { method: 'POST', body: { code: '000000' } }, 'restricted-csrf');
  assert.equal(fetch.mock.calls[4].arguments[1].headers['X-CSRF-Token'], 'restricted-csrf');
});

test('network failures and non-JSON service failures are actionable errors', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(api('/tickets'), { code: 'NETWORK_ERROR', status: 0 });
  fetch.mock.mockImplementation(async () => new Response('Unavailable', { status: 502 }));
  await assert.rejects(api('/tickets'), { code: 'REQUEST_FAILED', status: 502 });
});
