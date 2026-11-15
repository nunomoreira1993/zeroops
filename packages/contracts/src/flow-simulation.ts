import { z } from 'zod';
import {
  FLOW_FAILURE,
  FLOW_SUCCESS,
  actionKey,
  copilotMode,
  decisionOptions,
  type FlowDefinition,
  type FlowNode,
} from './flows.js';

// ---------------------------------------------------------------------------------------------
// P07 — simulador partilhado com o runtime. Um cenário fornece os resultados externos (ferramentas,
// Copilot, pessoas, cliente, tempo); o backend percorre o fluxo com as mesmas regras de transição e
// os mesmos executores do motor, sem efeitos reais.

/**
 * Níveis de validação, sempre identificados no resultado:
 * - `structural`: grafo, contratos, condições, referências, responsáveis e dependências;
 * - `behavior`: percurso com os resultados do cenário (fixtures), sem operações externas;
 * - `routing_copilot`: avaliação do encaminhamento com o Copilot real (resposta observada);
 * - `isolated_trial`: executa as capacidades disponíveis contra destinos de teste configurados.
 */
export const flowSimulationLevels = [
  'structural',
  'behavior',
  'routing_copilot',
  'isolated_trial',
] as const;
export type FlowSimulationLevel = (typeof flowSimulationLevels)[number];

const nodeIdSchema = z.string().trim().min(1).max(64);
const factSchema = z.string().trim().max(40);

/** Resultado externo de uma visita a uma etapa (o que a ferramenta, o Copilot ou a pessoa devolve). */
export const flowStepFixtureSchema = z.strictObject({
  /** Resultado detalhado ou porta (ex.: `done`, `failed`, `success`, opção da decisão). */
  result: z.string().trim().min(1).max(40).optional(),
  /** Fica à espera nesta visita (pessoa, Copilot ou ferramenta ainda sem resposta). */
  wait: z.boolean().optional(),
  /** Minutos simulados que a etapa demora a responder. */
  afterMinutes: z.number().int().min(0).max(10_080).optional(),
  summary: z.string().max(4000).optional(),
  replyDraft: z.string().max(4000).optional(),
  patch: z.string().max(20_000).optional(),
  /** A análise do Copilot pergunta algo ao cliente. */
  asksClient: z.boolean().optional(),
  /** Resposta do cliente à pergunta (sem resposta = o pedido fica à espera do cliente). */
  clientReply: z.string().max(2000).optional(),
  comment: z.string().max(2000).optional(),
  reason: z.string().max(1000).optional(),
});
export type FlowStepFixture = z.infer<typeof flowStepFixtureSchema>;

export const flowSimulationOutcomes = [
  'ended',
  'waiting',
  'failed',
  'unavailable',
  'invalid',
] as const;
export type FlowSimulationOutcome = (typeof flowSimulationOutcomes)[number];

export const flowRoutingExpectations = ['this', 'other', 'clarify', 'fallback', 'none'] as const;
export type FlowRoutingExpectation = (typeof flowRoutingExpectations)[number];

export const flowSimulationExpectedSchema = z.strictObject({
  outcome: z.enum(flowSimulationOutcomes).optional(),
  endOutcome: z.enum(['resolved', 'cancelled', 'escalated']).optional(),
  /** Etapas percorridas, por ordem (o percurso observado tem de ser exatamente este). */
  path: z.array(nodeIdSchema).max(80).optional(),
  /** Etapa onde a execução espera, falha ou termina. */
  stopsAt: nodeIdSchema.optional(),
  /** Escolha esperada do encaminhamento (este fluxo, outro, esclarecimento, fallback, nenhum). */
  routing: z.enum(flowRoutingExpectations).optional(),
});
export type FlowSimulationExpected = z.infer<typeof flowSimulationExpectedSchema>;

