import { createHmac, timingSafeEqual } from 'node:crypto';
import { PIPELINE_SIGNATURE_TOLERANCE_SECONDS } from '../../../../contracts/src/index.js';

/** Assinatura HMAC-SHA256 de um corpo: `sha256=<hex>` sobre `timestamp + "." + corpo`. */
export function signPipelinePayload(secret: string, timestamp: string, body: string | Buffer) {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.`);
  mac.update(body);
  return `sha256=${mac.digest('hex')}`;
}

/**
 * Verifica a assinatura de uma callback em tempo constante e rejeita carimbos fora da tolerância
 * (repetição de pedidos antigos). Não lança: devolve o motivo da recusa.
 */
export function verifyPipelineSignature(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: Buffer;
  now?: Date;
}): { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'invalid' } {
  if (!input.timestamp || !input.signature) return { ok: false, reason: 'missing' };
  if (!/^\d{9,12}$/.test(input.timestamp)) return { ok: false, reason: 'invalid' };
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(input.timestamp)) > PIPELINE_SIGNATURE_TOLERANCE_SECONDS)
    return { ok: false, reason: 'stale' };
  const expected = Buffer.from(signPipelinePayload(input.secret, input.timestamp, input.body));
  const received = Buffer.from(input.signature.trim());
  if (expected.length !== received.length || !timingSafeEqual(expected, received))
    return { ok: false, reason: 'invalid' };
  return { ok: true };
}
