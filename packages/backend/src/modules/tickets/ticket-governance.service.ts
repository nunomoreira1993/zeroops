import { createHash, randomUUID } from 'node:crypto';
import {
  decisionSchema,
  participantInputSchema,
  preExecutionStatuses,
  resolutionInputSchema,
  type DependencyInvalidation,
  type TicketParticipant,
  type TicketResolution,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { requireMember, type Queryable } from '../identity/membership.js';
import { parseInput } from '../identity/identity.validation.js';
import { findTicket } from './tickets.queries.js';
import { appendHumanComment } from './ticket-comments.js';
import { invalidateTicketDependencies } from './ticket-dependencies.js';
import { rejectWhenFlowManaged } from './flow-authority.js';

/** Gere participantes, resoluções sem código e invalidações auditadas do ticket. */
export class TicketGovernanceService {
  constructor(private readonly db: Database) {}

  /** Lista pessoas ativas ligadas ao ticket e identifica as participações obrigatórias. */
  async participants(actor: User, ticketId: string): Promise<TicketParticipant[]> {
    await findTicket(this.db, actor, ticketId);
    const result = await this.db.query<Omit<TicketParticipant, 'required'> & { required: number }>(
      `WITH people AS (
         SELECT created_by AS user_id,true AS required FROM tickets WHERE id=$1
         UNION ALL SELECT user_id,true FROM ticket_assignments WHERE ticket_id=$1
         UNION ALL SELECT user_id,false FROM ticket_participants WHERE ticket_id=$1 AND active
       )
       SELECT u.id AS "userId",u.display_name AS "displayName",m.role,m.organization,MAX(people.required) AS required
       FROM people JOIN users u ON u.id=people.user_id
       JOIN project_memberships m ON m.user_id=u.id AND m.project_id=$2
       WHERE NOT u.disabled AND NOT m.disabled
       GROUP BY u.id,u.display_name,m.role,m.organization ORDER BY u.display_name,u.id`,
      [ticketId, actor.projectId],
    );
    return result.rows.map((row) => ({ ...row, required: Boolean(row.required) }));
  }

  /** Lista membros do projeto que a equipa pode adicionar como participantes. */
  async candidates(actor: User, ticketId: string): Promise<TicketParticipant[]> {
    const member = await requireMember(this.db, actor);
    await findTicket(this.db, member, ticketId);
    if (!['technical', 'admin'].includes(member.role))
      throw new DomainError('FORBIDDEN', 'Só a equipa gere participantes.', 403);
    const result = await this.db.query<Omit<TicketParticipant, 'required'>>(
      `SELECT u.id AS "userId",u.display_name AS "displayName",m.role,m.organization
       FROM users u JOIN project_memberships m ON m.user_id=u.id
       WHERE m.project_id=$1 AND NOT u.disabled AND NOT m.disabled ORDER BY u.display_name,u.id`,
      [member.projectId],
    );
    return result.rows.map((row) => ({ ...row, required: false }));
  }

  /** Adiciona/remove participante com controlo de versão, autorização e auditoria. */
  async changeParticipant(actor: User, ticketId: string, raw: unknown) {
    const input = parseInput(participantInputSchema, raw);
    await this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      if (!['technical', 'admin'].includes(member.role))
        throw new DomainError('FORBIDDEN', 'Só a equipa gere participantes.', 403);
      const ticket = await findTicket(client, member, ticketId, true);
      if (ticket.version !== input.expectedVersion)
        throw new DomainError('STALE_VERSION', 'O pedido mudou. Recarregue a página.');
      const eligible = await client.query(
        `SELECT 1 FROM project_memberships m JOIN users u ON u.id=m.user_id
         WHERE m.project_id=$1 AND m.user_id=$2 AND NOT u.disabled AND NOT m.disabled LOCK IN SHARE MODE`,
        [member.projectId, input.userId],
      );
      if (input.action === 'add' && !eligible.rowCount)
        throw new DomainError(
          'INVALID_PARTICIPANT',
          'A pessoa não tem acesso ativo ao projeto.',
          400,
        );
      if (
        input.action === 'remove' &&
        (input.userId === ticket.created_by ||
          (
            await client.query(
              'SELECT 1 FROM ticket_assignments WHERE ticket_id=$1 AND user_id=$2',
              [ticketId, input.userId],
            )
          ).rowCount)
      )
        throw new DomainError(
          'REQUIRED_PARTICIPANT',
          'O autor e os responsáveis são participantes obrigatórios.',
        );
      if (input.action === 'remove') {
        const removed = await client.query(
          `UPDATE ticket_participants SET active=false,changed_by=$3,updated_at=NOW(3)
           WHERE ticket_id=$1 AND user_id=$2 AND active`,
          [ticketId, input.userId, member.id],
        );
        if (!removed.rowCount)
          throw new DomainError('PARTICIPANT_NOT_FOUND', 'Participante não encontrado.', 404);
      } else {
        await client.query(
          `INSERT INTO ticket_participants(ticket_id,user_id,active,changed_by) VALUES($1,$2,true,$3)
           ON DUPLICATE KEY UPDATE active=true,changed_by=VALUES(changed_by),updated_at=NOW(3)`,
          [ticketId, input.userId, member.id],
        );
      }
      await client.query('UPDATE tickets SET version=version+1,updated_at=NOW(3) WHERE id=$1', [
        ticketId,
      ]);
      await client.query(
        `INSERT INTO audit_events(id,actor_id,ticket_id,action,details)
         VALUES($1,$2,$3,'ticket.participant_changed',$4)`,
        [
          randomUUID(),
          member.id,
          ticketId,
          JSON.stringify({ userId: input.userId, action: input.action }),
        ],
      );
      if (input.action === 'add')
        await client.query(
          "INSERT INTO notification_outbox(id,topic,payload) VALUES($1,'ticket.participant_added',$2)",
          [
            randomUUID(),
            JSON.stringify({
              ticketId,
              projectId: member.projectId,
              userId: input.userId,
              actorId: member.id,
            }),
          ],
        );
    });
    return this.participants(actor, ticketId);
  }

  /** Obtém a proposta de resolução sem código que ainda não foi invalidada. */
  async resolution(actor: User, ticketId: string): Promise<TicketResolution | null> {
    await findTicket(this.db, actor, ticketId);
    const result = await this.db.query<
      Omit<TicketResolution, 'createdAt' | 'decidedAt'> & {
        createdAt: Date;
        decidedAt: Date | null;
      }
    >(
      `SELECT r.id,r.body,r.hash,u.display_name AS "authorName",r.client_id AS "clientId",r.status,
         r.created_at AS "createdAt",r.decided_at AS "decidedAt",r.decision_notes AS notes
       FROM ticket_resolutions r JOIN users u ON u.id=r.created_by
       WHERE r.ticket_id=$1 AND r.invalidated_at IS NULL ORDER BY r.ticket_version DESC LIMIT 1`,
      [ticketId],
    );
    const row = result.rows[0];
    return row
      ? {
          ...row,
          createdAt: row.createdAt.toISOString(),
          decidedAt: row.decidedAt?.toISOString() ?? null,
        }
      : null;
  }

  /** Lista alterações que invalidaram propostas ou decisões dependentes de versões antigas. */
  async invalidations(actor: User, ticketId: string): Promise<DependencyInvalidation[]> {
    await findTicket(this.db, actor, ticketId);
    const result = await this.db.query<
      Omit<DependencyInvalidation, 'createdAt'> & { createdAt: Date }
    >(
      `SELECT i.id,i.ticket_version AS "ticketVersion",u.display_name AS "actorName",i.reason,i.created_at AS "createdAt"
       FROM ticket_dependency_invalidations i JOIN users u ON u.id=i.actor_id
       WHERE i.ticket_id=$1 ORDER BY i.ticket_version,i.created_at`,
      [ticketId],
    );
    return result.rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  private async move(
    db: Queryable,
    actor: User,
    ticketId: string,
    from: string,
    to: string,
    action: string,
  ) {
    await db.query('UPDATE tickets SET status=$2,version=version+1,updated_at=NOW(3) WHERE id=$1', [
      ticketId,
      to,
    ]);
    await db.query(
      'INSERT INTO ticket_events(id,ticket_id,from_status,to_status) VALUES($1,$2,$3,$4)',
      [randomUUID(), ticketId, from, to],
    );
    await db.query('INSERT INTO audit_events(id,actor_id,ticket_id,action) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      actor.id,
      ticketId,
      action,
    ]);
    await db.query(
      "INSERT INTO notification_outbox(id,topic,payload) VALUES($1,'ticket.changed',$2)",
      [
        randomUUID(),
        JSON.stringify({ ticketId, projectId: actor.projectId, actorId: actor.id, status: to }),
      ],
    );
  }

  /** Propõe uma resposta pública que só o cliente atribuído pode confirmar ou rejeitar. */
  async proposeResolution(actor: User, ticketId: string, raw: unknown) {
    const input = parseInput(resolutionInputSchema, raw);
    await this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      if (!['technical', 'admin'].includes(member.role))
        throw new DomainError('FORBIDDEN', 'Só a equipa pode propor uma resolução.', 403);
      const ticket = await findTicket(client, member, ticketId, true);
      await rejectWhenFlowManaged(client, ticketId);
      if (ticket.version !== input.expectedVersion)
        throw new DomainError('STALE_VERSION', 'O pedido mudou. Recarregue a página.');
      if (!preExecutionStatuses.includes(ticket.status))
        throw new DomainError(
          'INVALID_STATE',
          'Este pedido já tem execução ou validação em curso.',
        );
      const assigned = await client.query<{ user_id: string }>(
        `SELECT a.user_id FROM ticket_assignments a
         JOIN project_memberships m ON m.user_id=a.user_id AND m.project_id=a.project_id
         JOIN users u ON u.id=m.user_id
         WHERE a.ticket_id=$1 AND a.stage='client' AND m.role='client' AND NOT m.disabled AND NOT u.disabled`,
        [ticketId],
      );
      const clientId = assigned.rows[0]?.user_id;
      if (!clientId)
        throw new DomainError(
          'CLIENT_REQUIRED',
          'Atribua um cliente ativo para confirmar a resolução.',
        );
      await invalidateTicketDependencies(
        client,
        member,
        ticketId,
        ticket.version + 1,
        'resolution',
      );
      const hash = createHash('sha256')
        .update(
          JSON.stringify({ ticketId, version: ticket.version + 1, body: input.body, clientId }),
        )
        .digest('hex');
      await client.query(
        `INSERT INTO ticket_resolutions(id,ticket_id,ticket_version,body,hash,created_by,client_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), ticketId, ticket.version + 1, input.body, hash, member.id, clientId],
      );
      await appendHumanComment(client, member, ticketId, input.body, 'public');
      await this.move(
        client,
        member,
        ticketId,
        ticket.status,
        'awaiting_confirmation',
        'resolution.proposed',
      );
    });
    return this.resolution(actor, ticketId);
  }

  /** Regista a decisão do cliente atribuído sobre o hash exato da resolução. */
  async decideResolution(actor: User, ticketId: string, raw: unknown) {
    const input = parseInput(decisionSchema, raw);
    await this.db.transaction(async (client) => {
      const member = await requireMember(client, actor, true);
      const ticket = await findTicket(client, member, ticketId, true);
      await rejectWhenFlowManaged(client, ticketId);
      if (ticket.version !== input.expectedVersion)
        throw new DomainError('STALE_VERSION', 'O pedido mudou. Recarregue a página.');
      if (ticket.status !== 'awaiting_confirmation')
        throw new DomainError('INVALID_STATE', 'O pedido não aguarda confirmação de resolução.');
      const result = await client.query<{ id: string; hash: string; client_id: string }>(
        `SELECT r.id,r.hash,r.client_id FROM ticket_resolutions r
         JOIN ticket_assignments a ON a.ticket_id=r.ticket_id AND a.stage='client' AND a.user_id=r.client_id
         WHERE r.ticket_id=$1 AND r.invalidated_at IS NULL AND r.status='pending' FOR UPDATE`,
        [ticketId],
      );
      const resolution = result.rows[0];
      if (!resolution) throw new DomainError('STALE_RESOLUTION', 'A resolução já não é válida.');
      if (member.role !== 'client' || resolution.client_id !== member.id)
        throw new DomainError(
          'FORBIDDEN',
          'Só o cliente atribuído pode confirmar ou rejeitar a resolução.',
          403,
        );
      if (resolution.hash !== input.artifactHash)
        throw new DomainError('STALE_ARTIFACT', 'A resposta mudou. Consulte a versão atual.');
      if (input.decision === 'reject' && input.notes.length < 3)
        throw new DomainError('REASON_REQUIRED', 'Indique o motivo da rejeição.', 400);
      await client.query(
        `UPDATE ticket_resolutions SET status=$2,decided_by=$3,decision_notes=$4,decided_at=NOW(3) WHERE id=$1`,
        [
          resolution.id,
          input.decision === 'approve' ? 'accepted' : 'rejected',
          member.id,
          input.notes,
        ],
      );
      await client.query(
        `INSERT INTO approvals(id,ticket_id,ticket_version,stage,artifact_hash,actor_id,decision,notes)
         VALUES($1,$2,$3,'resolution',$4,$5,$6,$7)`,
        [
          randomUUID(),
          ticketId,
          ticket.version,
          resolution.hash,
          member.id,
          input.decision,
          input.notes,
        ],
      );
      await this.move(
        client,
        member,
        ticketId,
        ticket.status,
        input.decision === 'approve' ? 'resolved' : 'investigating',
        `resolution.${input.decision}`,
      );
      if (input.notes) await appendHumanComment(client, member, ticketId, input.notes, 'public');
    });
    return { ok: true };
  }
}
