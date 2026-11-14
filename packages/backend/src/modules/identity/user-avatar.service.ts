import type { User } from '../../../../contracts/src/index.js';
import {
  USER_AVATAR_MAX_BYTES,
  userAvatarSchema,
  type UserAvatarInput,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { auditIdentity } from './identity-security.js';
import { parseInput } from './identity.validation.js';
import { validateActor } from './membership.js';

/** Confirma que o conteúdo corresponde ao tipo declarado pela assinatura binária. */
export function decodeUserAvatar(input: UserAvatarInput): Buffer {
  const data = Buffer.from(input.data, 'base64');
  const invalid = () =>
    new DomainError('INVALID_AVATAR', 'O ficheiro não é uma imagem válida do tipo indicado.', 400);
  if (!data.length) throw invalid();
  if (data.length > USER_AVATAR_MAX_BYTES)
    throw new DomainError('AVATAR_TOO_LARGE', 'A fotografia não pode exceder 512 KB.', 413);
  const ascii = (start: number, end: number) => data.subarray(start, end).toString('latin1');
  const valid =
    (input.mime === 'image/png' && ascii(0, 8) === '\x89PNG\r\n\x1a\n') ||
    (input.mime === 'image/jpeg' && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) ||
    (input.mime === 'image/webp' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP');
  if (!valid) throw invalid();
  return data;
}

/**
 * Fotografia de perfil: cada pessoa gere a sua; vê-a quem partilha um projeto ativo com ela
 * (ou a administração da instância). Sem fotografia, a interface mostra as iniciais.
 */
export class UserAvatarService {
  constructor(private readonly db: Database) {}

  async read(actor: User, userId: string) {
    validateActor(actor);
    const result = await this.db.query<{ mime: string; data: Buffer }>(
      `SELECT a.mime, a.data FROM user_avatars a JOIN users target ON target.id=a.user_id
       WHERE a.user_id=$1 AND (
         a.user_id=$2
         OR EXISTS (SELECT 1 FROM users me WHERE me.id=$2 AND me.instance_admin AND NOT me.disabled)
         OR EXISTS (
           SELECT 1 FROM project_memberships mine
           JOIN project_memberships theirs ON theirs.project_id=mine.project_id
           JOIN users me ON me.id=mine.user_id
           WHERE mine.user_id=$2 AND theirs.user_id=a.user_id
             AND NOT mine.disabled AND NOT me.disabled))`,
      [userId, actor.id],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('AVATAR_NOT_FOUND', 'Fotografia não encontrada.', 404);
    return { mime: row.mime, data: row.data };
  }

  /** Substitui a fotografia do próprio e devolve a nova versão (cache do browser). */
  async update(actor: User, raw: unknown) {
    validateActor(actor);
    const input = parseInput(userAvatarSchema, raw);
    const data = decodeUserAvatar(input);
    return this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO user_avatars(user_id,mime,data,updated_at) VALUES($1,$2,$3,NOW(3))
         ON DUPLICATE KEY UPDATE mime=VALUES(mime), data=VALUES(data), updated_at=NOW(3)`,
        [actor.id, input.mime, data],
      );
      await client.query(
        'UPDATE users SET avatar_version=COALESCE(avatar_version,0)+1 WHERE id=$1',
        [actor.id],
      );
      const version = await client.query<{ avatar_version: number }>(
        'SELECT avatar_version FROM users WHERE id=$1',
        [actor.id],
      );
      await auditIdentity(client, actor.id, 'identity.account.avatar_updated', actor.id);
      return { avatarVersion: version.rows[0]?.avatar_version ?? null };
    });
  }

  /** Remove a fotografia; volta a mostrar as iniciais. */
  async remove(actor: User) {
    validateActor(actor);
    return this.db.transaction(async (client) => {
      await client.query('DELETE FROM user_avatars WHERE user_id=$1', [actor.id]);
      await client.query('UPDATE users SET avatar_version=NULL WHERE id=$1', [actor.id]);
      await auditIdentity(client, actor.id, 'identity.account.avatar_removed', actor.id);
      return { avatarVersion: null };
    });
  }
}
