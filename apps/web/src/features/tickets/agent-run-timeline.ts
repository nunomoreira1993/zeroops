import {
  emptyUsage,
  quotaSnapshot,
  UsageAccumulator,
  type AgentMcpServer,
  type AgentQuestion,
  type AgentQuota,
  type AgentRunEvent,
  type AgentUsage,
} from '@zeroops/contracts';

export interface ToolPermission {
  kind: string;
  decision: 'approved' | 'denied';
  detail: string;
}

export type ToolStep = {
  kind: 'tool';
  key: string;
  tool: string;
  title: string | null;
  server: string | null;
  arguments: string | null;
  state: 'running' | 'succeeded' | 'failed';
  result: string | null;
  permission: ToolPermission | null;
};

/** Passo técnico do agente: intenção, ferramenta (com a permissão associada) ou permissão solta. */
export type StepItem =
  | { kind: 'status'; key: string; text: string }
  | ToolStep
  | { kind: 'permission'; key: string; permission: ToolPermission };

export type TimelineItem =
  | StepItem
  | { kind: 'steps'; key: string; steps: StepItem[] }
  | { kind: 'assistant'; key: string; text: string; streaming: boolean }
  | {
      kind: 'question';
      key: string;
      question: AgentQuestion;
      answer: string | null;
      author: string | null;
    }
  | { kind: 'user'; key: string; text: string; author: string }
  | { kind: 'usage'; key: string; usage: AgentUsage }
  | { kind: 'error'; key: string; text: string };

export interface AgentTimeline {
  items: TimelineItem[];
  servers: AgentMcpServer[];
  pendingQuestion: AgentQuestion | null;
  /** Consumo total dos eventos recebidos (null se o run não registou uso). */
  usage: AgentUsage | null;
  quota: AgentQuota | null;
}

/** Soma o consumo de vários runs (ex.: total do ticket). */
export function sumUsage(list: readonly (AgentUsage | null)[]): AgentUsage | null {
  const present = list.filter((usage): usage is AgentUsage => !!usage);
  if (!present.length) return null;
  const total = emptyUsage();
  const modelUsage = new Map<string, NonNullable<AgentUsage['modelUsage']>[number]>();
  const units = new Set<NonNullable<AgentUsage['costUnit']>>();
  let known = 0;
  let complete = present.length === list.length;
  let creditsComplete = present.length === list.length;
  for (const usage of present) {
    const reported = usage.costStatus === 'complete' || usage.costStatus === 'partial';
    if (
      reported &&
      (usage.costUnit === 'premium_requests' ||
        (usage.costStatus === 'partial' && usage.costUnit === null))
    )
      total.premiumRequests += usage.premiumRequests;
    if (reported && typeof usage.aiCredits === 'number' && Number.isFinite(usage.aiCredits)) {
      total.aiCredits = (total.aiCredits ?? 0) + usage.aiCredits;
      units.add('ai_credits');
    }
    if (reported && usage.costUnit) units.add(usage.costUnit);
    if (reported && usage.costUnit === null && usage.premiumRequests > 0)
      units.add('premium_requests');
    if (
      reported &&
      (usage.costUnit || typeof usage.aiCredits === 'number' || usage.premiumRequests > 0)
    )
      known++;
    if (usage.costStatus !== 'complete') complete = false;
    if (usage.aiCreditsStatus !== 'complete') creditsComplete = false;
    total.modelCalls += usage.modelCalls;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    for (const model of usage.models) if (!total.models.includes(model)) total.models.push(model);
    for (const entry of usage.modelUsage ?? []) {
      const current = modelUsage.get(entry.model);
      if (!current) {
        modelUsage.set(entry.model, { ...entry });
        continue;
      }
      const aiCredits =
        typeof current.aiCredits === 'number' || typeof entry.aiCredits === 'number'
          ? (current.aiCredits ?? 0) + (entry.aiCredits ?? 0)
          : null;
      modelUsage.set(entry.model, {
        model: entry.model,
        modelCalls: current.modelCalls + entry.modelCalls,
        inputTokens: current.inputTokens + entry.inputTokens,
        outputTokens: current.outputTokens + entry.outputTokens,
        cacheReadTokens: current.cacheReadTokens + entry.cacheReadTokens,
        cacheWriteTokens: (current.cacheWriteTokens ?? 0) + (entry.cacheWriteTokens ?? 0),
        aiCredits,
        aiCreditsStatus:
          aiCredits === null
            ? 'unavailable'
            : current.aiCreditsStatus === 'complete' && entry.aiCreditsStatus === 'complete'
              ? 'complete'
              : 'partial',
      });
    }
  }
  total.costUnit = units.size === 1 ? [...units][0]! : null;
  total.costStatus = known
    ? complete && units.size === 1
      ? 'complete'
      : 'partial'
    : present.every((usage) => usage.costStatus === 'legacy' || usage.costStatus === undefined)
      ? 'legacy'
      : 'unavailable';
  total.aiCreditsStatus =
    total.aiCredits === null || total.aiCredits === undefined
      ? 'unavailable'
      : creditsComplete
        ? 'complete'
        : 'partial';
  total.modelUsage = [...modelUsage.values()];
  return total;
}

