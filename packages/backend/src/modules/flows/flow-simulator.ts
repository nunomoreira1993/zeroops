import {
  FLOW_STEP_BUDGET,
  FLOW_SUCCESS,
  actionKey,
  decisionOptions,
  endOutcome,
  flowConditionPort,
  flowCopilotBlock,
  flowCopilotOutcome,
  flowDecisionNotRequired,
  flowVisitLimitExceeded,
  maxVisits,
  parseRoutingDecision,
  planFlowSelection,
  portLabel,
  resolveFlowTransition,
  resultPort,
  RoutingReplyError,
  type FlowDefinition,
  type FlowMatch,
  type FlowNode,
  type FlowRoutingPolicy,
  type FlowRoutingSimulationView,
  type FlowScenarioSpec,
  type FlowSimulationEffectView,
  type FlowSimulationLevel,
  type FlowSimulationResultView,
  type FlowSimulationStepView,
  type FlowSimulationUnavailable,
  type FlowStepFixture,
  type FlowTransitionFrom,
  type RoutingDecision,
  type TicketOrigin,
} from '../../../../contracts/src/index.js';
import type { Queryable } from '../identity/membership.js';
import {
  PORTABLE_FLOW_ACTIONS,
  type FlowActionEffects,
  type FlowActionRegistry,
} from './flow-actions.js';
import type { RoutingPromptCandidate } from './routing-prompt.js';

// ---------------------------------------------------------------------------------------------
// P07 — simulação de comportamento. Percorre a definição com as MESMAS regras de transição do
// motor (`flow-transitions`) e os MESMOS executores das ações portáveis; os efeitos externos
// passam por adapters (relógio, ferramentas, Copilot, pessoas, mensagens, incidente). Nenhum
// acesso à base de dados: o cliente entregue aos executores recusa qualquer query.

/** Cliente de base de dados recusado: um executor que tente escrever/ler falha a simulação. */
export const forbiddenSimulationClient: Queryable = {
  query: () =>
    Promise.reject(new Error('SIMULATION_DB_FORBIDDEN: a simulação não acede à base de dados.')),
};

/** Factos do projeto de que as etapas Copilot dependem (lidos em modo leitura ou do cenário). */
export interface FlowSimulationEnvironment {
  copilotReady: boolean;
  autoInvestigate: boolean;
  hasTeamMember: boolean;
}

/** Entrega no destino de ensaio isolado (outbox do projeto), nunca no ticket real. */
export type FlowTrialDeliver = (delivery: {
  nodeId: string;
  attempt: number;
  kind: FlowSimulationEffectView['kind'];
  payload: Record<string, unknown>;
}) => void;

export interface FlowBehaviourInput {
  definition: FlowDefinition;
  spec: FlowScenarioSpec;
  level: Extract<FlowSimulationLevel, 'behavior' | 'routing_copilot' | 'isolated_trial'>;
  environment: FlowSimulationEnvironment;
  actions: FlowActionRegistry;
  /** Ações com executor no runtime real (as restantes ficam sempre indisponíveis). */
  supportsAction?: (key: string) => boolean;
  /** Só no ensaio isolado: destino de teste configurado para mensagens e operações. */
  trial?: FlowTrialDeliver;
  start?: Date;
}

const MINUTE = 60_000;

/** Fixture da visita `attempt` (a última repete-se nas visitas seguintes). */
function fixtureFor(spec: FlowScenarioSpec, nodeId: string, attempt: number) {
  const list = spec.steps[nodeId];
  if (!list?.length) return null;
  return list[Math.min(attempt, list.length) - 1] ?? null;
}

/**
 * Percorre o fluxo com os resultados do cenário. Devolve o percurso, os efeitos (simulados ou
 * entregues no destino de ensaio), as capacidades indisponíveis e onde a execução para.
 */
