import { z } from 'zod';
import { repositoryResourceReferenceSchema } from './agent-profiles.js';
import { alertRuleCatalog, alertRuleGroups } from './alert-rules.js';
import type { TicketIncidentView } from './incidents.js';

/**
 * Fluxos de resolução de tickets por projeto. A definição é partilhada pelo editor visual, pelo
 * assistente (Copilot), pelo motor de execução e pelo simulador: a ordem de execução vem só das
 * ligações (`edges`); `layout` guarda apenas a posição das etapas no ecrã.
 */

export const flowOperationKeys = ['action', 'copilot_task', 'human_decision', 'end'] as const;
export type FlowOperationKey = (typeof flowOperationKeys)[number];

export const ticketOrigins = ['portal_client', 'portal_team', 'health', 'api'] as const;
export type TicketOrigin = (typeof ticketOrigins)[number];

const idSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);
const portSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,31}$/);

export const flowAssigneeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('role'),
    role: z.enum(['technical', 'qa', 'release', 'admin', 'client']),
  }),
  z.strictObject({
    kind: z.literal('user'),
    userId: z.uuid(),
    name: z.string().trim().max(160).optional(),
  }),
  z.strictObject({ kind: z.literal('ticket_author') }),
  z.strictObject({ kind: z.literal('team') }),
]);
export type FlowAssignee = z.infer<typeof flowAssigneeSchema>;

export const flowAgentProfileConfigSchema = z
  .strictObject({
    agentProfileId: z.uuid().optional(),
    agentProfileVersion: z.number().int().min(1).optional(),
    repositoryResources: z.array(repositoryResourceReferenceSchema).max(40).optional(),
  })
  .superRefine((config, context) => {
    if ((config.agentProfileId === undefined) !== (config.agentProfileVersion === undefined))
      context.addIssue({
        code: 'custom',
        message: 'A referência ao perfil exige identificador e versão.',
      });
  });
export type FlowAgentProfileConfig = z.infer<typeof flowAgentProfileConfigSchema>;

