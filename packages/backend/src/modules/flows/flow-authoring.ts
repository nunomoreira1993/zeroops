import { randomUUID } from 'node:crypto';
import type { ZodError } from 'zod';
import {
  applyFlowOperations,
  authoringDefinitionSummary,
  flowAgentProfileConfig,
  flowAuthoringApplySchema,
  flowAuthoringRoutingSchema,
  flowCapabilityRequestSchema,
  flowChangeKind,
  flowDefinitionSchema,
  parseRoutingPolicy,
  sameRoutingPolicy,
  type FlowAuthoringEventType,
  type FlowAuthoringEventView,
  type FlowAuthoringMode,
  type FlowAuthoringOperationView,
  type FlowAuthoringToolResult,
  type FlowCapabilityRequestView,
  type FlowDefinition,
  type FlowMatch,
  type FlowPatchOperation,
  type FlowRoutingPolicy,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import type { Queryable } from '../identity/membership.js';
import { requireProjectPermission } from '../identity/project-permissions.js';
import { toUser, type UserRow } from '../identity/identity.rows.js';
import { OWNED_BY, recordJobEvent, type JobLease } from '../agents/job-leases.js';
import { parseDefinition, parseMatch } from './flow-store.js';

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const iso = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).toISOString();

/** Tamanho máximo do payload de um evento (o stream não transporta definições inteiras). */
const EVENT_PAYLOAD_LIMIT = 48_000;

export interface AuthoringEventInput {
  projectId: string;
  flowId: string;
  sessionId?: string | null;
  requestId?: string | null;
  actorId?: string | null;
  type: FlowAuthoringEventType;
  payload?: Record<string, unknown>;
  /** Evita duplicados quando o mesmo efeito é registado de novo (retry, replay). */
  idempotencyKey?: string | null;
}

/** Regista um evento persistente de construção (ignorado se a chave de idempotência já existir). */
export async function recordAuthoringEvent(client: Queryable, event: AuthoringEventInput) {
  let payload = event.payload ?? {};
  if (JSON.stringify(payload).length > EVENT_PAYLOAD_LIMIT) {
    const { operations, ...rest } = payload as { operations?: unknown[] };
    payload = {
      ...rest,
      truncated: true,
      ...(Array.isArray(operations) ? { operationCount: operations.length } : {}),
    };
  }
  await client.query(
    `INSERT IGNORE INTO flow_authoring_events(project_id,flow_id,session_id,request_id,actor_id,event_type,payload,idempotency_key)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      event.projectId,
      event.flowId,
      event.sessionId ?? null,
      event.requestId ?? null,
      event.actorId ?? null,
      event.type,
      JSON.stringify(payload),
      event.idempotencyKey ?? null,
    ],
  );
}

/** Autor do pedido continua com `flows.edit` (revogação tem efeito imediato). */
export async function requireFlowAuthor(client: Queryable, projectId: string, userId: string) {
  const row = (await client.query<UserRow>('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
  if (!row) throw new DomainError('FORBIDDEN', 'Autor indisponível.', 403);
  await requireProjectPermission(client, toUser(row), projectId, 'flows.edit', true);
}

const REVOKED = ['FORBIDDEN', 'PROJECT_ARCHIVED', 'PROJECT_NOT_FOUND'];

interface AuthoringRequestRow {
  id: string;
  project_id: string;
  flow_id: string;
  session_id: string;
  requested_by: string;
  authoring_mode: FlowAuthoringMode;
  known_revision: number | null;
  attempt: number;
  lease_epoch: number;
  worker_id: string | null;
}

interface FlowLockRow {
  id: string;
  project_id: string;
  flow_definition: unknown;
  draft_version: number;
  flow_match: unknown;
  routing_policy?: unknown;
}

interface OperationRow {
  id: string;
  project_id: string;
  flow_id: string;
  session_id: string | null;
  request_id: string | null;
  actor_id: string;
  actor_name?: string | null;
  source: FlowAuthoringOperationView['source'];
  kind: FlowAuthoringOperationView['kind'];
  status: FlowAuthoringOperationView['status'];
  base_revision: number;
  result_revision: number | null;
  operations: unknown;
  routing: unknown;
  summary: string;
  definition_before: unknown;
  definition_after: unknown;
  routing_before: unknown;
  routing_after: unknown;
  error: string | null;
  undo_of: string | null;
  undone_by: string | null;
  created_at: Date;
}

type RoutingState = { match: FlowMatch; routingPolicy: FlowRoutingPolicy };

const json = <T>(value: unknown): T | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string')
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  return value as T;
};

function zodMessage(error: ZodError) {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join('.') || 'entrada'}: ${issue.message}`)
    .join('; ');
}

function sameMatch(a: FlowMatch, b: FlowMatch) {
  return (Object.keys(a) as (keyof FlowMatch)[]).every(
    (key) => [...a[key]].sort().join('\0') === [...(b[key] ?? [])].sort().join('\0'),
  );
}

