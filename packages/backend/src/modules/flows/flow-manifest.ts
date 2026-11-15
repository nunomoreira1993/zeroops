import { createHash } from 'node:crypto';
import {
  actionKey,
  canonicalJson,
  copilotMode,
  copilotStepModel,
  FLOW_ACTION_CONTRACT_VERSION,
  FLOW_COPILOT_CAPABILITY_CONTRACT_VERSION,
  FLOW_COPILOT_TASK_CONTRACT_VERSION,
  FLOW_MANIFEST_FORMAT,
  flowActionCatalog,
  flowRuntimeContractVersion,
  flowRuntimeSupported,
  flowSchemaVersion,
  isEmptyRoutingPolicy,
  type FlowDefinition,
  type FlowManifest,
  type FlowManifestRouting,
  type FlowMatch,
  type FlowRoutingPolicy,
} from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';
import type { FlowDependencyResolution } from '../agents/agent-profiles.service.js';
import { logicHash } from './flow-store.js';

const byKey =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) =>
    key(a).localeCompare(key(b));

/** Encaminhamento normalizado (listas ordenadas) para comparação e manifesto. */
export function normalizedRouting(input: {
  priority: number;
  isDefault: boolean;
  match: FlowMatch;
  alertKeys: string[];
  policy?: FlowRoutingPolicy | null;
}): FlowManifestRouting {
  return {
    priority: input.priority,
    isDefault: input.isDefault,
    match: {
      origins: [...input.match.origins].sort(),
      categories: [...input.match.categories].sort(),
      environments: [...input.match.environments].sort(),
      priorities: [...input.match.priorities].sort(),
    },
    alertKeys: [...new Set(input.alertKeys)].sort(),
    // Só presente quando definida: manifestos anteriores ao P05 mantêm o mesmo hash.
    ...(input.policy && !isEmptyRoutingPolicy(input.policy)
      ? {
          policy: {
            instructions: input.policy.instructions.trim(),
            positiveExamples: [...input.policy.positiveExamples],
            negativeExamples: [...input.policy.negativeExamples],
            fallbackOnUnresolved: input.policy.fallbackOnUnresolved,
          },
        }
      : {}),
  };
}

/** Recusa referências móveis (ex.: modelos «latest») antes de resolver dependências externas. */
export function assertPinnedReferences(definition: FlowDefinition) {
  for (const node of definition.nodes) {
    if (node.op !== 'copilot_task') continue;
    const model = copilotStepModel(node).model;
    if (model && /(^|[-_.:/])latest$/i.test(model))
      throw new DomainError(
        'FLOW_DEPENDENCY_MUTABLE',
        `A etapa «${node.label}» usa uma referência móvel de modelo («${model}»). Indique uma versão fixa.`,
        422,
      );
  }
}

/**
 * Manifesto determinístico da versão a ativar. Bloqueia ações sem executor no motor e contratos
 * que o runtime não suporta; credenciais e estados de integração ficam fora (revogações valem).
 */
export function buildFlowManifest(
  definition: FlowDefinition,
  routing: FlowManifestRouting,
  dependencies: FlowDependencyResolution,
  supportsAction: (key: string) => boolean,
): FlowManifest {
  assertPinnedReferences(definition);
  const runtimeContractVersion = flowRuntimeContractVersion(definition);
  if (!flowRuntimeSupported(runtimeContractVersion))
    throw new DomainError(
      'FLOW_RUNTIME_UNSUPPORTED',
      `Este runtime não executa o contrato de fluxo v${runtimeContractVersion}.`,
      422,
    );
  const actions: FlowManifest['actions'] = [];
  const copilotTasks: FlowManifest['copilotTasks'] = [];
  const requires = new Set<string>();
  for (const node of definition.nodes) {
    if (node.op === 'action') {
      const key = actionKey(node);
      const descriptor = flowActionCatalog[key];
      if (!descriptor || !supportsAction(key))
        throw new DomainError(
          'FLOW_DEPENDENCY_MISSING',
          `A ação «${key || '—'}» da etapa «${node.label}» não tem executor neste ZeroOps.`,
          422,
        );
      actions.push({
        nodeId: node.id,
        key,
        contractVersion: FLOW_ACTION_CONTRACT_VERSION,
        results: [...descriptor.results].sort(),
      });
      if (descriptor.external) requires.add(`action:${key}`);
    }
    if (node.op === 'copilot_task') {
      const model = copilotStepModel(node).model;
      const delegation = dependencies.delegationByNode?.[node.id];
      const usesCapabilities =
        delegation !== undefined ||
        (dependencies.skills ?? []).some((item) => item.nodeId === node.id);
      copilotTasks.push({
        nodeId: node.id,
        mode: copilotMode(node),
        model,
        contractVersion: usesCapabilities
          ? FLOW_COPILOT_CAPABILITY_CONTRACT_VERSION
          : FLOW_COPILOT_TASK_CONTRACT_VERSION,
        ...(delegation ? { delegation } : {}),
      });
      requires.add('copilot');
    }
  }
  const skills = [...(dependencies.skills ?? [])].sort(
    byKey((item) => `${item.nodeId}\0${item.name}`),
  );
  const delegates = [...(dependencies.delegates ?? [])].sort(
    byKey((item) => `${item.nodeId}\0${item.profileId}`),
  );
  if (skills.length || delegates.length) requires.add('copilot:capabilities');
  return {
    format: FLOW_MANIFEST_FORMAT,
    flow: {
      logicHash: logicHash(definition),
      schemaVersion: flowSchemaVersion(definition),
      runtimeContractVersion,
    },
    routing,
    agentProfiles: [...dependencies.agentProfiles].sort(byKey((item) => item.nodeId)),
    repositoryResources: [...dependencies.repositoryResources].sort(
      byKey((item) => `${item.nodeId}\0${item.path}`),
    ),
    globalInstructions: [...dependencies.globalInstructions].sort(
      byKey((item) => `${item.nodeId}\0${item.path}`),
    ),
    actions: actions.sort(byKey((item) => item.nodeId)),
    copilotTasks: copilotTasks.sort(byKey((item) => item.nodeId)),
    ...(skills.length ? { skills } : {}),
    ...(delegates.length ? { delegates } : {}),
    requires: [...requires].sort(),
  };
}

/** SHA-256 da serialização canónica do manifesto (identifica a configuração ativada). */
export function manifestHash(manifest: FlowManifest) {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}