export async function runFlowBehaviour(
  input: FlowBehaviourInput,
): Promise<FlowSimulationResultView> {
  const { definition, spec, level } = input;
  const trial = level === 'isolated_trial';
  const start = (input.start ?? new Date('2026-01-01T00:00:00.000Z')).getTime();
  const horizon = spec.horizonMinutes * MINUTE;
  let now = start;
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const visits = new Map<string, number>();
  const steps: FlowSimulationStepView[] = [];
  const effects: FlowSimulationEffectView[] = [];
  const unavailable: FlowSimulationUnavailable[] = [];
  let previous = {
    summary: null as string | null,
    replyDraft: null as string | null,
    patch: null as string | null,
  };
  let incidentClosed = false;
  let budget = FLOW_STEP_BUDGET;
  let from = null as FlowTransitionFrom | null;
  let currentId: string | null = definition.start;
  const ticketFacts = {
    origin: spec.ticket.origin,
    category: spec.ticket.category,
    environment: spec.ticket.environment,
    priority: spec.ticket.priority,
  };
  const minutes = () => Math.round((now - start) / MINUTE);
  const effect = (
    node: FlowNode,
    attempt: number,
    kind: FlowSimulationEffectView['kind'],
    summary: string,
    payload: Record<string, unknown> = {},
  ) => {
    const delivered = trial && input.trial && kind !== 'copilot_request';
    if (delivered)
      input.trial!({ nodeId: node.id, attempt, kind, payload: { summary, ...payload } });
    effects.push({
      nodeId: node.id,
      attempt,
      kind,
      mode: delivered ? 'trial' : 'simulated',
      summary: summary.slice(0, 500),
    });
  };
  const result = (
    outcome: FlowSimulationResultView['outcome'],
    node: FlowNode | null,
    message: string,
    extra: Partial<FlowSimulationResultView> = {},
  ): FlowSimulationResultView => ({
    level,
    outcome,
    endOutcome: outcome === 'ended' && node ? endOutcome(node) : null,
    stoppedAt: node ? { nodeId: node.id, label: node.label } : null,
    waitingFor: null,
    message,
    steps,
    effects,
    unavailable,
    issues: [],
    routing: null,
    notVerified: [],
    elapsedMinutes: minutes(),
    ...extra,
  });
  const advance = (fixture: FlowStepFixture | null) => {
    if (fixture?.afterMinutes) now += fixture.afterMinutes * MINUTE;
  };
  const beyondHorizon = () => now - start > horizon;

  while (currentId) {
    const node = nodes.get(currentId);
    if (!node) return result('failed', null, `A etapa «${currentId}» não existe na definição.`);
    budget -= 1;
    if (budget < 0)
      return result(
        'failed',
        node,
        'Demasiadas etapas seguidas sem espera: o motor interrompe o fluxo.',
      );
    const attempt = (visits.get(node.id) ?? 0) + 1;
    visits.set(node.id, attempt);
    if (flowVisitLimitExceeded(node, attempt))
      return result(
        'failed',
        node,
        `«${node.label}» atingiu o limite de ${maxVisits(node)} passagens: o motor bloqueia o pedido para revisão da equipa.`,
      );
    const startedAt = now;
    const step = (
      value: string | null,
      port: string | null,
      source: FlowSimulationStepView['source'],
      detail: string | null = null,
    ) =>
      steps.push({
        nodeId: node.id,
        label: node.label,
        op: node.op,
        attempt,
        atMinutes: minutes(),
        result: value,
        port,
        source,
        detail: detail ? detail.slice(0, 500) : null,
      });
    const wait = (
      waitingFor: NonNullable<FlowSimulationResultView['waitingFor']>,
      text: string,
    ) => {
      step(null, null, 'waiting', text);
      return result('waiting', node, text, { waitingFor });
    };
    /** Conclui a etapa com o resultado detalhado e segue a mesma transição que o motor. */
    const complete = (
      value: string,
      source: FlowSimulationStepView['source'],
      detail: string | null = null,
    ): FlowSimulationResultView | null => {
      const transition = resolveFlowTransition(definition, node.id, value, from?.nodeId ?? null);
      step(value, transition.port, source, detail);
      if (transition.kind === 'missing')
        return result(
          'failed',
          node,
          `A saída «${portLabel(node, transition.port)}» de «${node.label}» não tem destino: o motor interrompe o fluxo.`,
        );
      from = { nodeId: node.id, result: value, port: transition.port };
      currentId = transition.target;
      return null;
    };

    if (node.op === 'end') {
      step(null, null, 'end');
      const incidentOpen = spec.incident?.state === 'open' && !incidentClosed;
      if (incidentOpen)
        effect(node, attempt, 'close_incident', 'O fim do fluxo fecha o incidente da Saúde.');
      return result('ended', node, `Pedido terminado (${endOutcome(node)}).`);
    }

    if (node.op === 'condition') {
      const port = flowConditionPort(node, ticketFacts, from);
      const stop = complete(port, 'condition');
      if (stop) return stop;
      continue;
    }

    if (node.op === 'human_decision') {
      if (flowDecisionNotRequired(node, from)) {
        const stop = complete(
          FLOW_SUCCESS,
          'skipped',
          'Decisão não necessária para este resultado.',
        );
        if (stop) return stop;
        continue;
      }
      const fixture = fixtureFor(spec, node.id, attempt);
      if (!fixture?.result || fixture.wait)
        return wait('human_decision', `O pedido fica à espera da decisão «${node.label}».`);
      advance(fixture);
      if (beyondHorizon()) return wait('clock', 'O horizonte de tempo do cenário terminou.');
      if (!decisionOptions(node).some((option) => option.port === fixture.result)) {
        step(fixture.result, null, 'fixture');
        return result(
          'invalid',
          node,
          `«${fixture.result}» não é uma opção da decisão «${node.label}».`,
        );
      }
      budget = FLOW_STEP_BUDGET;
      const stop = complete(fixture.result, 'fixture', fixture.comment ?? null);
      if (stop) return stop;
      continue;
    }

    if (node.op === 'copilot_task') {
      const block = flowCopilotBlock(node, { profile: null, ...input.environment });
      if (block) {
        unavailable.push({ nodeId: node.id, capability: 'copilot', reason: block.reason });
        const stop = complete('failed', 'precheck', block.reason);
        if (stop) return stop;
        continue;
      }
      if (trial) {
        unavailable.push({
          nodeId: node.id,
          capability: 'copilot',
          reason: 'O ensaio isolado ainda não executa o Copilot contra recursos de teste.',
        });
        step(null, null, 'waiting', 'Capacidade indisponível no ensaio isolado.');
        return result(
          'unavailable',
          node,
          `«${node.label}» precisa do Copilot, que ainda não tem destino de ensaio isolado.`,
        );
      }
      const fixture = fixtureFor(spec, node.id, attempt);
      if (!fixture)
        return wait(
          'missing_fixture',
          `O cenário não indica a resposta do Copilot em «${node.label}» (visita ${attempt}).`,
        );
      effect(node, attempt, 'copilot_request', `Pedido ao Copilot (${node.label}) — não enviado.`);
      if (fixture.wait)
        return wait('copilot', `O pedido fica à espera do Copilot em «${node.label}».`);
      advance(fixture);
      if (beyondHorizon()) return wait('clock', 'O horizonte de tempo do cenário terminou.');
      budget = FLOW_STEP_BUDGET;
      const succeeded = !fixture.result || resultPort(fixture.result) === FLOW_SUCCESS;
      const outcome = flowCopilotOutcome(definition, node, {
        succeeded,
        askedClient: Boolean(fixture.asksClient),
      });
      if (outcome === 'await_client') {
        effect(
          node,
          attempt,
          'client_question',
          fixture.summary ?? 'O Copilot pergunta ao cliente.',
        );
        if (fixture.clientReply === undefined)
          return wait(
            'client_reply',
            `O pedido fica à espera da resposta do cliente em «${node.label}».`,
          );
        const stop = complete('needs_information', 'fixture', `Cliente: ${fixture.clientReply}`);
        if (stop) return stop;
        continue;
      }
      previous = {
        summary: fixture.summary ?? null,
        replyDraft: fixture.replyDraft ?? null,
        patch: fixture.patch ?? null,
      };
      const stop = complete(outcome, 'fixture', fixture.summary ?? fixture.reason ?? null);
      if (stop) return stop;
      continue;
    }

    // Ações: o cenário pode fixar o resultado; sem fixture, só as portáveis correm (com efeitos
    // simulados); as restantes ficam indisponíveis, sem sucesso fictício.
    const key = actionKey(node);
    if (input.supportsAction && !input.supportsAction(key)) {
      // Capacidade inexistente no runtime: nem uma fixture a torna disponível.
      unavailable.push({
        nodeId: node.id,
        capability: `action:${key}`,
        reason: 'O runtime deste ZeroOps não tem executor para esta ação.',
      });
      step(null, null, 'waiting', 'Capacidade indisponível no runtime.');
      return result('unavailable', node, `A ação «${key || '—'}» não existe neste runtime.`);
    }
    const fixture = fixtureFor(spec, node.id, attempt);
    const portable = PORTABLE_FLOW_ACTIONS.has(key);
    if (fixture && !(trial && portable)) {
      if (trial) {
        unavailable.push({
          nodeId: node.id,
          capability: `action:${key}`,
          reason: 'Ação sem integração de ensaio isolado: não é executada nem simulada no ensaio.',
        });
        step(null, null, 'waiting', 'Capacidade indisponível no ensaio isolado.');
        return result('unavailable', node, `A ação «${key}» não tem destino de ensaio isolado.`);
      }
      if (fixture.wait || !fixture.result)
        return wait('tool', `O pedido fica à espera da ação «${node.label}».`);
      advance(fixture);
      if (beyondHorizon()) return wait('clock', 'O horizonte de tempo do cenário terminou.');
      const stop = complete(fixture.result, 'fixture', fixture.reason ?? null);
      if (stop) return stop;
      continue;
    }
    const executor = portable ? input.actions[key] : undefined;
    if (!executor) {
      unavailable.push({
        nodeId: node.id,
        capability: `action:${key}`,
        reason: portable
          ? 'Sem executor neste ZeroOps.'
          : 'A ação acede a recursos reais: indique o resultado no cenário para a simular.',
      });
      step(null, null, 'waiting', 'Capacidade indisponível.');
      return result(
        'unavailable',
        node,
        `A ação «${key || '—'}» de «${node.label}» não pode ser executada nesta simulação.`,
      );
    }
    const adapters: FlowActionEffects = {
      comment: async (visibility, body) =>
        effect(
          node,
          attempt,
          visibility === 'public' ? 'comment_public' : 'comment_internal',
          body,
          { visibility, body },
        ),
      healthIncidentState: async () => {
        if (!spec.incident || spec.incident.state === 'none') return null;
        if (incidentClosed) return 'closed';
        const recovers = spec.incident.recoversAfterMinutes;
        return recovers !== undefined && now - start >= recovers * MINUTE ? 'recovered' : 'open';
      },
      closeHealthIncident: async () => {
        incidentClosed = true;
        effect(node, attempt, 'close_incident', 'Incidente da Saúde fechado.');
      },
    };
    for (;;) {
      const outcome = await executor({
        client: forbiddenSimulationClient,
        ticket: {
          id: '00000000-0000-4000-8000-00000000f707',
          projectId: '00000000-0000-4000-8000-00000000f707',
          createdBy: '00000000-0000-4000-8000-00000000f707',
          origin: spec.ticket.origin,
        },
        node,
        step: { id: `${node.id}:${attempt}`, attempt, startedAt: new Date(startedAt) },
        previous,
        now: new Date(now),
        effects: adapters,
      });
      if (!('wait' in outcome)) {
        const detail =
          typeof outcome.output?.reason === 'string'
            ? outcome.output.reason
            : typeof outcome.output?.external === 'string'
              ? outcome.output.external
              : typeof outcome.output?.summary === 'string'
                ? outcome.output.summary
                : null;
        const stop = complete(outcome.port, 'executor', detail);
        if (stop) return stop;
        break;
      }
      // Relógio controlado: a espera avança o tempo simulado e a etapa é reavaliada.
      now = Math.max(outcome.wait.getTime(), now + 1);
      budget = FLOW_STEP_BUDGET;
      if (beyondHorizon())
        return wait('clock', `«${node.label}» continua à espera no fim do horizonte.`);
    }
  }
  return result('failed', null, 'Destino inexistente.');
}

