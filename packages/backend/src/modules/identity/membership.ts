import { z } from 'zod';
import type { QueryResult, QueryResultRow } from '../../database/database.js';
import type { User } from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import { toUser, type UserRow } from './identity.rows.js';

export interface Queryable {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}
export const membershipColumns = `
  u.*, m.project_id, m.role, m.organization, (u.disabled OR m.disabled) AS disabled
`;
// Only contexts created by server-side authorization can bypass a missing membership.
const explicitProjectActors = new WeakSet<User>();
export const isProjectAdminContext = (actor: User) => explicitProjectActors.has(actor);

/** Authorizes an explicit project without granting membership or changing the session. */
export async function requireProjectAdmin(
  db: Queryable,
  actor: User,
  projectId: string,
  allowArchived = false,
  lock = false,
): Promise<User> {
  validateActor(actor);
  if (!z.uuid().safeParse(projectId).success)
    throw new DomainError('INVALID_INPUT', 'Projeto inválido.', 400);
  const project = await db.query<{ archived: boolean }>(
    `SELECT archived FROM projects WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
    [projectId],
  );
  if (!project.rows[0]) throw new DomainError('PROJECT_NOT_FOUND', 'Projeto não encontrado.', 404);
  const result = await db.query<UserRow>(
    `SELECT u.*,m.role,m.organization FROM users u
     LEFT JOIN project_memberships m ON m.user_id=u.id AND m.project_id=$2
     WHERE u.id=$1 AND NOT u.disabled
       AND (u.instance_admin OR (m.role='admin' AND NOT m.disabled))
     ${lock ? 'LOCK IN SHARE MODE' : ''}`,
    [actor.id, projectId],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError('FORBIDDEN', 'Sem administração deste projeto.', 403);
  if (project.rows[0].archived && !(allowArchived && row.instance_admin))
    throw new DomainError('PROJECT_ARCHIVED', 'Reative o projeto antes de continuar.', 409);
  const scoped = { ...toUser(row), projectId, role: 'admin' as const };
  explicitProjectActors.add(scoped);
  return scoped;
}

/** Rejeita contextos de ator inválidos antes de qualquer consulta de pertença. */
export function validateActor(actor: User): void {
  if (
    !actor ||
    !z.uuid().safeParse(actor.id).success ||
    !z.uuid().safeParse(actor.projectId).success
  ) {
    throw new DomainError('FORBIDDEN', 'Sem acesso a este projeto.', 403);
  }
}

/** Exige pertença ativa ao projeto e, opcionalmente, bloqueia a linha durante a transação. */
export async function requireMember(db: Queryable, actor: User, lock = false): Promise<User> {
  if (isProjectAdminContext(actor))
    return requireProjectAdmin(db, actor, actor.projectId, false, lock);
  validateActor(actor);
  const result = await db.query<UserRow>(
    `SELECT ${membershipColumns} FROM users u
     JOIN project_memberships m ON m.user_id=u.id
     JOIN projects p ON p.id=m.project_id
     WHERE u.id=$1 AND m.project_id=$2 AND NOT u.disabled AND NOT m.disabled AND NOT p.archived
     ${lock ? 'LOCK IN SHARE MODE' : ''}`,
    [actor.id, actor.projectId],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError('FORBIDDEN', 'Sem acesso a este projeto.', 403);
  return toUser(row);
}

/** Exige privilégios ativos de administração da instância, sem depender do papel no projeto. */
export async function requireInstanceAdmin(db: Queryable, actor: User, lock = false) {
  validateActor(actor);
  const result = await db.query<UserRow>(
    `SELECT * FROM users WHERE id=$1 AND instance_admin AND NOT disabled${lock ? ' LOCK IN SHARE MODE' : ''}`,
    [actor.id],
  );
  if (!result.rows[0])
    throw new DomainError('FORBIDDEN', 'Ação reservada à administração da instância.', 403);
  if (isProjectAdminContext(actor))
    return requireProjectAdmin(db, actor, actor.projectId, false, lock);
  return toUser(result.rows[0]);
}

/** Escolhe um contexto de projeto ativo sem elevar privilégios durante a autenticação. */
export async function defaultProjectContext(db: Queryable, row: UserRow, projectId?: string) {
  const membership = await db.query<UserRow>(
    `SELECT ${membershipColumns} FROM users u
     JOIN project_memberships m ON m.user_id=u.id
     JOIN projects p ON p.id=m.project_id
     WHERE u.id=$1 AND ($2 IS NULL OR m.project_id=$2)
       AND NOT u.disabled AND NOT m.disabled AND NOT p.archived
     ORDER BY (m.project_id=u.project_id) DESC, m.created_at, m.project_id LIMIT 1`,
    [row.id, projectId ?? null],
  );
  const current = membership.rows[0];
  if (current) return toUser(current);
  if (row.instance_admin && !row.disabled) return toUser(row);
  throw new DomainError('INVALID_CREDENTIALS', 'Não existe acesso ativo ao portal.', 401);
}

/**
 * Determina se a identidade exige MFA: por reposição administrativa, ou por perfil privilegiado
 * (administrador ou pertença não-cliente) quando o próprio utilizador não o desativou.
 */
export async function requiresMfa(db: Queryable, userId: string) {
  const result = await db.query<{ required: number }>(
    `SELECT (u.mfa_enrollment_required OR (NOT u.mfa_opt_out AND (u.instance_admin OR EXISTS (
       SELECT 1 FROM project_memberships m JOIN projects p ON p.id=m.project_id
       WHERE m.user_id=u.id AND NOT m.disabled AND NOT p.archived AND m.role<>'client'
     )))) AS required FROM users u WHERE u.id=$1 AND NOT u.disabled`,
    [userId],
  );
  if (!result.rows[0]) throw new DomainError('UNAUTHENTICATED', 'Conta indisponível.', 401);
  return Boolean(result.rows[0].required);
}
