import { z } from 'zod';

/**
 * Condições declarativas dos fluxos V2. Cada ramo compara factos conhecidos do ticket ou da
 * etapa anterior com valores literais; a avaliação é pura (sem `eval` nem código do fluxo).
 */

export const FLOW_CONDITION_OTHERWISE = 'otherwise';

/** Portas que o motor trata internamente e que não podem ser usadas como ramos nomeados. */
export const FLOW_RESERVED_PORTS = ['retry', 'needs_information', 'otherwise', 'wait'] as const;

export const flowConditionFields = [
  'ticket.origin',
  'ticket.category',
  'ticket.environment',
  'ticket.priority',
  'previous.result',
  'previous.port',
] as const;
export type FlowConditionField = (typeof flowConditionFields)[number];

export const flowConditionOperators = ['equals', 'not_equals', 'in', 'not_in'] as const;
export type FlowConditionOperator = (typeof flowConditionOperators)[number];

const literal = z.string().trim().min(1).max(64);
const portName = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,31}$/);

export const flowConditionSchema = z
  .strictObject({
    field: z.enum(flowConditionFields),
    operator: z.enum(flowConditionOperators),
    value: literal.optional(),
    values: z.array(literal).min(1).max(20).optional(),
  })
  .superRefine((condition, context) => {
    const list = condition.operator === 'in' || condition.operator === 'not_in';
    if (
      list
        ? !condition.values || condition.value !== undefined
        : !condition.value || condition.values
    )
      context.addIssue({
        code: 'custom',
        message: list
          ? 'Os operadores «in»/«not_in» exigem uma lista de valores.'
          : 'Os operadores «equals»/«not_equals» exigem um único valor.',
      });
  });
export type FlowCondition = z.infer<typeof flowConditionSchema>;

export const flowConditionBranchSchema = z.strictObject({
  port: portName,
  label: z.string().trim().min(1).max(80).optional(),
  conditions: z.array(flowConditionSchema).min(1).max(10),
});
export type FlowConditionBranch = z.infer<typeof flowConditionBranchSchema>;

export const flowConditionConfigSchema = z.strictObject({
  branches: z.array(flowConditionBranchSchema).min(1).max(8),
  label: z.string().trim().max(80).optional(),
  maxVisits: z.number().int().min(1).max(50).optional(),
});
export type FlowConditionConfig = z.infer<typeof flowConditionConfigSchema>;

/** Factos disponíveis para avaliar uma condição (só valores conhecidos no momento). */
export interface FlowConditionFacts {
  ticket?: { origin?: string; category?: string; environment?: string; priority?: string };
  previous?: { result?: string | null; port?: string | null };
}

/** Ramos válidos de uma etapa `condition` (lista vazia se a configuração for inválida). */
export function conditionBranches(config: Record<string, unknown>): FlowConditionBranch[] {
  const parsed = flowConditionConfigSchema.safeParse(config);
  return parsed.success ? parsed.data.branches : [];
}

/** Valida a configuração de uma etapa `condition`, devolvendo mensagens legíveis. */
export function conditionConfigIssues(config: Record<string, unknown>): string[] {
  const parsed = flowConditionConfigSchema.safeParse(config);
  if (!parsed.success)
    return parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`);
  const issues: string[] = [];
  const ports = parsed.data.branches.map((branch) => branch.port);
  if (new Set(ports).size !== ports.length) issues.push('Há ramos repetidos.');
  for (const port of ports)
    if ((FLOW_RESERVED_PORTS as readonly string[]).includes(port))
      issues.push(`O ramo «${port}» usa um nome reservado.`);
  return issues;
}

function factValue(field: FlowConditionField, facts: FlowConditionFacts): string | null {
  switch (field) {
    case 'ticket.origin':
      return facts.ticket?.origin ?? null;
    case 'ticket.category':
      return facts.ticket?.category ?? null;
    case 'ticket.environment':
      return facts.ticket?.environment ?? null;
    case 'ticket.priority':
      return facts.ticket?.priority ?? null;
    case 'previous.result':
      return facts.previous?.result ?? null;
    case 'previous.port':
      return facts.previous?.port ?? null;
  }
}

/** Um facto desconhecido nunca satisfaz uma condição (nem as negativas). */
export function conditionHolds(condition: FlowCondition, facts: FlowConditionFacts): boolean {
  const actual = factValue(condition.field, facts);
  if (actual === null) return false;
  switch (condition.operator) {
    case 'equals':
      return actual === condition.value;
    case 'not_equals':
      return actual !== condition.value;
    case 'in':
      return (condition.values ?? []).includes(actual);
    case 'not_in':
      return !(condition.values ?? []).includes(actual);
  }
}

/** Primeiro ramo cujas condições (todas) se verificam; caso contrário `otherwise`. */
export function evaluateConditionNode(
  config: Record<string, unknown>,
  facts: FlowConditionFacts,
): string {
  for (const branch of conditionBranches(config))
    if (branch.conditions.every((condition) => conditionHolds(condition, facts)))
      return branch.port;
  return FLOW_CONDITION_OTHERWISE;
}
