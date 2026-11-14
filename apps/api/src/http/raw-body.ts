import type { IncomingMessage } from 'node:http';
import { DomainError } from '../../../../packages/backend/src/errors.js';

const tooLarge = () => new DomainError('VALIDATION', 'Pedido demasiado grande.', 413);

/**
 * Lê o corpo bruto do pedido (formatos que o express.json não trata), com limite de tamanho.
 * Ao exceder o limite deixa de guardar e descarta o resto, para a resposta 413 chegar ao cliente.
 */
export function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  if (Number(request.headers['content-length'] ?? 0) > maxBytes) {
    request.resume();
    return Promise.reject(tooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total <= maxBytes) return void chunks.push(chunk);
      request.off('data', onData);
      request.resume();
      reject(tooLarge());
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}
