import type { FlowStepOutput } from '../../../../contracts/src/index.js';
import {
  createDelivery,
  deliveryForStep,
  evaluateDeliveryGates,
  type DeliveryRow,
} from '../delivery/delivery.store.js';
import type { FlowActionExecutor, FlowActionResult } from './flow-actions.js';

/** Intervalo de reavaliação enquanto a entrega corre (o fim da entrega acorda o fluxo). */
const POLL_MS = 30_000;

const output = (row: DeliveryRow): FlowStepOutput => ({
  delivery: {
    deliveryId: row.id,
    state: row.state,
    headSha: row.candidate_head_sha,
    integratedSha: row.integrated_sha,
    artifactDigest: row.artifact_digest,
    externalId: row.external_id,
  },
  ...(row.state_reason ? { reason: row.state_reason } : {}),
});

/** Resultado de uma entrega terminada: a porta é o estado; conflitos regressam com o motivo. */
function finished(row: DeliveryRow): FlowActionResult {
  const port = row.state;
  if (port === 'conflict' || port === 'rework')
    return {
      port,
      output: output(row),
      feedback: {
        comment: `${row.state_reason ?? 'A integração precisa de correção.'} Integre origin/${row.target_branch} no workspace, resolva e volte a testar.`,
        actor: 'ZeroOps (entrega)',
        evidence: null,
      },
    };
  return { port, output: output(row) };
}

/**
 * P09 — ação `deliver`. Na primeira avaliação verifica os gates (review aprovado sobre o head
 * atual, testes finais, pipeline do projeto) e cria a entrega na fila durável; a integração e a
 * publicação correm no executor. A etapa espera até a entrega terminar e segue pela porta do
 * estado final. Sem execução real (simulador) a ação não corre.
 */
export const deliverAction: FlowActionExecutor = async (context) => {
  if (!context.execution)
    return {
      port: 'blocked',
      output: { reason: 'A entrega só corre no motor de fluxos (sem execução real).' },
    };
  const existing = await deliveryForStep(context.client, context.step.id);
  if (existing) {
    if (existing.finished_at) return finished(existing);
    return { wait: new Date(context.now.getTime() + POLL_MS), output: output(existing) };
  }
  const gates = await evaluateDeliveryGates(context.client, {
    ticketId: context.ticket.id,
    projectId: context.ticket.projectId,
    executionId: context.execution.id,
    nodes: context.execution.definition.nodes,
    node: context.node,
  });
  // Autorização de publicação de capacidade em falta: espera (a autorização acorda a execução).
  if (!gates.ok && gates.pending)
    return { wait: new Date(context.now.getTime() + POLL_MS), output: { reason: gates.reason } };
  if (!gates.ok) return { port: 'blocked', output: { reason: gates.reason } };
  await createDelivery(context.client, {
    ticketId: context.ticket.id,
    projectId: context.ticket.projectId,
    executionId: context.execution.id,
    stepId: context.step.id,
    nodeId: context.node.id,
    gates,
  });
  const created = (await deliveryForStep(context.client, context.step.id))!;
  return { wait: new Date(context.now.getTime() + POLL_MS), output: output(created) };
};
