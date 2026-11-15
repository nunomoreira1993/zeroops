import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  capabilityCategoryNeedsDevelopment,
  capabilityDevelopmentLinkSchema,
  capabilityDevelopmentStartSchema,
  capabilityDevelopmentVersionSchema,
  capabilitySettingsSchema,
  deliveryNodeConfig,
  developmentNodeConfig,
  flowReviewConfig,
  type CapabilityCategory,
  type CapabilityDevelopmentListView,
  type CapabilityDevelopmentState,
  type CapabilityDevelopmentView,
  type CapabilitySettingsView,
  type CreateTicket,
  type FlowDefinition,
  type ProjectPermission,
  type Ticket,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { activeRepository } from '../development/git-repositories.service.js';
import { activePipeline } from '../delivery/pipelines.service.js';
import { recordAuthoringEvent } from '../flows/flow-authoring.js';
import { logicHash, parseDefinition } from '../flows/flow-store.js';
import { parseInput } from '../identity/identity.validation.js';
import type { Queryable } from '../identity/membership.js';
import {
  projectPermissionContext,
  requireProjectPermission,
  userHasProjectPermission,
} from '../identity/project-permissions.js';
import type { CreateTicketOptions, TicketCreatedHook } from '../tickets/tickets.service.js';

interface DevelopmentRow {
  id: string;
  project_id: string;
  flow_id: string;
  capability_request_id: string;
  category: CapabilityCategory;
  title: string;
  requirement: string;
  acceptance_criteria: unknown;
  required: number | boolean;
  source_draft_version: number;
  source_draft_hash: string;
  ticket_id: string | null;
  repository_id: string;
  pipeline_id: string;
  development_flow_id: string;
  state: CapabilityDevelopmentState;
  state_reason: string | null;
  requested_by: string;
  publish_authorized_by: string | null;
  publish_authorized_at: Date | null;
  delivery_id: string | null;
  published_sha: string | null;
  published_digest: string | null;
  runtime_version: string | null;
  runtime_confirmed_at: Date | null;
  linked_draft_version: number | null;
  linked_at: Date | null;
  cancelled_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface SettingsRow {
  project_id: string;
  repository_id: string;
  pipeline_id: string;
  development_flow_id: string;
  version: number;
}

interface DeliveryRow {
  id: string;
  state: string;
  state_reason: string | null;
  integrated_sha: string | null;
  artifact_digest: string | null;
  external_url: string | null;
}

/** Criação do ticket do desenvolvimento (TicketsService injetado pela composição). */
export type CapabilityTicketFactory = (
  actor: User,
  input: CreateTicket,
  options: CreateTicketOptions,
) => Promise<Ticket>;

export interface CapabilityDevelopmentOptions {
  createTicket: CapabilityTicketFactory;
  /** Versão (commit) do runtime do ZeroOps em execução (`ZEROOPS_VERSION`). */
  runtimeVersion?: () => string | null | undefined;
}

const iso = (value: Date | string | null) =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();
const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/** Estados em que o processo ainda acompanha o ticket/entrega (sincronização). */
const SYNC_STATES: readonly CapabilityDevelopmentState[] = [
  'developing',
  'review',
  'publishing',
  'published',
  'failed',
  'reconciliation_required',
];

/**
 * Liga o ticket de desenvolvimento ao processo de capacidade, na transação da criação. Só o
 * primeiro ticket fica ligado: um segundo (start repetido em concorrência) falha e é revertido.
 * Registado antes do motor de fluxos para falhar antes de iniciar a execução.
 */
export const capabilityTicketCreated: TicketCreatedHook = async (client, ticket, options) => {
  if (!options.capabilityDevelopmentId) return;
  const updated = await client.query(
    `UPDATE capability_developments SET ticket_id=$1,state='developing',state_reason=NULL,
       version=version+1,updated_at=NOW(3)
     WHERE id=$2 AND project_id=$3 AND ticket_id IS NULL AND state='requested'`,
    [ticket.id, options.capabilityDevelopmentId, ticket.projectId],
  );
  if (!updated.rowCount)
    throw new DomainError(
      'CAPABILITY_TICKET_EXISTS',
      'O desenvolvimento desta capacidade já tem ticket.',
      409,
    );
  await recordEvent(client, options.capabilityDevelopmentId, 'ticket_created', ticket.createdBy, {
    ticketId: ticket.id,
  });
};

async function recordEvent(
  client: Queryable,
  developmentId: string,
  kind: string,
  actorId: string | null,
  payload: Record<string, unknown>,
) {
  await client.query(
    'INSERT INTO capability_development_events(development_id,kind,actor_id,payload) VALUES($1,$2,$3,$4)',
    [developmentId, kind, actorId, JSON.stringify(payload)],
  );
}

/**
 * P10 — desenvolvimento de capacidades em falta pedidas na autoria. Cada operação verifica a sua
 * permissão (`capabilities.develop` para iniciar/cancelar, `capabilities.publish` para autorizar a
 * publicação, `flows.edit` para associar ao rascunho, `repositories.manage` para os recursos). O
 * desenvolvimento reutiliza o fluxo de desenvolvimento do projeto (P08/P09): ticket, workspace,
 * review humano e entrega pela pipeline atribuída. Nada aqui ativa fluxos.
 */
export class CapabilityDevelopmentService {
  constructor(
    private readonly db: Database,
    private readonly options: CapabilityDevelopmentOptions,
  ) {}

