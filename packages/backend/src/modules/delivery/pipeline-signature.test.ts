import { describe, expect, it } from 'vitest';
import { pipelineEndpointAllowed } from './pipelines.service.js';
import { signPipelinePayload, verifyPipelineSignature } from './pipeline-signature.js';

const secret = 'segredo-partilhado-com-mais-de-32-caracteres';
const now = new Date('2026-03-01T10:00:00Z');
const timestamp = String(Math.floor(now.getTime() / 1000));
const body = Buffer.from('{"status":"succeeded"}');

describe('assinatura das callbacks de pipeline', () => {
  it('aceita só o corpo exato assinado com o segredo e um carimbo recente', () => {
    const signature = signPipelinePayload(secret, timestamp, body);
    expect(verifyPipelineSignature({ secret, timestamp, signature, body, now })).toEqual({
      ok: true,
    });
    expect(
      verifyPipelineSignature({
        secret,
        timestamp,
        signature,
        body: Buffer.from('{"status":"failed"}'),
        now,
      }),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(
      verifyPipelineSignature({ secret: `${secret}x`, timestamp, signature, body, now }),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyPipelineSignature({ secret, timestamp, signature: undefined, body, now })).toEqual(
      { ok: false, reason: 'missing' },
    );
  });

  it('recusa a repetição de pedidos antigos', () => {
    const old = String(Number(timestamp) - 301);
    const signature = signPipelinePayload(secret, old, body);
    expect(verifyPipelineSignature({ secret, timestamp: old, signature, body, now })).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('endpoints só em origens autorizadas', () => {
    const origins = ['https://ci.example.test'];
    expect(pipelineEndpointAllowed('https://ci.example.test/hooks', origins)).toBe(true);
    expect(pipelineEndpointAllowed('https://ci.example.test.evil.test/hooks', origins)).toBe(false);
    expect(pipelineEndpointAllowed('http://ci.example.test/hooks', origins)).toBe(false);
    expect(pipelineEndpointAllowed('https://ci.example.test/hooks', [])).toBe(false);
  });
});