export const flowScenarioSpecSchema = z.strictObject({
  ticket: z
    .strictObject({
      title: z.string().trim().max(300).default(''),
      description: z.string().max(6000).default(''),
      origin: factSchema.default('portal_client'),
      category: factSchema.default('question'),
      environment: factSchema.default('production'),
      priority: factSchema.default('normal'),
    })
    .prefault({}),
  /** Ticket histórico de onde os factos foram copiados (só leitura; nunca é alterado). */
  sourceTicket: z
    .strictObject({ id: z.uuid(), key: z.string().max(40), snapshotAt: z.string().max(40) })
    .optional(),
  /** Resultados por etapa e visita (a última repete-se nas visitas seguintes). */
  steps: z.record(nodeIdSchema, z.array(flowStepFixtureSchema).min(1).max(20)).default({}),
  incident: z
    .strictObject({
      state: z.enum(['none', 'open']),
      /** Minutos (desde o início) até os alertas recuperarem; ausente = não recuperam. */
      recoversAfterMinutes: z.number().int().min(0).max(10_080).optional(),
    })
    .optional(),
  /** Substitui factos do projeto (Copilot configurado, investigação automática, equipa). */
  environment: z
    .strictObject({
      copilotReady: z.boolean().optional(),
      autoInvestigate: z.boolean().optional(),
      hasTeamMember: z.boolean().optional(),
    })
    .optional(),
  /** Tempo máximo simulado (relógio controlado). */
  horizonMinutes: z.number().int().min(1).max(10_080).default(1440),
  routing: z
    .strictObject({
      /** Resposta gravada do classificador (JSON do P05) para avaliação determinística. */
      recordedReply: z.string().max(8000).optional(),
    })
    .optional(),
  expected: flowSimulationExpectedSchema.default({}),
});
export type FlowScenarioSpec = z.infer<typeof flowScenarioSpecSchema>;
export type FlowScenarioSpecInput = z.input<typeof flowScenarioSpecSchema>;

export const flowScenarioInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(''),
  spec: flowScenarioSpecSchema,
  /** Versão conhecida pelo editor (controlo otimista); ausente ao criar. */
  version: z.number().int().min(1).optional(),
});
export type FlowScenarioInput = z.infer<typeof flowScenarioInputSchema>;

export const flowScenarioFromTicketSchema = z.strictObject({
  ticketId: z.uuid(),
  name: z.string().trim().min(1).max(120).optional(),
});

export const flowSimulationRunInputSchema = z.strictObject({
  level: z.enum(flowSimulationLevels),
  scenarioId: z.uuid().optional(),
  /** Cenário não guardado (rascunho do editor). */
  spec: flowScenarioSpecSchema.optional(),
  idempotencyKey: z.string().trim().min(8).max(80),
  trialTargetId: z.uuid().optional(),
});
export type FlowSimulationRunInput = z.infer<typeof flowSimulationRunInputSchema>;

export const flowTrialTargetInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
});

// ---------------------------------------------------------------------------------------------
// Resultado

export interface FlowSimulationStepView {
  nodeId: string;
  label: string;
  op: FlowNode['op'];
  attempt: number;
  /** Minutos simulados desde o início. */
  atMinutes: number;
  result: string | null;
  port: string | null;
  /** Origem do resultado: cenário, executor real (com efeitos simulados), condição, etc. */
  source: 'fixture' | 'executor' | 'condition' | 'skipped' | 'precheck' | 'end' | 'waiting';
  detail: string | null;
}

export interface FlowSimulationEffectView {
  nodeId: string;
  attempt: number;
  kind:
    | 'comment_public'
    | 'comment_internal'
    | 'close_incident'
    | 'copilot_request'
    | 'client_question';
  /** `simulated` = registado sem executar; `trial` = entregue no destino de ensaio isolado. */
  mode: 'simulated' | 'trial';
  summary: string;
}

export interface FlowSimulationUnavailable {
  nodeId: string | null;
  capability: string;
  reason: string;
}

export interface FlowRoutingSimulationView {
  /** `rules` = regras estruturadas; `recorded` = resposta gravada; `copilot` = Copilot real. */
  source: 'rules' | 'recorded' | 'copilot' | 'none';
  decision: FlowRoutingExpectation | 'invalid' | 'pending';
  chosenFlowId: string | null;
  chosenName: string | null;
  candidates: { key: string; flowId: string; name: string; draft: boolean }[];
  fallbackName: string | null;
  reason: string | null;
  question: string | null;
  /** Resposta observada do Copilot real (texto bruto, truncado) para auditoria. */
  observedReply: string | null;
}

