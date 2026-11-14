import type { User } from '../../../../contracts/src/index.js';
import {
  PROJECT_LOGO_MAX_BYTES,
  projectLogoSchema,
  type ProjectLogoInput,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { auditIdentity } from './identity-security.js';
import { parseInput } from './identity.validation.js';
import {
  requireInstanceAdmin,
  requireProjectAdmin,
  isProjectAdminContext,
  validateActor,
} from './membership.js';

const svgForbidden = /<script|<foreignObject|<iframe|<embed|<object|\son[a-z]+\s*=|javascript:/i;

/** Confirma que o conteúdo corresponde ao tipo declarado (assinatura binária ou SVG sem scripts). */
export function decodeProjectLogo(input: ProjectLogoInput): Buffer {
  const data = Buffer.from(input.data, 'base64');
  const invalid = () =>
    new DomainError('INVALID_LOGO', 'O ficheiro não é uma imagem válida do tipo indicado.', 400);
  if (!data.length) throw invalid();
  if (data.length > PROJECT_LOGO_MAX_BYTES)
    throw new DomainError('LOGO_TOO_LARGE', 'O logotipo não pode exceder 256 KB.', 413);
  const ascii = (start: number, end: number) => data.subarray(start, end).toString('latin1');
  switch (input.mime) {
    case 'image/png':
      if (ascii(0, 8) !== '\x89PNG\r\n\x1a\n') throw invalid();
      break;
    case 'image/jpeg':
      if (data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) throw invalid();
      break;
    case 'image/webp':
      if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP') throw invalid();
      break;
    case 'image/svg+xml': {
      const text = data.toString('utf8');
      if (!/<svg[\s>]/i.test(text) || svgForbidden.test(text)) throw invalid();
      break;
    }
  }
  return data;
}

/** Logotipo do cliente por projeto: leitura por membros, alteração pela administração da instância. */
export class ProjectLogoService {
  constructor(private readonly db: Database) {}

  /** Devolve o logotipo se o ator pertence ao projeto ou administra a instância. */
  async read(actor: User, projectId: string) {
    validateActor(actor);
    const result = await this.db.query<{ logo_mime: string; logo_data: Buffer }>(
      `SELECT p.logo_mime,p.logo_data FROM projects p
       WHERE p.id=$1 AND p.logo_mime IS NOT NULL AND (
         EXISTS (SELECT 1 FROM project_memberships m JOIN users u ON u.id=m.user_id
           WHERE m.project_id=p.id AND m.user_id=$2 AND NOT m.disabled AND NOT u.disabled)
         OR EXISTS (SELECT 1 FROM users u WHERE u.id=$2 AND u.instance_admin AND NOT u.disabled))`,
      [projectId, actor.id],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('LOGO_NOT_FOUND', 'Logotipo não encontrado.', 404);
    return { mime: row.logo_mime, data: row.logo_data };
  }

  /** Substitui o logotipo, incrementa a versão (cache) e audita a alteração. */
  async update(actor: User, projectId: string, raw: unknown) {
    const input = parseInput(projectLogoSchema, raw);
    const data = decodeProjectLogo(input);
    return this.save(actor, projectId, input.mime, data, 'identity.project.logo_updated');
  }

  /** Remove o logotipo; a interface volta a mostrar as iniciais do projeto. */
  remove(actor: User, projectId: string) {
    return this.save(actor, projectId, null, null, 'identity.project.logo_removed');
  }

  private save(
    actor: User,
    projectId: string,
    mime: string | null,
    data: Buffer | null,
    action: string,
  ) {
    return this.db.transaction(async (client) => {
      if (isProjectAdminContext(actor))
        await requireProjectAdmin(client, actor, projectId, false, true);
      else await requireInstanceAdmin(client, actor, true);
      const updated = await client.query(
        'UPDATE projects SET logo_mime=$2,logo_data=$3,logo_version=logo_version+1 WHERE id=$1',
        [projectId, mime, data],
      );
      if (!updated.rowCount)
        throw new DomainError('PROJECT_NOT_FOUND', 'Projeto não encontrado.', 404);
      const version = await client.query<{ logo_version: number }>(
        'SELECT logo_version FROM projects WHERE id=$1',
        [projectId],
      );
      await auditIdentity(client, actor.id, action, projectId);
      return { logoVersion: mime ? (version.rows[0]?.logo_version ?? null) : null };
    });
  }
}
