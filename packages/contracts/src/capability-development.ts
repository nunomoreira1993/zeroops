import { z } from 'zod';

/**
 * P10 — desenvolvimento de capacidades em falta pedidas na autoria (P06). Cada pedido gera no
 * máximo um processo (ticket + workspace + review + entrega pelo fluxo de desenvolvimento do
 * projeto). Publicar a capacidade nunca ativa o fluxo que a pediu: a associação ao rascunho é uma
 * alteração auditada e a ativação continua explícita.
 */
export const capabilityCategories = [
  'configuration',
  'agent_skill',
  'integration',
  'zeroops_change',
] as const;
export type CapabilityCategory = (typeof capabilityCategories)[number];

/** Só `integration`/`zeroops_change` exigem código e rollout; as restantes são configuração. */
export const capabilityCategoryNeedsDevelopment = (category: CapabilityCategory) =>
  category === 'integration' || category === 'zeroops_change';

export const capabilityDevelopmentStates = [
  'requested',
  'developing',
  'review',
  'publishing',
  'published',
  'available',
  'linked',
  'cancelled',
  'failed',
  'reconciliation_required',
] as const;
export type CapabilityDevelopmentState = (typeof capabilityDevelopmentStates)[number];

/** Estados que ainda bloqueiam a ativação de um fluxo com dependência obrigatória. */
export const capabilityBlockingStates: readonly CapabilityDevelopmentState[] =
  capabilityDevelopmentStates.filter((state) => state !== 'linked' && state !== 'cancelled');

export const capabilitySettingsSchema = z.strictObject({
  repositoryId: z.uuid(),
  pipelineId: z.uuid(),
  developmentFlowId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(),
});
export type CapabilitySettingsInput = z.infer<typeof capabilitySettingsSchema>;

export const capabilityDevelopmentStartSchema = z.strictObject({
  capabilityRequestId: z.uuid(),
  category: z.enum(capabilityCategories),
  title: z.string().trim().min(5).max(180),
  requirement: z.string().trim().min(10).max(8000),
  acceptanceCriteria: z.array(z.string().trim().min(3).max(500)).min(1).max(20),
  required: z.boolean().default(true),
  /** Autoriza já a publicação (exige também `capabilities.publish`). */
  authorizePublish: z.boolean().default(false),
});
export type CapabilityDevelopmentStartInput = z.infer<typeof capabilityDevelopmentStartSchema>;

export const capabilityDevelopmentVersionSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});

export const capabilityDevelopmentLinkSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  expectedDraftVersion: z.number().int().min(1),
  /** O rascunho mudou desde o pedido: o utilizador confirma que a capacidade continua aplicável. */
  acknowledgeDraftChanged: z.boolean().default(false),
});

export interface CapabilitySettingsView {
  projectId: string;
  version: number;
  repositoryId: string | null;
  pipelineId: string | null;
  developmentFlowId: string | null;
  canManage: boolean;
  /** Problemas que impedem iniciar desenvolvimentos (recursos arquivados, fluxo inativo, ...). */
  issues: string[];
}

export interface CapabilityDevelopmentEventView {
  id: number;
  kind: string;
  actor: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CapabilityDevelopmentView {
  id: string;
  projectId: string;
  flowId: string;
  capabilityRequestId: string;
  category: CapabilityCategory;
  title: string;
  requirement: string;
  acceptanceCriteria: string[];
  required: boolean;
  state: CapabilityDevelopmentState;
  stateReason: string | null;
  sourceDraftVersion: number;
  /** O rascunho mudou desde o pedido (a associação exige confirmação). */
  draftChanged: boolean;
  ticket: { id: string; key: string; status: string } | null;
  repositoryId: string | null;
  pipelineId: string | null;
  requestedBy: string | null;
  publishAuthorizedBy: string | null;
  publishAuthorizedAt: string | null;
  development: {
    branch: string | null;
    baseSha: string | null;
    headSha: string | null;
    pullRequestUrl: string | null;
    testsPassed: boolean | null;
    reviewPending: boolean;
  } | null;
  delivery: {
    id: string;
    state: string;
    stateReason: string | null;
    integratedSha: string | null;
    artifactDigest: string | null;
    externalUrl: string | null;
  } | null;
  publishedSha: string | null;
  publishedDigest: string | null;
  runtimeVersion: string | null;
  runtimeConfirmedAt: string | null;
  linkedDraftVersion: number | null;
  linkedAt: string | null;
  cancelledAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Ações disponíveis para o utilizador atual (o backend volta a verificar). */
  can: { authorizePublish: boolean; cancel: boolean; link: boolean };
  /** Próximo passo legível (sem detalhes internos). */
  nextStep: string;
  events: CapabilityDevelopmentEventView[];
}

export interface CapabilityDevelopmentListView {
  developments: CapabilityDevelopmentView[];
  settings: CapabilitySettingsView;
  can: { develop: boolean; publish: boolean };
}