function sameRoutingState(a: RoutingState, b: RoutingState) {
  return sameMatch(a.match, b.match) && sameRoutingPolicy(a.routingPolicy, b.routingPolicy);
}

/** Mantém as posições atuais das etapas que continuam a existir (o layout não é execução). */
function keepLayout(target: FlowDefinition, current: FlowDefinition): FlowDefinition {
  const layout = { ...target.layout };
  for (const node of target.nodes)
    if (current.layout[node.id]) layout[node.id] = current.layout[node.id]!;
  return { ...target, layout };
}

/** Converte uma operação persistida na vista da API, indicando se ainda pode ser desfeita. */
export function operationView(
  row: OperationRow,
  current?: CurrentDraft,
): FlowAuthoringOperationView {
  return {
    id: row.id,
    requestId: row.request_id,
    sessionId: row.session_id,
    actor: row.actor_name ?? null,
    source: row.source,
    kind: row.kind,
    status: row.status,
    baseRevision: Number(row.base_revision),
    resultRevision: row.result_revision === null ? null : Number(row.result_revision),
    operations: json<FlowPatchOperation[]>(row.operations) ?? [],
    routing: json(row.routing),
    summary: row.summary,
    error: row.error,
    undoOf: row.undo_of,
    undoneBy: row.undone_by,
    undoable: current ? undoBlocker(row, current) === null : false,
    createdAt: iso(row.created_at),
  };
}

interface CurrentDraft {
  revision: number;
  definition: FlowDefinition;
  routing: RoutingState;
}

/**
 * Uma operação aplicada só pode ser desfeita enquanto o rascunho continuar no estado que ela
 * produziu (ignorando posições): desfazer nunca apaga trabalho posterior de outra pessoa/sessão.
 */
function undoBlocker(row: OperationRow, current: CurrentDraft): string | null {
  if (row.status !== 'applied') return 'not_applied';
  if (row.undone_by) return 'already_undone';
  if (row.result_revision === null) return 'not_applied';
  if (Number(row.result_revision) === current.revision) return null;
  const after = json<FlowDefinition>(row.definition_after);
  const routingAfter = json<RoutingState>(row.routing_after);
  if (after && !['none', 'layout'].includes(flowChangeKind(after, current.definition)))
    return 'changed_since';
  if (routingAfter) {
    if (!sameRoutingState(normalizeRouting(routingAfter), current.routing)) return 'changed_since';
  } else if (!after) return 'changed_since';
  // Só houve mudanças de posição (ou noutra dimensão que esta operação não tocou).
  return null;
}

function normalizeRouting(value: Partial<RoutingState> | null | undefined): RoutingState {
  return {
    match: parseMatch(value?.match ?? null),
    routingPolicy: parseRoutingPolicy(value?.routingPolicy ?? null),
  };
}

function currentDraft(flow: FlowLockRow): CurrentDraft {
  return {
    revision: Number(flow.draft_version),
    definition: parseDefinition(flow.flow_definition),
    routing: {
      match: parseMatch(flow.flow_match),
      routingPolicy: parseRoutingPolicy(flow.routing_policy),
    },
  };
}

/**
 * Ferramentas de autoria do Copilot (P06). Cada chamada é fencada pelo lease do pedido, exige que
 * o autor mantenha `flows.edit`, valida o schema e a integridade e usa controlo otimista sobre a
 * revisão do rascunho. Não há caminho para ativar, alterar permissões ou outro projeto/fluxo: o
 * fluxo e o projeto vêm do pedido guardado, nunca dos argumentos do modelo.
 */
export class FlowAuthoringTools {
  constructor(private readonly db: Database) {}

  /** Lê o rascunho atual e passa a considerá-lo como base das próximas operações. */
  async getDraft(lease: JobLease): Promise<FlowAuthoringToolResult> {
    return this.owned(lease, 'flow_get_draft', null, async (client, request, flow) => {
      const draft = currentDraft(flow);
      await client.query('UPDATE flow_assistant_requests SET known_revision=$2 WHERE id=$1', [
        request.id,
        draft.revision,
      ]);
      const proposals =
        request.authoring_mode === 'assisted' ? await this.proposals(client, request.id) : [];
      await this.event(client, request, 'draft_read', { revision: draft.revision });
      return {
        ok: true,
        text: JSON.stringify({
          revision: draft.revision,
          draft: authoringDefinitionSummary(draft.definition),
          match: draft.routing.match,
          routingPolicy: draft.routing.routingPolicy,
          ...(proposals.length
            ? {
                pendingProposals: proposals.map((row) => ({
                  summary: row.summary,
                  operations: json(row.operations),
                  routing: json(row.routing),
                })),
              }
            : {}),
        }),
      };
    });
  }

