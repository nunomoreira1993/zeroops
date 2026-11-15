import { z } from 'zod';

/** Política de encaminhamento semântico de um fluxo (P05), sem dependências de outros contratos. */

export const ROUTING_POLICY_INSTRUCTIONS_LIMIT = 4000;
export const ROUTING_EXAMPLE_LIMIT = 500;
export const ROUTING_EXAMPLES_MAX = 10;

const exampleList = z
  .array(z.string().trim().min(3).max(ROUTING_EXAMPLE_LIMIT))
  .max(ROUTING_EXAMPLES_MAX)
  .default([]);

export const flowRoutingPolicySchema = z.strictObject({
  /** Quando este fluxo se aplica (vazio = sem encaminhamento semântico). */
  instructions: z.string().trim().max(ROUTING_POLICY_INSTRUCTIONS_LIMIT).default(''),
  positiveExamples: exampleList,
  negativeExamples: exampleList,
  /**
   * Este fluxo recebe os tickets cujo encaminhamento semântico não foi possível decidir (falha
   * do classificador, sem resposta do autor). Só tem efeito quando o fluxo é o fallback.
   */
  fallbackOnUnresolved: z.boolean().default(false),
});
export type FlowRoutingPolicy = z.infer<typeof flowRoutingPolicySchema>;

export const emptyRoutingPolicy = (): FlowRoutingPolicy => ({
  instructions: '',
  positiveExamples: [],
  negativeExamples: [],
  fallbackOnUnresolved: false,
});

/** Política lida da BD/JSON (valores inválidos ou ausentes = política vazia). */
export function parseRoutingPolicy(value: unknown): FlowRoutingPolicy {
  let raw = value;
  if (typeof raw === 'string')
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  const parsed = flowRoutingPolicySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyRoutingPolicy();
}

export const isSemanticPolicy = (policy: FlowRoutingPolicy | null | undefined) =>
  Boolean(policy && policy.instructions.trim());

export const isEmptyRoutingPolicy = (policy: FlowRoutingPolicy | null | undefined) =>
  !policy ||
  (!policy.instructions.trim() &&
    !policy.positiveExamples.length &&
    !policy.negativeExamples.length &&
    !policy.fallbackOnUnresolved);

export function sameRoutingPolicy(
  a: FlowRoutingPolicy | null | undefined,
  b: FlowRoutingPolicy | null | undefined,
) {
  const left = a ?? emptyRoutingPolicy();
  const right = b ?? emptyRoutingPolicy();
  return (
    left.instructions.trim() === right.instructions.trim() &&
    left.fallbackOnUnresolved === right.fallbackOnUnresolved &&
    left.positiveExamples.join('\0') === right.positiveExamples.join('\0') &&
    left.negativeExamples.join('\0') === right.negativeExamples.join('\0')
  );
}
