import { createHash } from 'node:crypto';

/** Gera o hash usado para validar tokens de conector sem persistir o segredo em claro. */
export function connectorTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