  /** Aplica (automático) ou propõe (assistido) um lote atómico de operações sobre o rascunho. */
  async applyOperations(
    lease: JobLease,
    toolCallId: string,
    raw: unknown,
  ): Promise<FlowAuthoringToolResult> {
    return this.owned(lease, 'flow_apply_operations', toolCallId, async (client, request, flow) => {
      const key = `${request.id}:${clip(toolCallId, 120)}`;
      const repeated = await this.repeated(client, key);
      if (repeated) return repeated;
      const parsed = flowAuthoringApplySchema.safeParse(raw);
      const draft = currentDraft(flow);
      if (!parsed.success)
        return this.reject(client, request, key, draft.revision, raw, zodMessage(parsed.error));
      const input = parsed.data;
      const conflict = await this.conflict(client, request, key, draft, input.operations, null);
      if (conflict) return conflict;
      const base =
        request.authoring_mode === 'assisted'
          ? await this.proposedDefinition(client, request.id, draft.definition)
          : draft.definition;
      let result;
      try {
        result = applyFlowOperations(base, input.operations);
        flowDefinitionSchema.parse(result.definition);
        await assertFlowDependencies(client, request.project_id, result.definition);
      } catch (error) {
        const message =
          error instanceof DomainError || error instanceof Error ? error.message : 'erro';
        return this.reject(client, request, key, draft.revision, input.operations, message);
      }
      const marks = {
        added: result.added,
        changed: result.changed,
        removed: result.removed,
        addedEdges: result.addedEdges,
        removedEdges: result.removedEdges,
      };
      const id = randomUUID();
      if (request.authoring_mode === 'auto') {
        const changed = flowChangeKind(draft.definition, result.definition) !== 'none';
        const revision = changed ? draft.revision + 1 : draft.revision;
        if (changed)
          await client.query(
            'UPDATE flows SET flow_definition=$2,draft_version=draft_version+1,updated_at=NOW(3) WHERE id=$1',
            [flow.id, result.definition],
          );
        await client.query('UPDATE flow_assistant_requests SET known_revision=$2 WHERE id=$1', [
          request.id,
          revision,
        ]);
        await this.insertOperation(client, request, {
          id,
          key,
          kind: 'definition',
          status: 'applied',
          baseRevision: draft.revision,
          resultRevision: revision,
          operations: input.operations,
          summary: input.summary,
          definitionBefore: draft.definition,
          definitionAfter: result.definition,
        });
        await this.event(client, request, 'operation_applied', {
          operationId: id,
          kind: 'definition',
          revision,
          baseRevision: draft.revision,
          summary: input.summary,
          operations: input.operations,
          ...marks,
        });
        return {
          ok: true,
          text: `Aplicado ao rascunho (revisão ${revision}). ${describe(marks)}`,
        };
      }
      await this.insertOperation(client, request, {
        id,
        key,
        kind: 'definition',
        status: 'proposed',
        baseRevision: draft.revision,
        resultRevision: null,
        operations: input.operations,
        summary: input.summary,
        definitionBefore: base,
        definitionAfter: result.definition,
      });
      await this.event(client, request, 'operation_proposed', {
        operationId: id,
        kind: 'definition',
        baseRevision: draft.revision,
        summary: input.summary,
        operations: input.operations,
        ...marks,
      });
      return {
        ok: true,
        text: `Proposto (o utilizador aceita ou descarta no fim). ${describe(marks)}`,
      };
    });
  }

  /** Regras de seleção/política de encaminhamento do rascunho (nunca prioridade nem ativação). */
  async setRouting(
    lease: JobLease,
    toolCallId: string,
    raw: unknown,
  ): Promise<FlowAuthoringToolResult> {
    return this.owned(lease, 'flow_set_routing', toolCallId, async (client, request, flow) => {
      const key = `${request.id}:${clip(toolCallId, 120)}`;
      const repeated = await this.repeated(client, key);
      if (repeated) return repeated;
      const parsed = flowAuthoringRoutingSchema.safeParse(raw);
      const draft = currentDraft(flow);
      if (!parsed.success)
        return this.reject(
          client,
          request,
          key,
          draft.revision,
          raw,
          zodMessage(parsed.error),
          'routing',
        );
      const conflict = await this.conflict(client, request, key, draft, null, parsed.data);
      if (conflict) return conflict;
      const next: RoutingState = {
        match: parsed.data.match ?? draft.routing.match,
        routingPolicy: parsed.data.routingPolicy ?? draft.routing.routingPolicy,
      };
      const routing = {
        ...(parsed.data.match ? { match: parsed.data.match } : {}),
        ...(parsed.data.routingPolicy ? { routingPolicy: parsed.data.routingPolicy } : {}),
      };
      const id = randomUUID();
      if (request.authoring_mode === 'auto') {
        const changed = !sameRoutingState(draft.routing, next);
        const revision = changed ? draft.revision + 1 : draft.revision;
        if (changed)
          await client.query(
            `UPDATE flows SET flow_match=$2,routing_policy=$3,draft_version=draft_version+1,updated_at=NOW(3)
              WHERE id=$1`,
            [flow.id, next.match, next.routingPolicy],
          );
        await client.query('UPDATE flow_assistant_requests SET known_revision=$2 WHERE id=$1', [
          request.id,
          revision,
        ]);
        await this.insertOperation(client, request, {
          id,
          key,
          kind: 'routing',
          status: 'applied',
          baseRevision: draft.revision,
          resultRevision: revision,
          routing,
          summary: parsed.data.summary,
          routingBefore: draft.routing,
          routingAfter: next,
        });
        await this.event(client, request, 'operation_applied', {
          operationId: id,
          kind: 'routing',
          revision,
          baseRevision: draft.revision,
          summary: parsed.data.summary,
          routing,
        });
        return {
          ok: true,
          text: `Regras de encaminhamento do rascunho atualizadas (revisão ${revision}). Só entram em serviço quando alguém ativar a versão.`,
        };
      }
      await this.insertOperation(client, request, {
        id,
        key,
        kind: 'routing',
        status: 'proposed',
        baseRevision: draft.revision,
        resultRevision: null,
        routing,
        summary: parsed.data.summary,
        routingBefore: draft.routing,
        routingAfter: next,
      });
      await this.event(client, request, 'operation_proposed', {
        operationId: id,
        kind: 'routing',
        baseRevision: draft.revision,
        summary: parsed.data.summary,
        routing,
      });
      return { ok: true, text: 'Regras de encaminhamento propostas para o utilizador aceitar.' };
    });
  }

