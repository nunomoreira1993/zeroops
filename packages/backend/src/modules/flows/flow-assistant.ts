import { ticketWorkPaused } from '../tickets/ticket-purge-health.js';
import {
  applyFlowOperations,
  decisionOptions,
  FLOW_AUTHORING_BATCH_LIMIT,
  flowActionCatalog,
  flowAssistantResponseSchema,
  flowDefinitionSchema,
  nodePorts,
  parseRoutingPolicy,
  portLabel,
  type FlowAssistantResponse,
  type FlowAuthoringEventType,
  type FlowAuthoringMode,
  type FlowAuthoringToolResult,
  type FlowDefinition,
  type FlowPatchOperation,
  type FlowStepOutput,
} from '../../../../contracts/src/index.js';
import { FlowAuthoringTools, recordAuthoringEvent } from './flow-authoring.js';
import type { Database } from '../../database/database.js';
import type { Queryable } from '../identity/membership.js';
import { requireProjectPermission } from '../identity/project-permissions.js';
import { toUser, type UserRow } from '../identity/identity.rows.js';
import { DomainError } from '../../errors.js';
import { parseDefinition, parseMatch } from './flow-store.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  LOCAL_WORKER,
  OWNED_BY,
  recordJobEvent,
  validateWorker,
  type FencedOutcome,
  type HeartbeatState,
  type JobEventType,
  type JobLease,
  type WorkerIdentity,
} from '../agents/job-leases.js';

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** Pedido reclamado pelo executor: o prompt já inclui o fluxo/ticket e o formato da resposta. */
export interface ClaimedAssistantRequest {
  id: string;
  projectId: string;
  /** `routing`: classificação do encaminhamento de um ticket (P05); `simulation`: avaliação P07. */
  scope: 'flow' | 'ticket' | 'routing' | 'simulation';
  prompt: string;
  /** Posse do pedido; obrigatória para concluir, falhar ou renovar. */
  lease: JobLease;
  /** P06: turno de construção — o executor expõe as ferramentas de autoria ao Copilot. */
  authoring?: { mode: FlowAuthoringMode };
}

/** Ferramentas de autoria expostas ao Copilot (nomes estáveis; ver `FlowAuthoringTools`). */
export const flowAuthoringToolNames = [
  'flow_get_draft',
  'flow_apply_operations',
  'flow_set_routing',
  'flow_report_missing_capability',
] as const;
export type FlowAuthoringToolName = (typeof flowAuthoringToolNames)[number];

interface RequestRow {
  id: string;
  project_id: string;
  scope: 'flow' | 'ticket';
  flow_id: string | null;
  ticket_id: string | null;
  requested_by: string;
  message: string;
  base_draft_version: number | null;
  attempt?: number;
  session_id?: string | null;
  authoring_mode?: FlowAuthoringMode | null;
  known_revision?: number | null;
}

const AUTHORING_REPLY = `Quando terminares, responde com um único objeto JSON (sem markdown):
{"reply": "resumo curto em português de Portugal do que fizeste/propuseste e do que falta", "question": null ou UMA pergunta concreta quando falta informação que muda o fluxo}.
Não incluas operações nesta resposta: só contam as que passaram pelas ferramentas.`;

async function catalogForPrompt(client: Queryable, projectId: string) {
  const profiles = await client.query<{ id: string; name: string; current_version: number }>(
    `SELECT id,name,current_version FROM zeroops_agent_profiles
      WHERE project_id=$1 AND archived_at IS NULL ORDER BY name LIMIT 30`,
    [projectId],
  );
  const skills = await client.query<{
    id: string;
    name: string;
    current_version: number;
    description: string | null;
  }>(
    `SELECT s.id,s.name,s.current_version,v.description FROM zeroops_skills s
       LEFT JOIN zeroops_skill_versions v ON v.skill_id=s.id AND v.version=s.current_version
      WHERE s.project_id=$1 AND s.archived_at IS NULL ORDER BY s.name LIMIT 30`,
    [projectId],
  );
  return [
    `Perfis de agente deste projeto (agentProfileId, versão atual, nome):\n${profiles.rows.map((p) => `${p.id} v${p.current_version} ${p.name}`).join('\n') || '(nenhum)'}`,
    `Skills deste projeto (skillId, versão atual, nome — descrição):\n${skills.rows.map((s) => `${s.id} v${s.current_version} ${s.name} — ${clip(s.description ?? '', 160)}`).join('\n') || '(nenhuma)'}`,
    'Numa etapa copilot_task, config.agentProfileId+agentProfileVersion escolhem o especialista, config.skills=[{skillId,version}] (exige perfil) e config.delegates=[{profileId,version}] os subagentes. Só podes usar ids desta lista.',
  ].join('\n\n');
}

/**
 * Prompt de um turno de construção (P06). O rascunho é lido e alterado SÓ pelas ferramentas;
 * o modelo não tem caminho para ativar, mudar permissões, prioridade ou «por omissão».
 */
