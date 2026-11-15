import type { Queryable } from '../identity/membership.js';
import { DomainError } from '../../errors.js';
import type { TicketStatus } from '../../../../contracts/src/index.js';

/**
 * Autoridade única (P11): enquanto existir uma execução de fluxo viva (running/waiting), só o
 * motor muda o estado do ticket. Com a execução terminal, a autoridade regressa à equipa.
 */
export async function hasLiveFlowExecution(db: Queryable, ticketId: string): Promise<boolean> {
  const result = await db.query(
    "SELECT id FROM flow_executions WHERE ticket_id=$1 AND status IN ('running','waiting') LIMIT 1",
    [ticketId],
  );
  return Boolean(result.rowCount ?? result.rows.length);
}

/** Rejeita transições legadas num ticket gerido por um fluxo vivo. */
export async function rejectWhenFlowManaged(db: Queryable, ticketId: string): Promise<void> {
  if (await hasLiveFlowExecution(db, ticketId))
    throw new DomainError(
      'FLOW_MANAGED',
      'Este pedido segue um fluxo ativo: use as ações da etapa atual.',
      409,
    );
}

const reopenedStatuses: readonly string[] = [
  'awaiting_information',
  'awaiting_client',
  'awaiting_technical',
  'awaiting_confirmation',
  'blocked',
];

/**
 * Estado após uma alteração da equipa (conteúdo, atribuições, correção de mensagem): fora de
 * fluxos reabre a análise; num fluxo vivo preserva o estado, que pertence ao motor.
 */
export async function statusAfterTeamChange(
  db: Queryable,
  ticketId: string,
  current: TicketStatus,
): Promise<TicketStatus> {
  if (!reopenedStatuses.includes(current)) return current;
  return (await hasLiveFlowExecution(db, ticketId)) ? current : 'investigating';
}