// ---------------------------------------------------------------------------------------------
// Encaminhamento (P05) na simulação: o próprio fluxo entra com as regras e a política do
// RASCUNHO; os restantes candidatos são os fluxos ativos do projeto.

/** Fluxo considerado no plano de encaminhamento simulado. */
export interface SimulatedRoutingFlow {
  id: string;
  name: string;
  priority: number;
  isDefault: boolean;
  match: FlowMatch;
  policy: FlowRoutingPolicy | null;
  /** O fluxo em teste (rascunho). */
  draft: boolean;
}

/** Plano de encaminhamento simulado: decisão direta pelas regras ou candidatos a classificar. */
export interface SimulatedRoutingPlan {
  view: FlowRoutingSimulationView;
  /** Candidatos e chaves para o classificador (apenas quando é preciso classificar). */
  prompt: RoutingPromptCandidate[] | null;
}

/** Aplica as regras estruturadas; quando há candidatos semânticos fixa as chaves (C1…, F). */
export function planSimulatedRouting(
  flows: SimulatedRoutingFlow[],
  ticket: FlowScenarioSpec['ticket'],
): SimulatedRoutingPlan {
  // Factos livres do cenário: uma origem desconhecida simplesmente não coincide com regras de origem.
  const plan = planFlowSelection(flows, { ...ticket, origin: ticket.origin as TicketOrigin });
  const self = flows.find((flow) => flow.draft);
  if (plan.kind === 'direct') {
    const flow = plan.flow;
    return {
      view: {
        source: 'rules',
        decision: !flow ? 'none' : flow.id === self?.id ? 'this' : 'other',
        chosenFlowId: flow?.id ?? null,
        chosenName: flow?.name ?? null,
        candidates: [],
        fallbackName: null,
        reason: flow
          ? 'Escolha direta pelas regras estruturadas (sem classificação).'
          : 'Nenhum fluxo ativo coincide e não há fluxo por omissão.',
        question: null,
        observedReply: null,
      },
      prompt: null,
    };
  }
  const keyed = plan.candidates.map((flow, index) => ({ key: `C${index + 1}`, flow }));
  if (plan.fallback) keyed.push({ key: 'F', flow: plan.fallback });
  return {
    view: {
      source: 'none',
      decision: 'pending',
      chosenFlowId: null,
      chosenName: null,
      candidates: keyed.map((item) => ({
        key: item.key,
        flowId: item.flow.id,
        name: item.flow.name,
        draft: item.flow.draft,
      })),
      fallbackName: plan.fallback?.name ?? null,
      reason: null,
      question: null,
      observedReply: null,
    },
    // Como no encaminhador real, o fallback não é oferecido ao classificador (só via `none`).
    prompt: keyed
      .filter((item) => item.key !== 'F')
      .map((item) => ({
        key: item.key,
        name: item.flow.name,
        policy: item.flow.policy,
      })),
  };
}