async function authoringPrompt(client: Queryable, request: RequestRow) {
  const flow = (
    await client.query<{
      name: string;
      flow_definition: unknown;
      draft_version: number;
      flow_match: unknown;
      routing_policy: unknown;
    }>(
      'SELECT name,flow_definition,draft_version,flow_match,routing_policy FROM flows WHERE id=$1',
      [request.flow_id],
    )
  ).rows[0];
  if (!flow) throw new Error('Fluxo inexistente.');
  const team = await members(client, request.project_id);
  const previous = await history(client, request);
  const done = await client.query<{ status: string; summary: string; operations: unknown }>(
    `SELECT status,summary,operations FROM flow_authoring_operations
      WHERE request_id=$1 AND status IN ('applied','proposed') ORDER BY created_at,id`,
    [request.id],
  );
  const mode = request.authoring_mode ?? 'assisted';
  return [
    'És o assistente de construção de fluxos de resolução de tickets do ZeroOps. Constróis o RASCUNHO do fluxo, passo a passo, com as ferramentas disponíveis.',
    'Regras:',
    '- Alteras o rascunho apenas com flow_apply_operations (etapas/ligações/configuração) e flow_set_routing (regras de seleção/encaminhamento). Texto livre não altera nada.',
    '- Trabalha de forma incremental: lotes pequenos (uma a três etapas com as respetivas ligações por chamada), para o utilizador ver o fluxo a crescer. Cada lote é atómico; um lote inválido é rejeitado sem alterar nada — corrige e tenta de novo.',
    '- Se uma ferramenta indicar que o rascunho mudou (conflito), chama flow_get_draft e reformula sobre o estado atual. Nunca desfaças alterações manuais de outras pessoas.',
    '- Não ativas o fluxo, não alteras permissões, prioridade nem o fluxo «por omissão»: isso é feito por pessoas na interface.',
    '- Quando o pedido exige uma ferramenta, integração, agente ou skill que não existe neste projeto, chama flow_report_missing_capability e explica o bloqueio. Não inventes ações, ids nem capacidades.',
    '- Se faltar informação que muda o fluxo (ex.: quem aprova), pergunta antes de inventar.',
    mode === 'auto'
      ? 'Modo: construção automática — as operações válidas são aplicadas ao rascunho de imediato.'
      : 'Modo: assistido — as operações ficam propostas e o utilizador aceita ou descarta no fim. Cada lote é validado sobre o rascunho mais as tuas propostas anteriores deste turno.',
    `Fluxo: «${flow.name}». Revisão do rascunho: ${Number(flow.draft_version)}. Definição atual (sem posições):\n${definitionForPrompt(parseDefinition(flow.flow_definition))}`,
    `Regras de seleção atuais do rascunho: ${JSON.stringify({ match: parseMatch(flow.flow_match), routingPolicy: parseRoutingPolicy(flow.routing_policy) })}`,
    `Membros ativos do projeto (id, nome, papel):\n${team.map((m) => `${m.id} ${m.display_name} (${m.role})`).join('\n') || '(nenhum)'}`,
    await catalogForPrompt(client, request.project_id),
    OPERATIONS_HELP,
    done.rows.length
      ? `Já feito numa tentativa anterior deste mesmo pedido (não repitas):\n${done.rows.map((row) => `- ${row.status}: ${row.summary || JSON.stringify(row.operations).slice(0, 300)}`).join('\n')}`
      : '',
    previous ? `Conversa anterior:\n${previous}` : '',
    `Pedido: ${request.message}`,
    AUTHORING_REPLY,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Resposta final de um turno de autoria (aceita texto à volta e ignora operações em texto). */
export function parseAuthoringReply(text: string): { reply: string; question: string | null } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start)
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as {
        reply?: unknown;
        question?: unknown;
      };
      return {
        reply: clip(typeof value.reply === 'string' ? value.reply.trim() : '', 4000),
        question:
          typeof value.question === 'string' && value.question.trim()
            ? clip(value.question.trim(), 500)
            : null,
      };
    } catch {
      // texto livre: usado como resposta, sem efeitos
    }
  return { reply: clip(text.trim(), 4000), question: null };
}

const RESPONSE_FORMAT = `
A tua resposta é um único objeto JSON (sem markdown) com:
- "reply": explicação curta em português de Portugal do que propões ou da resposta;
- "question": null, ou UMA pergunta concreta quando falta informação que altera a execução (ex.: "Quem deve aprovar neste projeto?"). Se perguntares, não inventes o valor em falta;
- "operations": lista de operações parciais (vazia se não houver alterações);
- "transition": null, ou {"stepId","port","comment"} para aplicar uma saída da etapa atual do ticket.`;

