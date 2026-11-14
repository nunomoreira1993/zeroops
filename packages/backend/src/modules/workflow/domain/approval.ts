import type { Role, TicketStatus } from '../../../../../contracts/src/index.js';
import { DomainError } from '../../../errors.js';

const gates: Partial<Record<TicketStatus, { role: Role; next: TicketStatus }>> = {
  awaiting_client: { role: 'client', next: 'awaiting_technical' },
  awaiting_technical: { role: 'technical', next: 'implementing' },
  awaiting_qa: { role: 'qa', next: 'awaiting_release' },
  awaiting_release: { role: 'release', next: 'deploying' },
};

/**
 * Calcula a transição de uma aprovação sem alterar o ticket.
 *
 * A decisão só é válida para o papel, versão e hash atuais; uma rejeição exige motivo.
 *
 * @throws DomainError se a etapa, autorização, versão, hash ou motivo forem inválidos.
 */
export function approveStage(input: {
  status: TicketStatus;
  version: number;
  expectedVersion: number;
  hash: string;
  expectedHash: string;
  role: Role;
  decision: 'approve' | 'reject';
  notes: string;
}): TicketStatus {
  const gate = gates[input.status];
  if (!gate || gate.role !== input.role)
    throw new DomainError('forbidden', 'Papel sem permissao para esta aprovacao.', 403);
  if (input.version !== input.expectedVersion || input.hash !== input.expectedHash) {
    throw new DomainError(
      'stale_approval',
      'O pedido ou artefacto mudou. Recarregue antes de aprovar.',
    );
  }
  if (input.decision === 'reject') {
    if (!input.notes.trim())
      throw new DomainError('reason_required', 'A rejeicao exige um motivo.', 400);
    return 'investigating';
  }
  return gate.next;
}
