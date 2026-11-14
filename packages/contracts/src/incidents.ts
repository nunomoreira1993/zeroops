import { z } from 'zod';

/**
 * Incidentes genéricos (fluxo «Incidente (Health)»): o ciclo de vida não depende do recurso.
 * Um novo tipo de recurso ou motor acrescenta-se aqui (critério de validação e ícone por omissão),
 * sem mudar o fluxo, o motor ou as ações.
 */

export const incidentEnvironments = ['quality', 'production'] as const;
export type IncidentEnvironmentKey = (typeof incidentEnvironments)[number];

/** Critérios de recuperação suportados pela etapa «Validar recuperação». */
export const recoveryCriteria = [
  'alerts_resolved',
  'disk_free',
  'memory_pressure',
  'cpu_load',
  'database_query',
  'service_active',
  'http_check',
] as const;
export type RecoveryCriterion = (typeof recoveryCriteria)[number];

export interface IncidentResourceKind {
  key: string;
  label: { pt: string; en: string };
  /** Critério de recuperação por omissão (o projeto e a etapa podem sobrepor). */
  criterion: RecoveryCriterion;
  icon: string;
}

/** Tipos de recurso monitorizado (extensível: basta uma entrada nova). */
export const incidentResourceKinds: Record<string, IncidentResourceKind> = {
  server: {
    key: 'server',
    label: { pt: 'Servidor', en: 'Server' },
    criterion: 'alerts_resolved',
    icon: 'linux',
  },
  disk: {
    key: 'disk',
    label: { pt: 'Armazenamento', en: 'Storage' },
    criterion: 'disk_free',
    icon: 'disk',
  },
  memory: {
    key: 'memory',
    label: { pt: 'Memória', en: 'Memory' },
    criterion: 'memory_pressure',
    icon: 'memory',
  },
  cpu: { key: 'cpu', label: { pt: 'CPU', en: 'CPU' }, criterion: 'cpu_load', icon: 'cpu' },
  network: {
    key: 'network',
    label: { pt: 'Rede', en: 'Network' },
    criterion: 'alerts_resolved',
    icon: 'network',
  },
  database: {
    key: 'database',
    label: { pt: 'Base de dados', en: 'Database' },
    criterion: 'database_query',
    icon: 'database',
  },
  service: {
    key: 'service',
    label: { pt: 'Serviço', en: 'Service' },
    criterion: 'service_active',
    icon: 'service',
  },
  application: {
    key: 'application',
    label: { pt: 'Aplicação', en: 'Application' },
    criterion: 'http_check',
    icon: 'application',
  },
  other: {
    key: 'other',
    label: { pt: 'Outro', en: 'Other' },
    criterion: 'alerts_resolved',
    icon: 'generic',
  },
};

/** Motores conhecidos e o respetivo ícone de marca (simple-icons local; `generic` sem marca). */
export const incidentEngines: Record<string, { label: string; icon: string; kind: string }> = {
  mysql: { label: 'MySQL', icon: 'mysql', kind: 'database' },
  mariadb: { label: 'MariaDB', icon: 'mariadb', kind: 'database' },
  db2: { label: 'IBM DB2', icon: 'ibm', kind: 'database' },
  nginx: { label: 'Nginx', icon: 'nginx', kind: 'service' },
  apache: { label: 'Apache', icon: 'apache', kind: 'service' },
  php: { label: 'PHP-FPM', icon: 'php', kind: 'service' },
  redis: { label: 'Redis', icon: 'redis', kind: 'service' },
  linux: { label: 'Linux', icon: 'linux', kind: 'server' },
  prometheus: { label: 'Prometheus', icon: 'prometheus', kind: 'service' },
  loki: { label: 'Loki', icon: 'grafana', kind: 'service' },
  git: { label: 'Git', icon: 'git', kind: 'application' },
  svn: { label: 'Subversion', icon: 'subversion', kind: 'application' },
};

export const incidentResourceSchema = z.strictObject({
  kind: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,30}$/),
  engine: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,30}$/)
    .nullable()
    .default(null),
  host: z.string().trim().max(160).nullable().default(null),
  /** Serviço systemd afetado, quando conhecido (ex.: `php-fpm.service`). */
  unit: z.string().trim().max(120).nullable().default(null),
  environment: z.enum(incidentEnvironments),
  /** `false` = recurso que não gerimos (ex.: DB2): só diagnóstico, nunca intervenção. */
  managed: z.boolean().default(true),
});
export type IncidentResource = z.infer<typeof incidentResourceSchema>;

