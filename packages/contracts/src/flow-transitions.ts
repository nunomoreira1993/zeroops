import type { FlowConditionFacts } from './flow-conditions.js';
import { evaluateConditionNode } from './flow-conditions.js';
import {
  FLOW_INTERNAL_RESULTS,
  FLOW_SUCCESS,
  actionKey,
  copilotMode,
  decisionOnlyWhen,
  decisionOptions,
  endOutcome,
  flowActionCatalog,
  maxVisits,
  nodePorts,
  resultPort,
  type FlowDefinition,
  type FlowNode,
  type FlowScenario,
  type FlowText,
  type SimulatedStep,
  type SimulationResult,
} from './flows.js';

// ---------------------------------------------------------------------------------------------
// Regras de transição partilhadas pelo motor real (`FlowEngine`) e pelo simulador (P07). Funções
// puras: nenhum efeito, nenhuma leitura de base de dados. Com as mesmas entradas, o runtime e a
// simulação percorrem exatamente as mesmas transições lógicas.

/** Etapas seguidas sem espera antes de o motor interromper a execução (proteção contra ciclos). */
export const FLOW_STEP_BUDGET = 60;

/** Etapa de onde se chegou (resultado detalhado e porta de saída). */
export interface FlowTransitionFrom {
  nodeId: string;
  result?: string | null;
  port?: string | null;
}

/** Destino de uma etapa concluída com um resultado detalhado. */
export type FlowTransition =
  | { kind: 'edge'; port: string; result: string; target: string; edgeId: string }
  | { kind: 'internal'; port: string; result: string; target: string }
  | { kind: 'missing'; port: string; result: string };

/**
 * Resolve a saída de uma etapa: a ligação com o nome exato do resultado (fluxos antigos), os
 * resultados internos (`retry` volta à etapa anterior, `needs_information` repete a etapa) ou a
 * porta sucesso/erro correspondente ao resultado.
 */
export function resolveFlowTransition(
  definition: Pick<FlowDefinition, 'nodes' | 'edges'>,
  nodeId: string,
  result: string,
  previousNodeId: string | null,
): FlowTransition {
  const outgoing = definition.edges.filter((edge) => edge.source === nodeId);
  const exact = outgoing.find((edge) => edge.port === result);
  const port = exact ? result : resultPort(result);
  if (!exact && (FLOW_INTERNAL_RESULTS as readonly string[]).includes(result)) {
    const target = result === 'retry' ? previousNodeId : nodeId;
    if (target && definition.nodes.some((node) => node.id === target))
      return { kind: 'internal', port, result, target };
  }
  const edge = outgoing.find((item) => item.port === port);
  return edge
    ? { kind: 'edge', port, result, target: edge.target, edgeId: edge.id }
    : { kind: 'missing', port, result };
}

/** A visita `attempt` ultrapassa o limite de passagens da etapa (o motor bloqueia o pedido). */
export function flowVisitLimitExceeded(node: Pick<FlowNode, 'config'>, attempt: number) {
  return attempt > maxVisits(node);
}

/** Decisão humana condicional (`onlyWhen`) que não precisa de pessoa para este resultado. */
export function flowDecisionNotRequired(
  node: Pick<FlowNode, 'op' | 'config'>,
  from: Pick<FlowTransitionFrom, 'result' | 'port'> | null | undefined,
) {
  if (node.op !== 'human_decision') return false;
  const onlyWhen = decisionOnlyWhen(node);
  const previous = from?.result ?? from?.port;
  return onlyWhen.length > 0 && !(previous && onlyWhen.includes(previous));
}

/** Porta escolhida por uma etapa `condition` com os factos do pedido e da etapa anterior. */
export function flowConditionPort(
  node: Pick<FlowNode, 'config'>,
  ticket: FlowConditionFacts['ticket'],
  from: Pick<FlowTransitionFrom, 'result' | 'port'> | null | undefined,
) {
  return evaluateConditionNode(node.config, {
    ...(ticket ? { ticket } : {}),
    previous: { result: from?.result ?? null, port: from?.port ?? null },
  });
}

