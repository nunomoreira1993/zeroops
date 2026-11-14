import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../errors.js';

const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, parameters, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Gera hash scrypt com salt aleatório e parâmetros codificados para verificação futura. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Verifica o formato scrypt e compara o resultado em tempo constante, inclusive entradas inválidas. */
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const match = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded ?? '');
  const salt = match?.[1] ? Buffer.from(match[1], 'hex') : Buffer.alloc(16);
  const expected = match?.[2] ? Buffer.from(match[2], 'hex') : Buffer.alloc(64);
  const actual = await derive(password, salt);
  const matches = timingSafeEqual(actual, expected);
  return match !== null && matches;
}

/** Gera um segredo aleatório URL-safe com 256 bits. */
export function secret(): string {
  return randomBytes(32).toString('base64url');
}

const temporaryAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/**
 * Palavra-passe temporária legível (sem caracteres ambíguos) para o primeiro acesso de um convite:
 * 16 caracteres aleatórios (~92 bits) em grupos de quatro, por exemplo `Ab3d-Ef9h-Jk2m-Np4q`.
 */
export function temporaryPassword(): string {
  const limit = 256 - (256 % temporaryAlphabet.length);
  const chars: string[] = [];
  while (chars.length < 16) {
    for (const byte of randomBytes(32)) {
      if (byte < limit && chars.length < 16)
        chars.push(temporaryAlphabet[byte % temporaryAlphabet.length]!);
    }
  }
  return chars.join('').replace(/(.{4})(?=.)/g, '$1-');
}

/** Calcula SHA-256 hexadecimal para tokens e material de auditoria não reversível. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Valida o formato de token ZeroOps e devolve apenas o seu hash SHA-256. */
export function tokenHash(token: string): string {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new DomainError('INVALID_TOKEN', 'Token inválido ou expirado.', 401);
  }
  return sha256(token);
}
