import { createHash, randomUUID } from 'node:crypto';
import {
  decisionSchema,
  proposalInputSchema,
  transitionSchema,
  type Capabilities,
  type Proposal,
  type TicketStatus,
  type Role,
  type User,
  preExecutionStatuses,
} from '../../../../contracts/src/index.js';
import { Database, type PoolClient } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { requireMember } from '../identity/membership.js';
import { approveStage } from './domain/approval.js';
import { nextTicketStatus } from './domain/ticket-transition.js';
import { invalidateTicketDependencies } from '../tickets/ticket-dependencies.js';
import { appendHumanComment } from '../tickets/ticket-comments.js';
import { recordTicketMove } from '../tickets/ticket-move.js';

interface LockedTicket {
  id: string;
  status: TicketStatus;
  version: number;
  actorRole: Role;
}
interface ProposalRow {
  id: string;
  hash: string;
  version: number;
  summary: string;
  steps: string[];
  acceptance_criteria: string[];
  risks: string[];
  created_at: Date;
}

const approvalStages: Partial<Record<TicketStatus, 'client' | 'technical' | 'qa' | 'release'>> = {
  awaiting_client: 'client',
  awaiting_technical: 'technical',
  awaiting_qa: 'qa',
  awaiting_release: 'release',
};

/** Casos de uso de propostas, aprovações e transições auditadas do ticket. */
export class WorkflowService {
  constructor(
    private readonly db: Database,
    private readonly capabilities: Capabilities,
  ) {}

  private async lock(client: PoolClient, actor: User, id: string, version: number) {
    const member = await requireMember(client, actor, true);
    const result = await client.query<Omit<LockedTicket, 'actorRole'>>(
      'SELECT id,status,version FROM tickets WHERE id=$1 AND project_id=$2 FOR UPDATE',
      [id, actor.projectId],
    );
    const row = result.rows[0];
    const ticket = row ? { ...row, actorRole: member.role } : null;
    if (!ticket) throw new DomainError('not_found', 'Ticket nao encontrado.', 404);
    if (ticket.version !== version)
      throw new DomainError('stale_version', 'O ticket mudou. Recarregue a pagina.');
    return ticket;
  }

  private async move(
    client: PoolClient,
    actor: User,
    ticket: LockedTicket,
    to: TicketStatus,
    action: string,
  ) {
    await recordTicketMove(client, {
      ticketId: ticket.id,
      projectId: actor.projectId,
      from: ticket.status,
      to,
      version: ticket.version,
      actorId: actor.id,
      action,
    });
  }