  /** Recursos de capacidades do projeto e problemas que impedem iniciar desenvolvimentos. */
  async settings(actor: User, projectId: string): Promise<CapabilitySettingsView> {
    const context = await projectPermissionContext(this.db, actor, projectId);
    if (!context.permissions.includes('flows.view'))
      throw new DomainError('FORBIDDEN', 'Sem permissão para consultar capacidades.', 403);
    return this.settingsView(this.db, projectId, context.permissions);
  }

  /** Atribui ao projeto o repositório, a pipeline e o fluxo de desenvolvimento de capacidades. */
  async saveSettings(actor: User, projectId: string, raw: unknown) {
    const input = parseInput(capabilitySettingsSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'repositories.manage',
        true,
      );
      const current = (
        await client.query<SettingsRow>(
          'SELECT * FROM project_capability_settings WHERE project_id=$1 FOR UPDATE',
          [projectId],
        )
      ).rows[0];
      if (input.expectedVersion !== Number(current?.version ?? 0))
        throw new DomainError(
          'VERSION_CONFLICT',
          'As definições de capacidades foram alteradas entretanto. Recarregue.',
          409,
        );
      const issues = await this.resourceIssues(client, projectId, input);
      if (issues.length) throw new DomainError('INVALID_INPUT', issues.join(' '), 400);
      if (current)
        await client.query(
          `UPDATE project_capability_settings SET repository_id=$2,pipeline_id=$3,development_flow_id=$4,
             version=version+1,updated_by=$5,updated_at=NOW(3) WHERE project_id=$1`,
          [projectId, input.repositoryId, input.pipelineId, input.developmentFlowId, actor.id],
        );
      else
        await client.query(
          `INSERT INTO project_capability_settings(project_id,repository_id,pipeline_id,development_flow_id,updated_by)
           VALUES($1,$2,$3,$4,$5)`,
          [projectId, input.repositoryId, input.pipelineId, input.developmentFlowId, actor.id],
        );
      await this.audit(client, context.actor.id, 'capability.settings_saved', {
        projectId,
        repositoryId: input.repositoryId,
        pipelineId: input.pipelineId,
        developmentFlowId: input.developmentFlowId,
      });
      return this.settingsView(client, projectId, context.permissions);
    });
  }

  /** Processos de capacidade de um fluxo (sincronizados com ticket/entrega antes de mostrar). */
  async list(
    actor: User,
    projectId: string,
    flowId: string,
  ): Promise<CapabilityDevelopmentListView> {
    const context = await projectPermissionContext(this.db, actor, projectId);
    if (!context.permissions.includes('flows.view'))
      throw new DomainError('FORBIDDEN', 'Sem permissão para consultar capacidades.', 403);
    this.assertUuid(flowId);
    const ids = (
      await this.db.query<{ id: string }>(
        'SELECT id FROM capability_developments WHERE project_id=$1 AND flow_id=$2 ORDER BY created_at',
        [projectId, flowId],
      )
    ).rows.map((row) => row.id);
    for (const id of ids) await this.sync(id);
    const developments: CapabilityDevelopmentView[] = [];
    for (const id of ids) developments.push(await this.view(this.db, id, context.permissions));
    return {
      developments,
      settings: await this.settingsView(this.db, projectId, context.permissions),
      can: {
        develop: context.permissions.includes('capabilities.develop'),
        publish: context.permissions.includes('capabilities.publish'),
      },
    };
  }

  /**
   * Inicia (ou devolve, se já existir) o processo de um pedido de capacidade. Idempotente por
   * pedido: mensagens repetidas ou recuperação da sessão não criam jobs/tickets duplicados.
   */
  async start(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(capabilityDevelopmentStartSchema, raw);
    this.assertUuid(flowId);
    const outcome = await this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'capabilities.develop',
        true,
      );
      const request = (
        await client.query<{ id: string; flow_id: string; status: string }>(
          'SELECT id,flow_id,status FROM flow_capability_requests WHERE id=$1 AND project_id=$2 FOR UPDATE',
          [input.capabilityRequestId, projectId],
        )
      ).rows[0];
      if (!request || request.flow_id !== flowId)
        throw new DomainError('NOT_FOUND', 'Pedido de capacidade não encontrado neste fluxo.', 404);
      const existing = (
        await client.query<{ id: string }>(
          'SELECT id FROM capability_developments WHERE capability_request_id=$1',
          [request.id],
        )
      ).rows[0];
      if (existing) return { id: existing.id, created: false, permissions: context.permissions };
      if (request.status !== 'open')
        throw new DomainError(
          'CAPABILITY_REQUEST_CLOSED',
          'O pedido de capacidade foi descartado.',
          409,
        );
      const flow = (
        await client.query<{ flow_definition: unknown; draft_version: number }>(
          'SELECT flow_definition,draft_version FROM flows WHERE id=$1 AND project_id=$2',
          [flowId, projectId],
        )
      ).rows[0];
      if (!flow) throw new DomainError('NOT_FOUND', 'Fluxo não encontrado.', 404);
      const settings = (
        await client.query<SettingsRow>(
          'SELECT * FROM project_capability_settings WHERE project_id=$1',
          [projectId],
        )
      ).rows[0];
      const needsDevelopment = capabilityCategoryNeedsDevelopment(input.category);
      if (needsDevelopment) {
        if (!settings)
          throw new DomainError(
            'CAPABILITY_RESOURCES_MISSING',
            'O projeto não tem repositório/pipeline de capacidades atribuídos.',
            409,
          );
        const issues = await this.resourceIssues(client, projectId, {
          repositoryId: settings.repository_id,
          pipelineId: settings.pipeline_id,
          developmentFlowId: settings.development_flow_id,
        });
        if (issues.length)
          throw new DomainError('CAPABILITY_RESOURCES_INVALID', issues.join(' '), 409);
      }
      if (input.authorizePublish && !context.permissions.includes('capabilities.publish'))
        throw new DomainError(
          'FORBIDDEN',
          'Autorizar a publicação exige capabilities.publish.',
          403,
        );
      const id = randomUUID();
      await client.query(
        `INSERT INTO capability_developments(id,project_id,flow_id,capability_request_id,category,title,
           requirement,acceptance_criteria,required,source_draft_version,source_draft_hash,repository_id,
           pipeline_id,development_flow_id,state,state_reason,requested_by,publish_authorized_by,publish_authorized_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'requested',$15,$16,$17,$18)`,
        [
          id,
          projectId,
          flowId,
          request.id,
          input.category,
          input.title,
          input.requirement,
          JSON.stringify(input.acceptanceCriteria),
          input.required ? 1 : 0,
          Number(flow.draft_version),
          this.draftHash(flow.flow_definition),
          // Categorias sem código: sem recursos atribuídos guarda o próprio fluxo como referência.
          settings?.repository_id ?? null,
          settings?.pipeline_id ?? null,
          settings?.development_flow_id ?? flowId,
          needsDevelopment
            ? null
            : 'Configuração/agente: configure no catálogo e associe ao rascunho.',
          context.actor.id,
          input.authorizePublish ? context.actor.id : null,
          input.authorizePublish ? new Date() : null,
        ],
      );
      await recordEvent(client, id, 'requested', context.actor.id, {
        category: input.category,
        required: input.required,
        sourceDraftVersion: Number(flow.draft_version),
        publishAuthorized: input.authorizePublish,
      });
      await recordAuthoringEvent(client, {
        projectId,
        flowId,
        actorId: context.actor.id,
        type: 'capability_development',
        payload: {
          developmentId: id,
          title: input.title,
          category: input.category,
          state: 'requested',
        },
        idempotencyKey: `capability-development:${id}:requested`,
      });
      await this.audit(client, context.actor.id, 'capability.development_requested', {
        projectId,
        flowId,
        developmentId: id,
        capabilityRequestId: request.id,
        category: input.category,
      });
      return { id, created: true, permissions: context.permissions };
    });
    await this.ensureTicket(actor, projectId, outcome.id);
    return this.view(this.db, outcome.id, outcome.permissions);
  }

  /** Autoriza a publicação (permissão separada); acorda a etapa de entrega em espera. */
  async authorizePublish(actor: User, projectId: string, flowId: string, id: string, raw: unknown) {
    const input = parseInput(capabilityDevelopmentVersionSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'capabilities.publish',
        true,
      );
      const row = await this.locked(client, projectId, flowId, id, input.expectedVersion);
      if (!capabilityCategoryNeedsDevelopment(row.category) || !row.ticket_id)
        throw new DomainError('INVALID_STATE', 'Este pedido não tem publicação a autorizar.', 409);
      if (!['developing', 'review', 'publishing'].includes(row.state))
        throw new DomainError('INVALID_STATE', 'O estado atual não aceita autorização.', 409);
      await client.query(
        `UPDATE capability_developments SET publish_authorized_by=$2,publish_authorized_at=NOW(3),
           version=version+1,updated_at=NOW(3) WHERE id=$1`,
        [id, context.actor.id],
      );
      await client.query(
        `UPDATE flow_executions SET wake_at=NOW(3) WHERE ticket_id=$1 AND status IN ('running','waiting')`,
        [row.ticket_id],
      );
      await recordEvent(client, id, 'publish_authorized', context.actor.id, {});
      await this.audit(client, context.actor.id, 'capability.publish_authorized', {
        projectId,
        flowId,
        developmentId: id,
        ticketId: row.ticket_id,
      });
      return this.view(client, id, context.permissions);
    });
  }

  /** Cancela o pedido: ticket, workspace e evidências são preservados; a publicação fica vedada. */
  async cancel(actor: User, projectId: string, flowId: string, id: string, raw: unknown) {
    const input = parseInput(capabilityDevelopmentVersionSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'capabilities.develop',
        true,
      );
      const row = await this.locked(client, projectId, flowId, id, input.expectedVersion);
      if (row.state === 'linked' || row.state === 'cancelled')
        throw new DomainError('INVALID_STATE', 'O pedido já não pode ser cancelado.', 409);
      const reason =
        row.state === 'publishing'
          ? 'Cancelado durante a publicação: o rollout já pedido é reconciliado pela pipeline.'
          : 'Cancelado; ticket, workspace e evidências preservados.';
      await client.query(
        `UPDATE capability_developments SET state='cancelled',state_reason=$2,cancelled_by=$3,
           cancelled_at=NOW(3),version=version+1,updated_at=NOW(3) WHERE id=$1`,
        [id, reason, context.actor.id],
      );
      await recordEvent(client, id, 'cancelled', context.actor.id, { from: row.state });
      await recordAuthoringEvent(client, {
        projectId,
        flowId,
        actorId: context.actor.id,
        type: 'capability_development',
        payload: { developmentId: id, title: row.title, state: 'cancelled' },
        idempotencyKey: `capability-development:${id}:cancelled`,
      });
      await this.audit(client, context.actor.id, 'capability.development_cancelled', {
        projectId,
        flowId,
        developmentId: id,
        from: row.state,
      });
      return this.view(client, id, context.permissions);
    });
  }

  /**
   * Associa a capacidade disponível ao rascunho (alteração auditada com nova versão do rascunho).
   * Se o rascunho mudou desde o pedido, exige confirmação explícita de que continua aplicável. O
   * fluxo continua em rascunho: a ativação é sempre explícita.
   */
  async link(actor: User, projectId: string, flowId: string, id: string, raw: unknown) {
    const input = parseInput(capabilityDevelopmentLinkSchema, raw);
    await this.sync(id);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      const flow = (
        await client.query<{ flow_definition: unknown; draft_version: number }>(
          'SELECT flow_definition,draft_version FROM flows WHERE id=$1 AND project_id=$2 FOR UPDATE',
          [flowId, projectId],
        )
      ).rows[0];
      if (!flow) throw new DomainError('NOT_FOUND', 'Fluxo não encontrado.', 404);
      const row = await this.locked(client, projectId, flowId, id, input.expectedVersion);
      const linkable =
        row.state === 'available' ||
        (row.state === 'requested' && !capabilityCategoryNeedsDevelopment(row.category));
      if (!linkable)
        throw new DomainError(
          'CAPABILITY_NOT_AVAILABLE',
          'A capacidade ainda não está disponível no runtime.',
          409,
        );
      if (Number(flow.draft_version) !== input.expectedDraftVersion)
        throw new DomainError('VERSION_CONFLICT', 'O rascunho foi alterado entretanto.', 409);
      const changed = this.draftHash(flow.flow_definition) !== row.source_draft_hash;
      if (changed && !input.acknowledgeDraftChanged)
        throw new DomainError(
          'CAPABILITY_DRAFT_CHANGED',
          'O rascunho mudou desde o pedido: confirme que a capacidade continua aplicável.',
          409,
        );
      await client.query(
        'UPDATE flows SET draft_version=draft_version+1,updated_at=NOW(3) WHERE id=$1',
        [flowId],
      );
      const draftVersion = Number(flow.draft_version) + 1;
      await client.query(
        `UPDATE capability_developments SET state='linked',state_reason=NULL,linked_draft_version=$2,
           linked_by=$3,linked_at=NOW(3),version=version+1,updated_at=NOW(3) WHERE id=$1`,
        [id, draftVersion, context.actor.id],
      );
      await recordEvent(client, id, 'linked', context.actor.id, {
        draftVersion,
        draftChanged: changed,
        sha: row.published_sha,
      });
      await recordAuthoringEvent(client, {
        projectId,
        flowId,
        actorId: context.actor.id,
        type: 'capability_linked',
        payload: {
          developmentId: id,
          title: row.title,
          draftVersion,
          draftChanged: changed,
          sha: row.published_sha,
          runtimeVersion: row.runtime_version,
        },
        idempotencyKey: `capability-development:${id}:linked`,
      });
      await this.audit(client, context.actor.id, 'capability.linked', {
        projectId,
        flowId,
        developmentId: id,
        draftVersion,
        draftChanged: changed,
        sha: row.published_sha,
      });
      return this.view(client, id, context.permissions);
    });
  }

  /** Sincroniza processos ativos (ciclo de manutenção do executor). */
  async syncActive(limit = 50) {
    const placeholders = SYNC_STATES.map((_, index) => `$${index + 1}`).join(',');
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM capability_developments WHERE ticket_id IS NOT NULL AND state IN (${placeholders})
        ORDER BY updated_at LIMIT ${Math.max(1, Math.min(limit, 500))}`,
      [...SYNC_STATES],
    );
    for (const row of rows.rows) await this.sync(row.id);
    return rows.rowCount;
  }

  /**
   * Deriva o estado do processo do ticket (execução, review) e da entrega (P09). `available` só
   * quando a versão em execução do runtime é a publicada; terminais nunca regridem.
   */
  async sync(id: string) {
    await this.db.transaction(async (client) => {
      const row = (
        await client.query<DevelopmentRow>(
          'SELECT * FROM capability_developments WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!row?.ticket_id || !SYNC_STATES.includes(row.state)) return;
      const next = await this.derive(client, row);
      if (!next || (next.state === row.state && next.reason === row.state_reason)) return;
      await client.query(
        `UPDATE capability_developments SET state=$2,state_reason=$3,delivery_id=COALESCE($4,delivery_id),
           published_sha=COALESCE($5,published_sha),published_digest=COALESCE($6,published_digest),
           runtime_version=COALESCE($7,runtime_version),
           runtime_confirmed_at=CASE WHEN $8 THEN NOW(3) ELSE runtime_confirmed_at END,
           version=version+1,updated_at=NOW(3) WHERE id=$1`,
        [
          id,
          next.state,
          next.reason,
          next.deliveryId ?? null,
          next.sha ?? null,
          next.digest ?? null,
          next.runtimeVersion ?? null,
          next.state === 'available' ? 1 : 0,
        ],
      );
      if (next.state !== row.state) {
        await recordEvent(client, id, `state_${next.state}`, null, {
          from: row.state,
          reason: next.reason,
          sha: next.sha ?? null,
          runtimeVersion: next.runtimeVersion ?? null,
        });
        await recordAuthoringEvent(client, {
          projectId: row.project_id,
          flowId: row.flow_id,
          type: 'capability_development',
          payload: { developmentId: id, title: row.title, state: next.state, reason: next.reason },
          idempotencyKey: `capability-development:${id}:${row.version}:${next.state}`,
        });
      }
    });
  }

  private async derive(
    client: Queryable,
    row: DevelopmentRow,
  ): Promise<{
    state: CapabilityDevelopmentState;
    reason: string | null;
    deliveryId?: string;
    sha?: string | null;
    digest?: string | null;
    runtimeVersion?: string | null;
  } | null> {
    const delivery = await this.latestDelivery(client, row.ticket_id!);
    if (delivery) {
      const base = { deliveryId: delivery.id };
      switch (delivery.state) {
        case 'published': {
          const runtime = this.options.runtimeVersion?.() ?? null;
          const sha = delivery.integrated_sha;
          if (sha && runtime && runtime.startsWith(sha))
            return {
              ...base,
              state: 'available',
              reason: null,
              sha,
              digest: delivery.artifact_digest,
              runtimeVersion: runtime,
            };
          return {
            ...base,
            state: 'published',
            reason: `Publicada; a aguardar a versão ${sha?.slice(0, 12) ?? '?'} no runtime (ativo: ${runtime ?? 'desconhecido'}).`,
            sha,
            digest: delivery.artifact_digest,
          };
        }
        case 'uncertain':
          return {
            ...base,
            state: 'reconciliation_required',
            reason: delivery.state_reason ?? 'Resultado do rollout incerto: a reconciliar.',
          };
        case 'failed':
        case 'blocked':
        case 'cancelled':
          return {
            ...base,
            state: 'failed',
            reason: delivery.state_reason ?? `Entrega ${delivery.state}.`,
          };
        case 'conflict':
        case 'rework':
          return {
            ...base,
            state: 'developing',
            reason: delivery.state_reason ?? 'Regressou ao desenvolvimento.',
          };
        default:
          return { ...base, state: 'publishing', reason: delivery.state_reason };
      }
    }
    const execution = await this.execution(client, row.ticket_id!);
    if (!execution) return { state: 'developing', reason: null };
    if (execution.status === 'failed' || execution.status === 'cancelled')
      return { state: 'failed', reason: `A execução do fluxo terminou (${execution.status}).` };
    if (execution.reviewPending) return { state: 'review', reason: null };
    // Review aprovado mas a entrega ainda não foi criada: só falta a autorização de publicação.
    if (execution.deliveryPending && !row.publish_authorized_by)
      return {
        state: 'review',
        reason: 'Review aprovado; a publicação aguarda autorização (capabilities.publish).',
      };
    if (execution.status === 'completed')
      return { state: 'failed', reason: 'O fluxo de desenvolvimento terminou sem publicação.' };
    return { state: 'developing', reason: null };
  }

  private async latestDelivery(client: Queryable, ticketId: string) {
    return (
      (
        await client.query<DeliveryRow>(
          `SELECT id,state,state_reason,integrated_sha,artifact_digest,external_url FROM delivery_runs
            WHERE ticket_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
          [ticketId],
        )
      ).rows[0] ?? null
    );
  }

  private async execution(client: Queryable, ticketId: string) {
    const row = (
      await client.query<{ status: string; current_node: string | null; flow_definition: unknown }>(
        `SELECT e.status,e.current_node,v.flow_definition FROM flow_executions e
           JOIN flow_versions v ON v.id=e.version_id WHERE e.ticket_id=$1`,
        [ticketId],
      )
    ).rows[0];
    if (!row) return null;
    let reviewPending = false;
    let deliveryPending = false;
    if (row.status === 'waiting' && row.current_node) {
      const definition = json<FlowDefinition | null>(row.flow_definition, null);
      const node = definition?.nodes.find((item) => item.id === row.current_node);
      reviewPending = Boolean(node && flowReviewConfig(node));
      deliveryPending = node?.op === 'action' && node.config.action === 'deliver';
    }
    return { status: row.status, reviewPending, deliveryPending };
  }

  /** Cria o ticket do desenvolvimento se ainda não existir (start repetido retoma). */
  private async ensureTicket(actor: User, projectId: string, id: string) {
    const row = (
      await this.db.query<DevelopmentRow>('SELECT * FROM capability_developments WHERE id=$1', [id])
    ).rows[0];
    if (!row || row.ticket_id || row.state !== 'requested') return;
    if (!capabilityCategoryNeedsDevelopment(row.category)) return;
    const criteria = json<string[]>(row.acceptance_criteria, []);
    const description = [
      `Pedido de capacidade (P10) originado no rascunho v${row.source_draft_version} do fluxo ${row.flow_id}.`,
      '',
      row.requirement,
      '',
      'Critérios de aceitação:',
      ...criteria.map((item) => `- ${item}`),
    ].join('\n');
    try {
      await this.options.createTicket(
        { ...actor, projectId },
        {
          title: row.title,
          description: description.slice(0, 20000),
          category: 'improvement',
          environment: 'quality',
          priority: 'medium',
        },
        { flowId: row.development_flow_id, capabilityDevelopmentId: id, origin: 'portal_team' },
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CAPABILITY_TICKET_EXISTS') return;
      await this.db.query(
        `UPDATE capability_developments SET state_reason=$2,updated_at=NOW(3) WHERE id=$1 AND ticket_id IS NULL`,
        [
          id,
          `Falha ao criar o ticket: ${error instanceof Error ? error.message : 'erro'}`.slice(
            0,
            1000,
          ),
        ],
      );
      throw error;
    }
  }

  private async locked(
    client: Queryable,
    projectId: string,
    flowId: string,
    id: string,
    expectedVersion: number,
  ) {
    this.assertUuid(flowId);
    this.assertUuid(id);
    const row = (
      await client.query<DevelopmentRow>(
        'SELECT * FROM capability_developments WHERE id=$1 AND project_id=$2 AND flow_id=$3 FOR UPDATE',
        [id, projectId, flowId],
      )
    ).rows[0];
    if (!row)
      throw new DomainError('NOT_FOUND', 'Desenvolvimento de capacidade não encontrado.', 404);
    if (Number(row.version) !== expectedVersion)
      throw new DomainError(
        'VERSION_CONFLICT',
        'O pedido foi alterado entretanto. Recarregue.',
        409,
      );
    return row;
  }

  private assertUuid(value: string) {
    if (!z.uuid().safeParse(value).success)
      throw new DomainError('INVALID_INPUT', 'Identificador inválido.', 400);
  }

  private draftHash(definition: unknown) {
    try {
      return logicHash(parseDefinition(json(definition, definition)));
    } catch {
      return '0'.repeat(64);
    }
  }

  /** Recursos atribuídos válidos: repositório e pipeline ativos e fluxo de desenvolvimento ativo. */
  private async resourceIssues(
    client: Queryable,
    projectId: string,
    input: { repositoryId: string; pipelineId: string; developmentFlowId: string },
  ) {
    const issues: string[] = [];
    const repository = await activeRepository(client, projectId, input.repositoryId);
    if (!repository) issues.push('O repositório não existe neste projeto ou está arquivado.');
    const pipeline = await activePipeline(client, projectId, input.pipelineId);
    if (!pipeline) issues.push('A pipeline não existe neste projeto ou está arquivada.');
    else if (pipeline.repository_id !== input.repositoryId)
      issues.push('A pipeline tem de publicar o repositório de capacidades.');
    const flow = (
      await client.query<{ flow_definition: unknown }>(
        `SELECT v.flow_definition FROM flows f JOIN flow_versions v ON v.id=f.published_version_id
          WHERE f.id=$1 AND f.project_id=$2`,
        [input.developmentFlowId, projectId],
      )
    ).rows[0];
    if (!flow) {
      issues.push('O fluxo de desenvolvimento tem de ter uma versão ativa.');
      return issues;
    }
    const definition = json<FlowDefinition | null>(flow.flow_definition, null);
    const nodes = definition?.nodes ?? [];
    if (
      !nodes.some(
        (node) =>
          node.op === 'copilot_task' &&
          node.config.mode === 'develop' &&
          developmentNodeConfig(node).repositoryId === input.repositoryId,
      )
    )
      issues.push('O fluxo de desenvolvimento não desenvolve no repositório de capacidades.');
    if (!nodes.some((node) => flowReviewConfig(node)))
      issues.push('O fluxo de desenvolvimento não tem review humano configurado.');
    if (
      !nodes.some(
        (node) =>
          node.op === 'action' &&
          node.config.action === 'deliver' &&
          deliveryNodeConfig(node).pipelineId === input.pipelineId,
      )
    )
      issues.push('O fluxo de desenvolvimento não publica pela pipeline de capacidades.');
    return issues;
  }

  private async settingsView(
    client: Queryable,
    projectId: string,
    permissions: readonly ProjectPermission[],
  ): Promise<CapabilitySettingsView> {
    const row = (
      await client.query<SettingsRow>(
        'SELECT * FROM project_capability_settings WHERE project_id=$1',
        [projectId],
      )
    ).rows[0];
    return {
      projectId,
      version: Number(row?.version ?? 0),
      repositoryId: row?.repository_id ?? null,
      pipelineId: row?.pipeline_id ?? null,
      developmentFlowId: row?.development_flow_id ?? null,
      canManage: permissions.includes('repositories.manage'),
      issues: row
        ? await this.resourceIssues(client, projectId, {
            repositoryId: row.repository_id,
            pipelineId: row.pipeline_id,
            developmentFlowId: row.development_flow_id,
          })
        : ['Sem recursos de capacidades atribuídos ao projeto.'],
    };
  }

  private async view(
    client: Queryable,
    id: string,
    permissions: readonly ProjectPermission[],
  ): Promise<CapabilityDevelopmentView> {
    const row = (
      await client.query<
        DevelopmentRow & {
          draft_hash_source: unknown;
          ticket_key: string | null;
          ticket_status: string | null;
          requester: string | null;
          authorizer: string | null;
        }
      >(
        `SELECT d.*,f.flow_definition AS draft_hash_source,t.key AS ticket_key,t.status AS ticket_status,
                ru.display_name AS requester,au.display_name AS authorizer
           FROM capability_developments d JOIN flows f ON f.id=d.flow_id
           LEFT JOIN tickets t ON t.id=d.ticket_id
           LEFT JOIN users ru ON ru.id=d.requested_by
           LEFT JOIN users au ON au.id=d.publish_authorized_by
          WHERE d.id=$1`,
        [id],
      )
    ).rows[0];
    if (!row)
      throw new DomainError('NOT_FOUND', 'Desenvolvimento de capacidade não encontrado.', 404);
    const delivery = row.ticket_id ? await this.latestDelivery(client, row.ticket_id) : null;
    const workspace = row.ticket_id
      ? (
          await client.query<{
            id: string;
            branch: string;
            base_sha: string | null;
            head_sha: string | null;
            tests_passed: number;
          }>(
            `SELECT id,branch,base_sha,head_sha,tests_passed FROM development_workspaces
              WHERE ticket_id=$1 AND repository_id=$2 ORDER BY created_at DESC LIMIT 1`,
            [row.ticket_id, row.repository_id],
          )
        ).rows[0]
      : undefined;
    const pullRequest = workspace
      ? (
          await client.query<{ url: string | null }>(
            `SELECT url FROM development_publications WHERE workspace_id=$1 AND kind='pull_request'
              ORDER BY updated_at DESC LIMIT 1`,
            [workspace.id],
          )
        ).rows[0]
      : undefined;
    const execution = row.ticket_id ? await this.execution(client, row.ticket_id) : null;
    const events = (
      await client.query<{
        id: number;
        kind: string;
        actor: string | null;
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT e.id,e.kind,u.display_name AS actor,e.payload,e.created_at
           FROM capability_development_events e LEFT JOIN users u ON u.id=e.actor_id
          WHERE e.development_id=$1 ORDER BY e.id DESC LIMIT 50`,
        [id],
      )
    ).rows;
    const authorizerValid =
      row.publish_authorized_by !== null &&
      (await userHasProjectPermission(
        client,
        row.publish_authorized_by,
        row.project_id,
        'capabilities.publish',
      ));
    const needsDevelopment = capabilityCategoryNeedsDevelopment(row.category);
    const state = row.state;
    return {
      id: row.id,
      projectId: row.project_id,
      flowId: row.flow_id,
      capabilityRequestId: row.capability_request_id,
      category: row.category,
      title: row.title,
      requirement: row.requirement,
      acceptanceCriteria: json<string[]>(row.acceptance_criteria, []),
      required: Boolean(Number(row.required)),
      state,
      stateReason: row.state_reason,
      sourceDraftVersion: Number(row.source_draft_version),
      draftChanged: this.draftHash(row.draft_hash_source) !== row.source_draft_hash,
      ticket:
        row.ticket_id && row.ticket_key
          ? { id: row.ticket_id, key: row.ticket_key, status: row.ticket_status ?? '' }
          : null,
      repositoryId: row.repository_id,
      pipelineId: row.pipeline_id,
      requestedBy: row.requester,
      publishAuthorizedBy: authorizerValid ? row.authorizer : null,
      publishAuthorizedAt: authorizerValid ? iso(row.publish_authorized_at) : null,
      development: workspace
        ? {
            branch: workspace.branch,
            baseSha: workspace.base_sha,
            headSha: workspace.head_sha,
            pullRequestUrl: pullRequest?.url ?? null,
            testsPassed: Boolean(Number(workspace.tests_passed)),
            reviewPending: Boolean(execution?.reviewPending),
          }
        : null,
      delivery: delivery
        ? {
            id: delivery.id,
            state: delivery.state,
            stateReason: delivery.state_reason,
            integratedSha: delivery.integrated_sha,
            artifactDigest: delivery.artifact_digest,
            externalUrl: delivery.external_url,
          }
        : null,
      publishedSha: row.published_sha,
      publishedDigest: row.published_digest,
      runtimeVersion: row.runtime_version,
      runtimeConfirmedAt: iso(row.runtime_confirmed_at),
      linkedDraftVersion:
        row.linked_draft_version === null ? null : Number(row.linked_draft_version),
      linkedAt: iso(row.linked_at),
      cancelledAt: iso(row.cancelled_at),
      version: Number(row.version),
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
      can: {
        authorizePublish:
          needsDevelopment &&
          permissions.includes('capabilities.publish') &&
          !authorizerValid &&
          row.ticket_id !== null &&
          ['developing', 'review', 'publishing'].includes(state),
        cancel:
          permissions.includes('capabilities.develop') &&
          state !== 'linked' &&
          state !== 'cancelled',
        link:
          permissions.includes('flows.edit') &&
          (state === 'available' || (state === 'requested' && !needsDevelopment)),
      },
      nextStep: this.nextStep(row, authorizerValid, Boolean(execution?.reviewPending)),
      events: events.map((event) => ({
        id: Number(event.id),
        kind: event.kind,
        actor: event.actor,
        payload: json<Record<string, unknown>>(event.payload, {}),
        createdAt: iso(event.created_at)!,
      })),
    };
  }

  private nextStep(row: DevelopmentRow, authorized: boolean, reviewPending: boolean) {
    const needsDevelopment = capabilityCategoryNeedsDevelopment(row.category);
    switch (row.state) {
      case 'requested':
        return needsDevelopment
          ? 'A criar o ticket de desenvolvimento (repita «Iniciar» se falhou).'
          : 'Configure a capacidade no catálogo do projeto e associe-a ao rascunho.';
      case 'developing':
        return authorized
          ? 'Em desenvolvimento e testes no workspace isolado.'
          : 'Em desenvolvimento. A publicação vai precisar de autorização (capabilities.publish).';
      case 'review':
        return reviewPending
          ? 'A aguardar o review humano configurado no fluxo de desenvolvimento.'
          : 'Em review.';
      case 'publishing':
        return authorized
          ? 'Rollout em curso pelo operador; a confirmar a versão no runtime.'
          : 'A aguardar autorização de publicação (capabilities.publish).';
      case 'published':
        return 'Publicada; a confirmar a versão ativa no runtime.';
      case 'available':
        return 'Disponível no runtime: associe-a ao rascunho (não ativa o fluxo).';
      case 'linked':
        return 'Associada ao rascunho. Ative o fluxo quando estiver pronto.';
      case 'cancelled':
        return 'Cancelado. O trabalho feito ficou preservado no ticket.';
      case 'failed':
        return 'Falhou: veja o ticket de desenvolvimento e a entrega.';
      case 'reconciliation_required':
        return 'Resultado do rollout incerto: o operador está a reconciliar; não repita a publicação.';
      default:
        return '';
    }
  }

  private async audit(
    client: Queryable,
    actorId: string,
    action: string,
    details: Record<string, unknown>,
  ) {
    await client.query('INSERT INTO audit_events(id,actor_id,action,details) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      actorId,
      action,
      JSON.stringify(details),
    ]);
  }
}