/** Ambiente consultado por uma ferramenta, a partir dos argumentos (`--env production`). */
export function toolEnvironment(args: string | null): 'production' | 'quality' | null {
  if (!args) return null;
  if (/--env[\s="'\\]+(production|prod)\b|"environment"\s*:\s*"production"/i.test(args))
    return 'production';
  if (/--env[\s="'\\]+(quality|qa)\b|"environment"\s*:\s*"quality"/i.test(args)) return 'quality';
  return null;
}

/** Comando ou descrição principal de uma ferramenta, a partir dos argumentos em JSON. */
export function parseToolArguments(args: string | null): Record<string, unknown> | null {
  if (!args) return null;
  try {
    const value: unknown = JSON.parse(args);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toolCommand(step: ToolStep): string | null {
  const command = parseToolArguments(step.arguments)?.command;
  return typeof command === 'string' ? command : null;
}

const isStep = (item: TimelineItem): item is StepItem =>
  item.kind === 'status' || item.kind === 'tool' || item.kind === 'permission';

/**
 * Junta passos técnicos consecutivos num bloco recolhível (como no VS Code). Um bloco só com
 * mensagens de estado continua visível como linhas simples.
 */
function groupSteps(items: TimelineItem[]): TimelineItem[] {
  const grouped: TimelineItem[] = [];
  let run: StepItem[] = [];
  const close = () => {
    const first = run[0];
    if (!first) return;
    if (run.some((step) => step.kind !== 'status'))
      grouped.push({ kind: 'steps', key: `steps-${first.key}`, steps: run });
    else grouped.push(...run);
    run = [];
  };
  for (const item of items) {
    if (isStep(item)) run.push(item);
    else {
      close();
      grouped.push(item);
    }
  }
  close();
  return grouped;
}

/**
 * Reconstrói a conversa ao vivo a partir dos eventos ordenados: junta os deltas por mensagem,
 * associa o fim e a permissão de cada ferramenta ao início, as respostas às perguntas, agrupa os
 * passos técnicos e soma o consumo do modelo por turno (cada mensagem da equipa abre um turno).
 */
export function buildTimeline(events: readonly AgentRunEvent[]): AgentTimeline {
  const items: TimelineItem[] = [];
  const messages = new Map<string, Extract<TimelineItem, { kind: 'assistant' }>>();
  const tools = new Map<string, ToolStep>();
  const permissions = new Map<string, ToolPermission>();
  const questions = new Map<string, Extract<TimelineItem, { kind: 'question' }>>();
  const servers = new Map<string, AgentMcpServer>();
  let total: AgentUsage | null = null;
  let turn: AgentUsage | null = null;
  let quota: AgentQuota | null = null;
  const accumulator = new UsageAccumulator();
  const closeTurn = (key: string) => {
    if (turn) items.push({ kind: 'usage', key: `usage-${key}`, usage: turn });
    turn = null;
  };

  for (const event of events) {
    const key = String(event.id);
    switch (event.type) {
      case 'status':
        items.push({ kind: 'status', key, text: event.text });
        break;
      case 'assistant.delta':
      case 'assistant.message': {
        const current = messages.get(event.messageId);
        const final = event.type === 'assistant.message';
        if (current) {
          current.text = final ? event.text : current.text + event.text;
          current.streaming = !final;
        } else {
          const item = { kind: 'assistant' as const, key, text: event.text, streaming: !final };
          messages.set(event.messageId, item);
          items.push(item);
        }
        break;
      }
      case 'tool.start': {
        const item: ToolStep = {
          kind: 'tool',
          key,
          tool: event.tool,
          title: event.title,
          server: event.server,
          arguments: event.arguments,
          state: 'running',
          result: null,
          permission: permissions.get(event.toolCallId) ?? null,
        };
        tools.set(event.toolCallId, item);
        items.push(item);
        break;
      }
      case 'tool.complete': {
        const item = tools.get(event.toolCallId);
        if (item) {
          item.state = event.success ? 'succeeded' : 'failed';
          item.result = event.success ? event.result : (event.error ?? event.result);
        }
        break;
      }
      case 'permission': {
        const permission = { kind: event.kind, decision: event.decision, detail: event.detail };
        const tool = event.toolCallId
          ? tools.get(event.toolCallId)
          : [...tools.values()]
              .reverse()
              .find((step) => !step.permission && toolCommand(step) === event.detail);
        if (tool) tool.permission = permission;
        else if (event.toolCallId && event.decision === 'approved')
          permissions.set(event.toolCallId, permission);
        else items.push({ kind: 'permission', key, permission });
        break;
      }
      case 'mcp.servers':
        servers.clear();
        for (const server of event.servers) servers.set(server.name, server);
        break;
      case 'mcp.status':
        servers.set(event.server, {
          name: event.server,
          status: event.status,
          ...(event.error ? { error: event.error } : {}),
        });
        break;
      case 'question': {
        const question: AgentQuestion = {
          questionId: event.questionId,
          kind: event.kind,
          question: event.question,
          choices: event.choices,
          allowFreeform: event.allowFreeform,
        };
        const item = { kind: 'question' as const, key, question, answer: null, author: null };
        questions.set(event.questionId, item);
        items.push(item);
        break;
      }
      case 'answer': {
        const item = questions.get(event.questionId);
        if (item) {
          item.answer = event.answer;
          item.author = event.author;
        }
        break;
      }
      case 'user.message':
        closeTurn(key);
        accumulator.userRequest();
        items.push({ kind: 'user', key, text: event.text, author: event.author });
        break;
      case 'usage':
        turn ??= emptyUsage();
        total ??= emptyUsage();
        accumulator.add(event, turn, total);
        break;
      case 'quota':
        quota = quotaSnapshot(event);
        break;
      case 'error':
        items.push({ kind: 'error', key, text: event.message });
        break;
    }
  }
  closeTurn('end');

  const open = [...questions.values()].filter((item) => item.answer === null);
  return {
    items: groupSteps(items),
    servers: [...servers.values()],
    pendingQuestion: open.at(-1)?.question ?? null,
    usage: total,
    quota,
  };
}
