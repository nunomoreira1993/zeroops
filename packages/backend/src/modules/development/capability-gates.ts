import { capabilityBlockingStates } from '../../../../contracts/src/index.js';
import type { Queryable } from '../identity/membership.js';
import { userHasProjectPermission } from '../identity/project-permissions.js';

export type CapabilityPublishGate = { ok: true } | { ok: false; pending: boolean; reason: string };

/**
 * P10 — gate extra das entregas de tickets de desenvolvimento de capacidade: a publicação exige
 * autorização separada (`capabilities.publish`) de alguém que ainda a tenha, o processo ativo e
 * a pipeline atribuída ao projeto. Tickets sem processo de capacidade não são afetados.
 * `pending` = falta uma autorização válida (antes de criar a entrega, a etapa espera por ela);
 * depois de criada, qualquer falha bloqueia a entrega (fail-closed).
 */
export async function capabilityPublishGate(
  client: Queryable,
  input: { ticketId: string; projectId: string; pipelineId: string },
): Promise<CapabilityPublishGate> {
  const row = (
    await client.query<{
      state: string;
      pipeline_id: string;
      publish_authorized_by: string | null;
    }>(
      'SELECT state,pipeline_id,publish_authorized_by FROM capability_developments WHERE ticket_id=$1 AND project_id=$2',
      [input.ticketId, input.projectId],
    )
  ).rows[0];
  if (!row) return { ok: true };
  if (row.state === 'cancelled')
    return { ok: false, pending: false, reason: 'O pedido de capacidade foi cancelado.' };
  const current = (
    await client.query<{ pipeline_id: string }>(
      'SELECT pipeline_id FROM project_capability_settings WHERE project_id=$1',
      [input.projectId],
    )
  ).rows[0];
  if (row.pipeline_id !== input.pipelineId || current?.pipeline_id !== input.pipelineId)
    return {
      ok: false,
      pending: false,
      reason: 'A pipeline não é o alvo de publicação de capacidades atribuído ao projeto.',
    };
  if (!row.publish_authorized_by)
    return {
      ok: false,
      pending: true,
      reason: 'A publicação da capacidade aguarda autorização (capabilities.publish).',
    };
  if (
    !(await userHasProjectPermission(
      client,
      row.publish_authorized_by,
      input.projectId,
      'capabilities.publish',
    ))
  )
    return {
      ok: false,
      pending: true,
      reason:
        'Quem autorizou a publicação já não tem capabilities.publish: é precisa nova autorização.',
    };
  return { ok: true };
}

/** Desenvolvimentos obrigatórios que ainda impedem ativar o fluxo (P10). */
export async function pendingCapabilityDependencies(client: Queryable, flowId: string) {
  const placeholders = capabilityBlockingStates.map((_, index) => `$${index + 2}`).join(',');
  return (
    await client.query<{ id: string; title: string; state: string }>(
      `SELECT id,title,state FROM capability_developments
        WHERE flow_id=$1 AND required=1 AND state IN (${placeholders}) ORDER BY created_at`,
      [flowId, ...capabilityBlockingStates],
    )
  ).rows;
}

/** Capacidades publicadas e associadas ao rascunho (registadas na ativação). */
export async function linkedCapabilities(client: Queryable, flowId: string) {
  return (
    await client.query<{
      id: string;
      title: string;
      category: string;
      published_sha: string | null;
      published_digest: string | null;
      runtime_version: string | null;
    }>(
      `SELECT id,title,category,published_sha,published_digest,runtime_version
         FROM capability_developments WHERE flow_id=$1 AND state='linked' ORDER BY linked_at`,
      [flowId],
    )
  ).rows.map((row) => ({
    developmentId: row.id,
    title: row.title,
    category: row.category,
    sha: row.published_sha,
    artifactDigest: row.published_digest,
    runtimeVersion: row.runtime_version,
  }));
}
