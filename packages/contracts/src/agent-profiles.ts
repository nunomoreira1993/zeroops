import { z } from 'zod';
import type { CapabilitySource } from './capabilities.js';

export const copilotToolKeys = ['sql', 'db2', 'log', 'loki', 'prom'] as const;
export type CopilotToolKey = (typeof copilotToolKeys)[number];

export const agentProfileModes = ['analysis', 'develop', 'report'] as const;
export type AgentProfileMode = (typeof agentProfileModes)[number];

export const agentProfileDefinitionSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  mission: z.string().trim().min(20).max(4000),
  expectedInputs: z.array(z.string().trim().min(1).max(200)).max(12),
  expectedOutput: z.string().trim().min(10).max(2000),
  completionCriteria: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  modes: z.array(z.enum(agentProfileModes)).min(1).max(agentProfileModes.length),
  allowedTools: z.array(z.enum(copilotToolKeys)).max(copilotToolKeys.length),
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{1,100}$/)
    .nullable(),
  fusionTier: z.enum(['standard', 'high', 'max']).nullable(),
  reasoningEffort: z.string().trim().min(1).max(32).nullable(),
  /** Instruções do especialista (ex.: corpo de um `.agent.md` importado). Opcional (P04). */
  instructions: z.string().trim().min(1).max(20000).optional(),
});
export type AgentProfileDefinition = z.infer<typeof agentProfileDefinitionSchema>;

export const agentProfileCreateSchema = agentProfileDefinitionSchema;
export const agentProfileVersionInputSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  definition: agentProfileDefinitionSchema,
});
export type AgentProfileVersionInput = z.infer<typeof agentProfileVersionInputSchema>;

export const repositoryResourceKindSchema = z.enum(['instruction', 'agent', 'skill']);
export type RepositoryResourceKind = z.infer<typeof repositoryResourceKindSchema>;

export const repositoryResourceReferenceSchema = z.strictObject({
  path: z.string().trim().min(1).max(240),
  required: z.boolean().default(false),
});
export type RepositoryResourceReference = z.infer<typeof repositoryResourceReferenceSchema>;

export interface RepositoryResource {
  path: string;
  kind: RepositoryResourceKind;
  name: string;
  description: string;
  sha256: string;
  /** Repository-wide rules applied to every Copilot step, not relevance-ranked extras. */
  globalInstruction?: boolean;
}

export interface RepositoryResourceCatalog {
  available: boolean;
  siteKey: string | null;
  reason: 'site_not_linked' | 'repository_unavailable' | null;
  resources: RepositoryResource[];
  /** Existing global rule files that could not be safely read. */
  unavailableGlobalInstructions?: string[];
}

export interface AgentProfileVersion {
  version: number;
  definition: AgentProfileDefinition;
  createdAt: string;
  createdBy: string | null;
  /** Proveniência da versão (importação `.agent.md` ou adoção por partilha). */
  source?: CapabilitySource | null;
}

export interface AgentProfile {
  id: string;
  projectId: string;
  currentVersion: number;
  archivedAt: string | null;
  versions: AgentProfileVersion[];
}

export interface RepositoryResourceSnapshot extends RepositoryResourceReference {
  kind: RepositoryResourceKind;
  sha256: string | null;
  content: string | null;
  status: 'loaded' | 'missing' | 'unavailable';
  selectionReason?: 'global_instruction' | 'flow_selected' | 'relevance';
  reason?: string;
}

export type RepositoryResourceSelectionReason = NonNullable<
  RepositoryResourceSnapshot['selectionReason']
>;

export interface AgentProfileRunSnapshot {
  id: string;
  version: number;
  definition: AgentProfileDefinition;
}
