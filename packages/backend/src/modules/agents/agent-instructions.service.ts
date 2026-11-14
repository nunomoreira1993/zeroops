import { randomUUID } from 'node:crypto';
import {
  agentChannelSettingsSchema,
  agentInstructionsInputSchema,
  type AgentInstructions,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { requireInstanceAdmin, requireMember, type Queryable } from '../identity/membership.js';
import { defaultInstructionsForSite } from './site-instructions.js';

/** Instruções iniciais da Pizza Hut (mantidas para compatibilidade; ver `site-instructions.ts`). */
export const DEFAULT_AGENT_INSTRUCTIONS = defaultInstructionsForSite('pizzahut');

/** Texto inicial do projeto enquanto não gravar instruções próprias (versão 0), conforme o site. */
async function projectDefaultInstructions(db: Queryable, projectId: string) {
  const row = (
    await db.query<{ siteKey: string | null }>(
      'SELECT site_key AS "siteKey" FROM projects WHERE id=$1',
      [projectId],
    )
  ).rows[0];
  return defaultInstructionsForSite(row?.siteKey);
}

const MAX_HISTORY = 10;

/** Instruções atuais do projeto (ou as por omissão), usadas no prompt de cada run. */
export async function currentAgentInstructions(db: Queryable, projectId: string) {
  const row = (
    await db.query<{ body: string }>(
      'SELECT body FROM project_agent_instructions WHERE project_id=$1 ORDER BY version DESC LIMIT 1',
      [projectId],
    )
  ).rows[0];
  return row?.body ?? (await projectDefaultInstructions(db, projectId));
}

/**
 * Instruções do agente por projeto, versionadas: cada gravação cria uma nova versão e fica na
 * auditoria. A equipa pode consultar; só a administração do projeto/instância as altera.
 */
export class AgentInstructionsService {
  constructor(private readonly db: Database) {}

  private async access(actor: User, manage = false) {
    const member = actor.instanceAdmin
      ? await requireInstanceAdmin(this.db, actor)
      : await requireMember(this.db, actor);
    const canManage = Boolean(actor.instanceAdmin) || member.role === 'admin';
    if (!actor.instanceAdmin && member.role === 'client')
      throw new DomainError('FORBIDDEN', 'As instruções do agente são reservadas à equipa.', 403);
    if (manage && !canManage)
      throw new DomainError('FORBIDDEN', 'Alteração reservada à administração do projeto.', 403);
    return { projectId: actor.projectId, canManage };
  }

  /** Versão atual, autor e histórico recente das instruções do projeto do ator. */
  async get(actor: User): Promise<AgentInstructions> {
    const { projectId, canManage } = await this.access(actor);
    const versions = await this.db.query<{
      version: number;
      body: string;
      created_at: Date;
      author: string | null;
    }>(
      `SELECT i.version, i.body, i.created_at, u.display_name AS author
       FROM project_agent_instructions i LEFT JOIN users u ON u.id=i.created_by
       WHERE i.project_id=$1 ORDER BY i.version DESC LIMIT ${MAX_HISTORY}`,
      [projectId],
    );
    const latest = versions.rows[0];
    const project = (
      await this.db.query<{ auto: boolean; investigate: boolean }>(
        'SELECT agent_auto_client_questions AS auto, agent_auto_investigate AS investigate FROM projects WHERE id=$1',
        [projectId],
      )
    ).rows[0];
    return {
      body: latest?.body ?? (await projectDefaultInstructions(this.db, projectId)),
      version: latest?.version ?? 0,
      isDefault: !latest,
      updatedAt: latest?.created_at.toISOString() ?? null,
      updatedBy: latest?.author ?? null,
      canManage,
      autoClientQuestions: project?.auto ?? true,
      autoInvestigate: project?.investigate ?? true,
      history: versions.rows.map((row) => ({
        version: row.version,
        createdAt: row.created_at.toISOString(),
        author: row.author,
      })),
    };
  }

  /** Grava uma nova versão se `expectedVersion` ainda for a atual (controlo de concorrência). */
  async save(actor: User, input: unknown): Promise<AgentInstructions> {
    const parsed = agentInstructionsInputSchema.safeParse(input);
    if (!parsed.success)
      throw new DomainError(
        'VALIDATION',
        'As instruções têm de ter entre 20 e 20000 caracteres.',
        400,
      );
    const { projectId } = await this.access(actor, true);
    await this.db.transaction(async (client) => {
      const current =
        (
          await client.query<{ version: number }>(
            'SELECT MAX(version) AS version FROM project_agent_instructions WHERE project_id=$1 FOR UPDATE',
            [projectId],
          )
        ).rows[0]?.version ?? 0;
      if (current !== parsed.data.expectedVersion)
        throw new DomainError(
          'CONFLICT',
          'As instruções foram alteradas entretanto. Recarregue a página.',
          409,
        );
      const version = current + 1;
      await client.query(
        'INSERT INTO project_agent_instructions(id,project_id,version,body,created_by) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), projectId, version, parsed.data.body, actor.id],
      );
      await client.query(
        'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,$2,NULL,$3,$4)',
        [
          randomUUID(),
          actor.id,
          'agent.instructions.saved',
          { projectId, version, length: parsed.data.body.length },
        ],
      );
    });
    return this.get(actor);
  }

  /** Opções do canal do agente: perguntas automáticas ao cliente e investigação automática. */
  async saveSettings(actor: User, input: unknown): Promise<AgentInstructions> {
    const parsed = agentChannelSettingsSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('VALIDATION', 'Definição inválida.', 400);
    const { projectId } = await this.access(actor, true);
    const { autoClientQuestions, autoInvestigate } = parsed.data;
    await this.db.transaction(async (client) => {
      if (autoClientQuestions !== undefined)
        await client.query('UPDATE projects SET agent_auto_client_questions=$2 WHERE id=$1', [
          projectId,
          autoClientQuestions,
        ]);
      if (autoInvestigate !== undefined)
        await client.query('UPDATE projects SET agent_auto_investigate=$2 WHERE id=$1', [
          projectId,
          autoInvestigate,
        ]);
      await client.query(
        'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,$2,NULL,$3,$4)',
        [
          randomUUID(),
          actor.id,
          'agent.settings.saved',
          { projectId, autoClientQuestions, autoInvestigate },
        ],
      );
    });
    return this.get(actor);
  }
}