// ---------------------------------------------------------------------------------------------
// Política de intervenção.

export const interventionActions = ['service_restart', 'server_reboot', 'set_parameter'] as const;
export type InterventionAction = (typeof interventionActions)[number];

export const interventionActionLabels: Record<InterventionAction, { pt: string; en: string }> = {
  service_restart: { pt: 'Reiniciar serviço', en: 'Restart service' },
  server_reboot: { pt: 'Reiniciar servidor', en: 'Reboot server' },
  set_parameter: { pt: 'Alterar parâmetro', en: 'Change parameter' },
};

export const interventionDecisions = ['auto', 'approval', 'forbidden'] as const;
export type InterventionDecision = (typeof interventionDecisions)[number];

/** Propriedades systemd que o canal de intervenção sabe ler e repor. */
export const interventionParameters = ['MemoryMax', 'MemoryHigh', 'CPUQuota', 'TasksMax'] as const;
export type InterventionParameter = (typeof interventionParameters)[number];

const unitSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9@_.-]{1,100}\.service$/);

export const interventionRuleSchema = z.strictObject({
  environment: z.enum(['any', ...incidentEnvironments]).default('any'),
  kind: z.string().trim().max(32).default('any'),
  engine: z.string().trim().max(32).default('any'),
  action: z.enum(interventionActions),
  decision: z.enum(interventionDecisions),
});
export type InterventionRule = z.infer<typeof interventionRuleSchema>;

export const validationSettingsSchema = z.strictObject({
  /** Tempo em que o critério tem de se manter verdadeiro para dar como recuperado. */
  observationMinutes: z.number().int().min(0).max(240).default(5),
  /** Prazo total da validação antes de seguir por «não recuperou». */
  timeoutMinutes: z.number().int().min(1).max(1440).default(30),
  /** Intervenções (tentativas) antes de escalar. */
  maxAttempts: z.number().int().min(1).max(5).default(2),
  /** Limites dos critérios. */
  diskFreePercent: z.number().min(1).max(90).default(15),
  memoryAvailablePercent: z.number().min(1).max(90).default(15),
  cpuLoadPerCore: z.number().min(0.1).max(20).default(1.5),
  httpUrl: z.string().trim().url().max(400).nullable().default(null),
});
export type ValidationSettings = z.infer<typeof validationSettingsSchema>;

export const incidentPolicySchema = z.strictObject({
  rules: z.array(interventionRuleSchema).max(60).default([]),
  /** Serviços que o agente pode reiniciar (tem de coincidir com a allowlist do relay). */
  services: z
    .array(
      z.strictObject({
        unit: unitSchema,
        engine: z.string().trim().max(32).nullable().default(null),
        environment: z.enum(['any', ...incidentEnvironments]).default('any'),
      }),
    )
    .max(40)
    .default([]),
  parameters: z
    .array(
      z.strictObject({
        unit: unitSchema,
        property: z.enum(interventionParameters),
        /** Valores aceites, ex.: `512M`…`2G` ou `50%`…`200%` (texto livre validado pelo relay). */
        allowed: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[0-9]{1,6}(%|[KMG])?$|^infinity$/),
          )
          .min(1)
          .max(12),
      }),
    )
    .max(40)
    .default([]),
  /** Motores nunca geridos por nós (só leitura). */
  unmanagedEngines: z.array(z.string().trim().max(32)).max(20).default(['db2']),
  validation: validationSettingsSchema.default(validationSettingsSchema.parse({})),
  /** Equipa a que o incidente é atribuído quando escala. */
  escalationRole: z.enum(['technical', 'admin', 'qa', 'release']).default('technical'),
});
export type IncidentPolicy = z.infer<typeof incidentPolicySchema>;

export const incidentPolicyInputSchema = z.strictObject({
  policy: incidentPolicySchema,
  expectedVersion: z.number().int().nonnegative(),
});

/** Cenários de demonstração (alertas sintéticos no QA, com intervenções simuladas). */
export const incidentDemoScenarios = ['disk', 'memory', 'mysql', 'db2'] as const;
export type IncidentDemoScenario = (typeof incidentDemoScenarios)[number];
export const incidentDemoInputSchema = z.strictObject({ scenario: z.enum(incidentDemoScenarios) });

