/**
 * P11 — métricas operacionais internas do projeto (equipa). Só valores efetivamente registados:
 * `null` significa «não registado/reportado», nunca zero inventado.
 */

export interface QueueMetric {
  kind: 'agent_run' | 'flow_assistant' | 'ticket_routing' | 'delivery';
  pending: number;
  running: number;
  oldestPendingSeconds: number | null;
  /** Espera média (criação → início) dos trabalhos iniciados na janela. */
  meanWaitSeconds: number | null;
  started: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface StepMetric {
  flowName: string;
  versionNumber: number;
  nodeId: string;
  completed: number;
  failed: number;
  waiting: number;
  active: number;
  /** Tentativas além da primeira (repetições do nó). */
  retries: number;
  meanDurationSeconds: number | null;
  maxDurationSeconds: number | null;
}

export interface CopilotUsageMetric {
  runsWithUsage: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Soma dos AI credits reportados; `null` quando nenhuma chamada os reportou. */
  aiCredits: number | null;
  callsWithoutReportedCredits: number;
  models: string[];
  /** Último snapshot de quota reportado pelo Copilot na janela. */
  quota: {
    unlimited: boolean;
    used: number;
    entitlement: number;
    remainingPercentage: number;
    overage: number;
    resetDate: string | null;
    reportedAt: string;
  } | null;
}

export interface CorrelatedEvent {
  at: string;
  kind:
    | 'step_failed'
    | 'job_lease'
    | 'run_failed'
    | 'delivery_uncertain'
    | 'delivery_failed'
    | 'intervention_uncertain'
    | 'intervention_failed'
    | 'tool_error';
  detail: string;
  projectId: string;
  ticketId: string | null;
  ticketKey: string | null;
  flowVersionId: string | null;
  executionId: string | null;
  stepId: string | null;
  jobId: string | null;
  attempt: number | null;
  externalOperation: string | null;
}

export interface OperationsMetrics {
  projectId: string;
  windowDays: number;
  generatedAt: string;
  queues: QueueMetric[];
  steps: StepMetric[];
  leases: { eventType: string; total: number }[];
  human: {
    waitingSteps: number;
    oldestWaitingSeconds: number | null;
    decisions: number;
    meanDecisionSeconds: number | null;
    agentQuestions: number;
    answersPending: number;
    answersConsumed: number;
  };
  copilot: CopilotUsageMetric;
  tools: { tool: string; ok: number; rejected: number; error: number; meanMs: number | null }[];
  deliveries: { state: string; total: number }[];
  interventions: { status: string; total: number }[];
  uncertain: { deliveries: number; interventions: number };
  health: {
    incidents: number;
    open: number;
    /** Incidentes cujos alertas recuperaram; não prova a recuperação do serviço. */
    recovered: number;
    meanRecoverySeconds: number | null;
    /** Incidentes com o mesmo título raiz aberto nos 7 dias anteriores. */
    recurrences: number;
    /** Validações do fluxo com recuperação confirmada pela sonda na janela de observação. */
    validationsConfirmed: number;
    /** Validações terminadas sem confirmação (falha, incerteza ou nova tentativa). */
    validationsNotConfirmed: number;
    /** Das não confirmadas, as que tiveram medições sem telemetria (resultado desconhecido). */
    validationsUnknownTelemetry: number;
  };
  correlation: CorrelatedEvent[];
}