/** Factos de que uma etapa Copilot depende antes de pedir trabalho. */
export interface FlowCopilotEnvironment {
  /** Modos suportados pelo perfil ZeroOps fixado na execução (`null` = sem perfil). */
  profile: { name: string; modes: readonly string[] } | null;
  autoInvestigate: boolean;
  copilotReady: boolean;
  hasTeamMember: boolean;
}

/** Bloqueio de uma etapa Copilot antes de pedir trabalho (`null` = pode pedir). */
export interface FlowCopilotBlock {
  errorCode:
    | 'agent_profile_mode_unsupported'
    | 'auto_disabled'
    | 'copilot_not_configured'
    | 'no_team_member';
  reason: string;
}

/** Pré-verificações de uma etapa Copilot, pela mesma ordem do motor. */
export function flowCopilotBlock(
  node: Pick<FlowNode, 'config'>,
  environment: FlowCopilotEnvironment,
): FlowCopilotBlock | null {
  const mode = copilotMode(node);
  if (environment.profile && !environment.profile.modes.includes(mode))
    return {
      errorCode: 'agent_profile_mode_unsupported',
      reason: `O perfil «${environment.profile.name}» não suporta o modo ${mode}.`,
    };
  if (node.config.skipWhenAutoDisabled && !environment.autoInvestigate)
    return {
      errorCode: 'auto_disabled',
      reason: 'A investigação automática está desativada neste projeto.',
    };
  if (!environment.copilotReady)
    return {
      errorCode: 'copilot_not_configured',
      reason: 'O Copilot não está configurado e verificado neste projeto.',
    };
  if (!environment.hasTeamMember)
    return { errorCode: 'no_team_member', reason: 'Não há membros da equipa ativos no projeto.' };
  return null;
}

/**
 * Resultado de uma etapa Copilot terminada: `await_client` = a análise perguntou algo ao cliente e
 * a etapa espera pela resposta (depois repete-se com `needs_information`).
 */
export function flowCopilotOutcome(
  definition: Pick<FlowDefinition, 'edges'>,
  node: Pick<FlowNode, 'id' | 'config'>,
  run: { succeeded: boolean; askedClient: boolean },
): 'failed' | 'done' | 'needs_information' | 'await_client' {
  if (!run.succeeded) return 'failed';
  if (copilotMode(node) !== 'analysis' || !run.askedClient) return 'done';
  const legacyEdge = definition.edges.some(
    (edge) => edge.source === node.id && edge.port === 'needs_information',
  );
  return legacyEdge ? 'needs_information' : 'await_client';
}

// ---------------------------------------------------------------------------------------------
// Percurso rápido («Experimentar com um ticket»): porta planeada por etapa e visita, sem efeitos.
// Usa as mesmas regras de transição do motor; a simulação de comportamento completa (executores,
// relógio e fixtures) está no backend (`flow-simulator.ts`).

function defaultResult(node: FlowNode): string | null {
  switch (node.op) {
    case 'action':
      return flowActionCatalog[actionKey(node)]?.simulationPort ?? null;
    case 'copilot_task':
      return FLOW_SUCCESS;
    case 'human_decision':
      return decisionOptions(node)[0]?.port ?? null;
    case 'condition':
    case 'end':
      return null;
  }
}

function simulatedEffect(node: FlowNode): FlowText {
  switch (node.op) {
    case 'condition':
      return {
        pt: 'Condição avaliada sobre os factos do pedido.',
        en: 'Condition evaluated against the ticket facts.',
      };
    case 'action': {
      const descriptor = flowActionCatalog[actionKey(node)];
      const name = descriptor?.label ?? { pt: 'Ação', en: 'Action' };
      return {
        pt: `${name.pt} — não executada na simulação.`,
        en: `${name.en} — not executed in the simulation.`,
      };
    }
    case 'copilot_task':
      return {
        pt: `Pedido ao Copilot (${copilotMode(node)}) — não enviado na simulação.`,
        en: `Copilot request (${copilotMode(node)}) — not sent in the simulation.`,
      };
    case 'human_decision':
      return { pt: 'Decisão humana simulada.', en: 'Simulated human decision.' };
    case 'end':
      return { pt: `Fim: ${endOutcome(node)}.`, en: `End: ${endOutcome(node)}.` };
  }
}