/**
 * Interpreta uma resposta do classificador (gravada ou observada) com a mesma validação do P05:
 * identificadores fora dos candidatos fixados ou formato inválido dão `invalid`, nunca escolha.
 */
export function applyRoutingReply(
  view: FlowRoutingSimulationView,
  text: string,
  source: 'recorded' | 'copilot',
): FlowRoutingSimulationView {
  const choosable = view.candidates.filter((item) => item.key !== 'F');
  const keys = choosable.map((item) => item.key);
  const names = choosable.map((item) => item.name);
  const observedReply = text.slice(0, 4000);
  let decision: RoutingDecision;
  try {
    decision = parseRoutingDecision(text, keys, names);
  } catch (error) {
    if (!(error instanceof RoutingReplyError)) throw error;
    return { ...view, source, decision: 'invalid', reason: error.message, observedReply };
  }
  const chosen =
    decision.decision === 'choose'
      ? choosable.find((item) => item.key === decision.candidate)
      : decision.decision === 'none' && view.fallbackName
        ? view.candidates.find((item) => item.key === 'F')
        : undefined;
  return {
    ...view,
    source,
    decision:
      decision.decision === 'clarify'
        ? 'clarify'
        : decision.decision === 'none'
          ? chosen
            ? 'fallback'
            : 'none'
          : chosen?.draft
            ? 'this'
            : 'other',
    chosenFlowId: chosen?.flowId ?? null,
    chosenName: chosen?.name ?? null,
    reason: decision.reason,
    question: decision.question,
    observedReply,
  };
}

