import { ticketWorkPaused } from '../tickets/ticket-purge-health.js';
import {
  applyFlowOperations,
  decisionOptions,
  flowActionCatalog,
  flowAssistantResponseSchema,
  flowDefinitionSchema,
  nodePorts,
  portLabel,
  type FlowAssistantResponse,
  type FlowDefinition,
  type FlowStepOutput,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import type { Queryable } from '../identity/membership.js';
import { parseDefinition } from './flow-store.js';

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** Pedido reclamado pelo executor: o prompt já inclui o fluxo/ticket e o formato da resposta. */
export interface ClaimedAssistantRequest {
  id: string;
  projectId: string;
  scope: 'flow' | 'ticket';
  prompt: string;
}

interface RequestRow {
  id: string;
  project_id: string;
  scope: 'flow' | 'ticket';
  flow_id: string | null;
  ticket_id: string | null;
  requested_by: string;
  message: string;
  base_draft_version: number | null;
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
  .map((action) => `${action.key} (resultados ${action.results.join('/')}; ${action.description.pt})`)
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
  constructor(private readonly db: Database) {}

  /** Reclama o pedido mais antigo e devolve o prompt completo (null se a fila estiver vazia). */
  async claimNext(): Promise<ClaimedAssistantRequest | null> {
    return this.db.transaction(async (client) => {
      const request = (
        await client.query<RequestRow>(
          `SELECT id,project_id,scope,flow_id,ticket_id,requested_by,message,base_draft_version
             FROM flow_assistant_requests WHERE status='queued'
             AND (scope='flow' OR NOT EXISTS(SELECT 1 FROM ticket_purge_maintenance p WHERE p.project_id=flow_assistant_requests.project_id AND p.lease_until>NOW(3)))
             ORDER BY created_at LIMIT 1 FOR UPDATE`,
        )
      ).rows[0];
      if (!request) return null;
      if (request.scope === 'ticket' && (await ticketWorkPaused(client, request.project_id)))
        return null;
      await client.query(
        "UPDATE flow_assistant_requests SET status='running',started_at=NOW(3) WHERE id=$1",
        [request.id],
      );
      try {
        const prompt =
          request.scope === 'flow'
            ? await flowPrompt(client, request)
            : await ticketPrompt(client, request);
        return { id: request.id, projectId: request.project_id, scope: request.scope, prompt };
      } catch {
        await client.query(
          "UPDATE flow_assistant_requests SET status='failed',error_code='context_unavailable',finished_at=NOW(3) WHERE id=$1",
          [request.id],
        );
        return null;
      }
    });
  }

  /**
   * Guarda a resposta. Num fluxo, as operações são aplicadas a uma cópia do rascunho para garantir
   * que a proposta é aplicável; nada é gravado no fluxo até o utilizador aceitar.
   */
  async complete(requestId: string, text: string) {
    await this.db.transaction(async (client) => {
      const request = (
        await client.query<RequestRow>(
          "SELECT * FROM flow_assistant_requests WHERE id=$1 AND status='running' FOR UPDATE",
          [requestId],
        )
      ).rows[0];
      if (!request) return;
      let response: FlowAssistantResponse;
      try {
        response = parseAssistantReply(text);
      } catch {
        await this.markFailed(client, requestId, 'invalid_response');
        return;
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
        "UPDATE flow_assistant_requests SET status='succeeded',assistant_response=$2,finished_at=NOW(3) WHERE id=$1",
        [requestId, response],
      );
    });
  }

  /** Regista a falha do pedido (Copilot indisponível, resposta inválida, etc.). */
  async fail(requestId: string, code: string) {
    await this.markFailed(this.db, requestId, code);
  }

  /** Pedidos em curso quando o executor parou ficam falhados (o utilizador pode repetir). */
  async failInterrupted() {
    const result = await this.db.query(
      "UPDATE flow_assistant_requests SET status='failed',error_code='interrupted',finished_at=NOW(3) WHERE status='running'",
    );
    return result.rowCount;
  }

  private async markFailed(client: Queryable, requestId: string, code: string) {
    await client.query(
      "UPDATE flow_assistant_requests SET status='failed',error_code=$2,finished_at=NOW(3) WHERE id=$1 AND status IN ('queued','running')",
      [requestId, clip(code, 100)],
    );
  }
}