/** Resultado planeado aceite pelo motor nesta etapa (porta, resultado detalhado ou interno). */
function plannedResult(node: FlowNode, planned: string | undefined) {
  if (!planned) return null;
  const ports = nodePorts(node);
  if (ports.includes(planned) || ports.includes(resultPort(planned))) return planned;
  return (FLOW_INTERNAL_RESULTS as readonly string[]).includes(planned) ? planned : null;
}

/**
 * Percorre o fluxo sem efeitos. O cenário indica, por etapa, o resultado em cada visita
 * (`wait` = fica à espera nessa visita); visitas além do cenário usam o resultado por omissão.
 */
export function simulateFlow(
  definition: FlowDefinition,
  scenario: FlowScenario = {},
  limit = 80,
  ticket?: FlowConditionFacts['ticket'],
): SimulationResult {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const visits = new Map<string, number>();
  const steps: SimulatedStep[] = [];
  let from = null as FlowTransitionFrom | null;
  let current = nodes.get(definition.start);
  const stop = (
    outcome: SimulationResult['outcome'],
    node: FlowNode | undefined,
    message: FlowText,
  ): SimulationResult => ({
    steps,
    outcome,
    stoppedAt: node
      ? { nodeId: node.id, label: node.label, assignee: node.assignee ?? null }
      : null,
    endOutcome: outcome === 'ended' && node ? endOutcome(node) : null,
    message,
  });
  while (current) {
    if (steps.length >= limit)
      return stop('loop_limit', current, {
        pt: 'Simulação interrompida: demasiadas etapas.',
        en: 'Simulation stopped: too many steps.',
      });
    const attempt = (visits.get(current.id) ?? 0) + 1;
    visits.set(current.id, attempt);
    if (flowVisitLimitExceeded(current, attempt))
      return stop('loop_limit', current, {
        pt: `«${current.label}» excedeu ${maxVisits(current)} visitas: o motor bloqueia o pedido para revisão da equipa.`,
        en: `«${current.label}» exceeded ${maxVisits(current)} visits: the engine blocks the ticket for team review.`,
      });
    const step = (port: string | null, effect: FlowText = simulatedEffect(current!)) =>
      steps.push({
        nodeId: current!.id,
        label: current!.label,
        op: current!.op,
        attempt,
        port,
        assignee: current!.op === 'end' ? null : (current!.assignee ?? null),
        effect,
      });
    if (current.op === 'end') {
      step(null);
      return stop('ended', current, {
        pt: `Pedido terminado (${endOutcome(current)}).`,
        en: `Ticket finished (${endOutcome(current)}).`,
      });
    }
    const planned = scenario[current.id]?.[attempt - 1];
    const skipped = flowDecisionNotRequired(current, from);
    if (!skipped && planned === 'wait') {
      step(null);
      return stop('waiting', current, {
        pt: `O pedido fica em «${current.label}».`,
        en: `The ticket stays at «${current.label}».`,
      });
    }
    const result: string | null = skipped
      ? FLOW_SUCCESS
      : current.op === 'condition'
        ? (plannedResult(current, planned) ?? flowConditionPort(current, ticket, from))
        : (plannedResult(current, planned) ?? defaultResult(current));
    const transition: FlowTransition | null = result
      ? resolveFlowTransition(definition, current.id, result, from?.nodeId ?? null)
      : null;
    step(
      transition?.port ?? null,
      skipped
        ? { pt: 'Decisão não necessária para este resultado.', en: 'Decision not required.' }
        : undefined,
    );
    if (!transition || transition.kind === 'missing')
      return stop('invalid', current, {
        pt: `A saída «${transition?.port ?? '—'}» de «${current.label}» não tem destino.`,
        en: `Output «${transition?.port ?? '—'}» of «${current.label}» has no target.`,
      });
    from = { nodeId: current.id, result: result!, port: transition.port };
    current = nodes.get(transition.target);
  }
  return stop('invalid', undefined, { pt: 'Destino inexistente.', en: 'Missing target.' });
}
