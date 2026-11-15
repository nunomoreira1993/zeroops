import { z } from 'zod';
import type { FlowRoutingPolicy } from './flow-routing-policy.js';

/**
 * Manifesto de dependências fixado na ativação de uma versão de fluxo. É determinístico (sem
 * datas, atores ou credenciais) e o seu hash identifica exatamente o que foi posto em serviço.
 */

export const FLOW_MANIFEST_FORMAT = 1;
/** Contrato das ações e das tarefas Copilot atualmente executadas pelo motor. */
export const FLOW_ACTION_CONTRACT_VERSION = 1;
export const FLOW_COPILOT_TASK_CONTRACT_VERSION = 1;
/** Tarefas Copilot com skills/especialistas compilados para o SDK (P04). */
export const FLOW_COPILOT_CAPABILITY_CONTRACT_VERSION = 2;

export interface FlowManifestSkill {
  nodeId: string;
  skillId: string;
  name: string;
  version: number;
  bundleHash: string;
}

export interface FlowManifestDelegate {
  nodeId: string;
  profileId: string;
  version: number;
  definitionHash: string;
}

export interface FlowManifestAgentProfile {
  nodeId: string;
  profileId: string;
  version: number;
  definitionHash: string;
}

export interface FlowManifestResource {
  nodeId: string;
  path: string;
  required: boolean;
  sha256: string | null;
}

export interface FlowManifestAction {
  nodeId: string;
  key: string;
  contractVersion: number;
  results: string[];
}

export interface FlowManifestCopilotTask {
  nodeId: string;
  mode: string;
  model: string | null;
  contractVersion: number;
  /** Só em tarefas com especialistas (contrato 2). */
  delegation?: { maxConcurrency: number; maxDepth: number };
}

export interface FlowManifestRouting {
  priority: number;
  isDefault: boolean;
  match: { origins: string[]; categories: string[]; environments: string[]; priorities: string[] };
  alertKeys: string[];
  /** Política semântica (P05); ausente quando vazia (hashes anteriores inalterados). */
  policy?: FlowRoutingPolicy;
}

export interface FlowManifest {
  format: number;
  flow: { logicHash: string; schemaVersion: number; runtimeContractVersion: number };
  routing: FlowManifestRouting;
  agentProfiles: FlowManifestAgentProfile[];
  repositoryResources: FlowManifestResource[];
  globalInstructions: { nodeId: string; path: string; sha256: string | null }[];
  actions: FlowManifestAction[];
  copilotTasks: FlowManifestCopilotTask[];
  /** Skills e especialistas fixados (P04); ausentes quando o fluxo não os usa. */
  skills?: FlowManifestSkill[];
  delegates?: FlowManifestDelegate[];
  /** Integrações usadas em runtime (informativo: credenciais e revogações ficam fora). */
  requires: string[];
}

export const flowActivateInputSchema = z.strictObject({
  expectedDraftVersion: z.number().int().min(1),
});

/** JSON canónico (chaves ordenadas, sem espaços) para hashes estáveis. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
    );
  return value;
}
