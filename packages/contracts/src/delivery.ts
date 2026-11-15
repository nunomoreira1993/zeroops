import { z } from 'zod';
import { flowReviewConfig, gitRefNameSchema, type NodeLike } from './development.js';

/**
 * P09 — Pipeline, integração e Health pelo fluxo.
 *
 * Pipelines de entrega por projeto (fornecedor `webhook` assinado por HMAC), configuração da ação
 * `deliver`, callbacks do fornecedor e vistas internas das entregas de um ticket.
 */

export const pipelineProviders = ['webhook'] as const;
export const pipelineEnvironments = ['quality', 'production'] as const;
export const pipelineHoldPolicies = ['until_published', 'until_flow_end'] as const;

/** Estados da entrega. Os terminais nunca regridem (callbacks tardias ficam só registadas). */
export const deliveryStates = [
  'queued',
  'integrating',
  'starting',
  'publishing',
  'uncertain',
  'published',
  'failed',
  'conflict',
  'rework',
  'blocked',
  'cancelled',
] as const;
export type DeliveryState = (typeof deliveryStates)[number];
export const terminalDeliveryStates: ReadonlySet<DeliveryState> = new Set([
  'published',
  'failed',
  'conflict',
  'rework',
  'blocked',
  'cancelled',
]);

/** Endpoint do fornecedor sem credenciais embutidas. */
export const pipelineEndpointSchema = z
  .string()
  .trim()
  .min(8)
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['https:', 'http:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'URL inválido: use http(s):// sem credenciais.');

export const projectPipelineInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[\p{L}\p{N} ._-]+$/u),
  provider: z.enum(pipelineProviders).default('webhook'),
  repositoryId: z.uuid(),
  targetBranch: gitRefNameSchema,
  environment: z.enum(pipelineEnvironments),
  endpointUrl: pipelineEndpointSchema,
  /** Segredo HMAC partilhado (só escrita; nunca é devolvido). Obrigatório ao criar. */
  secret: z.string().min(32).max(200).optional(),
  /** Política explícita: o ZeroOps pode integrar (push sem force) na branch de destino. */
  allowIntegration: z.boolean().default(false),
  holdPolicy: z.enum(pipelineHoldPolicies).default('until_published'),
  expectedVersion: z.number().int().nonnegative().optional(),
});
export type ProjectPipelineInput = z.infer<typeof projectPipelineInputSchema>;

export interface ProjectPipelineView {
  id: string;
  projectId: string;
  name: string;
  provider: (typeof pipelineProviders)[number];
  repository: { id: string; name: string };
  targetBranch: string;
  environment: (typeof pipelineEnvironments)[number];
  endpointUrl: string;
  callbackUrl: string;
  allowIntegration: boolean;
  holdPolicy: (typeof pipelineHoldPolicies)[number];
  version: number;
  archived: boolean;
  updatedAt: string;
}

/** Estados reportados pelo fornecedor. `accepted` não é publicação. */
export const pipelineStatuses = [
  'accepted',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type PipelineStatus = (typeof pipelineStatuses)[number];

const checkSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
  url: z.string().trim().max(500).optional(),
});
export type PipelineCheck = z.infer<typeof checkSchema>;

/** Callback assinada do fornecedor (também é o formato da resposta de `GET status`). */
export const pipelineCallbackSchema = z.strictObject({
  eventId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._:-]+$/),
  idempotencyKey: z.uuid(),
  externalId: z.string().trim().min(1).max(200),
  sequence: z.number().int().min(0).max(1_000_000),
  status: z.enum(pipelineStatuses),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  checks: z.array(checkSchema).max(50).default([]),
  url: z.string().trim().max(500).optional(),
  message: z.string().trim().max(1000).optional(),
});
export type PipelineCallback = z.infer<typeof pipelineCallbackSchema>;

export interface DeliveryEventView {
  id: string;
  eventId: string;
  source: 'callback' | 'reconcile' | 'runner';
  sequence: number;
  status: string;
  outcome: 'applied' | 'duplicate' | 'out_of_order' | 'ignored_terminal' | 'mismatch' | 'recorded';
  receivedAt: string;
}

export interface DeliveryRunView {
  id: string;
  stepId: string;
  nodeId: string;
  workspaceId: string;
  pipeline: { id: string; name: string; environment: string; targetBranch: string };
  state: DeliveryState;
  reason: string | null;
  candidate: { baseSha: string; headSha: string; scopeHash: string };
  approvals: { actorId: string; displayName: string }[];
  targetSha: string | null;
  integratedSha: string | null;
  revalidated: boolean;
  artifactDigest: string | null;
  externalId: string | null;
  externalUrl: string | null;
  pipelineStatus: string | null;
  checks: PipelineCheck[];
  /** Posição na fila de integração da branch de destino (1 = a seguir); `null` fora da fila. */
  queuePosition: number | null;
  attempts: number;
  events: DeliveryEventView[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Configuração da ação `deliver`: pipeline do projeto e decisão de review exigida. */
export function deliveryNodeConfig(node: NodeLike): {
  pipelineId: string | null;
  reviewNode: string | null;
} {
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  return { pipelineId: text(node.config.pipelineId), reviewNode: text(node.config.reviewNode) };
}

/** Problemas estruturais de uma etapa `deliver` (validação do P02). */
export function deliveryConfigIssues(
  node: NodeLike,
  nodes: ReadonlyMap<string, NodeLike>,
  options: { pipelines?: ReadonlySet<string> } = {},
): string[] {
  if (node.op !== 'action' || node.config.action !== 'deliver') return [];
  const issues: string[] = [];
  const config = deliveryNodeConfig(node);
  if (!config.pipelineId || !z.uuid().safeParse(config.pipelineId).success)
    issues.push('pipeline inválida.');
  else if (options.pipelines && !options.pipelines.has(config.pipelineId))
    issues.push('a pipeline não existe neste projeto ou está arquivada.');
  const review = config.reviewNode ? nodes.get(config.reviewNode) : undefined;
  if (!review || !flowReviewConfig(review))
    issues.push('a entrega tem de apontar para uma decisão de review configurada.');
  return issues;
}

/** Assinatura HMAC dos pedidos e callbacks: `sha256=hmac(secret, timestamp + "." + body)`. */
export const PIPELINE_SIGNATURE_HEADER = 'x-zeroops-signature';
export const PIPELINE_TIMESTAMP_HEADER = 'x-zeroops-timestamp';
export const PIPELINE_SIGNATURE_TOLERANCE_SECONDS = 300;
