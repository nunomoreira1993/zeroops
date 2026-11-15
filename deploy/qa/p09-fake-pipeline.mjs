// Fornecedor de pipeline FALSO para ensaios P09 em QA (nunca em Produção).
// Implementa o contrato `webhook` do ZeroOps: POST /deliveries, GET /deliveries/:key,
// POST /deliveries/:key/cancel, pedidos e callbacks assinados (HMAC-SHA256 sobre
// `timestamp.corpo`). Não publica nada: só simula estados e checks.
//
// Ambiente: SECRET (obrigatório, igual ao da pipeline), PORT (8787), HOST (127.0.0.1),
// CALLBACK_ORIGIN (opcional: substitui a origem do callbackUrl, ex. http://127.0.0.1:4311 para
// chegar à API sem passar pelo proxy público), STEP_MS (2000, intervalo entre estados).
// Controlo de ensaio (sem assinatura; só na rede interna): POST /_mode {"mode":"normal"|"drop"|"fail"}
// aplica-se ao próximo POST /deliveries; GET /_stats lista entregas e contagem de pedidos.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const secret = process.env.SECRET ?? '';
if (secret.length < 32) throw new Error('SECRET em falta (mínimo 32 caracteres).');
const port = Number(process.env.PORT ?? 8787);
const stepMs = Number(process.env.STEP_MS ?? 2000);
const callbackOrigin = process.env.CALLBACK_ORIGIN ?? '';
const deliveries = new Map();
let nextMode = 'normal';
let counter = 0;

const sign = (timestamp, body) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`;

function verified(req, body) {
  const timestamp = String(req.headers['x-zeroops-timestamp'] ?? '');
  const received = Buffer.from(String(req.headers['x-zeroops-signature'] ?? ''));
  const expected = Buffer.from(sign(timestamp, body));
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
  return fresh && received.length === expected.length && timingSafeEqual(received, expected);
}

function event(delivery, extra = {}) {
  return {
    eventId: `${delivery.externalId}:${delivery.sequence}:${delivery.status}`,
    idempotencyKey: delivery.key,
    externalId: delivery.externalId,
    sequence: delivery.sequence,
    status: delivery.status,
    sha: delivery.sha,
    artifactDigest: delivery.artifactDigest,
    checks: delivery.checks,
    ...extra,
  };
}

async function callback(delivery, payload) {
  if (!delivery.callbackUrl) return;
  let url = delivery.callbackUrl;
  if (callbackOrigin) url = callbackOrigin + new URL(url).pathname;
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zeroops-timestamp': timestamp,
        'x-zeroops-signature': sign(timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    delivery.callbacks.push({
      eventId: payload.eventId,
      status: res.status,
      response: text.slice(0, 200),
    });
  } catch (error) {
    delivery.callbacks.push({ eventId: payload.eventId, error: String(error) });
  }
}

function advance(delivery, status, checks) {
  if (['succeeded', 'failed', 'cancelled'].includes(delivery.status)) return false;
  delivery.sequence += 1;
  delivery.status = status;
  delivery.checks = checks;
  return true;
}

function schedule(delivery) {
  setTimeout(async () => {
    if (!advance(delivery, 'running', [{ name: 'deploy-qa-fake', status: 'running' }])) return;
    const running = event(delivery);
    await callback(delivery, running);
    setTimeout(async () => {
      const ok = delivery.mode !== 'fail';
      if (
        !advance(delivery, ok ? 'succeeded' : 'failed', [
          { name: 'deploy-qa-fake', status: ok ? 'passed' : 'failed' },
        ])
      )
        return;
      const final = event(delivery, ok ? {} : { message: 'Falha simulada pelo fornecedor falso.' });
      await callback(delivery, final);
      // Duplicado exato e mensagem antiga fora de ordem: o ZeroOps não pode regredir nem repetir.
      await callback(delivery, final);
      await callback(delivery, { ...running, eventId: `${running.eventId}:late` });
    }, stepMs);
  }, stepMs);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function handle(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url ?? '/', 'http://fake');
  if (url.pathname === '/_mode' && req.method === 'POST') {
    nextMode = JSON.parse(raw || '{}').mode ?? 'normal';
    return send(res, 200, { mode: nextMode });
  }
  if (url.pathname === '/_stats') return send(res, 200, { deliveries: [...deliveries.values()] });
  if (!verified(req, raw)) return send(res, 401, { error: 'assinatura inválida' });
  if (url.pathname === '/deliveries' && req.method === 'POST') {
    const input = JSON.parse(raw);
    const existing = deliveries.get(input.idempotencyKey);
    if (existing) {
      existing.posts += 1;
      return send(res, 409, { externalId: existing.externalId });
    }
    const mode = nextMode;
    nextMode = 'normal';
    const delivery = {
      key: input.idempotencyKey,
      externalId: `fake-${++counter}`,
      ticket: input.ticket,
      ref: input.ref,
      sha: input.sha,
      artifactDigest: input.artifactDigest,
      environment: input.environment,
      callbackUrl: input.callbackUrl,
      mode,
      posts: 1,
      gets: 0,
      sequence: 0,
      status: 'accepted',
      checks: [],
      callbacks: [],
      receivedAt: new Date().toISOString(),
    };
    deliveries.set(delivery.key, delivery);
    schedule(delivery);
    // `drop`: aceita mas não responde dentro do prazo do executor (resultado incerto).
    if (mode === 'drop')
      return setTimeout(() => send(res, 202, { externalId: delivery.externalId }), 60_000);
    return send(res, 202, { externalId: delivery.externalId });
  }
  const match = /^\/deliveries\/([0-9a-f-]{36})(\/cancel)?$/.exec(url.pathname);
  const delivery = match ? deliveries.get(match[1]) : undefined;
  if (!match) return send(res, 404, { error: 'rota desconhecida' });
  if (!delivery) return send(res, 404, { error: 'entrega desconhecida' });
  if (match[2] && req.method === 'POST') {
    if (advance(delivery, 'cancelled', delivery.checks)) await callback(delivery, event(delivery));
    return send(res, 202, { externalId: delivery.externalId });
  }
  delivery.gets += 1;
  return send(res, 200, event(delivery));
}

createServer((req, res) => {
  handle(req, res).catch((error) => send(res, 400, { error: String(error) }));
}).listen(port, process.env.HOST ?? '127.0.0.1', () =>
  console.log(`p09-fake-pipeline a escutar em ${port}`),
);
