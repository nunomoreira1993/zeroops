import type {
  Role,
  TicketStatus,
  TicketTransitionAction,
} from '../../../../../contracts/src/index.js';
import { DomainError } from '../../../errors.js';

/** Resolve a transição permitida pelo estado e papel, sem executar persistência. */
export function nextTicketStatus(
  status: TicketStatus,
  role: Role,
  action: TicketTransitionAction,
): TicketStatus {
  switch (action) {
    case 'investigate':
      if (!['technical', 'admin'].includes(role) || !['new', 'blocked'].includes(status))
        throw new DomainError('invalid_transition', 'Nao pode iniciar a investigacao.');
      return 'investigating';
    case 'request_information':
      if (!['technical', 'admin'].includes(role) || !['new', 'investigating'].includes(status))
        throw new DomainError('invalid_transition', 'Nao pode pedir esclarecimentos neste estado.');
      return 'awaiting_information';
    case 'resume':
      if (status !== 'awaiting_information')
        throw new DomainError('invalid_transition', 'O ticket nao aguarda informacao.');
      return 'investigating';
    case 'reopen':
      if (!['resolved', 'cancelled'].includes(status))
        throw new DomainError('invalid_transition', 'O ticket nao esta encerrado.');
      return 'new';
    case 'cancel':
      if (role !== 'admin' && role !== 'technical')
        throw new DomainError('forbidden', 'Apenas a equipa pode cancelar.', 403);
      if (
        ![
          'new',
          'investigating',
          'awaiting_information',
          'awaiting_client',
          'awaiting_technical',
          'awaiting_confirmation',
          'blocked',
        ].includes(status)
      )
        throw new DomainError(
          'invalid_transition',
          'Execucao ativa ou ticket encerrado. Requer reconciliacao.',
        );
      return 'cancelled';
  }
}