/** O que cada nível NÃO verifica (para não confundir simulação com certificação completa). */
export function notVerifiedFor(
  level: FlowSimulationLevel,
  routing: FlowRoutingSimulationView | null,
) {
  const items: string[] = [];
  if (level === 'structural')
    items.push(
      'Comportamento das etapas não percorrido (apenas grafo, contratos, referências e dependências).',
    );
  if (level !== 'structural') {
    items.push(
      level === 'isolated_trial'
        ? 'Copilot e ações sem integração de ensaio ficam indisponíveis (não são simulados no ensaio).'
        : 'Resultados de ferramentas, Copilot e pessoas vêm do cenário (fixtures), não de execuções reais.',
    );
    items.push(
      level === 'isolated_trial'
        ? 'Mensagens e operações foram entregues apenas no destino de ensaio isolado.'
        : 'Nenhum efeito externo foi executado: mensagens, notas e incidentes ficam apenas registados.',
    );
    items.push('Perfis ZeroOps e modelos validados apenas pelo manifesto de dependências.');
  }
  items.push('Associações explícitas de alertas da Saúde não são simuladas.');
  if (routing?.decision === 'pending')
    items.push('Encaminhamento semântico não avaliado (sem resposta gravada nem Copilot real).');
  if (routing?.source === 'recorded')
    items.push('Encaminhamento avaliado com uma resposta gravada, não com o Copilot real.');
  return items;
}