  /** Regista uma capacidade em falta ligada ao rascunho (não cria nem simula a capacidade). */
  async reportMissingCapability(
    lease: JobLease,
    toolCallId: string,
    raw: unknown,
  ): Promise<FlowAuthoringToolResult> {
    return this.owned(
      lease,
      'flow_report_missing_capability',
      toolCallId,
      async (client, request) => {
        const parsed = flowCapabilityRequestSchema.safeParse(raw);
        if (!parsed.success)
          return { ok: false, text: `Pedido inválido: ${zodMessage(parsed.error)}` };
        const key = `${request.id}:${clip(toolCallId, 120)}`;
        const id = randomUUID();
        const inserted = await client.query(
          `INSERT IGNORE INTO flow_capability_requests
             (id,project_id,flow_id,session_id,request_id,requested_by,capability_kind,capability,reason,node_id,idempotency_key)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            request.project_id,
            request.flow_id,
            request.session_id,
            request.id,
            request.requested_by,
            parsed.data.kind,
            parsed.data.capability,
            parsed.data.reason,
            parsed.data.nodeId ?? null,
            key,
          ],
        );
        if (inserted.rowCount)
          await this.event(
            client,
            request,
            'capability_missing',
            {
              capabilityRequestId: id,
              kind: parsed.data.kind,
              capability: parsed.data.capability,
              reason: clip(parsed.data.reason, 500),
              nodeId: parsed.data.nodeId ?? null,
            },
            `${key}:capability`,
          );
        return {
          ok: true,
          text: 'Capacidade em falta registada e visível para a equipa. Não a simules nem inventes uma ferramenta: descreve o bloqueio na resposta.',
        };
      },
    );
  }

  // ---- internos -----------------------------------------------------------------------------

  /**
   * Executa `work` com o pedido fencado (lease atual, `running`) e o fluxo bloqueado. Sem posse ou
   * com a permissão revogada, nada é escrito no rascunho.
   */
  private async owned(
    lease: JobLease,
    tool: string,
    toolCallId: string | null,
    work: (
      client: Queryable,
      request: AuthoringRequestRow,
      flow: FlowLockRow,
    ) => Promise<FlowAuthoringToolResult>,
  ): Promise<FlowAuthoringToolResult> {
    const lost: FlowAuthoringToolResult = {
      ok: false,
      stop: true,
      text: 'Este pedido já não está ativo (cancelado ou sem posse). Termina sem mais alterações.',
    };
    return this.db.transaction(async (client) => {
      const probe = (
        await client.query<{ flow_id: string | null; session_id: string | null }>(
          `SELECT flow_id,session_id FROM flow_assistant_requests WHERE ${OWNED_BY()}`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!probe?.flow_id || !probe.session_id) return lost;
      // Ordem de bloqueio igual à do editor: fluxo primeiro, depois o pedido.
      const flow = (
        await client.query<FlowLockRow>(
          'SELECT id,project_id,flow_definition,draft_version,flow_match,routing_policy FROM flows WHERE id=$1 FOR UPDATE',
          [probe.flow_id],
        )
      ).rows[0];
      const request = (
        await client.query<AuthoringRequestRow>(
          `SELECT id,project_id,flow_id,session_id,requested_by,authoring_mode,known_revision,attempt,lease_epoch,worker_id
             FROM flow_assistant_requests WHERE ${OWNED_BY()} FOR UPDATE`,
          [lease.jobId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!flow || !request || flow.project_id !== request.project_id) return lost;
      try {
        await requireFlowAuthor(client, request.project_id, request.requested_by);
      } catch (error) {
        if (!(error instanceof DomainError) || !REVOKED.includes(error.code)) throw error;
        await client.query(
          "UPDATE flow_assistant_requests SET status='failed',error_code='authorization_revoked',finished_at=NOW(3),lease_until=NULL WHERE id=$1",
          [request.id],
        );
        await recordJobEvent(client, {
          kind: 'flow_assistant',
          jobId: request.id,
          projectId: request.project_id,
          ticketId: null,
          attempt: Number(request.attempt),
          epoch: lease.epoch,
          workerId: lease.workerId,
          type: 'failed',
          details: { code: 'authorization_revoked', tool },
        });
        await this.event(client, request, 'turn_failed', { code: 'authorization_revoked', tool });
        return {
          ok: false,
          stop: true,
          text: 'O autor deixou de ter permissão para editar este fluxo. Termina.',
        };
      }
      void toolCallId;
      return work(client, request, flow);
    });
  }

  private async repeated(client: Queryable, key: string): Promise<FlowAuthoringToolResult | null> {
    const row = (
      await client.query<{ status: string; result_revision: number | null; error: string | null }>(
        'SELECT status,result_revision,error FROM flow_authoring_operations WHERE idempotency_key=$1',
        [key],
      )
    ).rows[0];
    if (!row) return null;
    if (row.status === 'applied')
      return { ok: true, text: `Já aplicado (revisão ${row.result_revision}).` };
    if (row.status === 'proposed') return { ok: true, text: 'Já proposto.' };
    return { ok: false, text: row.error ?? 'Operação rejeitada.' };
  }

  /** Rascunho mudou desde a última leitura: regista o conflito e pede ao modelo para reler. */
  private async conflict(
    client: Queryable,
    request: AuthoringRequestRow,
    key: string,
    draft: CurrentDraft,
    operations: FlowPatchOperation[] | null,
    routing: unknown,
  ): Promise<FlowAuthoringToolResult | null> {
    const known = request.known_revision === null ? null : Number(request.known_revision);
    if (known === draft.revision) return null;
    const error = `O rascunho mudou (revisão ${draft.revision}; a tua base era ${known ?? '?'}). Nada foi aplicado. Chama flow_get_draft e reformula sobre o estado atual, sem desfazer alterações de outras pessoas.`;
    const id = randomUUID();
    await this.insertOperation(client, request, {
      id,
      key,
      kind: operations ? 'definition' : 'routing',
      status: 'conflict',
      baseRevision: known ?? draft.revision,
      resultRevision: null,
      ...(operations ? { operations } : {}),
      ...(routing ? { routing } : {}),
      summary: '',
      error,
    });
    await this.event(client, request, 'operation_conflict', {
      operationId: id,
      baseRevision: known,
      currentRevision: draft.revision,
      ...(operations ? { operations } : {}),
    });
    return { ok: false, text: error };
  }

  private async reject(
    client: Queryable,
    request: AuthoringRequestRow,
    key: string,
    revision: number,
    operations: unknown,
    message: string,
    kind: 'definition' | 'routing' = 'definition',
  ): Promise<FlowAuthoringToolResult> {
    const error = clip(`Operação rejeitada, rascunho inalterado: ${message}`, 600);
    const id = randomUUID();
    const safeOperations = Array.isArray(operations) ? operations.slice(0, 20) : null;
    await this.insertOperation(client, request, {
      id,
      key,
      kind,
      status: 'rejected',
      baseRevision: revision,
      resultRevision: null,
      ...(kind === 'definition' && safeOperations ? { operations: safeOperations } : {}),
      summary: '',
      error,
    });
    await this.event(client, request, 'operation_rejected', {
      operationId: id,
      kind,
      error,
    });
    return { ok: false, text: error };
  }

  private async proposals(client: Queryable, requestId: string) {
    return (
      await client.query<OperationRow>(
        "SELECT * FROM flow_authoring_operations WHERE request_id=$1 AND status='proposed' ORDER BY created_at,id",
        [requestId],
      )
    ).rows;
  }

  /** Rascunho + propostas já feitas neste turno (modo assistido): base da próxima proposta. */
  private async proposedDefinition(client: Queryable, requestId: string, draft: FlowDefinition) {
    let definition = draft;
    for (const row of await this.proposals(client, requestId)) {
      if (row.kind !== 'definition') continue;
      const operations = json<FlowPatchOperation[]>(row.operations) ?? [];
      definition = applyFlowOperations(definition, operations).definition;
    }
    return definition;
  }

  private async insertOperation(
    client: Queryable,
    request: AuthoringRequestRow,
    row: {
      id: string;
      key: string;
      kind: 'definition' | 'routing';
      status: FlowAuthoringOperationView['status'];
      baseRevision: number;
      resultRevision: number | null;
      operations?: unknown;
      routing?: unknown;
      summary: string;
      error?: string;
      definitionBefore?: FlowDefinition;
      definitionAfter?: FlowDefinition;
      routingBefore?: RoutingState;
      routingAfter?: RoutingState;
    },
  ) {
    await client.query(
      `INSERT INTO flow_authoring_operations
         (id,project_id,flow_id,session_id,request_id,actor_id,source,kind,status,base_revision,result_revision,
          operations,routing,summary,definition_before,definition_after,routing_before,routing_after,error,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,'assistant',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        row.id,
        request.project_id,
        request.flow_id,
        request.session_id,
        request.id,
        request.requested_by,
        row.kind,
        row.status,
        row.baseRevision,
        row.resultRevision,
        row.operations === undefined ? null : JSON.stringify(row.operations),
        row.routing === undefined ? null : JSON.stringify(row.routing),
        clip(row.summary, 400),
        row.definitionBefore ?? null,
        row.definitionAfter ?? null,
        row.routingBefore ?? null,
        row.routingAfter ?? null,
        row.error ?? null,
        row.key,
      ],
    );
  }

  private async event(
    client: Queryable,
    request: AuthoringRequestRow,
    type: FlowAuthoringEventType,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    await recordAuthoringEvent(client, {
      projectId: request.project_id,
      flowId: request.flow_id,
      sessionId: request.session_id,
      requestId: request.id,
      actorId: request.requested_by,
      type,
      payload,
      idempotencyKey: idempotencyKey ?? null,
    });
  }
}

function describe(marks: {
  added: string[];
  changed: string[];
  removed: string[];
  addedEdges: string[];
  removedEdges: string[];
}) {
  const parts = [
    marks.added.length && `novas: ${marks.added.join(', ')}`,
    marks.changed.length && `alteradas: ${marks.changed.join(', ')}`,
    marks.removed.length && `removidas: ${marks.removed.join(', ')}`,
    marks.addedEdges.length && `${marks.addedEdges.length} ligação(ões) criada(s)`,
    marks.removedEdges.length && `${marks.removedEdges.length} ligação(ões) removida(s)`,
  ].filter(Boolean);
  return parts.length ? `${parts.join('; ')}.` : 'Sem alterações.';
}

/** Perfis/skills referenciados têm de existir neste projeto na versão fixada. */
export async function assertFlowDependencies(
  client: Queryable,
  projectId: string,
  definition: FlowDefinition,
) {
  for (const node of definition.nodes) {
    if (node.op !== 'copilot_task') continue;
    const config = flowAgentProfileConfig(node);
    const profiles = [
      ...(config.agentProfileId
        ? [{ profileId: config.agentProfileId, version: config.agentProfileVersion! }]
        : []),
      ...(config.delegates ?? []),
    ];
    for (const profile of profiles) {
      const found = await client.query(
        `SELECT 1 FROM zeroops_agent_profile_versions v JOIN zeroops_agent_profiles p ON p.id=v.profile_id
          WHERE v.profile_id=$1 AND v.version=$2 AND v.project_id=$3 AND p.archived_at IS NULL`,
        [profile.profileId, profile.version, projectId],
      );
      if (!found.rowCount)
        throw new Error(
          `Dependência em falta na etapa ${node.id}: perfil ${profile.profileId} v${profile.version} não existe neste projeto (usa flow_report_missing_capability).`,
        );
    }
    for (const skill of config.skills ?? []) {
      const found = await client.query(
        `SELECT 1 FROM zeroops_skill_versions v JOIN zeroops_skills s ON s.id=v.skill_id
          WHERE v.skill_id=$1 AND v.version=$2 AND v.project_id=$3 AND s.archived_at IS NULL`,
        [skill.skillId, skill.version, projectId],
      );
      if (!found.rowCount)
        throw new Error(
          `Dependência em falta na etapa ${node.id}: skill ${skill.skillId} v${skill.version} não existe neste projeto (usa flow_report_missing_capability).`,
        );
    }
  }
}

// ---- Serviço (API) ------------------------------------------------------------------------------

interface EventRow {
  id: number | string;
  event_type: FlowAuthoringEventType;
  request_id: string | null;
  session_id: string | null;
  actor: string | null;
  payload: unknown;
  created_at: Date;
}

export const AUTHORING_EVENT_PAGE = 200;

/** Leitura de eventos, operações, capacidades e desfazer (chamado pelo `FlowsService`). */
export class FlowAuthoringStore {
  /** Devolve eventos persistidos do fluxo depois do cursor `after`, por ordem crescente. */
  async events(client: Queryable, flowId: string, after: number, limit = AUTHORING_EVENT_PAGE) {
    const rows = await client.query<EventRow>(
      `SELECT e.id,e.event_type,e.request_id,e.session_id,u.display_name AS actor,e.payload,e.created_at
         FROM flow_authoring_events e LEFT JOIN users u ON u.id=e.actor_id
        WHERE e.flow_id=$1 AND e.id>$2 ORDER BY e.id LIMIT $3`,
      [flowId, Math.max(0, Math.trunc(after)), Math.min(Math.max(limit, 1), AUTHORING_EVENT_PAGE)],
    );
    return rows.rows.map((row): FlowAuthoringEventView => ({
      id: Number(row.id),
      type: row.event_type,
      requestId: row.request_id,
      sessionId: row.session_id,
      actor: row.actor,
      payload: json<Record<string, unknown>>(row.payload) ?? {},
      createdAt: iso(row.created_at),
    }));
  }

  /** Último cursor de eventos do fluxo (0 quando ainda não há eventos). */
  async lastEventId(client: Queryable, flowId: string) {
    const row = (
      await client.query<{ id: number | null }>(
        'SELECT MAX(id) AS id FROM flow_authoring_events WHERE flow_id=$1',
        [flowId],
      )
    ).rows[0];
    return Number(row?.id ?? 0);
  }

  /** Operações de autoria recentes do fluxo, com a disponibilidade de desfazer calculada. */
  async operations(client: Queryable, flow: FlowLockRow) {
    const rows = await client.query<OperationRow>(
      `SELECT o.*,u.display_name AS actor_name FROM flow_authoring_operations o
         LEFT JOIN users u ON u.id=o.actor_id
        WHERE o.flow_id=$1 ORDER BY o.created_at DESC,o.id DESC LIMIT 60`,
      [flow.id],
    );
    const current = currentDraft(flow);
    return rows.rows.map((row) => operationView(row, current));
  }

  /** Capacidades em falta registadas para o rascunho do fluxo. */
  async capabilities(client: Queryable, flowId: string) {
    const rows = await client.query<{
      id: string;
      capability_kind: FlowCapabilityRequestView['kind'];
      capability: string;
      reason: string;
      node_id: string | null;
      status: FlowCapabilityRequestView['status'];
      requester: string | null;
      request_id: string | null;
      created_at: Date;
    }>(
      `SELECT c.*,u.display_name AS requester FROM flow_capability_requests c
         LEFT JOIN users u ON u.id=c.requested_by
        WHERE c.flow_id=$1 AND c.status='open' ORDER BY c.created_at DESC LIMIT 30`,
      [flowId],
    );
    return rows.rows.map((row): FlowCapabilityRequestView => ({
      id: row.id,
      kind: row.capability_kind,
      capability: row.capability,
      reason: row.reason,
      nodeId: row.node_id,
      status: row.status,
      requestedBy: row.requester,
      requestId: row.request_id,
      createdAt: iso(row.created_at),
    }));
  }

  /**
   * Desfaz uma operação aplicada criando uma NOVA revisão (o histórico fica intacto). Só é possível
   * enquanto o rascunho continuar no estado que a operação produziu; caso contrário, 409.
   */
  async undo(
    client: Queryable,
    flow: FlowLockRow,
    actorId: string,
    operationId: string,
    expectedDraftVersion: number,
  ) {
    const current = currentDraft(flow);
    if (current.revision !== expectedDraftVersion)
      throw new DomainError(
        'FLOW_DRAFT_CHANGED',
        'O rascunho foi alterado entretanto. Recarregue antes de desfazer.',
        409,
      );
    const row = (
      await client.query<OperationRow>(
        'SELECT * FROM flow_authoring_operations WHERE id=$1 AND flow_id=$2 FOR UPDATE',
        [operationId, flow.id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'Operação não encontrada.', 404);
    const blocker = undoBlocker(row, current);
    if (blocker)
      throw new DomainError(
        'FLOW_UNDO_UNAVAILABLE',
        blocker === 'already_undone'
          ? 'Esta operação já foi desfeita.'
          : blocker === 'changed_since'
            ? 'O rascunho mudou depois desta operação. Desfaça primeiro as alterações mais recentes ou edite manualmente.'
            : 'Só operações aplicadas podem ser desfeitas.',
        409,
      );
    const before = json<FlowDefinition>(row.definition_before);
    const routingBefore = json<RoutingState>(row.routing_before);
    const nextDefinition = before ? keepLayout(before, current.definition) : current.definition;
    const nextRouting = routingBefore ? normalizeRouting(routingBefore) : current.routing;
    flowDefinitionSchema.parse(nextDefinition);
    const revision = current.revision + 1;
    await client.query(
      `UPDATE flows SET flow_definition=$2,flow_match=$3,routing_policy=$4,draft_version=draft_version+1,updated_at=NOW(3)
        WHERE id=$1`,
      [flow.id, nextDefinition, nextRouting.match, nextRouting.routingPolicy],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO flow_authoring_operations
         (id,project_id,flow_id,session_id,request_id,actor_id,source,kind,status,base_revision,result_revision,
          operations,routing,summary,definition_before,definition_after,routing_before,routing_after,undo_of,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,'undo',$7,'applied',$8,$9,NULL,NULL,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        flow.project_id,
        flow.id,
        row.session_id,
        row.request_id,
        actorId,
        row.kind,
        current.revision,
        revision,
        clip(`Desfazer: ${row.summary || row.kind}`, 400),
        before ? current.definition : null,
        before ? nextDefinition : null,
        routingBefore ? current.routing : null,
        routingBefore ? nextRouting : null,
        row.id,
        `undo:${row.id}`,
      ],
    );
    await client.query('UPDATE flow_authoring_operations SET undone_by=$2 WHERE id=$1', [
      row.id,
      id,
    ]);
    await recordAuthoringEvent(client, {
      projectId: flow.project_id,
      flowId: flow.id,
      sessionId: row.session_id,
      requestId: row.request_id,
      actorId,
      type: 'operation_undone',
      payload: { operationId: id, undoOf: row.id, revision, kind: row.kind },
    });
    return { revision, operationId: id };
  }

  /**
   * Aceitar uma proposta do modo assistido: aplica as operações e regras propostas ao rascunho
   * atual numa única revisão auditada (desfazível) e fecha as linhas propostas.
   */
  async acceptProposals(
    client: Queryable,
    flow: FlowLockRow,
    requestId: string,
    actorId: string,
    operations: FlowPatchOperation[],
  ) {
    const current = currentDraft(flow);
    const proposals = (
      await client.query<OperationRow>(
        "SELECT * FROM flow_authoring_operations WHERE request_id=$1 AND status='proposed' ORDER BY created_at,id FOR UPDATE",
        [requestId],
      )
    ).rows;
    const routingRows = proposals.filter((row) => row.kind === 'routing');
    let nextRouting = current.routing;
    for (const row of routingRows) {
      const routing = json<Partial<RoutingState>>(row.routing) ?? {};
      nextRouting = {
        match: routing.match ? parseMatch(routing.match) : nextRouting.match,
        routingPolicy: routing.routingPolicy
          ? parseRoutingPolicy(routing.routingPolicy)
          : nextRouting.routingPolicy,
      };
    }
    const nextDefinition = flowDefinitionSchema.parse(
      applyFlowOperations(current.definition, operations).definition,
    );
    await this.assertAcceptDependencies(client, flow.project_id, nextDefinition);
    const revision = current.revision + 1;
    await client.query(
      `UPDATE flows SET flow_definition=$2,flow_match=$3,routing_policy=$4,draft_version=draft_version+1,updated_at=NOW(3)
        WHERE id=$1`,
      [flow.id, nextDefinition, nextRouting.match, nextRouting.routingPolicy],
    );
    const sessionId = proposals[0]?.session_id ?? null;
    const id = randomUUID();
    await client.query(
      `INSERT INTO flow_authoring_operations
         (id,project_id,flow_id,session_id,request_id,actor_id,source,kind,status,base_revision,result_revision,
          operations,routing,summary,definition_before,definition_after,routing_before,routing_after,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,'accept','definition','applied',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        flow.project_id,
        flow.id,
        sessionId,
        requestId,
        actorId,
        current.revision,
        revision,
        JSON.stringify(operations),
        routingRows.length ? JSON.stringify(nextRouting) : null,
        'Proposta aceite',
        current.definition,
        nextDefinition,
        routingRows.length ? current.routing : null,
        routingRows.length ? nextRouting : null,
        `accept:${requestId}`,
      ],
    );
    await client.query(
      "UPDATE flow_authoring_operations SET status='accepted' WHERE request_id=$1 AND status='proposed'",
      [requestId],
    );
    await recordAuthoringEvent(client, {
      projectId: flow.project_id,
      flowId: flow.id,
      sessionId,
      requestId,
      actorId,
      type: 'proposal_accepted',
      payload: { operationId: id, revision, operationCount: operations.length },
      idempotencyKey: `accept:${requestId}`,
    });
  }

  /** Descarta as propostas pendentes de um pedido no modo assistido, sem tocar no rascunho. */
  async discardProposals(client: Queryable, flow: FlowLockRow, requestId: string, actorId: string) {
    await client.query(
      "UPDATE flow_authoring_operations SET status='discarded' WHERE request_id=$1 AND status='proposed'",
      [requestId],
    );
    await recordAuthoringEvent(client, {
      projectId: flow.project_id,
      flowId: flow.id,
      requestId,
      actorId,
      type: 'proposal_discarded',
      payload: {},
      idempotencyKey: `discard:${requestId}`,
    });
  }

  /** Mesma regra das ferramentas: referências P04 têm de existir no projeto. */
  private async assertAcceptDependencies(
    client: Queryable,
    projectId: string,
    definition: FlowDefinition,
  ) {
    try {
      await assertFlowDependencies(client, projectId, definition);
    } catch (error) {
      throw new DomainError(
        'FLOW_PROPOSAL_STALE',
        error instanceof Error ? error.message : 'Dependência em falta.',
        409,
      );
    }
  }
}

export type { FlowLockRow, AuthoringRequestRow };