export interface FlowSimulationResultView {
  level: FlowSimulationLevel;
  outcome: FlowSimulationOutcome | null;
  endOutcome: 'resolved' | 'cancelled' | 'escalated' | null;
  stoppedAt: { nodeId: string; label: string } | null;
  waitingFor:
    'human_decision' | 'copilot' | 'client_reply' | 'clock' | 'missing_fixture' | 'tool' | null;
  message: string;
  steps: FlowSimulationStepView[];
  effects: FlowSimulationEffectView[];
  unavailable: FlowSimulationUnavailable[];
  /** Problemas da validação estrutural (nível `structural`). */
  issues: { code: string; message: string; nodeId?: string }[];
  routing: FlowRoutingSimulationView | null;
  /** O que este nível não verifica (para não confundir com certificação completa). */
  notVerified: string[];
  elapsedMinutes: number;
}

export interface FlowSimulationCheck {
  key: 'outcome' | 'endOutcome' | 'path' | 'stopsAt' | 'routing';
  expected: string;
  observed: string;
  passed: boolean;
}

export interface FlowSimulationComparison {
  verdict: 'passed' | 'failed' | 'no_expectations';
  checks: FlowSimulationCheck[];
}

/** Compara o esperado no cenário com o observado (só as expectativas indicadas contam). */
export function compareSimulation(
  expected: FlowSimulationExpected,
  result: FlowSimulationResultView,
): FlowSimulationComparison {
  const checks: FlowSimulationCheck[] = [];
  const add = (key: FlowSimulationCheck['key'], want: string, got: string) =>
    checks.push({ key, expected: want, observed: got, passed: want === got });
  if (expected.outcome) add('outcome', expected.outcome, result.outcome ?? '—');
  if (expected.endOutcome) add('endOutcome', expected.endOutcome, result.endOutcome ?? '—');
  if (expected.path)
    add('path', expected.path.join(' → '), result.steps.map((step) => step.nodeId).join(' → '));
  if (expected.stopsAt) add('stopsAt', expected.stopsAt, result.stoppedAt?.nodeId ?? '—');
  if (expected.routing) add('routing', expected.routing, result.routing?.decision ?? '—');
  return {
    verdict: !checks.length
      ? 'no_expectations'
      : checks.every((check) => check.passed)
        ? 'passed'
        : 'failed',
    checks,
  };
}

// ---------------------------------------------------------------------------------------------
// Vistas da biblioteca de cenários e das execuções

export interface FlowSimulationHashes {
  definitionHash: string;
  routingHash: string;
  /** `null` quando o manifesto de dependências não pode ser resolvido (dependência em falta). */
  manifestHash: string | null;
}

