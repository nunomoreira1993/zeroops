import { randomUUID } from 'node:crypto';
import type { AgentRunTrigger, CapabilityRunManifest } from '../../../../contracts/src/index.js';
import { capabilityManifestHash } from './capability-catalog.js';
import type {
  AgentProfileRunSnapshot,
  RepositoryResourceSnapshot,
} from '../../../../contracts/src/agent-profiles.js';
import type { Queryable } from '../identity/membership.js';
import type { TicketCreatedHook } from '../tickets/tickets.service.js';
import { ticketWorkPaused } from '../tickets/ticket-purge-health.js';

export const AUTO_INVESTIGATION_INSTRUCTIONS =
  'Pedido novo: faz a primeira análise. Percebe o problema, procura evidências no ambiente do pedido e propõe a resposta ao cliente. Se faltar informação essencial, pergunta ao cliente.';

/** O Copilot (integração partilhada do projeto) está configurado e verificado. */
export async function copilotReady(client: Queryable, projectId: string) {
  const found = await client.query(
    "SELECT 1 AS ok FROM integration_settings WHERE project_id=$1 AND kind='copilot' AND state='verified' LIMIT 1",
    [projectId],
  );
  return found.rowCount > 0;
}

/**
 * Enfileira um run automático (sem pedido humano). Devolve o id ou null quando o Copilot não
 * está pronto ou o ticket já tem uma investigação em curso.
 */
export async function queueAgentRun(
  client: Queryable,
  input: {
    ticketId: string;
    projectId: string;
    requestedBy: string;
    instructions: string;
    trigger: AgentRunTrigger;
    ticketVersion: number;
    /** Modo do executor: `implement` entrega uma proposta de alteração (diff). */
    mode?: 'investigate' | 'implement';
    /** Etapa do fluxo que pediu o run (retomada no fim do run). */
    flowStepId?: string;
    /** false: as perguntas ao cliente ficam só na nota interna. */
    clientQuestionsAllowed?: boolean;
    agentProfile?: AgentProfileRunSnapshot;
    repositorySnapshotHash?: string | null;
    repositoryResources?: RepositoryResourceSnapshot[];
    allowedTools?: string[];
    /** Skills e especialistas fixados para o run (P04). */
    capabilityManifest?: CapabilityRunManifest;
    /** Workspace Git persistente da etapa de desenvolvimento (P08). */
    developmentWorkspaceId?: string;
    /** Modelo pedido pela etapa (já validado); ausente = modelo da integração. */
    model?: {
      model: string | null;
      reasoningEffort: string | null;
      executionMode: 'copilot' | 'local';
      fusionTier: 'standard' | 'high' | 'max' | null;
    };
  },
): Promise<string | null> {
  if (await ticketWorkPaused(client, input.projectId)) return null;
  if (!(await copilotReady(client, input.projectId))) return null;
  const active = await client.query(
    "SELECT id FROM agent_runs WHERE ticket_id=$1 AND status IN ('queued','running') FOR UPDATE",
    [input.ticketId],
  );
  if (active.rowCount) return null;
  const runId = randomUUID();
  await client.query(
    `INSERT INTO agent_runs(id,ticket_id,project_id,requested_by,instructions,ticket_version,run_trigger,mode,flow_step_id,client_questions_allowed,model,reasoning_effort,execution_mode,fusion_tier,agent_profile_id,agent_profile_version,agent_profile_snapshot,repository_snapshot_hash,repository_resources,allowed_tools,capability_manifest,capability_manifest_hash,development_workspace_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      runId,
      input.ticketId,
      input.projectId,
      input.requestedBy,
      input.instructions,
      input.ticketVersion,
      input.trigger,
      input.mode ?? 'investigate',
      input.flowStepId ?? null,
      input.clientQuestionsAllowed ?? true,
      input.model?.model ?? null,
      input.model?.reasoningEffort ?? null,
      input.model?.executionMode ?? 'copilot',
      input.model?.fusionTier ?? null,
      input.agentProfile?.id ?? null,
      input.agentProfile?.version ?? null,
      input.agentProfile ?? null,
      input.repositorySnapshotHash ?? null,
      // Arrays seriam expandidos em listas SQL; as colunas JSON recebem texto serializado.
      input.repositoryResources ? JSON.stringify(input.repositoryResources) : null,
      input.allowedTools ? JSON.stringify(input.allowedTools) : null,
      input.capabilityManifest ? JSON.stringify(input.capabilityManifest) : null,
      input.capabilityManifest ? capabilityManifestHash(input.capabilityManifest) : null,
      input.developmentWorkspaceId ?? null,
    ],
  );
  await client.query(
    'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,NULL,$2,$3,$4)',
    [randomUUID(), input.ticketId, 'agent.run_requested', { runId, trigger: input.trigger }],
  );
  return runId;
}

/** Membro da equipa (admin/técnico ativo) em nome de quem corre um run pedido por um cliente. */
export async function teamRequester(client: Queryable, projectId: string) {
  const found = await client.query<{ id: string }>(
    `SELECT u.id FROM project_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.project_id=$1 AND NOT u.disabled AND NOT m.disabled AND m.role IN ('admin','technical')
      ORDER BY m.role<>'admin', u.email LIMIT 1`,
    [projectId],
  );
  return found.rows[0]?.id ?? null;
}

/**
 * Hook de criação de ticket: o Copilot investiga automaticamente cada pedido novo quando o
 * projeto o permite (`projects.agent_auto_investigate`) e a integração está verificada.
 */
export const autoInvestigateNewTicket: TicketCreatedHook = async (client, ticket, options) => {
  const project = (
    await client.query<{ auto: boolean }>(
      'SELECT agent_auto_investigate AS auto FROM projects WHERE id=$1',
      [ticket.projectId],
    )
  ).rows[0];
  if (!project?.auto) return;
  const requestedBy =
    ticket.creatorRole === 'client'
      ? await teamRequester(client, ticket.projectId)
      : ticket.createdBy;
  if (!requestedBy) return;
  await queueAgentRun(client, {
    ticketId: ticket.id,
    projectId: ticket.projectId,
    requestedBy,
    instructions: options.agentInstructions ?? AUTO_INVESTIGATION_INSTRUCTIONS,
    trigger: 'auto',
    ticketVersion: ticket.version,
  });
};
