import type { AgentRunEventPayload } from '../../../packages/contracts/src/index.js';

/** Forma mínima de um evento de sessão do SDK. */
export interface SessionEventLike {
  type: string;
  data?: unknown;
  id?: string;
}

const TEXT_LIMIT = 20000;
const DETAIL_LIMIT = 2000;
const SECRET_PATTERNS = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(password|passwd|pwd|secret|token)\s*[=:]\s*\S+/gi,
];

export type Redactor = (text: string) => string;

/**
 * Remove das mensagens os valores secretos conhecidos do run (token Copilot, token dos conectores)
 * e padrões comuns de credenciais, antes de serem guardados ou mostrados na interface.
 */
export function createRedactor(secrets: string[]): Redactor {
  const known = [...new Set(secrets.filter((secret) => secret.length >= 8))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => {
    let value = text;
    for (const secret of known) value = value.split(secret).join('[redigido]');
    for (const pattern of SECRET_PATTERNS)
      value = value.replace(pattern, (match) =>
        /^(password|passwd|pwd|secret|token)/i.test(match)
          ? match.replace(/([=:]\s*)\S+$/, '$1[redigido]')
          : '[redigido]',
      );
    return value;
  };
}

export function clip(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function mcpServers(value: unknown) {
  return (Array.isArray(value) ? value : []).map((item) => {
    const server = record(item);
    const error = text(server.error);
    return {
      name: text(server.displayName) ?? text(server.name) ?? 'mcp',
      status: text(server.status) ?? 'unknown',
      ...(error ? { error } : {}),
    };
  });
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Converte o snapshot `premium_interactions` de `account.getQuota` no evento de quota do run. */
export function mapQuota(result: unknown): AgentRunEventPayload | null {
  const snapshots = record(record(result).quotaSnapshots);
  const premium = record(snapshots.premium_interactions);
  if (!Object.keys(premium).length) return null;
  return {
    type: 'quota',
    unlimited: premium.isUnlimitedEntitlement === true,
    used: count(premium.usedRequests),
    entitlement: typeof premium.entitlementRequests === 'number' ? premium.entitlementRequests : 0,
    remainingPercentage: count(premium.remainingPercentage),
    overage: count(premium.overage),
    resetDate: text(premium.resetDate),
  };
}

/**
 * Converte um evento do SDK no evento da conversa mostrado à equipa. Eventos internos (telemetria,
 * contexto, etc.) são ignorados. Todos os textos passam pelo `redact` e ficam limitados.
 */
export function mapSessionEvent(
  event: SessionEventLike,
  redact: Redactor,
): AgentRunEventPayload | null {
  const data = record(event.data);
  const safe = (value: unknown, limit = DETAIL_LIMIT) => {
    const raw = serialize(value);
    return raw === null ? null : clip(redact(raw), limit);
  };
  switch (event.type) {
    case 'assistant.message_delta': {
      const delta = text(data.deltaContent);
      if (!delta || data.parentToolCallId) return null;
      return {
        type: 'assistant.delta',
        messageId: String(data.messageId ?? ''),
        text: redact(delta),
      };
    }
    case 'assistant.message': {
      const content = text(data.content);
      if (!content || data.parentToolCallId) return null;
      return {
        type: 'assistant.message',
        messageId: String(data.messageId ?? ''),
        text: clip(redact(content), TEXT_LIMIT),
      };
    }
    case 'assistant.intent': {
      const intent = text(data.intent);
      return intent ? { type: 'status', text: clip(redact(intent), 200) } : null;
    }
    case 'tool.execution_start': {
      const tool = text(data.toolName);
      if (!tool) return null;
      return {
        type: 'tool.start',
        toolCallId: String(data.toolCallId ?? ''),
        tool: text(data.mcpToolName) ?? tool,
        title: safe(data.toolTitle, 200),
        server: text(data.mcpServerDisplayName) ?? text(data.mcpServerName),
        arguments: safe(data.arguments),
      };
    }
    case 'tool.execution_complete': {
      const result = record(data.result);
      const error = record(data.error);
      return {
        type: 'tool.complete',
        toolCallId: String(data.toolCallId ?? ''),
        success: data.success === true,
        result: safe(result.content),
        error: safe(error.message, 500),
      };
    }
    case 'session.mcp_servers_loaded':
      return { type: 'mcp.servers', servers: mcpServers(data.servers) };
    case 'session.mcp_server_status_changed': {
      const server = text(data.serverName);
      if (!server) return null;
      return {
        type: 'mcp.status',
        server,
        status: text(data.status) ?? 'unknown',
        error: safe(data.error, 500),
      };
    }
    case 'assistant.usage': {
      const copilotUsage = record(data.copilotUsage);
      const fusion = record(data.fusion);
      const model = text(data.responseModel) ?? text(fusion.sourceModel) ?? text(data.model);
      if (!model) return null;
      const nano = amount(copilotUsage.totalNanoAiu);
      const cost = amount(data.cost);
      const aiCreditsStatus =
        data.aiCreditsStatus === 'complete' ||
        data.aiCreditsStatus === 'partial' ||
        data.aiCreditsStatus === 'unavailable'
          ? data.aiCreditsStatus
          : nano === null
            ? 'unavailable'
            : 'complete';
      const accounting = record(data.accounting);
      const sourceSessionId = text(accounting.sourceSessionId);
      const usageId = text(accounting.usageId);
      const sequence = amount(accounting.sequence);
      const apiCallId = text(data.apiCallId);
      const sdkEventId = text(event.id);
      const fusionId = text(fusion.fusionId);
      const phaseId = text(fusion.phaseId);
      const sourceModel = text(fusion.sourceModel);
      const billingUnit =
        nano !== null || data.aiCreditsStatus !== undefined
          ? 'ai_credits'
          : data.billingUnit === 'premium_requests' || (cost !== null && cost > 0)
            ? 'premium_requests'
            : undefined;
      return {
        type: 'usage',
        model: clip(model, 100),
        cost,
        ...(billingUnit ? { billingUnit } : {}),
        aiCredits: nano === null ? null : nano / 1_000_000_000,
        aiCreditsStatus: nano === null ? 'unavailable' : aiCreditsStatus,
        ...(sourceSessionId && usageId && sequence !== null && Number.isInteger(sequence)
          ? {
              accounting: {
                sourceSessionId: clip(sourceSessionId, 200),
                usageId: clip(usageId, 200),
                sequence,
              },
            }
          : {}),
        ...(apiCallId ? { apiCallId: clip(apiCallId, 200) } : {}),
        ...(sdkEventId ? { sdkEventId: clip(sdkEventId, 200) } : {}),
        ...(fusionId
          ? {
              fusion: {
                fusionId: clip(fusionId, 200),
                ...(phaseId ? { phaseId: clip(phaseId, 200) } : {}),
                ...(sourceModel ? { sourceModel: clip(sourceModel, 100) } : {}),
              },
            }
          : {}),
        initiator: text(data.initiator),
        inputTokens: count(data.inputTokens),
        outputTokens: count(data.outputTokens),
        cacheReadTokens: count(data.cacheReadTokens),
        cacheWriteTokens: count(data.cacheWriteTokens),
        durationMs: typeof data.duration === 'number' ? Math.round(data.duration) : null,
      };
    }
    // Estes totais já incluem os recibos assistant.usage; não são chamadas adicionais.
    case 'assistant.fusion_phase_completed':
    case 'session.fusion_turn_completed':
    case 'session.usage_checkpoint':
    case 'session.shutdown':
      return null;
    case 'session.error':
      return { type: 'error', message: safe(data.message, 500) ?? 'Erro do agente.' };
    default:
      return null;
  }
}