export const flowNodeSchema = z.strictObject({
  id: idSchema,
  op: z.enum(flowOperationKeys),
  label: z.string().trim().min(1).max(120),
  assignee: flowAssigneeSchema.nullish(),
  instructions: z.string().trim().max(3000).nullish(),
  ticketStatus: z
    .enum([
      'investigating',
      'awaiting_information',
      'awaiting_client',
      'awaiting_technical',
      'awaiting_confirmation',
      'implementing',
      'awaiting_qa',
      'awaiting_release',
      'deploying',
      'blocked',
    ])
    .nullish(),
  config: z
    .record(z.string(), z.unknown())
    .default({})
    .superRefine((config, context) => {
      const subset = {
        ...(config.agentProfileId !== undefined ? { agentProfileId: config.agentProfileId } : {}),
        ...(config.agentProfileVersion !== undefined
          ? { agentProfileVersion: config.agentProfileVersion }
          : {}),
        ...(config.repositoryResources !== undefined
          ? { repositoryResources: config.repositoryResources }
          : {}),
      };
      const parsed = flowAgentProfileConfigSchema.safeParse(subset);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          context.addIssue({ ...issue, path: [...(issue.path ?? [])] });
    }),
});
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowEdgeSchema = z.strictObject({
  id: idSchema,
  source: idSchema,
  port: portSchema,
  target: idSchema,
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

export const flowDefinitionSchema = z.strictObject({
  start: idSchema,
  nodes: z.array(flowNodeSchema).min(1).max(60),
  edges: z.array(flowEdgeSchema).max(200),
  layout: z
    .record(z.string(), z.strictObject({ x: z.number().finite(), y: z.number().finite() }))
    .default({}),
});
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;

/** Texto em português e inglês (a UI escolhe pelo idioma da conta). */
export interface FlowText {
  pt: string;
  en: string;
}

export interface FlowConfigField {
  key: string;
  label: FlowText;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'boolean';
  options?: { value: string; label: FlowText }[];
  required?: boolean;
}

/**
 * Cada etapa tem só duas saídas: sucesso e erro. O resultado detalhado devolvido pela ação
 * (ex.: «proibida», «sem integração») fica guardado na etapa como motivo, sem criar setas novas.
 */
export const FLOW_SUCCESS = 'success';
export const FLOW_FAILURE = 'failure';
export const FLOW_PORTS: string[] = [FLOW_SUCCESS, FLOW_FAILURE];
export type FlowBinaryPort = typeof FLOW_SUCCESS | typeof FLOW_FAILURE;

/** Resultados detalhados que contam como sucesso (os restantes contam como erro). */
const successResults = new Set([
  FLOW_SUCCESS,
  'done',
  'auto',
  'needs_approval',
  'no_action',
  'recovered',
  'passed',
  'succeeded',
  'manual',
  'needs_information',
  'approve',
  'resolve',
  'replied',
  'confirmed',
]);

/** Saída (sucesso/erro) correspondente a um resultado detalhado ou a uma porta antiga. */
export function resultPort(result: string): FlowBinaryPort {
  return successResults.has(result) ? FLOW_SUCCESS : FLOW_FAILURE;
}

/**
 * Resultados tratados dentro da própria etapa, sem seta: `retry` volta à etapa anterior (nova
 * tentativa) e `needs_information` espera pela resposta do cliente e repete a análise.
 */
export const FLOW_INTERNAL_RESULTS = ['retry', 'needs_information'] as const;

export interface FlowActionDescriptor {
  key: string;
  label: FlowText;
  description: FlowText;
  ports: string[];
  /** Resultados detalhados que o executor pode devolver (motivo guardado na etapa). */
  results: string[];
  fields: FlowConfigField[];
  /** Depende de uma integração externa ainda por configurar (a etapa regista o bloqueio). */
  external?: FlowText;
  /** Porta usada pelo simulador quando o cenário não indica outra. */
  simulationPort: string;
}

/**
 * Catálogo de ações. Acrescentar uma ação = nova entrada aqui e o respetivo executor no backend;
 * os fluxos existentes não mudam porque guardam só a chave da ação.
 */
export const flowActionCatalog: Record<string, FlowActionDescriptor> = {
  client_message: {
    key: 'client_message',
    label: { pt: 'Mensagem ao cliente', en: 'Message to client' },
    description: {
      pt: 'Publica uma mensagem pública no pedido (ex.: agradecimento ou relatório final).',
      en: 'Posts a public message on the ticket (e.g. thank-you or final report).',
    },
    ports: FLOW_PORTS,
    results: ['done'],
    fields: [
      {
        key: 'source',
        label: { pt: 'Conteúdo', en: 'Content' },
        kind: 'select',
        options: [
          { value: 'text', label: { pt: 'Texto fixo', en: 'Fixed text' } },
          {
            value: 'previous_reply',
            label: {
              pt: 'Resposta proposta pelo Copilot (com texto fixo de recurso)',
              en: 'Copilot reply draft (with fallback text)',
            },
          },
        ],
      },
      {
        key: 'body',
        label: { pt: 'Texto da mensagem', en: 'Message text' },
        kind: 'textarea',
        required: true,
      },
    ],
    simulationPort: 'success',
  },
  internal_note: {
    key: 'internal_note',
    label: { pt: 'Nota interna', en: 'Internal note' },
    description: {
      pt: 'Regista uma nota visível apenas à equipa.',
      en: 'Records a note visible only to the team.',
    },
    ports: FLOW_PORTS,
    results: ['done'],
    fields: [
      {
        key: 'source',
        label: { pt: 'Conteúdo', en: 'Content' },
        kind: 'select',
        options: [
          { value: 'text', label: { pt: 'Texto fixo', en: 'Fixed text' } },
          {
            value: 'previous_summary',
            label: { pt: 'Resumo da última etapa do Copilot', en: 'Last Copilot step summary' },
          },
        ],
      },
      {
        key: 'body',
        label: { pt: 'Texto da nota', en: 'Note text' },
        kind: 'textarea',
        required: true,
      },
    ],
    simulationPort: 'success',
  },
  health_remediation: {
    key: 'health_remediation',
    label: { pt: 'Aplicar correção (Saúde)', en: 'Apply remediation (Health)' },
    description: {
      pt: 'Aplica no ambiente a correção que o Copilot preparou numa cópia temporária (diff e evidência guardados no ticket).',
      en: 'Applies to the environment the fix Copilot prepared in a temporary copy (diff and evidence stored on the ticket).',
    },
    ports: FLOW_PORTS,
    results: ['done', 'failed', 'unavailable'],
    fields: [
      {
        key: 'procedure',
        label: { pt: 'Correção a aplicar', en: 'Remediation to apply' },
        kind: 'textarea',
      },
    ],
    external: {
      pt: 'Requer uma integração de aplicação de correções em QA/Produção (por configurar): sem ela, o diff fica no ticket e a etapa termina em erro (motivo: sem integração).',
      en: 'Requires a QA/Production remediation integration (not configured): without it, the diff stays on the ticket and the step ends in failure (reason: no integration).',
    },
    simulationPort: 'failure',
  },
  verify_health_recovery: {
    key: 'verify_health_recovery',
    label: { pt: 'Verificar recuperação', en: 'Verify recovery' },
    description: {
      pt: 'Aguarda que os alertas do incidente recuperem dentro do prazo.',
      en: 'Waits for the incident alerts to recover within the time limit.',
    },
    ports: FLOW_PORTS,
    results: ['passed', 'failed', 'unknown'],
    fields: [
      {
        key: 'timeoutMinutes',
        label: { pt: 'Prazo (minutos)', en: 'Time limit (minutes)' },
        kind: 'number',
      },
    ],
    simulationPort: 'failure',
  },
  deploy: {
    key: 'deploy',
    label: { pt: 'Publicação (deploy)', en: 'Release (deploy)' },
    description: {
      pt: 'Publica a alteração aprovada. Sem integração de deploy, termina com sucesso como publicação manual (a confirmação humana seguinte só é pedida nesse caso).',
      en: 'Releases the approved change. Without a deploy integration, succeeds as a manual release (the following human confirmation is only requested in that case).',
    },
    ports: FLOW_PORTS,
    results: ['succeeded', 'manual', 'failed'],
    fields: [
      {
        key: 'environment',
        label: { pt: 'Ambiente', en: 'Environment' },
        kind: 'select',
        options: [
          { value: 'production', label: { pt: 'Produção', en: 'Production' } },
          { value: 'quality', label: { pt: 'Qualidade', en: 'Quality' } },
        ],
      },
    ],
    external: {
      pt: 'Requer uma integração de deploy (por configurar): sem ela, a publicação é manual.',
      en: 'Requires a deploy integration (not configured): without it, the release is manual.',
    },
    simulationPort: 'success',
  },
  incident_intake: {
    key: 'incident_intake',
    label: { pt: 'Receber alerta', en: 'Receive alert' },
    description: {
      pt: 'Regista o recurso afetado, o ambiente, a hora e a evidência do alerta e garante uma só intervenção de cada vez no mesmo recurso.',
      en: 'Records the affected resource, environment, time and alert evidence, and ensures a single intervention at a time on the same resource.',
    },
    ports: FLOW_PORTS,
    results: ['done'],
    fields: [],
    simulationPort: 'success',
  },
  authorize_intervention: {
    key: 'authorize_intervention',
    label: { pt: 'Decidir intervenção', en: 'Decide intervention' },
    description: {
      pt: 'Avalia a ação proposta pela investigação contra a política do projeto (automática, com aprovação ou proibida). Apagar ficheiros ou dados é sempre proibido.',
      en: 'Checks the action proposed by the investigation against the project policy (automatic, approval or forbidden). Deleting files or data is always forbidden.',
    },
    ports: FLOW_PORTS,
    results: ['auto', 'needs_approval', 'no_action', 'forbidden'],
    fields: [
      {
        key: 'override',
        label: { pt: 'Nesta etapa', en: 'In this step' },
        kind: 'select',
        options: [
          {
            value: 'policy',
            label: { pt: 'Seguir a política do projeto', en: 'Follow project policy' },
          },
          {
            value: 'approval',
            label: { pt: 'Pedir sempre aprovação', en: 'Always ask for approval' },
          },
          { value: 'forbidden', label: { pt: 'Nunca intervir', en: 'Never intervene' } },
        ],
      },
    ],
    simulationPort: 'success',
  },
  remediate: {
    key: 'remediate',
    label: { pt: 'Intervir', en: 'Intervene' },
    description: {
      pt: 'Executa a ação autorizada (reiniciar serviço, reiniciar servidor ou alterar parâmetro) pelo canal auditado, guardando o valor anterior e a forma de repor.',
      en: 'Runs the authorised action (restart service, reboot server or change parameter) through the audited channel, storing the previous value and how to roll back.',
    },
    ports: FLOW_PORTS,
    results: ['done', 'no_action', 'failed', 'forbidden'],
    fields: [],
    simulationPort: 'success',
  },
  validate_recovery: {
    key: 'validate_recovery',
    label: { pt: 'Validar recuperação', en: 'Validate recovery' },
    description: {
      pt: 'Confirma a recuperação com o critério do recurso (disco, memória, query segura à BD, HTTP visível ao utilizador) durante a janela de observação.',
      en: 'Confirms recovery with the resource criterion (disk, memory, safe database query, user-facing HTTP) during the observation window.',
    },
    ports: FLOW_PORTS,
    results: ['recovered', 'retry', 'not_recovered', 'unknown'],
    fields: [
      {
        key: 'criterion',
        label: { pt: 'Critério', en: 'Criterion' },
        kind: 'select',
        options: [
          { value: 'auto', label: { pt: 'Pelo tipo de recurso', en: 'By resource type' } },
          { value: 'alerts_resolved', label: { pt: 'Alertas resolvidos', en: 'Alerts resolved' } },
          { value: 'disk_free', label: { pt: 'Espaço em disco', en: 'Disk space' } },
          { value: 'memory_pressure', label: { pt: 'Pressão de memória', en: 'Memory pressure' } },
          { value: 'cpu_load', label: { pt: 'Carga de CPU', en: 'CPU load' } },
          {
            value: 'database_query',
            label: { pt: 'Query segura à BD', en: 'Safe database query' },
          },
          { value: 'service_active', label: { pt: 'Serviço ativo', en: 'Service active' } },
          { value: 'http_check', label: { pt: 'Verificação HTTP', en: 'HTTP check' } },
        ],
      },
      {
        key: 'observationMinutes',
        label: { pt: 'Janela de observação (min)', en: 'Observation window (min)' },
        kind: 'number',
      },
      {
        key: 'timeoutMinutes',
        label: { pt: 'Prazo (minutos)', en: 'Time limit (minutes)' },
        kind: 'number',
      },
      {
        key: 'maxAttempts',
        label: { pt: 'Tentativas de intervenção', en: 'Intervention attempts' },
        kind: 'number',
      },
    ],
    simulationPort: 'success',
  },
  email_notify: {
    key: 'email_notify',
    label: { pt: 'Enviar e-mail', en: 'Send e-mail' },
    description: {
      pt: 'Envia o e-mail de fecho (impacto, o que aconteceu, intervenção e evidência) ou de escalada (impacto atual, evidência, tentativas e próximo passo).',
      en: 'Sends the closure e-mail (impact, what happened, intervention and evidence) or the escalation e-mail (current impact, evidence, attempts and next step).',
    },
    ports: FLOW_PORTS,
    results: ['done', 'failed'],
    fields: [
      {
        key: 'template',
        label: { pt: 'Modelo', en: 'Template' },
        kind: 'select',
        options: [
          { value: 'closure', label: { pt: 'Fecho do incidente', en: 'Incident closure' } },
          { value: 'escalation', label: { pt: 'Escalada', en: 'Escalation' } },
        ],
      },
      {
        key: 'recipients',
        label: {
          pt: 'Destinatários (vazio = os da Saúde por criticidade)',
          en: 'Recipients (empty = Health recipients by criticality)',
        },
        kind: 'text',
      },
    ],
    simulationPort: 'success',
  },
  assign_team: {
    key: 'assign_team',
    label: { pt: 'Atribuir à equipa', en: 'Assign to team' },
    description: {
      pt: 'Mantém o pedido aberto e atribui-o à equipa responsável, com nota interna do que já foi tentado.',
      en: 'Keeps the ticket open and assigns it to the responsible team, with an internal note of what was tried.',
    },
    ports: FLOW_PORTS,
    results: ['done'],
    fields: [
      {
        key: 'role',
        label: { pt: 'Equipa', en: 'Team' },
        kind: 'select',
        options: [
          { value: 'policy', label: { pt: 'A da política do projeto', en: 'Project policy team' } },
          { value: 'technical', label: { pt: 'Equipa técnica', en: 'Technical team' } },
          { value: 'admin', label: { pt: 'Administradores', en: 'Administrators' } },
        ],
      },
    ],
    simulationPort: 'success',
  },
};

/** Modelo do Copilot numa etapa `copilot_task` (vazio = o do projeto). */
export interface CopilotStepModel {
  executionMode: 'copilot' | 'local' | null;
  model: string | null;
  fusionTier: 'standard' | 'high' | 'max' | null;
  reasoningEffort: string | null;
}

export function copilotStepModel(node: Pick<FlowNode, 'config'>): CopilotStepModel {
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
  const mode = node.config.executionMode;
  const tier = node.config.fusionTier;
  return {
    executionMode: mode === 'copilot' || mode === 'local' ? mode : null,
    model: text(node.config.model),
    fusionTier: tier === 'standard' || tier === 'high' || tier === 'max' ? tier : null,
    reasoningEffort: text(node.config.reasoningEffort),
  };
}

/** Perfil ZeroOps e recursos técnicos opcionais de uma etapa Copilot. */
export function flowAgentProfileConfig(node: Pick<FlowNode, 'config'>): FlowAgentProfileConfig {
  return flowAgentProfileConfigSchema.parse({
    ...(node.config.agentProfileId !== undefined
      ? { agentProfileId: node.config.agentProfileId }
      : {}),
    ...(node.config.agentProfileVersion !== undefined
      ? { agentProfileVersion: node.config.agentProfileVersion }
      : {}),
    ...(node.config.repositoryResources !== undefined
      ? { repositoryResources: node.config.repositoryResources }
      : {}),
  });
}

export const copilotTaskModes = ['analysis', 'develop', 'report'] as const;
export type CopilotTaskMode = (typeof copilotTaskModes)[number];

export const flowOperationLabels: Record<FlowOperationKey, FlowText> = {
  action: { pt: 'Executar ação', en: 'Run action' },
  copilot_task: { pt: 'Pedir trabalho ao Copilot', en: 'Ask Copilot' },
  human_decision: { pt: 'Decisão humana', en: 'Human decision' },
  end: { pt: 'Terminar', en: 'Finish' },
};

export const flowPortLabels: Record<string, FlowText> = {
  success: { pt: 'sucesso', en: 'success' },
  failure: { pt: 'erro', en: 'failure' },
  done: { pt: 'concluído', en: 'done' },
  failed: { pt: 'falhou', en: 'failed' },
  unavailable: { pt: 'indisponível', en: 'unavailable' },
  passed: { pt: 'passou', en: 'passed' },
  unknown: { pt: 'sem verificação', en: 'not verified' },
  succeeded: { pt: 'publicado', en: 'released' },
  manual: { pt: 'publicação manual', en: 'manual release' },
  needs_information: { pt: 'falta informação', en: 'needs information' },
  auto: { pt: 'automática', en: 'automatic' },
  needs_approval: { pt: 'precisa de aprovação', en: 'needs approval' },
  forbidden: { pt: 'proibida', en: 'forbidden' },
  no_action: { pt: 'sem ação', en: 'no action' },
  recovered: { pt: 'recuperou', en: 'recovered' },
  not_recovered: { pt: 'não recuperou', en: 'not recovered' },
  retry: { pt: 'tentar de novo', en: 'retry' },
  approve: { pt: 'aprovar', en: 'approve' },
  reject: { pt: 'rejeitar', en: 'reject' },
};

export interface FlowDecisionOption {
  port: string;
  label: string;
  requiresComment?: boolean;
  /** Visibilidade do comentário da decisão (interno por omissão). */
  commentVisibility?: 'internal' | 'public';
}

const decisionOptionSchema = z.strictObject({
  port: portSchema,
  label: z.string().trim().min(1).max(80),
  requiresComment: z.boolean().optional(),
  commentVisibility: z.enum(['internal', 'public']).optional(),
});

/** Opções de uma decisão humana (cada opção é uma porta de saída). */
export function decisionOptions(node: Pick<FlowNode, 'config'>): FlowDecisionOption[] {
  const parsed = z.array(decisionOptionSchema).safeParse(node.config.options);
  return parsed.success ? parsed.data : [];
}

/**
 * Decisão condicional: só espera por uma pessoa quando a etapa anterior terminou com um destes
 * resultados (ex.: `needs_approval`, `manual`); nos outros casos segue sozinha pela saída de
 * sucesso. Lista vazia = pede sempre a decisão.
 */
export function decisionOnlyWhen(node: Pick<FlowNode, 'config'>): string[] {
  const value = node.config.onlyWhen;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

/** Opções por omissão de uma decisão humana nova (aprovar = sucesso, rejeitar = erro). */
export function defaultDecisionOptions(): FlowDecisionOption[] {
  return [
    { port: FLOW_SUCCESS, label: 'Aprovar' },
    { port: FLOW_FAILURE, label: 'Rejeitar', requiresComment: true },
  ];
}

/** Nome legível de um resultado detalhado guardado na etapa (ex.: «proibida»). */
export function resultLabel(result: string, locale: 'pt' | 'en' = 'pt') {
  return flowPortLabels[result]?.[locale] ?? result;
}

/** Modo da tarefa do Copilot (análise por omissão). */
export function copilotMode(node: Pick<FlowNode, 'config'>): CopilotTaskMode {
  const mode = node.config.mode;
  return copilotTaskModes.includes(mode as CopilotTaskMode)
    ? (mode as CopilotTaskMode)
    : 'analysis';
}

/** Chave da ação configurada numa etapa `action` (string vazia se ausente). */
export function actionKey(node: Pick<FlowNode, 'config'>) {
  return typeof node.config.action === 'string' ? node.config.action : '';
}

/** Portas de saída de uma etapa (sucesso e erro), que as ligações têm de ligar a um destino. */
export function nodePorts(node: Pick<FlowNode, 'op' | 'config'>): string[] {
  switch (node.op) {
    case 'action':
      return flowActionCatalog[actionKey(node)] ? [...FLOW_PORTS] : [];
    case 'copilot_task':
      return [...FLOW_PORTS];
    case 'human_decision':
      return decisionOptions(node).map((option) => option.port);
    case 'end':
      return [];
  }
}

/** Nome legível de uma porta (opção da decisão ou etiqueta genérica). */
export function portLabel(
  node: Pick<FlowNode, 'op' | 'config'> | undefined,
  port: string,
  locale: 'pt' | 'en' = 'pt',
) {
  if (node?.op === 'human_decision') {
    const option = decisionOptions(node).find((item) => item.port === port);
    if (option) return option.label;
  }
  return flowPortLabels[port]?.[locale] ?? port;
}

/** Resultado final de uma etapa `end`. */
export function endOutcome(node: Pick<FlowNode, 'config'>): 'resolved' | 'cancelled' | 'escalated' {
  const outcome = node.config.outcome;
  return outcome === 'cancelled' || outcome === 'escalated' ? outcome : 'resolved';
}

export interface FlowIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/**
 * Valida a definição para publicação: destinos, portas ligadas, responsáveis e ações configuradas.
 * `members` (ids ativos do projeto) valida responsáveis do tipo `user` quando fornecido.
 */
export function validateFlowDefinition(
  input: unknown,
  options: { members?: ReadonlySet<string> } = {},
): FlowIssue[] {
  const parsed = flowDefinitionSchema.safeParse(input);
  if (!parsed.success)
    return [
      {
        code: 'invalid_schema',
        message: `Definição inválida: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      },
    ];
  const definition = parsed.data;
  const issues: FlowIssue[] = [];
  const nodes = new Map<string, FlowNode>();
  for (const node of definition.nodes) {
    if (nodes.has(node.id))
      issues.push({
        code: 'duplicate_node',
        message: `Etapa repetida: ${node.id}.`,
        nodeId: node.id,
      });
    nodes.set(node.id, node);
  }
  if (!nodes.has(definition.start))
    issues.push({ code: 'missing_start', message: 'A etapa inicial não existe.' });
  const edgeIds = new Set<string>();
  const outgoing = new Map<string, FlowEdge>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id))
      issues.push({
        code: 'duplicate_edge',
        message: `Ligação repetida: ${edge.id}.`,
        edgeId: edge.id,
      });
    edgeIds.add(edge.id);
    const source = nodes.get(edge.source);
    if (!source || !nodes.has(edge.target)) {
      issues.push({
        code: 'dangling_edge',
        message: `A ligação ${edge.id} aponta para uma etapa inexistente.`,
        edgeId: edge.id,
      });
      continue;
    }
    if (!nodePorts(source).includes(edge.port))
      issues.push({
        code: 'unknown_port',
        message: `«${source.label}» não tem a saída «${edge.port}».`,
        edgeId: edge.id,
        nodeId: source.id,
      });
    const key = `${edge.source}:${edge.port}`;
    if (outgoing.has(key))
      issues.push({
        code: 'ambiguous_port',
        message: `A saída «${portLabel(source, edge.port)}» de «${source.label}» tem mais do que um destino.`,
        edgeId: edge.id,
        nodeId: source.id,
      });
    outgoing.set(key, edge);
  }
  for (const node of definition.nodes) {
    const at = { nodeId: node.id };
    if (node.op === 'action') {
      const descriptor = flowActionCatalog[actionKey(node)];
      if (!descriptor)
        issues.push({
          code: 'unknown_action',
          message: `«${node.label}» não tem uma ação válida.`,
          ...at,
        });
      else
        for (const field of descriptor.fields)
          if (
            field.required &&
            !(typeof node.config[field.key] === 'string' && String(node.config[field.key]).trim())
          )
            issues.push({
              code: 'missing_config',
              message: `«${node.label}»: falta «${field.label.pt}».`,
              ...at,
            });
    }
    if (node.op === 'human_decision') {
      if (!node.assignee)
        issues.push({
          code: 'missing_assignee',
          message: `«${node.label}» não tem responsável.`,
          ...at,
        });
      const decisionPorts = decisionOptions(node).map((option) => option.port);
      if (!decisionPorts.length)
        issues.push({
          code: 'missing_options',
          message: `«${node.label}» não tem opções de decisão.`,
          ...at,
        });
      if (new Set(decisionPorts).size !== decisionPorts.length)
        issues.push({
          code: 'duplicate_option',
          message: `«${node.label}» tem opções repetidas.`,
          ...at,
        });
      if (
        decisionPorts.length &&
        (decisionPorts.length !== 2 ||
          !decisionPorts.includes(FLOW_SUCCESS) ||
          !decisionPorts.includes(FLOW_FAILURE))
      )
        issues.push({
          code: 'invalid_options',
          message: `«${node.label}» tem de ter exatamente duas opções: uma de sucesso e uma de erro.`,
          ...at,
        });
    }
    if (
      node.assignee?.kind === 'user' &&
      options.members &&
      !options.members.has(node.assignee.userId)
    )
      issues.push({
        code: 'inactive_assignee',
        message: `O responsável de «${node.label}» não é membro ativo do projeto.`,
        ...at,
      });
    for (const port of nodePorts(node))
      if (!outgoing.has(`${node.id}:${port}`))
        issues.push({
          code: 'unconnected_port',
          message: `A saída «${portLabel(node, port)}» de «${node.label}» não tem destino.`,
          ...at,
        });
  }
  const reachable = new Set<string>();
  const queue = nodes.has(definition.start) ? [definition.start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of definition.edges) if (edge.source === id) queue.push(edge.target);
  }
  for (const node of definition.nodes)
    if (!reachable.has(node.id))
      issues.push({
        code: 'unreachable',
        message: `«${node.label}» não é alcançável a partir do início.`,
        nodeId: node.id,
      });
  if (!definition.nodes.some((node) => node.op === 'end' && reachable.has(node.id)))
    issues.push({ code: 'missing_end', message: 'O fluxo não tem uma etapa final alcançável.' });
  return issues;
}

/** Parte executável da definição (sem disposição), com ordem estável para comparação e hash. */
export function flowLogic(definition: FlowDefinition) {
  const nodes = [...definition.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => ({
      id: node.id,
      op: node.op,
      label: node.label,
      assignee: node.assignee ?? null,
      instructions: node.instructions ?? null,
      ticketStatus: node.ticketStatus ?? null,
      config: sortKeys(node.config),
    }));
  const edges = [...definition.edges]
    .sort((a, b) => `${a.source}:${a.port}`.localeCompare(`${b.source}:${b.port}`))
    .map((edge) => ({ source: edge.source, port: edge.port, target: edge.target }));
  return JSON.stringify({ start: definition.start, nodes, edges });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/** Distingue mover etapas no ecrã (só `layout`) de alterar a ordem/lógica de execução. */
export function flowChangeKind(
  before: FlowDefinition,
  after: FlowDefinition,
): 'none' | 'layout' | 'logic' {
  if (flowLogic(before) !== flowLogic(after)) return 'logic';
  return JSON.stringify(before.layout) === JSON.stringify(after.layout) ? 'none' : 'layout';
}

// ---------------------------------------------------------------------------------------------
// Alterações propostas (assistente): operações parciais sobre a definição.

const nodePatchSchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  assignee: flowAssigneeSchema.nullable().optional(),
  instructions: z.string().trim().max(3000).nullable().optional(),
  ticketStatus: flowNodeSchema.shape.ticketStatus.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const flowPatchOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('add_node'),
    node: flowNodeSchema,
    position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
  }),
  z.strictObject({ type: z.literal('update_node'), id: idSchema, changes: nodePatchSchema }),
  z.strictObject({ type: z.literal('remove_node'), id: idSchema }),
  z.strictObject({
    type: z.literal('connect'),
    source: idSchema,
    port: portSchema,
    target: idSchema,
  }),
  z.strictObject({ type: z.literal('disconnect'), source: idSchema, port: portSchema }),
  z.strictObject({ type: z.literal('set_start'), id: idSchema }),
]);
export type FlowPatchOperation = z.infer<typeof flowPatchOperationSchema>;

export interface FlowPatchResult {
  definition: FlowDefinition;
  added: string[];
  changed: string[];
  removed: string[];
  addedEdges: string[];
  removedEdges: string[];
}

/** Aplica operações parciais a uma cópia da definição, marcando o que mudou para o desenho. */
export function applyFlowOperations(
  base: FlowDefinition,
  operations: FlowPatchOperation[],
): FlowPatchResult {
  const definition: FlowDefinition = structuredClone(base);
  const result: FlowPatchResult = {
    definition,
    added: [],
    changed: [],
    removed: [],
    addedEdges: [],
    removedEdges: [],
  };
  const removeEdge = (predicate: (edge: FlowEdge) => boolean) => {
    for (const edge of definition.edges.filter(predicate)) result.removedEdges.push(edge.id);
    definition.edges = definition.edges.filter((edge) => !predicate(edge));
  };
  for (const operation of operations) {
    switch (operation.type) {
      case 'add_node': {
        if (definition.nodes.some((node) => node.id === operation.node.id))
          throw new Error(`A etapa ${operation.node.id} já existe.`);
        definition.nodes.push(operation.node);
        definition.layout[operation.node.id] = operation.position ?? nextPosition(definition);
        result.added.push(operation.node.id);
        break;
      }
      case 'update_node': {
        const node = definition.nodes.find((item) => item.id === operation.id);
        if (!node) throw new Error(`A etapa ${operation.id} não existe.`);
        const { config, ...rest } = operation.changes;
        Object.assign(node, rest);
        if (config) node.config = { ...node.config, ...config };
        const ports = nodePorts(node);
        removeEdge((edge) => edge.source === node.id && !ports.includes(edge.port));
        if (!result.added.includes(node.id)) result.changed.push(node.id);
        break;
      }
      case 'remove_node': {
        if (!definition.nodes.some((node) => node.id === operation.id))
          throw new Error(`A etapa ${operation.id} não existe.`);
        definition.nodes = definition.nodes.filter((node) => node.id !== operation.id);
        delete definition.layout[operation.id];
        removeEdge((edge) => edge.source === operation.id || edge.target === operation.id);
        result.removed.push(operation.id);
        break;
      }
      case 'connect': {
        if (
          !definition.nodes.some((node) => node.id === operation.source) ||
          !definition.nodes.some((node) => node.id === operation.target)
        )
          throw new Error('Ligação para uma etapa inexistente.');
        removeEdge((edge) => edge.source === operation.source && edge.port === operation.port);
        const id = uniqueEdgeId(definition, `${operation.source}-${operation.port}`);
        definition.edges.push({
          id,
          source: operation.source,
          port: operation.port,
          target: operation.target,
        });
        result.addedEdges.push(id);
        if (!result.added.includes(operation.source) && !result.changed.includes(operation.source))
          result.changed.push(operation.source);
        break;
      }
      case 'disconnect':
        removeEdge((edge) => edge.source === operation.source && edge.port === operation.port);
        break;
      case 'set_start':
        if (!definition.nodes.some((node) => node.id === operation.id))
          throw new Error(`A etapa ${operation.id} não existe.`);
        definition.start = operation.id;
        break;
    }
  }
  return result;
}

function uniqueEdgeId(definition: FlowDefinition, base: string) {
  const clean = base.replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
  let id = clean;
  for (let index = 2; definition.edges.some((edge) => edge.id === id); index += 1)
    id = `${clean}-${index}`;
  return id;
}

function nextPosition(definition: FlowDefinition) {
  const positions = Object.values(definition.layout);
  const maxY = positions.length ? Math.max(...positions.map((item) => item.y)) : 0;
  return { x: 0, y: maxY + 140 };
}

// ---------------------------------------------------------------------------------------------
// Regras de seleção do fluxo.

export const flowMatchSchema = z.strictObject({
  origins: z.array(z.enum(ticketOrigins)).max(4).default([]),
  categories: z
    .array(z.enum(['incident', 'bug', 'improvement', 'question']))
    .max(4)
    .default([]),
  environments: z
    .array(z.enum(['development', 'quality', 'production']))
    .max(3)
    .default([]),
  priorities: z
    .array(z.enum(['low', 'medium', 'high', 'critical']))
    .max(4)
    .default([]),
});
export type FlowMatch = z.infer<typeof flowMatchSchema>;

export interface FlowMatchTicket {
  origin: TicketOrigin;
  category: string;
  environment: string;
  priority: string;
}

/** Uma regra vazia num critério aceita qualquer valor; todos os critérios preenchidos têm de coincidir. */
export function flowMatches(match: FlowMatch, ticket: FlowMatchTicket) {
  return (
    (!match.origins.length || match.origins.includes(ticket.origin)) &&
    (!match.categories.length || match.categories.includes(ticket.category as never)) &&
    (!match.environments.length || match.environments.includes(ticket.environment as never)) &&
    (!match.priorities.length || match.priorities.includes(ticket.priority as never))
  );
}

export interface FlowCandidate {
  id: string;
  name: string;
  priority: number;
  isDefault: boolean;
  match: FlowMatch;
}

/**
 * Escolha determinística: entre os fluxos publicados com regra coincidente ganha o de menor
 * número de prioridade (prioridades iguais são recusadas ao gravar); sem coincidência usa o
 * fluxo por omissão do projeto.
 */
export function selectFlow<T extends FlowCandidate>(
  candidates: T[],
  ticket: FlowMatchTicket,
): T | null {
  const matching = candidates
    .filter((flow) => !flow.isDefault && flowMatches(flow.match, ticket))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  return matching[0] ?? candidates.find((flow) => flow.isDefault) ?? null;
}

export const flowSettingsSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  priority: z.number().int().min(1).max(999),
  isDefault: z.boolean(),
  match: flowMatchSchema,
});
export type FlowSettings = z.infer<typeof flowSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// Simulação («Experimentar com um ticket»): percurso sem efeitos.

export const flowScenarioSchema = z
  .record(z.string(), z.array(z.string().max(32)).max(20))
  .default({});
export type FlowScenario = z.infer<typeof flowScenarioSchema>;

export interface SimulatedStep {
  nodeId: string;
  label: string;
  op: FlowOperationKey;
  attempt: number;
  port: string | null;
  assignee: FlowAssignee | null;
  effect: FlowText;
}

export interface SimulationResult {
  steps: SimulatedStep[];
  outcome: 'ended' | 'waiting' | 'loop_limit' | 'invalid';
  stoppedAt: { nodeId: string; label: string; assignee: FlowAssignee | null } | null;
  endOutcome: 'resolved' | 'cancelled' | 'escalated' | null;
  message: FlowText;
}

/** Visitas a uma etapa antes de o motor parar o ciclo (configurável por etapa em `maxVisits`). */
export const DEFAULT_MAX_VISITS = 6;

/** Limite de visitas de uma etapa (evita ciclos infinitos). */
export function maxVisits(node: Pick<FlowNode, 'config'>) {
  const value = Number(node.config.maxVisits);
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : DEFAULT_MAX_VISITS;
}

function defaultPort(node: FlowNode): string | null {
  switch (node.op) {
    case 'action':
      return flowActionCatalog[actionKey(node)]?.simulationPort ?? null;
    case 'copilot_task':
      return FLOW_SUCCESS;
    case 'human_decision':
      return decisionOptions(node)[0]?.port ?? null;
    case 'end':
      return null;
  }
}

function simulatedEffect(node: FlowNode): FlowText {
  switch (node.op) {
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

/**
 * Percorre o fluxo sem efeitos. O cenário indica, por etapa, a porta a seguir em cada visita
 * (`wait` = fica à espera nessa visita); visitas além do cenário usam a porta por omissão.
 */
export function simulateFlow(
  definition: FlowDefinition,
  scenario: FlowScenario = {},
  limit = 80,
): SimulationResult {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const visits = new Map<string, number>();
  const steps: SimulatedStep[] = [];
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
    if (attempt > maxVisits(current))
      return stop('loop_limit', current, {
        pt: `«${current.label}» excedeu ${maxVisits(current)} visitas: o motor bloqueia o pedido para revisão da equipa.`,
        en: `«${current.label}» exceeded ${maxVisits(current)} visits: the engine blocks the ticket for team review.`,
      });
    const planned = scenario[current.id]?.[attempt - 1];
    if (current.op === 'end') {
      steps.push({
        nodeId: current.id,
        label: current.label,
        op: current.op,
        attempt,
        port: null,
        assignee: null,
        effect: simulatedEffect(current),
      });
      return stop('ended', current, {
        pt: `Pedido terminado (${endOutcome(current)}).`,
        en: `Ticket finished (${endOutcome(current)}).`,
      });
    }
    if (planned === 'wait') {
      steps.push({
        nodeId: current.id,
        label: current.label,
        op: current.op,
        attempt,
        port: null,
        assignee: current.assignee ?? null,
        effect: simulatedEffect(current),
      });
      return stop('waiting', current, {
        pt: `O pedido fica em «${current.label}».`,
        en: `The ticket stays at «${current.label}».`,
      });
    }
    const port =
      planned && nodePorts(current).includes(planned)
        ? planned
        : planned && nodePorts(current).includes(resultPort(planned))
          ? resultPort(planned)
          : defaultPort(current);
    steps.push({
      nodeId: current.id,
      label: current.label,
      op: current.op,
      attempt,
      port,
      assignee: current.assignee ?? null,
      effect: simulatedEffect(current),
    });
    const edge = definition.edges.find((item) => item.source === current!.id && item.port === port);
    if (!edge)
      return stop('invalid', current, {
        pt: `A saída «${port ?? '—'}» de «${current.label}» não tem destino.`,
        en: `Output «${port ?? '—'}» of «${current.label}» has no target.`,
      });
    current = nodes.get(edge.target);
  }
  return stop('invalid', undefined, { pt: 'Destino inexistente.', en: 'Missing target.' });
}

// ---------------------------------------------------------------------------------------------
// Migração de fluxos antigos (várias saídas por etapa) para sucesso/erro.

function isBinaryNode(node: FlowNode, edges: FlowEdge[]) {
  const ports = edges.filter((edge) => edge.source === node.id).map((edge) => edge.port);
  if (node.op === 'human_decision') {
    const options = decisionOptions(node).map((option) => option.port);
    return options.length === 2 && options.includes(FLOW_SUCCESS) && options.includes(FLOW_FAILURE);
  }
  return ports.every((port) => port === FLOW_SUCCESS || port === FLOW_FAILURE);
}

/**
 * Converte um fluxo com saídas detalhadas (forbidden, manual, retry…) para duas saídas por etapa.
 * O destino de sucesso é o da primeira saída antiga de sucesso; se uma saída de sucesso levava a
 * uma decisão humana (ex.: «needs_approval» → aprovação), a decisão passa a ser o destino e só é
 * pedida para esses resultados (`onlyWhen`). Saídas `retry`/`needs_information` passam a ser
 * tratadas pelo motor. Idempotente: etapas já binárias ficam iguais.
 */
export function toBinaryFlow(source: FlowDefinition): {
  definition: FlowDefinition;
  changed: boolean;
} {
  const definition: FlowDefinition = structuredClone(source);
  if (definition.nodes.every((node) => isBinaryNode(node, definition.edges)))
    return { definition: source, changed: false };
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const originalEdges = definition.edges;
  const edges: FlowEdge[] = [];
  const gates = new Map<string, Set<string>>();
  for (const node of definition.nodes) {
    if (node.op === 'end') continue;
    if (isBinaryNode(node, originalEdges)) {
      edges.push(...originalEdges.filter((edge) => edge.source === node.id));
      continue;
    }
    const outgoing = originalEdges.filter(
      (edge) =>
        edge.source === node.id &&
        !(FLOW_INTERNAL_RESULTS as readonly string[]).includes(edge.port),
    );
    if (node.op === 'human_decision') {
      const options = decisionOptions(node);
      const success = options.find((option) => resultPort(option.port) === FLOW_SUCCESS);
      const failure = options.find((option) => resultPort(option.port) === FLOW_FAILURE);
      const successTarget = success && outgoing.find((edge) => edge.port === success.port)?.target;
      const failureTarget = failure && outgoing.find((edge) => edge.port === failure.port)?.target;
      node.config = {
        ...node.config,
        options: [
          { ...(success ?? { label: 'Aprovar' }), port: FLOW_SUCCESS },
          { ...(failure ?? { label: 'Rejeitar', requiresComment: true }), port: FLOW_FAILURE },
        ],
      };
      const okTarget = successTarget ?? failureTarget;
      const errorTarget = failureTarget ?? successTarget;
      if (okTarget)
        edges.push({
          id: `${node.id}-${FLOW_SUCCESS}`,
          source: node.id,
          port: FLOW_SUCCESS,
          target: okTarget,
        });
      if (errorTarget)
        edges.push({
          id: `${node.id}-${FLOW_FAILURE}`,
          source: node.id,
          port: FLOW_FAILURE,
          target: errorTarget,
        });
      continue;
    }
    const order =
      node.op === 'action'
        ? (flowActionCatalog[actionKey(node)]?.results ?? [])
        : ['done', 'failed'];
    const sorted = [...outgoing].sort((a, b) => {
      const ia = order.indexOf(a.port);
      const ib = order.indexOf(b.port);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const successEdges = sorted.filter((edge) => resultPort(edge.port) === FLOW_SUCCESS);
    const failureEdge = sorted.find((edge) => resultPort(edge.port) === FLOW_FAILURE);
    const gateEdges = successEdges.filter(
      (edge) => nodes.get(edge.target)?.op === 'human_decision',
    );
    let okTarget = successEdges[0]?.target;
    if (gateEdges.length && successEdges.some((edge) => !gateEdges.includes(edge))) {
      // Algumas saídas de sucesso passavam por uma decisão humana: a decisão fica condicional.
      const gate = gateEdges[0]!;
      okTarget = gate.target;
      const only = gates.get(gate.target) ?? new Set<string>();
      for (const edge of gateEdges.filter((item) => item.target === gate.target))
        only.add(edge.port);
      gates.set(gate.target, only);
    }
    const errorTarget = failureEdge?.target ?? okTarget;
    okTarget ??= errorTarget;
    if (okTarget)
      edges.push({
        id: `${node.id}-${FLOW_SUCCESS}`,
        source: node.id,
        port: FLOW_SUCCESS,
        target: okTarget,
      });
    if (errorTarget)
      edges.push({
        id: `${node.id}-${FLOW_FAILURE}`,
        source: node.id,
        port: FLOW_FAILURE,
        target: errorTarget,
      });
  }
  for (const [nodeId, results] of gates) {
    const node = nodes.get(nodeId);
    if (node && !decisionOnlyWhen(node).length)
      node.config = { ...node.config, onlyWhen: [...results] };
  }
  definition.edges = edges;
  // Remove etapas que deixaram de ter caminho (ex.: «aguarda cliente», que o motor trata agora).
  const reachableBefore = reachable(source.start, originalEdges);
  const reachableAfter = reachable(definition.start, edges);
  const dropped = definition.nodes
    .filter((node) => reachableBefore.has(node.id) && !reachableAfter.has(node.id))
    .map((node) => node.id);
  if (dropped.length) {
    definition.nodes = definition.nodes.filter((node) => !dropped.includes(node.id));
    definition.edges = definition.edges.filter((edge) => !dropped.includes(edge.source));
    for (const id of dropped) delete definition.layout[id];
  }
  return { definition, changed: true };
}

function reachable(start: string, edges: FlowEdge[]) {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of edges)
      if (edge.source === id && !seen.has(edge.target)) {
        seen.add(edge.target);
        queue.push(edge.target);
      }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// Vistas da API.

export type FlowVersionStatus = 'draft' | 'published';

export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  priority: number;
  isDefault: boolean;
  match: FlowMatch;
  template: string | null;
  draftVersion: number;
  draftChanged: boolean;
  published: { id: string; number: number; publishedAt: string; publishedBy: string | null } | null;
  activeExecutions: number;
  updatedAt: string;
  /** Tipos de alerta da Saúde que abrem tickets neste fluxo (só entra por essa associação). */
  alertKeys: string[];
}

/**
 * Tipo de alerta da Saúde que pode ter fluxo próprio: regras do Prometheus (`prometheus:<regra>`)
 * e verificações internas que abrem tickets (`check:<verificação>`).
 */
export const healthAlertKeySchema = z
  .string()
  .regex(/^(prometheus|check):[A-Za-z0-9_.-]{1,140}$/, 'Tipo de alerta inválido.');

export function healthAlertKey(source: 'prometheus' | 'check', name: string) {
  return `${source}:${name}`;
}

export interface HealthAlertType {
  key: string;
  title: string;
  group: string;
}

export const healthAlertTypes: readonly HealthAlertType[] = [
  ...alertRuleCatalog.map((rule) => ({
    key: healthAlertKey('prometheus', rule.id),
    title: rule.title,
    group: alertRuleGroups[rule.group],
  })),
  {
    key: healthAlertKey('check', 'scheduled-jobs'),
    title: 'Falha de processos automáticos ou tarefas agendadas',
    group: 'Verificações internas',
  },
];

/** Associação de um tipo de alerta ao fluxo que trata os seus tickets (null = fluxo por omissão). */
export interface HealthAlertFlowLink extends HealthAlertType {
  flowId: string | null;
  flowName: string | null;
}

export const healthAlertFlowLinkSchema = z.strictObject({
  alertKey: healthAlertKeySchema,
  flowId: z.uuid().nullable(),
});
export const healthAlertFlowCreateSchema = z.strictObject({ alertKey: healthAlertKeySchema });

export interface FlowVersionInfo {
  id: string;
  number: number;
  publishedAt: string;
  publishedBy: string | null;
  activeExecutions: number;
}

export interface FlowDetail extends FlowSummary {
  draft: FlowDefinition;
  versions: FlowVersionInfo[];
  issues: FlowIssue[];
  members: { id: string; displayName: string; role: string }[];
  copilotReady: boolean;
}

export interface FlowAssistantResponse {
  reply: string;
  question: string | null;
  operations: FlowPatchOperation[];
  transition: { stepId: string; port: string; comment: string | null } | null;
}

export const flowAssistantResponseSchema = z.strictObject({
  reply: z.string().trim().max(4000).default(''),
  question: z.string().trim().max(500).nullable().default(null),
  operations: z.array(flowPatchOperationSchema).max(40).default([]),
  transition: z
    .strictObject({
      stepId: z.string().max(64),
      port: portSchema,
      comment: z.string().max(4000).nullable().default(null),
    })
    .nullable()
    .default(null),
});

export interface FlowAssistantRequestView {
  id: string;
  scope: 'flow' | 'ticket';
  message: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  resolution: 'pending' | 'accepted' | 'discarded';
  response: FlowAssistantResponse | null;
  baseDraftVersion: number | null;
  errorCode: string | null;
  requestedBy: string;
  createdAt: string;
}

export interface FlowStepView {
  id: string;
  nodeId: string;
  label: string;
  op: FlowOperationKey;
  attempt: number;
  status: 'active' | 'waiting' | 'completed' | 'failed';
  port: string | null;
  assignee: { label: string; userIds: string[] } | null;
  actor: { id: string; displayName: string } | null;
  output: FlowStepOutput;
  agentRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Informação produzida por uma etapa. `internal` só é devolvida à equipa. */
export interface FlowStepOutput {
  /** Resultado detalhado da etapa (ex.: `forbidden`, `manual`); a saída seguida é sucesso/erro. */
  result?: string | null;
  /** Análise à espera da resposta do cliente (o run que fez a pergunta). */
  awaitingClient?: { runId: string } | null;
  summary?: string;
  replyDraft?: string | null;
  evidence?: { source: string; detail: string }[];
  patch?: string | null;
  proposedTests?: string[];
  comment?: string | null;
  commentVisibility?: 'internal' | 'public';
  clientMessage?: string | null;
  note?: string | null;
  reason?: string | null;
  external?: string | null;
  feedback?: string | null;
  errorCode?: string | null;
  /** Evidência das etapas de incidente (decisão, intervenção, validação, e-mail). */
  incident?: {
    resource?: {
      kind: string;
      engine: string | null;
      host: string | null;
      unit: string | null;
      managed: boolean;
    };
    alertComponent?: string | null;
    causeComponent?: string | null;
    causeConfirmed?: boolean;
    report?: Record<string, unknown> | null;
    decision?: 'auto' | 'approval' | 'forbidden' | null;
    decisionReason?: string | null;
    interventionId?: string | null;
    action?: string | null;
    target?: string | null;
    parameter?: string | null;
    previousValue?: string | null;
    newValue?: string | null;
    rollback?: string | null;
    criterion?: string | null;
    measurements?: { at: string; ok: boolean; detail: string }[];
    attempts?: number;
    recipients?: string[];
    template?: string | null;
    simulated?: boolean;
  };
}

export interface FlowExecutionEventView {
  id: string;
  kind: string;
  stepId: string | null;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TicketFlowView {
  execution: {
    id: string;
    status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
    currentNodeId: string | null;
    flow: { id: string; name: string };
    version: { id: string; number: number; latestNumber: number };
    startedAt: string;
    finishedAt: string | null;
  };
  definition: FlowDefinition;
  steps: FlowStepView[];
  events: FlowExecutionEventView[];
  /** Quem tem a próxima ação e o que pode fazer o utilizador atual. */
  next: {
    stepId: string;
    nodeId: string;
    label: string;
    assignee: { label: string; userIds: string[] } | null;
    options: FlowDecisionOption[];
    canAct: boolean;
    waitingFor: 'person' | 'copilot' | 'system';
  } | null;
  /** Saídas possíveis a partir da etapa atual. */
  paths: { port: string; label: string; target: string; targetLabel: string }[];
  canUseAssistant: boolean;
  /** Incidente Health ligado ao ticket (só para a equipa). */
  incident?: TicketIncidentView | null;
}

export const flowDecisionInputSchema = z.strictObject({
  stepId: z.uuid(),
  port: portSchema,
  comment: z.string().trim().max(8000).optional(),
  idempotencyKey: z.string().trim().min(8).max(80),
});
export type FlowDecisionInput = z.infer<typeof flowDecisionInputSchema>;