const OPERATIONS_HELP = `Operações (alteram só a parte relevante; não reescrevas o fluxo):
- {"type":"add_node","node":{id,op,label,assignee?,instructions?,config}}
- {"type":"update_node","id","changes":{label?,assignee?,instructions?,ticketStatus?,config?}} (config é fundida)
- {"type":"remove_node","id"}
- {"type":"connect","source","port","target"} (substitui a ligação existente dessa saída)
- {"type":"disconnect","source","port"}
- {"type":"set_start","id"}
Ids: minúsculas, números, _ ou -. A ordem de execução é dada apenas pelas ligações (não pela posição).
Cada etapa (exceto "end") tem exatamente duas saídas: "success" e "failure". O motivo detalhado (ex.: forbidden, manual) fica guardado na etapa, sem setas extra.
Operações (op):
- "copilot_task": config.mode "analysis", "develop" (proposta de alteração em diff) ou "report". Quando a análise pergunta algo ao cliente, a etapa espera pela resposta e repete-se sozinha; config.askClient=false impede perguntas ao cliente.
- "human_decision": assignee {"kind":"role","role":"technical|qa|release|admin|client"} | {"kind":"user","userId"} | {"kind":"ticket_author"} | {"kind":"team"}; config.options exatamente [{port:"success",label,…},{port:"failure",label,requiresComment?,commentVisibility?:"internal"|"public"}]. config.onlyWhen (opcional) = resultados da etapa anterior que exigem a decisão (ex.: ["needs_approval"]); nos outros casos segue sozinha por "success".
- "action": config.action uma de: ${Object.values(flowActionCatalog)
  .map(
    (action) => `${action.key} (resultados ${action.results.join('/')}; ${action.description.pt})`,
  )
  .join('; ')}.
- "end": config.outcome "resolved" | "cancelled" | "escalated".
Para enviar comentários de uma decisão ao Copilot, liga a opção (com requiresComment) à etapa copilot_task: o motor passa o comentário e a evidência como entrada dessa etapa.`;

function definitionForPrompt(definition: FlowDefinition) {
  return JSON.stringify({
    start: definition.start,
    nodes: definition.nodes,
    edges: definition.edges.map(({ source, port, target }) => ({ source, port, target })),
  });
}

async function members(client: Queryable, projectId: string) {
  return (
    await client.query<{ id: string; display_name: string; role: string }>(
      `SELECT u.id,u.display_name,m.role FROM project_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.project_id=$1 AND NOT m.disabled AND NOT u.disabled ORDER BY m.role,u.display_name LIMIT 60`,
      [projectId],
    )
  ).rows;
}

async function history(client: Queryable, request: RequestRow) {
  const column = request.scope === 'flow' ? 'flow_id' : 'ticket_id';
  const rows = await client.query<{
    message: string;
    assistant_response: unknown;
    resolution: string;
  }>(
    `SELECT message,assistant_response,resolution FROM flow_assistant_requests
      WHERE ${column}=$1 AND scope=$2 AND id<>$3 AND status='succeeded'
      ORDER BY created_at DESC LIMIT 6`,
    [request.scope === 'flow' ? request.flow_id : request.ticket_id, request.scope, request.id],
  );
  return rows.rows
    .reverse()
    .map((row) => {
      const response = flowAssistantResponseSchema.safeParse(row.assistant_response);
      const reply = response.success
        ? [response.data.reply, response.data.question].filter(Boolean).join(' ')
        : '';
      return `Utilizador: ${clip(row.message, 600)}\nAssistente (${row.resolution}): ${clip(reply, 600)}`;
    })
    .join('\n\n');
}

