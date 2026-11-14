import { z } from 'zod';
import { roleSchema } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const displayNameSchema = z.string().trim().min(1).max(160);
export const passwordSchema = z.string().min(12).max(128);
export const inviteSchema = z.strictObject({
  email: emailSchema,
  displayName: displayNameSchema,
  role: roleSchema,
});
export const activationSchema = z.strictObject({
  token: z.string(),
  password: passwordSchema,
  displayName: displayNameSchema,
});
export const initialAdminSchema = z.strictObject({
  email: emailSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
});

/** Valida entrada externa com Zod e traduz falhas para o erro de domínio INVALID_INPUT. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainError('INVALID_INPUT', 'Os dados fornecidos são inválidos.', 400);
  }
  return result.data;
}