export interface IncidentPolicyView {
  policy: IncidentPolicy;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Regras por omissão: reiniciar serviço sem confirmação, reboot e parâmetros com aprovação. */
export const defaultInterventionRules: InterventionRule[] = [
  { environment: 'any', kind: 'any', engine: 'any', action: 'service_restart', decision: 'auto' },
  { environment: 'any', kind: 'any', engine: 'any', action: 'server_reboot', decision: 'approval' },
  { environment: 'any', kind: 'any', engine: 'any', action: 'set_parameter', decision: 'approval' },
];

export function defaultIncidentPolicy(): IncidentPolicy {
  return incidentPolicySchema.parse({ rules: defaultInterventionRules });
}

export interface ProposedIntervention {
  action: InterventionAction;
  /** Unidade systemd (restart/parâmetro) ou host (reboot). */
  target: string;
  parameter?: InterventionParameter | null;
  value?: string | null;
  reason: string;
}

export interface PolicyEvaluation {
  decision: InterventionDecision;
  reason: string;
  /** Regra que decidiu (ausente em proibições fixas). */
  rule?: InterventionRule;
}

const ruleSpecificity = (rule: InterventionRule) =>
  (rule.environment === 'any' ? 0 : 4) +
  (rule.kind === 'any' ? 0 : 2) +
  (rule.engine === 'any' ? 0 : 1);

/**
 * Decide se uma intervenção pode correr. Proibições fixas (não configuráveis): recursos não
 * geridos, motores marcados como não geridos, serviços/parâmetros fora da allowlist do projeto.
 * Entre as regras coincidentes ganha a mais específica; em empate, a mais restritiva.
 */
export function evaluateIntervention(
  policy: IncidentPolicy,
  resource: IncidentResource,
  proposal: ProposedIntervention,
): PolicyEvaluation {
  const engine = resource.engine ?? '';
  if (!resource.managed || policy.unmanagedEngines.includes(engine))
    return {
      decision: 'forbidden',
      reason: `O recurso ${engine || resource.kind} não é gerido por nós: só diagnóstico.`,
    };
  if (proposal.action === 'service_restart' || proposal.action === 'set_parameter') {
    const listed = policy.services.some(
      (service) =>
        service.unit === proposal.target &&
        (service.environment === 'any' || service.environment === resource.environment),
    );
    if (!listed)
      return {
        decision: 'forbidden',
        reason: `O serviço ${proposal.target} não está na lista de serviços permitidos do projeto.`,
      };
  }
  if (proposal.action === 'set_parameter') {
    const allowed = policy.parameters.find(
      (item) => item.unit === proposal.target && item.property === proposal.parameter,
    );
    if (!allowed || !proposal.value || !allowed.allowed.includes(proposal.value))
      return {
        decision: 'forbidden',
        reason: `O valor ${proposal.parameter ?? '?'}=${proposal.value ?? '?'} não está entre os valores permitidos.`,
      };
  }
  const order: Record<InterventionDecision, number> = { auto: 0, approval: 1, forbidden: 2 };
  const matching = policy.rules
    .filter(
      (rule) =>
        rule.action === proposal.action &&
        (rule.environment === 'any' || rule.environment === resource.environment) &&
        (rule.kind === 'any' || rule.kind === resource.kind) &&
        (rule.engine === 'any' || rule.engine === engine),
    )
    .sort(
      (a, b) => ruleSpecificity(b) - ruleSpecificity(a) || order[b.decision] - order[a.decision],
    );
  const rule = matching[0];
  if (!rule)
    return {
      decision: 'approval',
      reason: 'Nenhuma regra do projeto cobre esta ação: precisa de aprovação humana.',
    };
  const label = interventionActionLabels[proposal.action].pt.toLowerCase();
  const reason =
    rule.decision === 'auto'
      ? `A política do projeto permite ${label} sem confirmação neste ambiente.`
      : rule.decision === 'approval'
        ? `A política do projeto exige aprovação humana para ${label}.`
        : `A política do projeto proíbe ${label} neste recurso.`;
  return { decision: rule.decision, reason, rule };
}

/** Critério de validação para o recurso (por omissão o do tipo de recurso). */
export function recoveryCriterionFor(resource: Pick<IncidentResource, 'kind'>): RecoveryCriterion {
  return incidentResourceKinds[resource.kind]?.criterion ?? 'alerts_resolved';
}

// ---------------------------------------------------------------------------------------------
// Relatório estruturado da investigação (bloco JSON no resumo do Copilot).

export const INCIDENT_REPORT_FENCE = 'zeroops-incident';

export const incidentReportSchema = z.object({
  observations: z.array(z.string().max(1000)).max(20).default([]),
  impact: z.string().max(2000).default(''),
  hypotheses: z.array(z.string().max(1000)).max(10).default([]),
  alertComponent: z.string().max(160).nullable().default(null),
  causeComponent: z.string().max(160).nullable().default(null),
  causeConfirmed: z.boolean().default(false),
  /** `false` = a causa está num recurso que não gerimos. */
  causeManaged: z.boolean().default(true),
  recoveredSpontaneously: z.boolean().default(false),
  proposedAction: z
    .object({
      action: z.enum(interventionActions),
      target: z.string().max(160),
      parameter: z.enum(interventionParameters).nullable().optional(),
      value: z.string().max(40).nullable().optional(),
      reason: z.string().max(1000).default(''),
    })
    .nullable()
    .default(null),
  nextStep: z.string().max(1000).default(''),
});
export type IncidentReport = z.infer<typeof incidentReportSchema>;

/** Extrai o relatório estruturado (bloco ```zeroops-incident) do resumo do agente. */
export function parseIncidentReport(summary: string | null | undefined): IncidentReport | null {
  if (!summary) return null;
  const match = summary.match(/```(?:zeroops-incident|json)\s*\n([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = incidentReportSchema.safeParse(JSON.parse(match[1]!));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Formato pedido ao agente (prompt da etapa de investigação). */
export function incidentReportInstruction() {
  return [
    `No fim do resumo inclui um bloco \`\`\`${INCIDENT_REPORT_FENCE} com JSON válido:`,
    '{"observations":["…"],"impact":"…","hypotheses":["…"],"alertComponent":"componente que emitiu o alerta",',
    '"causeComponent":"componente onde está a causa ou null","causeConfirmed":true|false,"causeManaged":true|false,',
    '"recoveredSpontaneously":true|false,',
    '"proposedAction":{"action":"service_restart|server_reboot|set_parameter","target":"unidade systemd ou host",',
    '"parameter":"MemoryMax|MemoryHigh|CPUQuota|TasksMax|null","value":"ex.: 1G|null","reason":"…"} ou null,',
    '"nextStep":"próximo passo recomendado"}.',
    'Propõe só ações desta lista; nunca proponhas apagar ficheiros, dados ou código. Se a causa estiver num recurso não gerido (ex.: DB2), usa causeManaged=false e proposedAction=null.',
  ].join(' ');
}

// ---------------------------------------------------------------------------------------------
// Intervenções registadas e suspensão da Saúde.

export type InterventionStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'refused' | 'cancelled' | 'simulated';

export interface IncidentInterventionView {
  id: string;
  ticketId: string;
  stepId: string | null;
  action: InterventionAction;
  target: string;
  parameter: string | null;
  previousValue: string | null;
  newValue: string | null;
  rollback: string | null;
  decision: InterventionDecision;
  decisionReason: string;
  status: InterventionStatus;
  result: string | null;
  actor: 'agent' | 'human';
  createdAt: string;
  finishedAt: string | null;
}

/** Resumo do incidente mostrado no ticket (só à equipa). */
export interface TicketIncidentView {
  environment: IncidentEnvironmentKey;
  state: string;
  resource: IncidentResource | null;
  alertComponent: string | null;
  causeComponent: string | null;
  causeConfirmed: boolean;
  demoScenario: string | null;
  openedAt: string;
  recoveredAt: string | null;
  interventions: IncidentInterventionView[];
}

export const healthSuspendInputSchema = z.strictObject({
  environment: z.enum(incidentEnvironments),
  reason: z.string().trim().min(5).max(500),
});
export const healthResumeInputSchema = z.strictObject({
  environment: z.enum(incidentEnvironments),
});

export interface HealthSuspensionView {
  id: string;
  environment: IncidentEnvironmentKey;
  reason: string;
  suspendedBy: string;
  suspendedAt: string;
  resumedBy: string | null;
  resumedAt: string | null;
  cancelledRuns: number;
}

export interface HealthSuspensionState {
  /** Suspensões ativas por ambiente. */
  active: Partial<Record<IncidentEnvironmentKey, HealthSuspensionView>>;
  history: HealthSuspensionView[];
}