export interface FlowScenarioView {
  id: string;
  name: string;
  description: string;
  spec: FlowScenarioSpec;
  version: number;
  hash: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface FlowSimulationRunView {
  id: string;
  level: FlowSimulationLevel;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  scenarioId: string | null;
  scenarioName: string;
  scenarioVersion: number | null;
  hashes: FlowSimulationHashes & { scenarioHash: string };
  /** Hashes diferentes do rascunho/cenário atuais: resultado histórico, não certifica o atual. */
  stale: boolean;
  staleReasons: ('definition' | 'routing' | 'manifest' | 'scenario')[];
  result: FlowSimulationResultView | null;
  comparison: FlowSimulationComparison | null;
  errorCode: string | null;
  trialTargetId: string | null;
  requestedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface FlowTrialTargetView {
  id: string;
  name: string;
  kind: 'outbox';
  active: boolean;
  deliveries: number;
  createdAt: string;
}

export interface FlowSimulationsView {
  current: FlowSimulationHashes;
  scenarios: FlowScenarioView[];
  runs: FlowSimulationRunView[];
  trialTargets: FlowTrialTargetView[];
  examples: { name: string; description: string; spec: FlowScenarioSpecInput }[];
  canManageTargets: boolean;
}

/** Testes do rascunho registados na ativação (para mostrar o que foi efetivamente testado). */
export interface FlowActivationTestEvidence {
  runId: string;
  level: FlowSimulationLevel;
  scenarioName: string;
  verdict: FlowSimulationComparison['verdict'] | null;
  outcome: FlowSimulationOutcome | null;
  manifestHash: string;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Cenários de exemplo gerados a partir do próprio fluxo (só os aplicáveis à definição).

function firstOf(definition: FlowDefinition, predicate: (node: FlowNode) => boolean) {
  return definition.nodes.find(predicate) ?? null;
}

/** Fixture de sucesso para uma etapa (primeira opção numa decisão). */
function successFixture(node: FlowNode): FlowStepFixture | null {
  switch (node.op) {
    case 'copilot_task':
      return {
        result: 'done',
        summary: 'Análise simulada concluída.',
        replyDraft: 'Resposta simulada ao cliente.',
      };
    case 'human_decision': {
      const success = decisionOptions(node).find((option) => option.port === FLOW_SUCCESS);
      return { result: success?.port ?? decisionOptions(node)[0]?.port ?? FLOW_SUCCESS };
    }
    case 'action':
      return ['client_message', 'internal_note', 'health_remediation', 'deploy'].includes(
        actionKey(node),
      )
        ? null
        : { result: FLOW_SUCCESS };
    default:
      return null;
  }
}

function successSteps(definition: FlowDefinition) {
  const steps: Record<string, FlowStepFixture[]> = {};
  for (const node of definition.nodes) {
    const fixture = successFixture(node);
    if (fixture) steps[node.id] = [fixture];
  }
  return steps;
}

/**
 * Cenários de exemplo para este fluxo: sucesso, ambiguidade no encaminhamento, falta de
 * informação, rejeição, falha de ferramenta, timeout, retry limitado e capacidade indisponível.
 * Cada exemplo só é proposto quando a definição tem as etapas necessárias.
 */
export function exampleScenarios(
  definition: FlowDefinition,
): { name: string; description: string; spec: FlowScenarioSpecInput }[] {
  const base = successSteps(definition);
  const examples: { name: string; description: string; spec: FlowScenarioSpecInput }[] = [
    {
      name: 'Sucesso',
      description: 'Todas as etapas respondem com sucesso.',
      spec: { steps: base, incident: { state: 'open', recoversAfterMinutes: 5 } },
    },
    {
      name: 'Ambiguidade no encaminhamento',
      description: 'O classificador pede esclarecimento (resposta gravada).',
      spec: {
        ticket: { title: 'Problema com o pagamento', description: 'Algo não está bem.' },
        steps: base,
        routing: {
          recordedReply: JSON.stringify({
            decision: 'clarify',
            candidate: null,
            reason: 'O pedido não indica se é uma consulta ou uma alteração.',
            alternatives: [],
            question: 'Pretende saber o estado de um pagamento ou pedir uma alteração ao sistema?',
          }),
        },
        expected: { routing: 'clarify' },
      },
    },
  ];
  const analysis = firstOf(
    definition,
    (node) => node.op === 'copilot_task' && copilotMode(node) === 'analysis',
  );
  if (analysis)
    examples.push({
      name: 'Falta de informação',
      description: 'A análise pergunta ao cliente e o pedido fica à espera da resposta.',
      spec: {
        steps: {
          ...base,
          [analysis.id]: [
            { result: 'done', asksClient: true, summary: 'Falta o número do pedido.' },
          ],
        },
        expected: { outcome: 'waiting', stopsAt: analysis.id },
      },
    });
  const decision = firstOf(
    definition,
    (node) =>
      node.op === 'human_decision' &&
      decisionOptions(node).some((option) => option.port === FLOW_FAILURE),
  );
  if (decision)
    examples.push({
      name: 'Rejeição',
      description: `«${decision.label}» rejeita uma vez e depois aprova.`,
      spec: {
        steps: {
          ...base,
          [decision.id]: [{ result: FLOW_FAILURE, comment: 'Rever.' }, { result: FLOW_SUCCESS }],
        },
      },
    });
  const tool = firstOf(definition, (node) => node.op === 'action' || node.op === 'copilot_task');
  if (tool)
    examples.push({
      name: 'Falha de ferramenta',
      description: `«${tool.label}» falha.`,
      spec: { steps: { ...base, [tool.id]: [{ result: 'failed', reason: 'Falha simulada.' }] } },
    });
  const verify = firstOf(
    definition,
    (node) => node.op === 'action' && actionKey(node) === 'verify_health_recovery',
  );
  if (verify)
    examples.push({
      name: 'Timeout',
      description: 'Os alertas nunca recuperam: a verificação termina por timeout.',
      spec: { steps: base, incident: { state: 'open' }, horizonMinutes: 1440 },
    });
  if (decision)
    examples.push({
      name: 'Retry limitado',
      description: `«${decision.label}» rejeita sempre até ao limite de passagens.`,
      spec: { steps: { ...base, [decision.id]: [{ result: FLOW_FAILURE, comment: 'Rever.' }] } },
    });
  examples.push({
    name: 'Capacidade indisponível',
    description: 'O Copilot não está configurado neste projeto.',
    spec: { steps: base, environment: { copilotReady: false } },
  });
  return examples;
}
