import { z } from 'zod';

/** Fotografia de perfil: só formatos raster (o SVG pode conter scripts). */
export const userAvatarMimeTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const USER_AVATAR_MAX_BYTES = 512 * 1024;
export const userAvatarSchema = z.strictObject({
  mime: z.enum(userAvatarMimeTypes),
  /** Conteúdo em base64 (sem prefixo `data:`). */
  data: z
    .string()
    .max(Math.ceil(USER_AVATAR_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type UserAvatarInput = z.infer<typeof userAvatarSchema>;

/** URL autenticado da fotografia, versionado para a cache do browser; `null` sem fotografia. */
export const avatarUrl = (user: { id: string; avatarVersion?: number | null }) =>
  user.avatarVersion === null || user.avatarVersion === undefined
    ? null
    : `/api/users/${encodeURIComponent(user.id)}/avatar?v=${user.avatarVersion}`;
