/** Investigação de um ticket pelo agente (Copilot CLI), pedida pela equipa. */
import type {
  RepositoryResourceKind,
  RepositoryResourceSelectionReason,
} from './agent-profiles.js';

export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AgentExecutionMode = 'copilot' | 'local';
export type AgentFusionTier = 'standard' | 'high' | 'max';

export interface AgentEvidence {
  source: string;
  detail: string;
}

/** Chamada a um conector de leitura (BD do site, logs), registada como evidência do run. */
export interface AgentToolCall {
  tool: string;
  /** Ambiente consultado (QA ou Produção). */
  environment: 'quality' | 'production';
  request: string;
  outcome: 'ok' | 'rejected' | 'error';
  rowCount: number | null;
  durationMs: number;
  errorCode: string | null;
  createdAt: string;
}

/** `auto`: investigação ao criar o ticket; `incident_review`: análise pós-incidente da Saúde; `flow`: etapa de um fluxo do projeto. */
export type AgentRunTrigger = 'manual' | 'client_reply' | 'auto' | 'incident_review' | 'flow';

export interface AgentRun {
  id: string;
  ticketId: string;
  status: AgentRunStatus;
  /** Origem: equipa, resposta do cliente, criação do ticket ou análise pós-incidente. */
  trigger: AgentRunTrigger;
  instructions: string | null;
  progress: string | null;
  summary: string | null;
  replyDraft: string | null;
  /** Perguntas do agente ao cliente (enviadas automaticamente se o projeto o permitir). */
  clientQuestions: string[];
  /** Mensagem pública criada com as perguntas (null se não foram enviadas). */
  clientMessageId: string | null;
  evidence: AgentEvidence[];
  toolCalls: AgentToolCall[];
  errorCode: string | null;
  cancelRequested: boolean;
  /** Pergunta do agente ainda sem resposta (o run está à espera da equipa). */
  pendingQuestion: AgentQuestion | null;
  /** Consumo estimado do run (null em runs sem registo de uso). */
  usage: AgentUsage | null;
  /** Última quota de premium requests lida durante o run. */
  quota: AgentQuota | null;
  /** Modelo escolhido ao pedir o run (`auto`, Fusion…); `null` usa o modelo da integração. */
  model: string | null;
  /** Esforço de raciocínio pedido (`high`…); `null` usa a predefinição do modelo. */
  reasoningEffort: string | null;
  executionMode?: AgentExecutionMode;
  fusionTier?: AgentFusionTier | null;
  /** Perfil de execução ZeroOps e versão imutável, quando o run veio de um flow moderno. */
  agentProfile?: { id: string; version: number; name: string } | null;
  /** SHA-256 do conjunto de conteúdos técnicos carregados; não é uma revisão SVN. */
  repositorySnapshotHash?: string | null;
  repositoryResources?: {
    path: string;
    kind: RepositoryResourceKind;
    required: boolean;
    sha256: string | null;
    status: 'loaded' | 'missing' | 'unavailable';
    selectionReason?: RepositoryResourceSelectionReason;
  }[];
  allowedTools?: string[] | null;
  effectiveTools?: string[] | null;
  effectiveModel?: string | null;
  requestedBy: { id: string; displayName: string; avatarVersion?: number | null };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Pergunta feita pelo agente (`ask_user` ou aprovação de plano). */
export interface AgentQuestion {
  questionId: string;
  kind: 'ask_user' | 'plan';
  question: string;
  choices: string[];
  allowFreeform: boolean;
}

export type AgentAiCreditsStatus = 'complete' | 'partial' | 'unavailable';
export type AgentCostUnit = 'ai_credits' | 'premium_requests';
export type AgentCostStatus = AgentAiCreditsStatus | 'legacy';

/** Uma chamada concreta ao modelo; valores ausentes não significam custo zero. */
export interface AgentModelCall {
  model: string;
  /** Multiplicador legado; só é faturação premium quando a unidade é conhecida. */
  cost: number | null;
  billingUnit?: AgentCostUnit;
  /** Montante reportado pelo Copilot, sem estimativas por tokens ou descontos adicionais. */
  aiCredits?: number | null;
  aiCreditsStatus?: AgentAiCreditsStatus;
  accounting?: { sourceSessionId: string; sequence: number; usageId: string };
  apiCallId?: string;
  /** Identidade original do evento SDK, não o ID da linha na base de dados. */
  sdkEventId?: string;
  fusion?: { fusionId: string; phaseId?: string; sourceModel?: string };
  /** Origem da chamada (ex.: `sub-agent`); ausente quando é pedida pela equipa. */
  initiator: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
  durationMs: number | null;
}

/** Consumo reportado do run (ou turno). Campos opcionais permitem ler registos antigos. */
export interface AgentUsage {
  premiumRequests: number;
  aiCredits?: number | null;
  aiCreditsStatus?: AgentAiCreditsStatus;
  costUnit?: AgentCostUnit | null;
  costStatus?: AgentCostStatus;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
  models: string[];
  modelUsage?: AgentModelUsage[];
}

/** Detalhe por modelo concreto; a soma de caches não é um custo adicional. */
export type AgentModelUsage = Pick<
  AgentUsage,
  | 'modelCalls'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'aiCredits'
  | 'aiCreditsStatus'
> & { model: string };

export function emptyUsage(): AgentUsage {
  return {
    premiumRequests: 0,
    aiCredits: null,
    aiCreditsStatus: 'unavailable',
    costUnit: null,
    costStatus: 'unavailable',
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    models: [],
    modelUsage: [],
  };
}

/**
 * Soma apenas recibos de chamadas concretas, não snapshots nem totais de fases Fusion.
 * Créditos somam todas as chamadas; a regra de um multiplicador por pedido mantém-se apenas
 * para faturação premium legada explicitamente conhecida. As identidades do SDK evitam replay.
 */
export class UsageAccumulator {
  private awaitingRequest = true;
  private readonly receipts = new Set<string>();
  private readonly units = new WeakMap<AgentUsage, Set<AgentCostUnit>>();