  /** Devolve a proposta válida mais recente do ticket, se existir. */
  async currentProposal(actor: User, ticketId: string): Promise<Proposal | null> {
    await requireMember(this.db, actor);
    const result = await this.db.query<ProposalRow>(
      `SELECT p.* FROM proposals p JOIN tickets t ON t.id=p.ticket_id
      WHERE t.id=$1 AND t.project_id=$2 AND p.invalidated_at IS NULL ORDER BY p.version DESC LIMIT 1`,
      [ticketId, actor.projectId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          hash: row.hash,
          version: row.version,
          summary: row.summary,
          steps: row.steps,
          acceptanceCriteria: row.acceptance_criteria,
          risks: row.risks,
          createdAt: row.created_at.toISOString(),
        }
      : null;
  }

  /** Resolve o hash da proposta ou candidato que a etapa atual deve aprovar. */
  async approvalHash(actor: User, ticketId: string, status: TicketStatus) {
    await requireMember(this.db, actor);
    if (status === 'awaiting_qa' || status === 'awaiting_release' || status === 'deploying') {
      const result = await this.db.query<{ candidate_hash: string }>(
        `SELECT r.candidate_hash FROM execution_runs r
        JOIN tickets t ON t.id=r.ticket_id WHERE t.id=$1 AND t.project_id=$2 AND r.status='completed' AND r.invalidated_at IS NULL
        ORDER BY r.created_at DESC LIMIT 1`,
        [ticketId, actor.projectId],
      );
      return result.rows[0]?.candidate_hash ?? null;
    }
    return (await this.currentProposal(actor, ticketId))?.hash ?? null;
  }

  /** Publica proposta versionada após verificar papel, estado, responsáveis e não autoaprovação. */
  async publishProposal(actor: User, ticketId: string, raw: unknown) {
    const input = proposalInputSchema.parse(raw);
    await this.db.transaction(async (client) => {
      const ticket = await this.lock(client, actor, ticketId, input.expectedVersion);
      if (!['technical', 'admin'].includes(ticket.actorRole))
        throw new DomainError('forbidden', 'Apenas a equipa tecnica publica propostas.', 403);
      if (
        !preExecutionStatuses.includes(ticket.status) ||
        ticket.status === 'awaiting_information'
      ) {
        throw new DomainError(
          'invalid_state',
          'Nao pode substituir uma proposta durante implementacao ou QA.',
        );
      }
      const assignments = await client.query<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM ticket_assignments a
         JOIN project_memberships m ON m.user_id=a.user_id AND m.project_id=a.project_id
         JOIN users u ON u.id=a.user_id
         WHERE a.ticket_id=$1 AND NOT m.disabled AND NOT u.disabled
           AND ((a.stage='client' AND m.role='client')
             OR (a.stage='technical' AND m.role='technical')
             OR (a.stage='qa' AND m.role='qa')
             OR (a.stage='release' AND m.role='release'))`,
        [ticketId],
      );
      if (Number(assignments.rows[0]?.count) !== 4)
        throw new DomainError(
          'assignments_incomplete',
          'Atribua quatro responsáveis distintos antes de publicar a proposta.',
        );
      const technicalAssignee = await client.query<{ user_id: string }>(
        `SELECT user_id FROM ticket_assignments
         WHERE ticket_id=$1 AND stage='technical'`,
        [ticketId],
      );
      if (technicalAssignee.rows[0]?.user_id === actor.id)
        throw new DomainError(
          'self_approval',
          'O responsável técnico atribuído não pode publicar a proposta que terá de aprovar.',
          403,
        );
      const content = {
        summary: input.summary,
        steps: input.steps,
        acceptanceCriteria: input.acceptanceCriteria,
        risks: input.risks,
      };
      await invalidateTicketDependencies(client, actor, ticketId, ticket.version + 1, 'proposal');
      const hash = createHash('sha256')
        .update(JSON.stringify({ ...content, version: ticket.version + 1 }))
        .digest('hex');
      await client.query(
        `INSERT INTO proposals(id,ticket_id,version,hash,summary,steps,acceptance_criteria,risks,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          ticketId,
          ticket.version + 1,
          hash,
          input.summary,
          JSON.stringify(input.steps),
          JSON.stringify(input.acceptanceCriteria),
          JSON.stringify(input.risks),
          actor.id,
        ],
      );
      await this.move(client, actor, ticket, 'awaiting_client', 'proposal.published');
    });
    return this.currentProposal(actor, ticketId);
  }

