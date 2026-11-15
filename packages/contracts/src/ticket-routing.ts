import { z } from 'zod';
import { flowMatches, type FlowCandidate, type FlowMatchTicket } from './flows.js';
import { isSemanticPolicy, type FlowRoutingPolicy } from './flow-routing-policy.js';

/**
 * P05 — encaminhamento semântico. Cada fluxo pode ter uma política em linguagem natural (com
 * exemplos) que o Copilot usa para escolher entre os candidatos autorizados do projeto. A política
 * faz parte do encaminhamento versionado: só entra em serviço com «Ativar esta versão».
 */

export interface RoutableFlow extends FlowCandidate {
  policy: FlowRoutingPolicy | null;
}

/**
 * Plano de seleção, puro e determinístico, sobre os fluxos ATIVOS (já filtrados de alertas):
 * - sem regra coincidente → fluxo por omissão;
 * - o primeiro fluxo coincidente (por prioridade) sem política semântica → escolha direta
 *   (comportamento anterior ao P05, preservado);
 * - caso contrário, os fluxos semânticos coincidentes antes do primeiro não semântico são os
 *   candidatos e esse não semântico (ou o fluxo por omissão) é o fallback configurado.
 * Um único candidato sem fallback é escolhido diretamente: não há alternativa a decidir.
 */
export type FlowSelectionPlan<T extends RoutableFlow> =
  { kind: 'direct'; flow: T | null } | { kind: 'classify'; candidates: T[]; fallback: T | null };

export function planFlowSelection<T extends RoutableFlow>(
  flows: T[],
  ticket: FlowMatchTicket,
): FlowSelectionPlan<T> {
  const matching = flows
    .filter((flow) => !flow.isDefault && flowMatches(flow.match, ticket))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  const fallbackDefault = flows.find((flow) => flow.isDefault) ?? null;
  const top = matching[0];
  if (!top) return { kind: 'direct', flow: fallbackDefault };
  if (!isSemanticPolicy(top.policy)) return { kind: 'direct', flow: top };
  const firstPlain = matching.findIndex((flow) => !isSemanticPolicy(flow.policy));
  const candidates = firstPlain < 0 ? matching : matching.slice(0, firstPlain);
  const fallback = firstPlain < 0 ? fallbackDefault : matching[firstPlain]!;
  if (candidates.length === 1 && !fallback) return { kind: 'direct', flow: candidates[0]! };
  return { kind: 'classify', candidates, fallback };
}

// ---------------------------------------------------------------------------------------------
// Resposta do classificador (validada no backend; a confiança declarada é ignorada).

export const ROUTING_QUESTION_LIMIT = 1000;
export const ROUTING_MAX_QUESTIONS = 2;

const routingReplySchema = z.object({
  decision: z.enum(['choose', 'clarify', 'none']),
  candidate: z.string().trim().max(10).nullish(),
  reason: z.string().trim().min(1).max(600),
  alternatives: z.array(z.string().trim().max(10)).max(20).default([]),
  question: z.string().trim().max(ROUTING_QUESTION_LIMIT).nullish(),
});

export interface RoutingDecision {
  decision: 'choose' | 'clarify' | 'none';
  candidate: string | null;
  reason: string;
  alternatives: string[];
  question: string | null;
}

export class RoutingReplyError extends Error {}

/**
 * Valida o texto devolvido pelo Copilot. Recusa identificadores fora do conjunto fixado (o
 * modelo não pode inventar fluxos), escolhas sem candidato e esclarecimentos sem pergunta.
 */
export function parseRoutingDecision(
  text: string,
  keys: readonly string[],
  internalNames: readonly string[] = [],
): RoutingDecision {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new RoutingReplyError('Resposta sem JSON.');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new RoutingReplyError('JSON inválido.');
  }
  const parsed = routingReplySchema.safeParse(raw);
  if (!parsed.success) throw new RoutingReplyError('Formato da decisão inválido.');
  const reply = parsed.data;
  const known = new Set(keys);
  const candidate = reply.candidate?.trim() || null;
  if (reply.decision === 'choose' && (!candidate || !known.has(candidate)))
    throw new RoutingReplyError('Candidato desconhecido.');
  if (reply.alternatives.some((item) => !known.has(item)))
    throw new RoutingReplyError('Alternativa desconhecida.');
  const question = reply.question?.trim() || null;
  if (reply.decision === 'clarify' && (!question || question.length < 10))
    throw new RoutingReplyError('Esclarecimento sem pergunta.');
  if (reply.decision === 'clarify' && question && exposesInternals(question, keys, internalNames))
    throw new RoutingReplyError('A pergunta pública expõe identificadores internos.');
  return {
    decision: reply.decision,
    candidate: reply.decision === 'choose' ? candidate : null,
    reason: reply.reason,
    alternatives: [...new Set(reply.alternatives)].filter((item) => item !== candidate),
    question: reply.decision === 'clarify' ? question : null,
  };
}

/**
 * A pergunta vai para o cliente: não pode citar chaves internas (C1, F) nem nomes de fluxos.
 * Nomes de uma só palavra (ex.: «Consulta») só contam quando citados, por serem linguagem comum.
 */
function exposesInternals(
  question: string,
  keys: readonly string[],
  internalNames: readonly string[],
): boolean {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    keys.some((key) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escape(key)}(?![\\p{L}\\p{N}])`, 'u').test(question),
    )
  )
    return true;
  const lower = question.toLocaleLowerCase('pt');
  return internalNames.some((raw) => {
    const name = raw.trim().toLocaleLowerCase('pt');
    if (name.length < 3) return false;
    if (/\s/.test(name)) return lower.includes(name);
    return ['«»', '""', '“”', "''"].some(([open, close]) =>
      lower.includes(`${open}${name}${close}`),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Vista do encaminhamento de um ticket (só equipa; o cliente vê apenas a pergunta pública).

export const ticketRoutingStatuses = [
  'classifying',
  'awaiting_reply',
  'pending_manual',
  'routed',
  'cancelled',
] as const;
export type TicketRoutingStatus = (typeof ticketRoutingStatuses)[number];

export interface TicketRoutingCandidateView {
  key: string;
  flowId: string;
  versionId: string;
  versionNumber: number;
  name: string;
  priority: number;
  instructions: string;
  fallback: boolean;
}

export interface TicketRoutingEventView {
  kind: string;
  actor: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TicketRoutingView {
  status: TicketRoutingStatus;
  policyHash: string;
  candidates: TicketRoutingCandidateView[];
  questionsAsked: number;
  pendingQuestion: { text: string; askedAt: string; replyDueAt: string | null } | null;
  lastDecision: RoutingDecision | null;
  resolution: string | null;
  reason: string | null;
  chosen: { flowId: string; versionId: string; name: string; versionNumber: number } | null;
  routedAt: string | null;
  routedBy: string | null;
  job: { status: string; attempt: number; errorCode: string | null } | null;
  /** O ator pode escolher manualmente entre os candidatos fixados. */
  canRoute: boolean;
  events: TicketRoutingEventView[];
}

export const manualRouteInputSchema = z.strictObject({
  versionId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
});
export type ManualRouteInput = z.infer<typeof manualRouteInputSchema>;
