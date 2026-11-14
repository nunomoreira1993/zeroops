import type { FlowAssignee, FlowText } from '@zeroops/contracts';

export const roleLabels: Record<string, FlowText> = {
  technical: { pt: 'Responsável técnico', en: 'Technical lead' },
  qa: { pt: 'QA', en: 'QA' },
  release: { pt: 'Release', en: 'Release' },
  admin: { pt: 'Administrador', en: 'Administrator' },
  client: { pt: 'Cliente', en: 'Client' },
};

/** Nome legível do responsável configurado numa etapa. */
export function assigneeLabel(assignee: FlowAssignee | null | undefined, locale: 'pt' | 'en') {
  if (!assignee) return locale === 'pt' ? 'Sistema / equipa' : 'System / team';
  switch (assignee.kind) {
    case 'role':
      return roleLabels[assignee.role]?.[locale] ?? assignee.role;
    case 'user':
      return assignee.name ?? (locale === 'pt' ? 'Utilizador' : 'User');
    case 'ticket_author':
      return locale === 'pt' ? 'Autor do pedido' : 'Ticket author';
    case 'team':
      return locale === 'pt' ? 'Equipa' : 'Team';
  }
}

export const ticketStatusOptions = [
  'investigating',
  'awaiting_information',
  'awaiting_client',
  'awaiting_technical',
  'awaiting_confirmation',
  'implementing',
  'awaiting_qa',
  'awaiting_release',
  'deploying',
  'blocked',
] as const;

export const executionStatusLabels: Record<string, FlowText> = {
  running: { pt: 'Em curso', en: 'Running' },
  waiting: { pt: 'À espera', en: 'Waiting' },
  completed: { pt: 'Concluído', en: 'Completed' },
  failed: { pt: 'Interrompido', en: 'Stopped' },
  cancelled: { pt: 'Cancelado', en: 'Cancelled' },
};

export const stepStatusLabels: Record<string, FlowText> = {
  active: { pt: 'em curso', en: 'running' },
  waiting: { pt: 'à espera', en: 'waiting' },
  completed: { pt: 'concluída', en: 'completed' },
  failed: { pt: 'falhou', en: 'failed' },
};

export const originLabels: Record<string, FlowText> = {
  portal_client: { pt: 'Portal (cliente)', en: 'Portal (client)' },
  portal_team: { pt: 'Portal (equipa)', en: 'Portal (team)' },
  health: { pt: 'Saúde (alerta)', en: 'Health (alert)' },
  api: { pt: 'API', en: 'API' },
};

/** Gera uma chave de porta (`a-z0-9_`) a partir do texto de uma opção. */
export function portKey(label: string, taken: string[]) {
  const base =
    label
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 28) || 'opcao';
  let key = base;
  for (let index = 2; taken.includes(key); index += 1) key = `${base}_${index}`;
  return key;
}

/** Gera um id de etapa (`a-z0-9_-`) único. */
export function nodeKey(label: string, taken: string[]) {
  return portKey(label, taken);
}

/** Chave estável por intenção: o mesmo clique repetido envia a mesma chave. */
export function newIdempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
