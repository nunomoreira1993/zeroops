import type { HealthRecipientTarget, HealthSettings } from '../../../../contracts/src/index.js';

/**
 * Destinatarios de um envio: listas da rota do alarme (se existir) ou listas por defeito do
 * destino (criticidade ou relatorio), mais os e-mails diretos do formato anterior. Sem repetidos.
 */
export function resolveRecipients(
  settings: HealthSettings,
  target: HealthRecipientTarget,
  checkId?: string,
): string[] {
  const route = checkId ? settings.routes[checkId] : undefined;
  const listIds = route?.length ? route : settings.defaults[target];
  const lists = new Map(settings.lists.map((list) => [list.id, list.emails]));
  const emails = [...listIds.flatMap((id) => lists.get(id) ?? []), ...settings.recipients[target]];
  const unique = new Map<string, string>();
  for (const email of emails) if (!unique.has(email.toLowerCase())) unique.set(email.toLowerCase(), email);
  return [...unique.values()];
}