  private amount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  private mergeStatus(
    previous: AgentAiCreditsStatus,
    next: AgentAiCreditsStatus,
  ): AgentAiCreditsStatus {
    return previous === next ? previous : 'partial';
  }

  /** Marca o início de um novo pedido do utilizador (mensagem de seguimento). */
  userRequest() {
    this.awaitingRequest = true;
  }

  /** Acrescenta a chamada a cada destino (ex.: turno e total do run). */
  add(call: AgentModelCall, ...targets: AgentUsage[]) {
    const source = call.accounting?.sourceSessionId ?? '';
    const identities = [
      ...(call.accounting
        ? [
            JSON.stringify(['usage', source, call.accounting.usageId]),
            JSON.stringify(['sequence', source, call.accounting.sequence]),
          ]
        : []),
      ...(call.apiCallId ? [JSON.stringify(['api', source, call.apiCallId])] : []),
      ...(call.sdkEventId ? [JSON.stringify(['event', call.sdkEventId])] : []),
    ];
    if (identities.some((identity) => this.receipts.has(identity))) {
      for (const identity of identities) this.receipts.add(identity);
      return;
    }
    for (const identity of identities) this.receipts.add(identity);
    const credits = this.amount(call.aiCredits);
    const creditStatus = credits === null ? 'unavailable' : (call.aiCreditsStatus ?? 'complete');
    const cost = this.amount(call.cost);
    // O mapper antigo fabricava zeros. Um multiplicador positivo antigo não era fabricado.
    const legacyPremium =
      call.billingUnit === 'premium_requests' ||
      (call.billingUnit === undefined &&
        call.aiCredits === undefined &&
        call.aiCreditsStatus === undefined &&
        cost !== null &&
        cost > 0);
    const unit: AgentCostUnit | null =
      call.billingUnit === 'ai_credits' || credits !== null
        ? 'ai_credits'
        : legacyPremium
          ? 'premium_requests'
          : null;
    const status: AgentCostStatus =
      unit === 'ai_credits'
        ? creditStatus
        : legacyPremium && cost !== null
          ? 'complete'
          : call.aiCreditsStatus === undefined && call.billingUnit === undefined
            ? 'legacy'
            : 'unavailable';
    const billable = this.awaitingRequest && !call.initiator;
    if (billable) this.awaitingRequest = false;
    for (const target of new Set(targets)) {
      const first = target.modelCalls === 0;
      if (billable && legacyPremium && cost !== null) target.premiumRequests += cost;
      if (credits !== null) target.aiCredits = (target.aiCredits ?? 0) + credits;
      target.aiCreditsStatus = first
        ? creditStatus
        : this.mergeStatus(target.aiCreditsStatus ?? 'unavailable', creditStatus);
      const previousUnit = target.costUnit ?? null;
      const units = this.units.get(target) ?? new Set<AgentCostUnit>();
      if (previousUnit) units.add(previousUnit);
      if (unit) units.add(unit);
      this.units.set(target, units);
      target.costUnit = units.size === 1 ? [...units][0]! : null;
      target.costStatus = first
        ? status
        : target.costStatus === status && previousUnit === unit
          ? status
          : 'partial';
      target.modelCalls += 1;
      target.inputTokens += this.amount(call.inputTokens) ?? 0;
      target.outputTokens += this.amount(call.outputTokens) ?? 0;
      target.cacheReadTokens += this.amount(call.cacheReadTokens) ?? 0;
      target.cacheWriteTokens =
        (target.cacheWriteTokens ?? 0) + (this.amount(call.cacheWriteTokens) ?? 0);
      if (!target.models.includes(call.model)) target.models.push(call.model);
      target.modelUsage ??= [];
      let detail = target.modelUsage.find((item) => item.model === call.model);
      if (!detail) {
        detail = {
          model: call.model,
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          aiCredits: null,
          aiCreditsStatus: 'unavailable',
        };
        target.modelUsage.push(detail);
      }
      detail.aiCreditsStatus =
        detail.modelCalls === 0
          ? creditStatus
          : this.mergeStatus(detail.aiCreditsStatus ?? 'unavailable', creditStatus);
      if (credits !== null) detail.aiCredits = (detail.aiCredits ?? 0) + credits;
      detail.modelCalls += 1;
      detail.inputTokens += this.amount(call.inputTokens) ?? 0;
      detail.outputTokens += this.amount(call.outputTokens) ?? 0;
      detail.cacheReadTokens += this.amount(call.cacheReadTokens) ?? 0;
      detail.cacheWriteTokens =
        (detail.cacheWriteTokens ?? 0) + (this.amount(call.cacheWriteTokens) ?? 0);
    }
  }
}

/** Quota de premium requests da conta Copilot do projeto (snapshot mais recente do run). */
export interface AgentQuota {
  unlimited: boolean;
  used: number;
  entitlement: number;
  remainingPercentage: number;
  overage: number;
  resetDate: string | null;
}

/** Retira de um evento `quota` só os campos do snapshot. */
export function quotaSnapshot(event: AgentQuota): AgentQuota {
  return {
    unlimited: event.unlimited,
    used: event.used,
    entitlement: event.entitlement,
    remainingPercentage: event.remainingPercentage,
    overage: event.overage,
    resetDate: event.resetDate,
  };
}

export interface AgentMcpServer {
  name: string;
  status: string;
  error?: string;
}

/**
 * Eventos da conversa ao vivo com o agente, por ordem de `id`. Os textos já vêm limitados e sem
 * segredos; `assistant.delta` acumula-se por `messageId` até chegar `assistant.message`.
 */
export type AgentRunEventPayload =
  | { type: 'status'; text: string }
  | { type: 'assistant.delta'; messageId: string; text: string }
  | { type: 'assistant.message'; messageId: string; text: string }
  | {
      type: 'tool.start';
      toolCallId: string;
      tool: string;
      title: string | null;
      server: string | null;
      arguments: string | null;
    }
  | {
      type: 'tool.complete';
      toolCallId: string;
      success: boolean;
      result: string | null;
      error: string | null;
    }
  | { type: 'mcp.servers'; servers: AgentMcpServer[] }
  | { type: 'mcp.status'; server: string; status: string; error: string | null }
  | ({ type: 'question' } & AgentQuestion)
  | { type: 'answer'; questionId: string; answer: string; author: string }
  | { type: 'user.message'; text: string; author: string }
  | {
      type: 'permission';
      kind: string;
      decision: 'approved' | 'denied';
      detail: string;
      /** Chamada de ferramenta a que a permissão se refere (ausente em runs antigos). */
      toolCallId?: string;
    }
  | ({ type: 'usage' } & AgentModelCall)
  | ({ type: 'quota' } & AgentQuota)
  | { type: 'error'; message: string };

export type AgentRunEventType = AgentRunEventPayload['type'];

export type AgentRunEvent = AgentRunEventPayload & { id: number; createdAt: string };

/** Modelo sintético: o Copilot escolhe o modelo em cada pedido. */
export const AGENT_MODEL_AUTO = 'auto';
/** Esforço "High" da UI; "Standard" envia `null` (predefinição do modelo). */
export const AGENT_EFFORT_HIGH = 'high';

/** Modelo disponível na conta Copilot do projeto, lido pelo executor via SDK. */
export interface AgentModelOption {
  id: string;
  name: string;
  /** Multiplicador de premium requests por pedido (`null` se desconhecido; 0 = incluído). */
  multiplier: number | null;
  /** Esforços de raciocínio suportados (vazio quando o modelo não os aceita). */
  efforts: string[];
  defaultEffort: string | null;
  /** Modelo "Copilot Fusion" (combina vários modelos). */
  fusion: boolean;
}

/** Catálogo de modelos do projeto (cache atualizada pelo executor). */
export interface AgentModelCatalog {
  models: AgentModelOption[];
  routingTiers?: AgentRoutingTier[];
  /** Modelo configurado na integração (usado quando o pedido não indica modelo). */
  defaultModel: string | null;
  refreshedAt: string | null;
  /** Há uma atualização pedida ao executor ainda por concluir. */
  refreshing: boolean;
  errorCode: string | null;
}

/** É um modelo Fusion (`hydrafusion`, `hydrafusion-max`…). */
export const isFusionModel = (id: string) => id === 'fusion' || /^hydrafusion/i.test(id);

export interface AgentRoutingTier {
  id: string;
  name: string;
  description: string;
  fusionTier: AgentFusionTier | null;
  enabled: boolean;
  visible: boolean;
  reason: string | null;
  promo?: {
    discountPercent?: number;
    startsAt?: string;
    endsAt?: string;
    message?: string;
  };
}

/** Entrada da equipa durante o run: resposta a uma pergunta ou mensagem de seguimento. */
export type AgentRunInput =
  { kind: 'answer'; questionId: string; text: string } | { kind: 'message'; text: string };
