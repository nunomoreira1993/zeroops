import type { FlowDefinition, FlowNode, FlowStepOutput } from '../../../../contracts/src/index.js';
import type { Queryable } from '../identity/membership.js';
import { closeHealthIncident } from '../health/health-incident-lifecycle.js';
import { appendAutomatedComment } from '../tickets/ticket-comments.js';
import { deliverAction } from './flow-deliver-action.js';

export interface FlowActionContext {
  client: Queryable;
  ticket: { id: string; projectId: string; createdBy: string; origin: string };
  node: FlowNode;
  step: { id: string; attempt: number; startedAt: Date };
  /** Execução real do motor (ausente no simulador: ações que dependem dela ficam indisponíveis). */
  execution?: { id: string; definition: FlowDefinition };
  /** Último resultado do Copilot nesta execução (resumo, resposta proposta e diff). */
  previous: { summary: string | null; replyDraft: string | null; patch: string | null };
  now: Date;
  /**
   * Efeitos externos das ações portáveis. O motor usa a base de dados; o simulador regista-os sem
   * os executar e o ensaio isolado entrega-os num destino de teste (P07).
   */
  effects: FlowActionEffects;
}

/** Efeitos de que dependem as ações portáveis (as mesmas regras correm no motor e no simulador). */
export interface FlowActionEffects {
  comment(visibility: 'public' | 'internal', body: string): Promise<void>;
  /** Estado do incidente da Saúde do ticket (`null` = sem incidente). */
  healthIncidentState(): Promise<string | null>;
  closeHealthIncident(): Promise<void>;
}

/** Efeitos reais sobre o ticket (comentários, incidente da Saúde). */
export function databaseActionEffects(
  client: Queryable,
  ticket: FlowActionContext['ticket'],
): FlowActionEffects {
  return {
    comment: (visibility, body) =>
      appendAutomatedComment(client, {
        ticketId: ticket.id,
        projectId: ticket.projectId,
        authorId: ticket.createdBy,
        visibility,
        body,
        authorKind: 'system',
      }).then(() => undefined),
    healthIncidentState: async () =>
      (
        await client.query<{ state: string }>(
          'SELECT state FROM health_incidents WHERE ticket_id=$1 FOR UPDATE',
          [ticket.id],
        )
      ).rows[0]?.state ?? null,
    closeHealthIncident: () => closeHealthIncident(client, ticket.id).then(() => undefined),
  };
}

/**
 * Segue por uma porta, ou espera e volta a ser avaliada em `wait` (verificações com prazo). O
 * `feedback` acompanha a porta até à etapa seguinte (ex.: conflito de integração → desenvolvimento).
 */
export type FlowActionResult =
  | {
      port: string;
      output?: FlowStepOutput;
      feedback?: { comment: string; actor: string | null; evidence?: string | null };
    }
  | { wait: Date; output?: FlowStepOutput };

export type FlowActionExecutor = (context: FlowActionContext) => Promise<FlowActionResult>;

/**
 * Executores por chave de ação. Uma ação nova acrescenta aqui o executor e no catálogo dos
 * contratos a descrição; as definições já publicadas não mudam.
 */
export type FlowActionRegistry = Readonly<Record<string, FlowActionExecutor>>;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const clientMessage: FlowActionExecutor = async (context) => {
  const fallback = text(context.node.config.body);
  const body =
    context.node.config.source === 'previous_reply'
      ? context.previous.replyDraft?.trim() || fallback
      : fallback;
  await context.effects.comment('public', body);
  return { port: 'done', output: { clientMessage: body } };
};

const internalNote: FlowActionExecutor = async (context) => {
  const fallback = text(context.node.config.body);
  const summary = context.previous.summary?.trim();
  const body =
    context.node.config.source === 'previous_summary' && summary
      ? `${fallback}\n\n${summary}`
      : fallback;
  await context.effects.comment('internal', body);
  return { port: 'done', output: { note: body } };
};

/**
 * Aplica no ambiente a correção preparada pelo Copilot. O diff e a evidência já ficaram no ticket
 * (cópia temporária); sem integração de aplicação, regista o que ficou por aplicar e segue por
 * «unavailable».
 */
const healthRemediation: FlowActionExecutor = async (context) => {
  const procedure = text(context.node.config.procedure);
  const prepared = context.previous.patch?.trim()
    ? 'O Copilot preparou a correção numa cópia temporária; o diff e a evidência estão no ticket.'
    : 'O Copilot não produziu alterações de ficheiros.';
  const external = `${prepared} Não foi aplicada no ambiente: falta configurar a integração de aplicação de correções do projeto.${procedure ? ` Correção prevista: ${procedure}` : ''}`;
  return { port: 'unavailable', output: { external } };
};

/** Prazo para o incidente da Saúde aparecer depois da criação do ticket (é gravado a seguir). */
const INCIDENT_GRACE_MS = 2 * 60_000;

const verifyHealthRecovery: FlowActionExecutor = async (context) => {
  const minutes = Number(context.node.config.timeoutMinutes);
  const timeoutMs =
    (Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 1440) : 30) * 60_000;
  const elapsed = context.now.getTime() - context.step.startedAt.getTime();
  const state = await context.effects.healthIncidentState();
  if (state === null) {
    if (context.ticket.origin === 'health' && elapsed < INCIDENT_GRACE_MS)
      return { wait: new Date(context.now.getTime() + 30_000) };
    return {
      port: 'unknown',
      output: { reason: 'Sem incidente da Saúde associado: não foi possível verificar.' },
    };
  }
  if (state !== 'open') {
    await context.effects.closeHealthIncident();
    return { port: 'passed', output: { summary: 'Os alertas do incidente recuperaram.' } };
  }
  if (elapsed >= timeoutMs)
    return {
      port: 'failed',
      output: {
        reason: `Os alertas continuam ativos ${Math.round(timeoutMs / 60_000)} minutos depois da correção.`,
      },
    };
  return {
    wait: new Date(
      Math.min(context.now.getTime() + 60_000, context.step.startedAt.getTime() + timeoutMs),
    ),
  };
};

/** Sem integração de deploy: a publicação é manual e fica à espera da confirmação do responsável. */
const deploy: FlowActionExecutor = async (context) => ({
  port: 'manual',
  output: {
    external: `Publicação manual em ${text(context.node.config.environment) || 'production'}: não há integração de deploy configurada.`,
  },
});

/**
 * Ações cujos efeitos passam todos por effects (sem acesso direto à base de dados): o simulador e
 * o ensaio isolado executam o mesmo código do motor. As restantes precisam de resultado no cenário.
 */
export const PORTABLE_FLOW_ACTIONS: ReadonlySet<string> = new Set([
  'client_message',
  'internal_note',
  'health_remediation',
  'verify_health_recovery',
  'deploy',
]);

/** Executores por omissão (integrações externas ausentes seguem pelas portas de recurso). */
export const defaultFlowActions: FlowActionRegistry = {
  client_message: clientMessage,
  internal_note: internalNote,
  health_remediation: healthRemediation,
  verify_health_recovery: verifyHealthRecovery,
  deploy,
  deliver: deliverAction,
};
