import { randomUUID } from 'node:crypto';
import type { User } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';

type ActorRow = {
  id: string;
  project_id: string;
  email: string;
  display_name: string;
  role: User['role'];
  instance_admin: number | boolean;
};

/**
 * Operacoes de servidor (CLI `zeroops-ops`) em nome de um administrador existente.
 * Nao conhece passwords: quem tem acesso root ao servidor ja controla a BD e a chave de cifra.
 * Usa os mesmos servicos que a UI (mesmas validacoes e auditoria); o comando fica auditado como `ops.cli`.
 */
export class OperatorSession {
  private constructor(
    private readonly db: Database,
    readonly actor: User,
  ) {}

  /** Abre contexto CLI apenas para conta ativa com papel de administrador. */
  static async forAdmin(db: Database, email: string) {
    const found = await db.query<ActorRow>(
      `SELECT id,project_id,email,display_name,role,instance_admin FROM users
       WHERE email=$1 AND NOT disabled`,
      [email.trim()],
    );
    const row = found.rows[0];
    if (!row || (!row.instance_admin && row.role !== 'admin'))
      throw new DomainError('FORBIDDEN', `Sem administrador ativo com o e-mail ${email}.`, 403);
    return new OperatorSession(db, {
      id: row.id,
      projectId: row.project_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      instanceAdmin: Boolean(row.instance_admin),
    });
  }

  /** Regista comando operacional sem incluir credenciais no evento de auditoria. */
  async audit(command: string, details: Record<string, unknown> = {}) {
    await this.db.query(
      `INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,'ops.cli',$3)`,
      [randomUUID(), this.actor.id, JSON.stringify({ command, ...details })],
    );
  }
}
