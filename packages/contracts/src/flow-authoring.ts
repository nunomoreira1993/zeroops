import { z } from 'zod';
import { flowRoutingPolicySchema, type FlowRoutingPolicy } from './flow-routing-policy.js';
import {
  flowMatchSchema,
  flowPatchOperationSchema,
  type FlowDefinition,
  type FlowMatch,
  type FlowPatchOperation,
} from './flows.js';

/**
 * P06 — construção de fluxos por conversa. O Copilot altera o rascunho apenas através de
 * ferramentas tipadas (validadas e autorizadas no backend); texto livre ou JSON parcial do stream
 * nunca é executado. A ativação continua a ser uma ação explícita (P02).
 */

/** `assisted`: as operações ficam propostas até aceitar; `auto`: aplicadas ao rascunho logo. */
export const flowAuthoringModes = ['assisted', 'auto'] as const;
export type FlowAuthoringMode = (typeof flowAuthoringModes)[number];

export const flowAuthoringRequestSchema = z.strictObject({
  message: z.string().trim().min(2).max(2000),
  mode: z.enum(flowAuthoringModes).optional(),
});

/** Limite de operações por chamada: um lote é aplicado de forma atómica (tudo ou nada). */
export const FLOW_AUTHORING_BATCH_LIMIT = 20;

export const flowAuthoringApplySchema = z.strictObject({
  operations: z.array(flowPatchOperationSchema).min(1).max(FLOW_AUTHORING_BATCH_LIMIT),
  summary: z.string().trim().max(300).default(''),
});
export type FlowAuthoringApplyInput = z.infer<typeof flowAuthoringApplySchema>;

/** Regras de seleção e política de encaminhamento do rascunho (sem prioridade nem «por omissão»). */
export const flowAuthoringRoutingSchema = z
  .strictObject({
    match: flowMatchSchema.optional(),
    routingPolicy: flowRoutingPolicySchema.optional(),
    summary: z.string().trim().max(300).default(''),
  })
  .refine((value) => value.match !== undefined || value.routingPolicy !== undefined, {
    message: 'Indique match e/ou routingPolicy.',
  });
export type FlowAuthoringRoutingInput = z.infer<typeof flowAuthoringRoutingSchema>;

export const flowCapabilityKinds = ['tool', 'integration', 'agent', 'skill', 'other'] as const;
export type FlowCapabilityKind = (typeof flowCapabilityKinds)[number];

export const flowCapabilityRequestSchema = z.strictObject({
  kind: z.enum(flowCapabilityKinds).default('tool'),
  capability: z.string().trim().min(3).max(120),
  reason: z.string().trim().min(3).max(1000),
  nodeId: z
    .string()
    .regex(/^[a-z0-9_-]{1,64}$/)
    .nullish(),
});
export type FlowCapabilityRequestInput = z.infer<typeof flowCapabilityRequestSchema>;

export const flowAuthoringUndoSchema = z.strictObject({
  expectedDraftVersion: z.number().int().min(1),
});
export const flowAuthoringModeSchema = z.strictObject({ mode: z.enum(flowAuthoringModes) });

export const flowAuthoringEventTypes = [
  'turn_queued',
  'turn_started',
  'turn_completed',
  'turn_failed',
  'turn_cancelled',
  'draft_read',
  'operation_applied',
  'operation_proposed',
  'operation_rejected',
  'operation_conflict',
  'proposal_accepted',
  'proposal_discarded',
  'operation_undone',
  'draft_saved',
  'capability_missing',
  'capability_development',
  'capability_linked',
  'mode_changed',
] as const;
export type FlowAuthoringEventType = (typeof flowAuthoringEventTypes)[number];

/**
 * Evento persistente da construção (cursor = `id`). O payload só contém estado operacional,
 * ferramentas e resultados — nunca o raciocínio do modelo nem segredos.
 */
export interface FlowAuthoringEventView {
  id: number;
  type: FlowAuthoringEventType;
  requestId: string | null;
  sessionId: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type FlowAuthoringOperationStatus =
  'applied' | 'proposed' | 'rejected' | 'conflict' | 'accepted' | 'discarded';

export interface FlowAuthoringOperationView {
  id: string;
  requestId: string | null;
  sessionId: string | null;
  actor: string | null;
  source: 'assistant' | 'accept' | 'undo';
  kind: 'definition' | 'routing';
  status: FlowAuthoringOperationStatus;
  baseRevision: number;
  resultRevision: number | null;
  operations: FlowPatchOperation[];
  routing: { match?: FlowMatch; routingPolicy?: FlowRoutingPolicy } | null;
  summary: string;
  error: string | null;
  undoOf: string | null;
  undoneBy: string | null;
  /** Ainda pode ser desfeita: aplicada, não desfeita e o rascunho não mudou desde então. */
  undoable: boolean;
  createdAt: string;
}

export interface FlowCapabilityRequestView {
  id: string;
  kind: FlowCapabilityKind;
  capability: string;
  reason: string;
  nodeId: string | null;
  status: 'open' | 'dismissed';
  requestedBy: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface FlowAuthoringStateView {
  session: { id: string; mode: FlowAuthoringMode } | null;
  draftVersion: number;
  operations: FlowAuthoringOperationView[];
  capabilities: FlowCapabilityRequestView[];
  /** Cursor do último evento: o cliente continua a partir daqui (SSE/polling). */
  lastEventId: number;
}

/** Resultado devolvido ao modelo por uma ferramenta de autoria. */
export interface FlowAuthoringToolResult {
  ok: boolean;
  /** Texto para o modelo (curto, sem dados internos de outros projetos). */
  text: string;
  /** O pedido perdeu a posse (cancelado, expirado ou autor sem permissão): o executor para. */
  stop?: boolean;
}

/** Definição sem layout, para o modelo e para os eventos (o layout é do editor). */
export function authoringDefinitionSummary(definition: FlowDefinition) {
  return {
    start: definition.start,
    nodes: definition.nodes,
    edges: definition.edges.map(({ source, port, target }) => ({ source, port, target })),
  };
}