async function flowPrompt(client: Queryable, request: RequestRow) {
  const flow = (
    await client.query<{ name: string; flow_definition: unknown }>(
      'SELECT name,flow_definition FROM flows WHERE id=$1',
      [request.flow_id],
    )
  ).rows[0];
  if (!flow) throw new Error('Fluxo inexistente.');
  const team = await members(client, request.project_id);
  const previous = await history(client, request);
  return [
    'És o assistente de fluxos de resolução de tickets do ZeroOps. Alteras um fluxo por conversa.',
    'Não executes comandos nem consultes ficheiros: responde só com base neste contexto.',
    `Fluxo: «${flow.name}». Definição atual (rascunho):\n${definitionForPrompt(parseDefinition(flow.flow_definition))}`,
    `Membros ativos do projeto (id, nome, papel):\n${team.map((m) => `${m.id} ${m.display_name} (${m.role})`).join('\n') || '(nenhum)'}`,
    OPERATIONS_HELP,
    'Se um pedido exigir um responsável e houver mais do que uma pessoa possível sem papel óbvio, pergunta quem deve ser (sem operações). Prefere responsáveis por papel quando o pedido fala de um papel ("responsável técnico" = role technical, QA = role qa).',
    previous ? `Conversa anterior:\n${previous}` : '',
    `Pedido: ${request.message}`,
    RESPONSE_FORMAT,
    '"transition" deve ser sempre null neste contexto.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function ticketPrompt(client: Queryable, request: RequestRow) {
  const ticket = (
    await client.query<{
      key: string;
      title: string;
      description: string;
      status: string;
      created_by: string;
    }>('SELECT `key`,title,description,status,created_by FROM tickets WHERE id=$1', [
      request.ticket_id,
    ])
  ).rows[0];
  const execution = (
    await client.query<{
      id: string;
      status: string;
      current_step_id: string | null;
      flow_definition: unknown;
      name: string;
      number: number;
    }>(
      `SELECT e.id,e.status,e.current_step_id,v.flow_definition,f.name,v.number
         FROM flow_executions e JOIN flow_versions v ON v.id=e.version_id JOIN flows f ON f.id=e.flow_id
        WHERE e.ticket_id=$1`,
      [request.ticket_id],
    )
  ).rows[0];
  if (!ticket || !execution) throw new Error('Ticket sem fluxo.');
  const definition = parseDefinition(execution.flow_definition);
  const label = (nodeId: string) => definition.nodes.find((node) => node.id === nodeId);
  const steps = await client.query<{
    id: string;
    node_id: string;
    attempt: number;
    status: string;
    port: string | null;
    step_output: FlowStepOutput | null;
    step_assignee: { label: string } | null;
    actor: string | null;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT s.id,s.node_id,s.attempt,s.status,s.port,s.step_output,s.step_assignee,u.display_name AS actor,
            s.started_at,s.finished_at
       FROM flow_execution_steps s LEFT JOIN users u ON u.id=s.actor_id
      WHERE s.execution_id=$1 ORDER BY s.step_sequence`,
    [execution.id],
  );
  const requester = (
    await client.query<{ display_name: string; role: string }>(
      `SELECT u.display_name,COALESCE(m.role,'') AS role FROM users u
         LEFT JOIN project_memberships m ON m.user_id=u.id AND m.project_id=$2 WHERE u.id=$1`,
      [request.requested_by, request.project_id],
    )
  ).rows[0];
  const lines = steps.rows.map((step) => {
    const node = label(step.node_id);
    const output = step.step_output ?? {};
    const detail = [
      output.summary && `resultado: ${clip(output.summary, 500)}`,
      output.comment && `comentário: ${clip(output.comment, 400)}`,
      output.reason && `motivo: ${clip(output.reason, 300)}`,
      output.external && `integração: ${clip(output.external, 300)}`,
      output.errorCode && `erro: ${output.errorCode}`,
    ]
      .filter(Boolean)
      .join('; ');
    return `- [${step.id}] ${node?.label ?? step.node_id} #${step.attempt} (${step.status}) desde ${step.started_at.toISOString()}${step.finished_at ? ` até ${step.finished_at.toISOString()}` : ''}${step.port ? ` → ${portLabel(node, step.port)}` : ''}${step.actor ? ` por ${step.actor}` : ''}${step.step_assignee ? ` [responsável: ${step.step_assignee.label}]` : ''}${detail ? ` — ${detail}` : ''}`;
  });
  const current = steps.rows.find((step) => step.id === execution.current_step_id);
  const currentNode = current && label(current.node_id);
  const exits =
    currentNode && current?.status === 'waiting'
      ? currentNode.op === 'human_decision'
        ? decisionOptions(currentNode)
            .map(
              (option) =>
                `${option.port} («${option.label}»${option.requiresComment ? ', exige comentário' : ''})`,
            )
            .join(', ')
        : `nenhuma decisão humana (espera ${currentNode.op === 'copilot_task' ? 'pelo Copilot' : 'pelo sistema'}; saídas ${nodePorts(currentNode).join(', ')})`
      : 'nenhuma';
  return [
    'És o assistente do ZeroOps para quem está a resolver um ticket concreto. Responde com base no histórico abaixo, em português de Portugal, de forma objetiva: onde está, porque está parado, quem tem a próxima ação e o que falta.',
    'Não executes comandos nem consultes ficheiros. Não alteres o processo do projeto (operations sempre []): isso faz-se no editor de fluxos.',
    `Ticket ${ticket.key}: ${ticket.title} (estado ${ticket.status})\n${clip(ticket.description, 1500)}`,
    `Fluxo «${execution.name}» versão ${execution.number}, execução ${execution.status}.`,
    `Etapas do fluxo (id: nome → saídas):\n${definition.nodes
      .map(
        (node) =>
          `${node.id}: ${node.label} (${node.op}) → ${definition.edges
            .filter((edge) => edge.source === node.id)
            .map((edge) => `${edge.port}→${edge.target}`)
            .join(', ')}`,
      )
      .join('\n')}`,
    `Histórico (etapas executadas):\n${clip(lines.slice(-60).join('\n'), 14000) || '(vazio)'}`,
    current
      ? `Etapa atual: [${current.id}] ${currentNode?.label ?? current.node_id}. Saídas disponíveis: ${exits}.`
      : 'Sem etapa atual.',
    `Quem pergunta: ${requester?.display_name ?? 'utilizador'} (${requester?.role ?? ''}).`,
    'Se o utilizador pedir uma ação sobre este ticket (ex.: "devolve ao desenvolvimento com este comentário"), indica em "transition" o stepId da etapa atual, a saída correspondente e o comentário. Só é aplicada depois de o utilizador confirmar e se tiver permissão.',
    (await history(client, request)) ? `Conversa anterior:\n${await history(client, request)}` : '',
    `Pedido: ${request.message}`,
    RESPONSE_FORMAT,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Extrai e valida a resposta JSON do assistente (aceita texto à volta do objeto). */
export function parseAssistantReply(text: string): FlowAssistantResponse {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start)
    return { reply: text.trim(), question: null, operations: [], transition: null };
  return flowAssistantResponseSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/**
 * Fila dos pedidos ao assistente. O executor reclama um pedido, corre o Copilot sem ferramentas
 * de escrita nem shell e devolve o texto; a resposta é validada aqui antes de ficar visível.
 */
export class FlowAssistantQueue {
  private readonly tools: FlowAuthoringTools;

  constructor(private readonly db: Database) {
    this.tools = new FlowAuthoringTools(db);
  }

  /**
   * Chamada de uma ferramenta de autoria pelo executor. Fencada pelo lease e reautorizada em cada
   * chamada; nomes desconhecidos são recusados.
   */
  async authoringTool(
    lease: JobLease,
    name: string,
    toolCallId: string,
    args: unknown,
  ): Promise<FlowAuthoringToolResult> {
    switch (name as FlowAuthoringToolName) {
      case 'flow_get_draft':
        return this.tools.getDraft(lease);
      case 'flow_apply_operations':
        return this.tools.applyOperations(lease, toolCallId, args);
      case 'flow_set_routing':
        return this.tools.setRouting(lease, toolCallId, args);
      case 'flow_report_missing_capability':
        return this.tools.reportMissingCapability(lease, toolCallId, args);
      default:
        return { ok: false, text: `Ferramenta desconhecida: ${clip(String(name), 60)}.` };
    }
  }

  /**
   * Reclama atomicamente o pedido mais antigo para `worker` e devolve o prompt completo (null se a
   * fila estiver vazia). O `UPDATE` só reclama pedidos ainda `queued` e incrementa a época do lease.
   */
  async claimNext(worker: WorkerIdentity = LOCAL_WORKER): Promise<ClaimedAssistantRequest | null> {
    validateWorker(worker);
    return this.db.transaction(async (client) => {
      const candidate = (
        await client.query<RequestRow>(
          `SELECT id,project_id,scope,flow_id,ticket_id,requested_by,message,base_draft_version,session_id,authoring_mode
             FROM flow_assistant_requests WHERE status='queued'
             AND (scope='flow' OR NOT EXISTS(SELECT 1 FROM ticket_purge_maintenance p WHERE p.project_id=flow_assistant_requests.project_id AND p.lease_until>NOW(3)))
             ORDER BY created_at LIMIT 1`,
        )
      ).rows[0];
      if (!candidate) return null;
      if (candidate.scope === 'flow') {
        try {
          await this.requireAuthor(client, candidate);
        } catch (error) {
          if (
            !(error instanceof DomainError) ||
            !['FORBIDDEN', 'PROJECT_ARCHIVED', 'PROJECT_NOT_FOUND'].includes(error.code)
          )
            throw error;
          await client.query(
            "UPDATE flow_assistant_requests SET status='failed',error_code='authorization_revoked',finished_at=NOW(3) WHERE id=$1 AND status='queued'",
            [candidate.id],
          );
          await this.authoringEvent(client, candidate, 'turn_failed', {
            code: 'authorization_revoked',
          });
          return null;
        }
      }
      const request = (
        await client.query<RequestRow>(
          "SELECT * FROM flow_assistant_requests WHERE id=$1 AND status='queued' FOR UPDATE",
          [candidate.id],
        )
      ).rows[0];
      if (!request) return null;
      if (request.scope === 'ticket' && (await ticketWorkPaused(client, request.project_id)))
        return null;
      const claimed = await client.query(
        `UPDATE flow_assistant_requests SET status='running', started_at=COALESCE(started_at,NOW(3)),
           worker_id=$2, lease_epoch=lease_epoch+1, attempt=attempt+1,
           lease_until=TIMESTAMPADD(SECOND,$3,NOW(3)), heartbeat_at=NOW(3)
         WHERE id=$1 AND status='queued'`,
        [request.id, worker.workerId, worker.leaseSeconds],
      );
      if (!claimed.rowCount) return null;
      const owned = (
        await client.query<{ lease_epoch: number; attempt: number }>(
          'SELECT lease_epoch,attempt FROM flow_assistant_requests WHERE id=$1',
          [request.id],
        )
      ).rows[0]!;
      const lease: JobLease = {
        jobId: request.id,
        workerId: worker.workerId,
        epoch: Number(owned.lease_epoch),
        leaseSeconds: worker.leaseSeconds,
      };
      await this.event(client, request, lease, Number(owned.attempt), 'claimed');
      const authoring = request.scope === 'flow' && request.session_id ? true : false;
      try {
        if (authoring) {
          await client.query(
            'UPDATE flow_assistant_requests r JOIN flows f ON f.id=r.flow_id SET r.known_revision=f.draft_version WHERE r.id=$1',
            [request.id],
          );
          await this.authoringEvent(client, request, 'turn_started', {
            attempt: Number(owned.attempt),
            mode: request.authoring_mode ?? 'assisted',
          });
        }
        const prompt =
          request.scope === 'flow'
            ? authoring
              ? await authoringPrompt(client, request)
              : await flowPrompt(client, request)
            : await ticketPrompt(client, request);
        return {
          id: request.id,
          projectId: request.project_id,
          scope: request.scope,
          prompt,
          lease,
          ...(authoring ? { authoring: { mode: request.authoring_mode ?? 'assisted' } } : {}),
        };
      } catch {
        await client.query(
          "UPDATE flow_assistant_requests SET status='failed',error_code=$2,finished_at=NOW(3),lease_until=NULL WHERE id=$1",
          [request.id, 'context_unavailable'],
        );
        await this.authoringEvent(client, request, 'turn_failed', { code: 'context_unavailable' });
        return null;
      }
    });
  }

  /** Renova o lease do pedido; `owned=false` indica que o executor tem de parar. */
  async heartbeat(lease: JobLease): Promise<HeartbeatState> {
    const renewed = await this.db.query(
      `UPDATE flow_assistant_requests SET lease_until=TIMESTAMPADD(SECOND,$4,NOW(3)), heartbeat_at=NOW(3)
       WHERE ${OWNED_BY()}`,
      [lease.jobId, lease.workerId, lease.epoch, lease.leaseSeconds],
    );
    if (renewed.rowCount) return { owned: true, cancelRequested: false };
    await this.rejectStale(this.db, lease, 'lease_lost');
    return { owned: false, cancelRequested: true };
  }

  /**
   * Guarda a resposta, apenas pela tentativa com o lease atual. Num fluxo, as operações são
   * aplicadas a uma cópia do rascunho para garantir que a proposta é aplicável; nada é gravado no
   * fluxo até o utilizador aceitar.
   */
  async complete(lease: JobLease, text: string): Promise<FencedOutcome> {
    await this.finalReplyOperations(lease, text);
    return this.db.transaction(async (client) => {
      const requestId = lease.jobId;
      const candidate = (
        await client.query<RequestRow>(
          `SELECT * FROM flow_assistant_requests WHERE ${OWNED_BY()}`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!candidate) return this.rejectStale(client, lease, 'stale_attempt_rejected', 'succeeded');
      if (candidate.scope === 'flow') {
        try {
          await this.requireAuthor(client, candidate);
        } catch (error) {
          if (
            !(error instanceof DomainError) ||
            !['FORBIDDEN', 'PROJECT_ARCHIVED', 'PROJECT_NOT_FOUND'].includes(error.code)
          )
            throw error;
          await this.markFailed(client, requestId, 'authorization_revoked');
          await this.event(client, candidate, lease, Number(candidate.attempt ?? 0), 'failed', {
            code: 'authorization_revoked',
          });
          await this.authoringEvent(client, candidate, 'turn_failed', {
            code: 'authorization_revoked',
          });
          return 'accepted';
        }
      }
      const request = (
        await client.query<RequestRow>(
          `SELECT * FROM flow_assistant_requests WHERE ${OWNED_BY()} FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!request) return this.rejectStale(client, lease, 'stale_attempt_rejected', 'succeeded');
      if (request.scope === 'flow' && request.session_id)
        return this.completeAuthoring(client, request, lease, text);
      let response: FlowAssistantResponse;
      try {
        response = parseAssistantReply(text);
      } catch {
        await this.markFailed(client, requestId, 'invalid_response');
        await this.event(client, request, lease, Number(request.attempt ?? 0), 'failed', {
          code: 'invalid_response',
        });
        return 'accepted';
      }
      if (request.scope === 'flow') {
        response = { ...response, transition: null };
        const flow = (
          await client.query<{ flow_definition: unknown }>(
            'SELECT flow_definition FROM flows WHERE id=$1',
            [request.flow_id],
          )
        ).rows[0];
        try {
          const result = applyFlowOperations(
            parseDefinition(flow?.flow_definition),
            response.operations,
          );
          flowDefinitionSchema.parse(result.definition);
        } catch (error) {
          response = {
            ...response,
            operations: [],
            reply:
              `${response.reply}\n\n(A proposta não era aplicável ao rascunho atual: ${error instanceof Error ? clip(error.message, 200) : 'erro'}.)`.trim(),
          };
        }
      } else response = { ...response, operations: [] };
      await client.query(
        "UPDATE flow_assistant_requests SET status='succeeded',assistant_response=$2,finished_at=NOW(3),lease_until=NULL WHERE id=$1",
        [requestId, response],
      );
      await this.event(client, request, lease, Number(request.attempt ?? 0), 'completed');
      return 'accepted';
    });
  }

  /**
   * Fim de um turno de construção. As alterações já passaram pelas ferramentas: no modo assistido
   * a proposta é composta pelas linhas `proposed` deste pedido (nunca pelo texto do modelo); no
   * automático já estão no rascunho e não há nada para aceitar.
   */
  /**
   * Operações enviadas só na mensagem final completa (sem chamar ferramentas): passam pelo mesmo
   * caminho validado, autorizado e idempotente das ferramentas. Nunca se lê JSON parcial do stream.
   */
  private async finalReplyOperations(lease: JobLease, text: string) {
    let operations: FlowPatchOperation[];
    try {
      operations = parseAssistantReply(text).operations;
    } catch {
      return;
    }
    if (!operations.length) return;
    const request = (
      await this.db.query<{ session_id: string | null; used: number }>(
        `SELECT r.session_id,
                (SELECT COUNT(*) FROM flow_authoring_operations o WHERE o.request_id=r.id AND o.source='assistant') AS used
           FROM flow_assistant_requests r WHERE ${OWNED_BY('r.')}`,
        [lease.jobId, lease.workerId, lease.epoch],
      )
    ).rows[0];
    if (!request?.session_id || Number(request.used) > 0) return;
    await this.tools.applyOperations(lease, 'final-reply', {
      operations: operations.slice(0, FLOW_AUTHORING_BATCH_LIMIT),
      summary: 'Alterações da resposta final',
    });
  }

  private async completeAuthoring(
    client: Queryable,
    request: RequestRow,
    lease: JobLease,
    text: string,
  ): Promise<FencedOutcome> {
    const { reply, question } = parseAuthoringReply(text);
    const rows = (
      await client.query<{ kind: string; status: string; operations: unknown }>(
        "SELECT kind,status,operations FROM flow_authoring_operations WHERE request_id=$1 AND source='assistant' ORDER BY created_at,id",
        [request.id],
      )
    ).rows;
    const operations: FlowPatchOperation[] = [];
    let proposals = 0;
    for (const row of rows) {
      if (row.status !== 'proposed') continue;
      proposals += 1;
      if (row.kind !== 'definition') continue;
      const parsed =
        typeof row.operations === 'string' ? JSON.parse(row.operations) : row.operations;
      if (Array.isArray(parsed)) operations.push(...(parsed as FlowPatchOperation[]));
    }
    const response: FlowAssistantResponse = {
      reply: reply || (proposals ? 'Proposta pronta para rever.' : 'Concluído.'),
      question,
      operations: operations.slice(0, 40),
      transition: null,
    };
    const counts = {
      applied: rows.filter((row) => row.status === 'applied').length,
      proposed: proposals,
      rejected: rows.filter((row) => row.status === 'rejected').length,
      conflicts: rows.filter((row) => row.status === 'conflict').length,
    };
    await client.query(
      `UPDATE flow_assistant_requests SET status='succeeded',assistant_response=$2,finished_at=NOW(3),lease_until=NULL,
              resolution=$3 WHERE id=$1`,
      [request.id, response, proposals ? 'pending' : 'accepted'],
    );
    await this.event(client, request, lease, Number(request.attempt ?? 0), 'completed', counts);
    await this.authoringEvent(client, request, 'turn_completed', {
      reply: response.reply,
      question,
      ...counts,
    });
    return 'accepted';
  }

  /** Regista a falha do pedido (Copilot indisponível, resposta inválida, etc.) pelo dono do lease. */
  async fail(lease: JobLease, code: string): Promise<FencedOutcome> {
    return this.db.transaction(async (client) => {
      const owned = (
        await client.query<RequestRow>(
          `SELECT * FROM flow_assistant_requests WHERE ${OWNED_BY()} FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!owned) return this.rejectStale(client, lease, 'stale_attempt_rejected', 'failed');
      await this.markFailed(client, lease.jobId, code);
      await this.event(client, owned, lease, Number(owned.attempt ?? 0), 'failed', { code });
      await this.authoringEvent(client, owned, 'turn_failed', { code: clip(code, 100) });
      return 'accepted';
    });
  }

  /** Devolve o pedido à fila sem consumir tentativa (paragem ordenada do executor). */
  async release(lease: JobLease, reason = 'shutdown'): Promise<FencedOutcome> {
    return this.db.transaction(async (client) => {
      const request = (
        await client.query<RequestRow & { attempt: number }>(
          `SELECT * FROM flow_assistant_requests WHERE ${OWNED_BY()} FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!request) return this.rejectStale(client, lease, 'stale_attempt_rejected');
      await client.query(
        `UPDATE flow_assistant_requests SET status='queued', worker_id=NULL, lease_until=NULL,
           heartbeat_at=NULL, attempt=GREATEST(attempt-1,0) WHERE id=$1`,
        [request.id],
      );
      await this.event(client, request, lease, Number(request.attempt), 'released', { reason });
      await this.authoringEvent(client, request, 'turn_queued', { reason: 'released' });
      return 'accepted';
    });
  }

  /**
   * Reconciliação por lease: pedidos `running` com lease expirado (ou legados sem lease) voltam à
   * fila uma vez; depois falham com `interrupted`. Pedidos vivos de outros executores ficam intactos.
   */
  async recoverExpired(maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    const outcome = { requeued: 0, failed: 0 };
    const expired = await this.db.query<{ id: string }>(
      "SELECT id FROM flow_assistant_requests WHERE status='running' AND (lease_until IS NULL OR lease_until<=NOW(3)) LIMIT 50",
    );
    for (const { id } of expired.rows) {
      await this.db.transaction(async (client) => {
        const request = (
          await client.query<
            RequestRow & { attempt: number; lease_epoch: number; worker_id: string | null }
          >(
            `SELECT * FROM flow_assistant_requests WHERE id=$1 AND status='running'
               AND (lease_until IS NULL OR lease_until<=NOW(3)) FOR UPDATE`,
            [id],
          )
        ).rows[0];
        if (!request) return;
        const lease: JobLease = {
          jobId: id,
          workerId: request.worker_id ?? '',
          epoch: Number(request.lease_epoch),
          leaseSeconds: 0,
        };
        if (Number(request.attempt) < maxAttempts) {
          await client.query(
            "UPDATE flow_assistant_requests SET status='queued', worker_id=NULL, lease_until=NULL, heartbeat_at=NULL WHERE id=$1",
            [id],
          );
          await this.event(
            client,
            request,
            lease,
            Number(request.attempt),
            'lease_expired_requeued',
          );
          await this.authoringEvent(client, request, 'turn_queued', { reason: 'lease_expired' });
          outcome.requeued += 1;
        } else {
          await this.markFailed(client, id, 'interrupted');
          await this.event(client, request, lease, Number(request.attempt), 'lease_expired_failed');
          await this.authoringEvent(client, request, 'turn_failed', { code: 'interrupted' });
          outcome.failed += 1;
        }
      });
    }
    return outcome;
  }

  private async rejectStale(
    client: Queryable,
    lease: JobLease,
    type: JobEventType,
    terminal?: string,
  ): Promise<FencedOutcome> {
    const row = (
      await client.query<
        RequestRow & {
          status: string;
          worker_id: string | null;
          lease_epoch: number;
          attempt: number;
        }
      >('SELECT * FROM flow_assistant_requests WHERE id=$1', [lease.jobId])
    ).rows[0];
    if (!row) return 'stale';
    if (
      terminal &&
      row.status === terminal &&
      row.worker_id === lease.workerId &&
      Number(row.lease_epoch) === lease.epoch
    )
      return 'duplicate';
    await this.event(client, row, lease, Number(row.attempt), type, {
      currentEpoch: Number(row.lease_epoch),
      currentStatus: row.status,
    });
    return 'stale';
  }

  private async event(
    client: Queryable,
    request: RequestRow,
    lease: JobLease,
    attempt: number,
    type: JobEventType,
    details?: Record<string, unknown>,
  ) {
    await recordJobEvent(client, {
      kind: 'flow_assistant',
      jobId: request.id,
      projectId: request.project_id,
      ticketId: request.ticket_id,
      attempt,
      epoch: lease.epoch,
      workerId: lease.workerId || null,
      type,
      details,
    });
  }

  private async authoringEvent(
    client: Queryable,
    request: RequestRow,
    type: FlowAuthoringEventType,
    payload: Record<string, unknown>,
  ) {
    if (request.scope !== 'flow' || !request.session_id || !request.flow_id) return;
    await recordAuthoringEvent(client, {
      projectId: request.project_id,
      flowId: request.flow_id,
      sessionId: request.session_id,
      requestId: request.id,
      actorId: request.requested_by,
      type,
      payload,
    });
  }

  private async markFailed(client: Queryable, requestId: string, code: string) {
    await client.query(
      "UPDATE flow_assistant_requests SET status='failed',error_code=$2,finished_at=NOW(3),lease_until=NULL WHERE id=$1 AND status IN ('queued','running')",
      [requestId, clip(code, 100)],
    );
  }

  private async requireAuthor(client: Queryable, request: RequestRow) {
    const row = (
      await client.query<UserRow>('SELECT * FROM users WHERE id=$1', [request.requested_by])
    ).rows[0];
    if (!row) throw new DomainError('FORBIDDEN', 'Autor indisponível.', 403);
    await requireProjectPermission(client, toUser(row), request.project_id, 'flows.edit', true);
  }
}