  /** Regista a decisão do responsável atribuído sobre o hash atual e cria runs apenas se autorizados. */
  async decide(actor: User, ticketId: string, raw: unknown) {
    const input = decisionSchema.parse(raw);
    await this.db.transaction(async (client) => {
      const ticket = await this.lock(client, actor, ticketId, input.expectedVersion);
      const candidateStage = ['awaiting_qa', 'awaiting_release'].includes(ticket.status);
      const approvalStage = approvalStages[ticket.status];
      if (!approvalStage)
        throw new DomainError('invalid_state', 'Esta etapa não permite uma decisão.');
      const assigned = await client.query<{ user_id: string; role: Role }>(
        `SELECT a.user_id, m.role
         FROM ticket_assignments a
         JOIN project_memberships m ON m.user_id=a.user_id AND m.project_id=a.project_id
         JOIN users u ON u.id=a.user_id
         WHERE a.ticket_id=$1 AND a.stage=$2
           AND NOT m.disabled AND NOT u.disabled`,
        [ticketId, approvalStage],
      );
      if (assigned.rows[0]?.user_id !== actor.id || assigned.rows[0]?.role !== ticket.actorRole)
        throw new DomainError(
          'forbidden',
          'A decisão está reservada ao responsável ativo atribuído a esta etapa.',
          403,
        );
      const result = candidateStage
        ? await client.query<{ hash: string }>(
            "SELECT candidate_hash AS hash FROM execution_runs WHERE ticket_id=$1 AND status='completed' AND invalidated_at IS NULL ORDER BY created_at DESC LIMIT 1",
            [ticketId],
          )
        : await client.query<{ hash: string }>(
            'SELECT hash FROM proposals WHERE ticket_id=$1 AND invalidated_at IS NULL ORDER BY version DESC LIMIT 1',
            [ticketId],
          );
      const hash = result.rows[0]?.hash;
      if (!hash)
        throw new DomainError('missing_artifact', 'Nao existe artefacto verificavel para aprovar.');
      if (ticket.status === 'awaiting_technical') {
        const proposal = await client.query<{ created_by: string }>(
          'SELECT created_by FROM proposals WHERE ticket_id=$1 AND invalidated_at IS NULL ORDER BY version DESC LIMIT 1',
          [ticketId],
        );
        if (proposal.rows[0]?.created_by === actor.id)
          throw new DomainError(
            'self_approval',
            'Quem publicou a proposta não pode aprová-la na etapa técnica.',
            403,
          );
      }
      const next = approveStage({
        status: ticket.status,
        version: ticket.version,
        expectedVersion: input.expectedVersion,
        hash,
        expectedHash: input.artifactHash,
        role: ticket.actorRole,
        decision: input.decision,
        notes: input.notes,
      });
      if (next === 'implementing' && !this.capabilities.implementation) {
        throw new DomainError(
          'executor_unavailable',
          'Executor isolado ainda nao validado. Autorizacao nao consumida.',
          503,
        );
      }
      if (next === 'deploying' && !this.capabilities.deployment) {
        throw new DomainError(
          'deployment_unavailable',
          'Destino e operador de deploy ainda nao validados. Aprovacao nao consumida.',
          503,
        );
      }
      await client.query(
        `INSERT INTO approvals(id,ticket_id,ticket_version,stage,artifact_hash,actor_id,decision,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          ticketId,
          ticket.version,
          ticket.status,
          hash,
          actor.id,
          input.decision,
          input.notes,
        ],
      );
      await this.move(client, actor, ticket, next, `approval.${input.decision}`);
      if (next === 'implementing' || next === 'deploying') {
        const runId = randomUUID();
        if (next === 'implementing') {
          await client.query(
            `INSERT INTO execution_runs(id,ticket_id,ticket_version,proposal_hash,status) VALUES($1,$2,$3,$4,'pending')`,
            [runId, ticketId, ticket.version + 1, hash],
          );
        } else {
          await client.query(
            `INSERT INTO deployment_runs(id,ticket_id,ticket_version,candidate_hash,status) VALUES($1,$2,$3,$4,'pending')`,
            [runId, ticketId, ticket.version + 1, hash],
          );
        }
        await client.query('INSERT INTO notification_outbox(id,topic,payload) VALUES($1,$2,$3)', [
          randomUUID(),
          next === 'implementing' ? 'execution.requested' : 'deployment.requested',
          JSON.stringify({ runId, ticketId, hash }),
        ]);
      }
    });
    return { ok: true };
  }

  /** Executa uma transição permitida ao papel/estado e mantém eventos e auditoria consistentes. */
  async transition(actor: User, ticketId: string, raw: unknown) {
    const input = transitionSchema.parse(raw);
    await this.db.transaction(async (client) => {
      const ticket = await this.lock(client, actor, ticketId, input.expectedVersion);
      const next = nextTicketStatus(ticket.status, ticket.actorRole, input.action);
      if (input.action === 'cancel' || input.action === 'reopen')
        await invalidateTicketDependencies(
          client,
          actor,
          ticketId,
          ticket.version + 1,
          input.action,
        );
      await this.move(client, actor, ticket, next, `ticket.${input.action}`);
      await appendHumanComment(
        client,
        await requireMember(client, actor),
        ticketId,
        input.notes,
        'public',
      );
    });
    return { ok: true };
  }
}
