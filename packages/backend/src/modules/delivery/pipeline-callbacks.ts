import { z } from 'zod';
import { pipelineCallbackSchema } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import type { DeliveryStore } from './delivery.store.js';
import { verifyPipelineSignature } from './pipeline-signature.js';

/**
 * Recebe uma callback do fornecedor de pipeline: assinatura HMAC sobre o corpo exato (e carimbo
 * recente), contrato estrito e correlação pela chave de idempotência da entrega. Duplicados,
 * mensagens fora de ordem e mensagens tardias são aceites (2xx) mas não alteram o estado.
 */
export async function receivePipelineCallback(
  store: DeliveryStore,
  pipelineId: string,
  request: { timestamp?: string; signature?: string; body: Buffer | undefined },
) {
  const unauthorized = () =>
    new DomainError('PIPELINE_SIGNATURE', 'Assinatura da pipeline inválida.', 401);
  if (!z.uuid().safeParse(pipelineId).success || !request.body) throw unauthorized();
  const secret = await store.callbackSecret(pipelineId);
  if (!secret) throw unauthorized();
  const verified = verifyPipelineSignature({
    secret,
    timestamp: request.timestamp,
    signature: request.signature,
    body: request.body,
  });
  if (!verified.ok) throw unauthorized();
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body.toString('utf8'));
  } catch {
    throw new DomainError('VALIDATION', 'Callback inválida.', 400);
  }
  const event = pipelineCallbackSchema.safeParse(parsed);
  if (!event.success) throw new DomainError('VALIDATION', 'Callback inválida.', 400);
  const applied = await store.applyEvent(pipelineId, event.data, 'callback');
  if (!applied) throw new DomainError('NOT_FOUND', 'Entrega desconhecida.', 404);
  return applied;
}
