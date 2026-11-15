import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  applyFlowOperations,
  decisionOptions,
  healthAlertKey,
  flowAssistantResponseSchema,
  flowAuthoringModeSchema,
  flowAuthoringRequestSchema,
  flowAuthoringUndoSchema,
  flowChangeKind,
  flowDefinitionSchema,
  flowMatches,
  flowReviewConfig,
  flowScenarioSchema,
  flowSchemaVersion,
  flowSettingsSchema,
  healthAlertFlowCreateSchema,
  healthAlertFlowLinkSchema,
  healthAlertTypes,
  parseRoutingPolicy,
  portLabel,
  sameRoutingPolicy,
  selectFlow,
  simulateFlow,
  validateFlowDefinition,
  type FlowActivationKind,
  type FlowActivationView,
  type FlowAssistantRequestView,
  type FlowAuthoringMode,
  type FlowAuthoringStateView,
  type FlowDefinition,
  type FlowDetail,
  type FlowMatch,
  type FlowPendingChanges,
  type FlowRoutingPolicy,
  type FlowStepOutput,
  type FlowStepView,
  type FlowSummary,
  type HealthAlertFlowLink,
  type TicketFlowView,
  type TicketOrigin,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { copilotReady } from '../agents/agent-auto-runs.js';
import { AgentProfilesService } from '../agents/agent-profiles.service.js';
import { activeRepositoryIds } from '../development/git-repositories.service.js';
import { activePipelineIds } from '../delivery/pipelines.service.js';
import {
  linkedCapabilities,
  pendingCapabilityDependencies,
} from '../development/capability-gates.js';
import { parseInput } from '../identity/identity.validation.js';
import { ticketIncidentView } from '../incidents/incident-view.js';
import { requireMember, type Queryable } from '../identity/membership.js';
import { requireProjectPermission } from '../identity/project-permissions.js';
import { HEALTH_CATALOG } from '../health/health-catalog.js';
import { findTicket } from '../tickets/tickets.queries.js';
import { canDecide, FlowEngine, type ExecutionRow, type StepRow } from './flow-engine.js';
import { activationTestEvidence } from './flow-simulation.service.js';
import {
  generalFlowTemplate,
  healthFlowTemplate,
  maintenanceFlowTemplate,
} from './flow-templates.js';
import {
  ensureDefaultFlows,
  parseAlertKeys,
  parseDefinition,
  activePolicy,
  parseMatch,
  publishedFlows,
  type FlowRow,
} from './flow-store.js';
import {
  assertPinnedReferences,
  buildFlowManifest,
  manifestHash,
  normalizedRouting,
} from './flow-manifest.js';
import { FlowAuthoringStore, recordAuthoringEvent } from './flow-authoring.js';
import { recordJobEvent } from '../agents/job-leases.js';

const idSchema = z.uuid();
const createSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  template: z.enum(['blank', 'general', 'health', 'maintenance']).default('blank'),
  description: z.string().trim().max(500).default(''),
});
const draftSchema = z.strictObject({
  expectedDraftVersion: z.number().int().min(1),
  definition: flowDefinitionSchema,
});
const publishSchema = z.strictObject({ expectedDraftVersion: z.number().int().min(1) });
const simulateSchema = z.strictObject({
  ticketId: z.uuid().nullish(),
  scenario: flowScenarioSchema,
  definition: flowDefinitionSchema.optional(),
});
const messageSchema = z.strictObject({ message: z.string().trim().min(2).max(2000) });
const resolutionSchema = z.strictObject({
  resolution: z.enum(['accepted', 'discarded']),
  expectedDraftVersion: z.number().int().min(1).optional(),
});
const applySchema = z.strictObject({ idempotencyKey: z.string().trim().min(8).max(80) });

/** Fluxo novo sem modelo: uma análise do Copilot e o fim, para continuar por conversa ou à mão. */
const blankDefinition = (): FlowDefinition => ({
  start: 'analise',
  nodes: [
    {
      id: 'analise',
      op: 'copilot_task',
      label: 'Análise do Copilot',
      config: { mode: 'analysis' },
    },
    { id: 'resolvido', op: 'end', label: 'Resolvido', config: { outcome: 'resolved' } },
  ],
  edges: [
    { id: 'analise-success', source: 'analise', port: 'success', target: 'resolvido' },
    { id: 'analise-failure', source: 'analise', port: 'failure', target: 'resolvido' },
  ],
  layout: { analise: { x: 0, y: 0 }, resolvido: { x: 0, y: 160 } },
});

const templates = {
  general: generalFlowTemplate,
  health: healthFlowTemplate,
  maintenance: maintenanceFlowTemplate,
};

function flowAlertTypes() {
  return [
    ...healthAlertTypes.filter((type) => !type.key.startsWith('check:')),
    ...HEALTH_CATALOG.map((check) => ({
      key: healthAlertKey('check', check.id),
      title: check.title,
      group: check.group,
    })),
  ];
}

const iso = (value: Date | string | null) =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

type Routing = {
  priority: number;
  isDefault: boolean;
  match: FlowMatch;
  policy?: FlowRoutingPolicy | null;
};

function sameRouting(a: Routing, b: Routing) {
  return (
    sameRoutingPolicy(a.policy, b.policy) &&
    a.priority === b.priority &&
    a.isDefault === b.isDefault &&
    (Object.keys(a.match) as (keyof FlowMatch)[]).every(
      (key) => [...a.match[key]].sort().join('\0') === [...b.match[key]].sort().join('\0'),
    )
  );
}

interface AssistantRow {
  id: string;
  scope: 'flow' | 'ticket';
  message: string;
  status: FlowAssistantRequestView['status'];
  resolution: FlowAssistantRequestView['resolution'];
  assistant_response: unknown;
  base_draft_version: number | null;
  error_code: string | null;
  requester: string;
  created_at: Date;
  flow_id: string | null;
  ticket_id: string | null;
  requested_by: string;
  session_id?: string | null;
  authoring_mode?: FlowAuthoringMode | null;
}

function assistantView(row: AssistantRow): FlowAssistantRequestView {
  const response = flowAssistantResponseSchema.safeParse(row.assistant_response);
  return {
    id: row.id,
    scope: row.scope,
    message: row.message,
    status: row.status,
    resolution: row.resolution,
    response: row.assistant_response && response.success ? response.data : null,
    baseDraftVersion: row.base_draft_version,
    errorCode: row.error_code,
    requestedBy: row.requester,
    createdAt: iso(row.created_at)!,
    authoringMode: row.session_id ? (row.authoring_mode ?? 'assisted') : null,
  };
}

/** Informação visível ao cliente numa etapa: só mensagens públicas. */
function publicOutput(output: FlowStepOutput): FlowStepOutput {
  return {
    ...(output.clientMessage ? { clientMessage: output.clientMessage } : {}),
    ...(output.comment && output.commentVisibility === 'public'
      ? { comment: output.comment, commentVisibility: 'public' as const }
      : {}),
  };
}

/**
 * Configuração dos fluxos por projeto (administração) e acompanhamento por ticket. O editor
 * manual e o assistente escrevem a mesma definição (rascunho); a execução usa sempre a versão
 * publicada no momento em que o ticket entrou no fluxo.
 */
export class FlowsService {
  constructor(
    private readonly db: Database,
    private readonly engine: FlowEngine = new FlowEngine(db),
    private readonly agentProfiles: AgentProfilesService = new AgentProfilesService(db),
  ) {}

  private readonly authoring = new FlowAuthoringStore();

  /** Fluxos do projeto (cria os modelos por omissão na primeira visita). */
  async list(actor: User, projectId: string): Promise<FlowSummary[]> {
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(client, actor, projectId, 'flows.view', true);
      if (context.isAdmin) await ensureDefaultFlows(client, projectId);
      const rows = await client.query<FlowRow>(
        'SELECT * FROM flows WHERE project_id=$1 ORDER BY is_default, priority, name',
        [projectId],
      );
      return Promise.all(rows.rows.map((row) => this.summary(client, row)));
    });
  }

  /** Fluxo com rascunho, versões, problemas de validação e membros (para os responsáveis). */
  async get(actor: User, projectId: string, flowId: string): Promise<FlowDetail> {
    await requireProjectPermission(this.db, actor, projectId, 'flows.view');
    return this.detail(this.db, projectId, idSchema.parse(flowId));
  }

  /** Cria um fluxo vazio ou a partir de um modelo (rascunho, sem regra de seleção ativa). */
  async create(actor: User, projectId: string, raw: unknown): Promise<FlowDetail> {
    const input = parseInput(createSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      await this.requireInitialized(client, projectId, context.isAdmin);
      const id = await this.insertFlow(client, projectId, context.actor.id, input);
      return this.detail(client, projectId, id);
    });
  }

  /** Tipos de alerta da Saúde e o fluxo que trata os tickets de cada um. */
  async alertFlows(actor: User, projectId: string): Promise<HealthAlertFlowLink[]> {
    await requireProjectPermission(this.db, actor, projectId, 'flows.view');
    return this.alertLinks(this.db, projectId);
  }

  /**
   * Associa (ou retira, com `flowId: null`) o fluxo próprio de um tipo de alerta. Altera o que
   * está em serviço, por isso exige `flows.activate` e fica no histórico de ativações.
   */
  async linkAlertFlow(actor: User, projectId: string, raw: unknown) {
    const input = parseInput(healthAlertFlowLinkSchema, raw);
    const key = input.alertKey;
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'flows.activate',
        true,
      );
      const previous = (
        await client.query<{ flow_id: string }>(
          'SELECT flow_id FROM health_alert_flows WHERE project_id=$1 AND alert_key=$2 FOR UPDATE',
          [projectId, key],
        )
      ).rows[0]?.flow_id;
      if (input.flowId) {
        const flow = await this.lockFlow(client, projectId, input.flowId);
        if (!flow.published_version_id)
          throw new DomainError(
            'FLOW_NOT_PUBLISHED',
            'Ative uma versão do fluxo antes de o associar a um alerta.',
            409,
          );
        if (previous === flow.id) return this.alertLinks(client, projectId);
        await this.saveAlertLink(client, projectId, key, flow.id, context.actor.id);
        await this.recordActivation(client, {
          projectId,
          flowId: flow.id,
          kind: 'alert_link',
          versionId: flow.published_version_id,
          actorId: context.actor.id,
          details: { alertKey: key, action: 'linked', previousFlowId: previous ?? null },
        });
      } else if (previous) {
        await client.query('DELETE FROM health_alert_flows WHERE project_id=$1 AND alert_key=$2', [
          projectId,
          key,
        ]);
        await this.recordActivation(client, {
          projectId,
          flowId: previous,
          kind: 'alert_link',
          versionId: null,
          actorId: context.actor.id,
          details: { alertKey: key, action: 'unlinked' },
        });
      }
      return this.alertLinks(client, projectId);
    });
  }

  /**
   * Cria um RASCUNHO próprio para um tipo de alerta a partir do modelo de incidentes da Saúde.
   * Não cria versão nem associação: o alerta só passa a usá-lo quando alguém com permissão o
   * ativar («Ativar esta versão»), o que reclama o alerta na mesma transação.
   */
  async createAlertFlow(actor: User, projectId: string, raw: unknown): Promise<FlowDetail> {
    const key = parseInput(healthAlertFlowCreateSchema, raw).alertKey;
    const type = flowAlertTypes().find((item) => item.key === key);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      await this.requireInitialized(client, projectId, context.isAdmin);
      const title = (type?.title ?? key).slice(0, 70);
      const id = await this.insertFlow(client, projectId, context.actor.id, {
        name: `Alerta: ${title}`,
        template: 'health',
        description: `Tickets abertos pelo alerta «${title}».`,
      });
      await client.query('UPDATE flows SET pending_alert_keys=$2 WHERE id=$1', [
        id,
        JSON.stringify([key]),
      ]);
      return this.detail(client, projectId, id);
    });
  }

  /** Administração inicializa os modelos (como rascunhos); delegados precisam disso feito. */
  private async requireInitialized(client: Queryable, projectId: string, isAdmin: boolean) {
    if (isAdmin) {
      await ensureDefaultFlows(client, projectId);
      return;
    }
    if (
      !(await client.query('SELECT id FROM flows WHERE project_id=$1 LIMIT 1', [projectId]))
        .rowCount
    )
      throw new DomainError(
        'FLOW_INITIALIZATION_REQUIRED',
        'A administração deve inicializar os fluxos do projeto antes da primeira criação.',
        409,
      );
  }

  private async recordActivation(
    client: Queryable,
    input: {
      projectId: string;
      flowId: string;
      kind: FlowActivationKind;
      versionId: string | null;
      actorId: string;
      baseDraftVersion?: number | null;
      previousVersionId?: string | null;
      manifestHash?: string | null;
      details?: Record<string, unknown>;
    },
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO flow_activations(id,project_id,flow_id,version_id,kind,actor_id,base_draft_version,
                                    previous_version_id,manifest_hash,activation_details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        input.projectId,
        input.flowId,
        input.versionId,
        input.kind,
        input.actorId,
        input.baseDraftVersion ?? null,
        input.previousVersionId ?? null,
        input.manifestHash ?? null,
        JSON.stringify(input.details ?? {}),
      ],
    );
    return id;
  }

  private async saveAlertLink(
    client: Queryable,
    projectId: string,
    alertKey: string,
    flowId: string,
    userId: string,
  ) {
    await client.query(
      `INSERT INTO health_alert_flows(project_id,alert_key,flow_id,updated_by) VALUES($1,$2,$3,$4)
       ON DUPLICATE KEY UPDATE flow_id=VALUES(flow_id),updated_by=VALUES(updated_by),updated_at=NOW(3)`,
      [projectId, alertKey, flowId, userId],
    );
  }

  private async alertLinks(client: Queryable, projectId: string): Promise<HealthAlertFlowLink[]> {
    const rows = (
      await client.query<{ alert_key: string; flow_id: string; name: string }>(
        `SELECT l.alert_key,l.flow_id,f.name FROM health_alert_flows l JOIN flows f ON f.id=l.flow_id
          WHERE l.project_id=$1`,
        [projectId],
      )
    ).rows;
    const pending = new Map<string, { id: string; name: string }>();
    for (const flow of (
      await client.query<{ id: string; name: string; pending_alert_keys: unknown }>(
        'SELECT id,name,pending_alert_keys FROM flows WHERE project_id=$1 AND pending_alert_keys IS NOT NULL ORDER BY name',
        [projectId],
      )
    ).rows)
      for (const key of parseAlertKeys(flow.pending_alert_keys))
        if (!pending.has(key)) pending.set(key, { id: flow.id, name: flow.name });
    return flowAlertTypes().map((type) => {
      const link = rows.find((row) => row.alert_key === type.key);
      const draft = pending.get(type.key);
      return {
        ...type,
        flowId: link?.flow_id ?? null,
        flowName: link?.name ?? null,
        pendingFlowId: draft?.id ?? null,
        pendingFlowName: draft?.name ?? null,
      };
    });
  }

  private async insertFlow(
    client: Queryable,
    projectId: string,
    userId: string,
    input: z.infer<typeof createSchema>,
  ) {
    await this.assertNameFree(client, projectId, input.name, null);
    const template = input.template === 'blank' ? null : templates[input.template]();
    const rows = (
      await client.query<{ priority: number; is_default: number | boolean }>(
        'SELECT priority,is_default FROM flows WHERE project_id=$1 FOR UPDATE',
        [projectId],
      )
    ).rows;
    const used = new Set(rows.map((row) => Number(row.priority)));
    const top = Math.max(
      0,
      ...rows.filter((row) => !Number(row.is_default)).map((row) => Number(row.priority)),
    );
    // Depois da última regra; perto do limite usa a prioridade livre mais alta (únicas por projeto).
    let priority = Math.min(top + 10, 998);
    while (used.has(priority) && priority > 1) priority -= 1;
    if (used.has(priority))
      throw new DomainError(
        'FLOW_PRIORITY_TAKEN',
        'Não há prioridades livres. Reorganize as prioridades dos fluxos existentes.',
        409,
      );
    const id = randomUUID();
    await client.query(
      `INSERT INTO flows(id,project_id,name,description,template,priority,is_default,flow_match,flow_definition,created_by)
       VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9)`,
      [
        id,
        projectId,
        input.name,
        input.description || template?.description || '',
        template?.template ?? null,
        priority,
        template?.match ?? { origins: [], categories: [], environments: [], priorities: [] },
        template?.definition ?? blankDefinition(),
        userId,
      ],
    );
    return id;
  }

  /**
   * Grava o rascunho (editor manual). Mover etapas só altera a disposição; a ordem de execução
   * vem das ligações. `expectedDraftVersion` evita perder alterações de outra pessoa/assistente.
   */
  async saveDraft(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(draftSchema, raw);
    return this.db.transaction(async (client) => {
      await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      const flow = await this.lockFlow(client, projectId, flowId);
      if (Number(flow.draft_version) !== input.expectedDraftVersion)
        throw new DomainError(
          'FLOW_DRAFT_CHANGED',
          'O rascunho foi alterado entretanto. Recarregue para ver a versão atual.',
          409,
        );
      const before = parseDefinition(flow.flow_definition);
      const kind = flowChangeKind(before, input.definition);
      if (kind === 'none') return { draftVersion: Number(flow.draft_version), changeKind: kind };
      await client.query(
        'UPDATE flows SET flow_definition=$2,draft_version=draft_version+1,updated_at=NOW(3) WHERE id=$1',
        [flow.id, input.definition],
      );
      await recordAuthoringEvent(client, {
        projectId,
        flowId: flow.id,
        actorId: actor.id,
        type: 'draft_saved',
        payload: { revision: Number(flow.draft_version) + 1, changeKind: kind },
      });
      return { draftVersion: Number(flow.draft_version) + 1, changeKind: kind };
    });
  }

  /**
   * Nome, descrição e regra de seleção do RASCUNHO (prioridade única; um fluxo por omissão no
   * rascunho). A regra só entra em serviço quando a versão for ativada, por isso basta editar.
   */
  async saveSettings(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(flowSettingsSchema, raw);
    return this.db.transaction(async (client) => {
      await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      await client.query('SELECT id FROM flows WHERE project_id=$1 FOR UPDATE', [projectId]);
      const flow = await this.lockFlow(client, projectId, flowId);
      const routingChanged = !sameRouting(
        {
          priority: Number(flow.priority),
          isDefault: Boolean(flow.is_default),
          match: parseMatch(flow.flow_match),
          policy: parseRoutingPolicy(flow.routing_policy),
        },
        { ...input, policy: input.routingPolicy ?? parseRoutingPolicy(flow.routing_policy) },
      );
      await this.assertNameFree(client, projectId, input.name, flow.id);
      const clash = (
        await client.query<{ name: string }>(
          'SELECT name FROM flows WHERE project_id=$1 AND priority=$2 AND id<>$3',
          [projectId, input.priority, flow.id],
        )
      ).rows[0];
      if (clash)
        throw new DomainError(
          'FLOW_PRIORITY_TAKEN',
          `A prioridade ${input.priority} já é usada por «${clash.name}». Cada regra tem uma prioridade diferente para a escolha ser previsível.`,
          409,
        );
      if (flow.is_default && !input.isDefault)
        throw new DomainError(
          'FLOW_DEFAULT_REQUIRED',
          'Marque outro fluxo como «por omissão» em vez de retirar este.',
          409,
        );
      if (input.isDefault && !flow.is_default)
        // O anterior deixa de ser o «por omissão» do rascunho: a revisão dele muda também.
        await client.query(
          `UPDATE flows SET is_default=0,draft_version=draft_version+1,updated_at=NOW(3)
            WHERE project_id=$1 AND is_default=1`,
          [projectId],
        );
      await client.query(
        `UPDATE flows SET name=$2,description=$3,priority=$4,is_default=$5,flow_match=$6,
                draft_version=draft_version+$7,routing_policy=COALESCE($8,routing_policy),updated_at=NOW(3)
          WHERE id=$1`,
        [
          flow.id,
          input.name,
          input.description,
          input.priority,
          input.isDefault,
          input.match,
          routingChanged ? 1 : 0,
          input.routingPolicy ?? null,
        ],
      );
      if (routingChanged)
        await recordAuthoringEvent(client, {
          projectId,
          flowId: flow.id,
          actorId: actor.id,
          type: 'draft_saved',
          payload: { revision: Number(flow.draft_version) + 1, changeKind: 'routing' },
        });
      return this.detail(client, projectId, flow.id);
    });
  }

  /**
   * «Ativar esta versão»: congela o rascunho (definição + encaminhamento + alertas pendentes)
   * numa versão imutável com manifesto de dependências e põe-na em serviço para NOVOS tickets.
   * Tickets em curso mantêm a versão com que entraram. Repetir o pedido para a mesma revisão
   * do rascunho devolve a ativação existente, sem duplicar.
   */
  async publish(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(publishSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'flows.activate',
        true,
      );
      const flow = await this.lockFlow(client, projectId, flowId);
      const draftVersion = Number(flow.draft_version);
      if (draftVersion !== input.expectedDraftVersion)
        throw new DomainError(
          'FLOW_DRAFT_CHANGED',
          'O rascunho foi alterado entretanto. Recarregue antes de ativar.',
          409,
        );
      const repeated = await client.query(
        "SELECT id FROM flow_activations WHERE flow_id=$1 AND kind='activation' AND base_draft_version=$2",
        [flow.id, draftVersion],
      );
      if (repeated.rowCount) return this.detail(client, projectId, flow.id);
      const definition = parseDefinition(flow.flow_definition);
      const issues = validateFlowDefinition(definition, {
        members: new Set((await this.members(client, projectId)).map((member) => member.id)),
        repositories: await activeRepositoryIds(client, projectId),
        pipelines: await activePipelineIds(client, projectId),
      });
      if (issues.length)
        throw new DomainError(
          'FLOW_INVALID',
          `O fluxo tem ${issues.length} problema(s): ${issues
            .slice(0, 3)
            .map((issue) => issue.message)
            .join(' ')}`,
          422,
        );
      // P10: dependência obrigatória ainda em desenvolvimento bloqueia a ativação (não a edição).
      const missing = await pendingCapabilityDependencies(client, flow.id);
      if (missing.length)
        throw new DomainError(
          'FLOW_CAPABILITY_PENDING',
          `Há ${missing.length} capacidade(s) obrigatória(s) ainda indisponível(is): ${missing
            .slice(0, 3)
            .map((item) => item.title)
            .join('; ')}.`,
          409,
        );
      const pending = await this.pendingChanges(client, flow);
      if (!pending.definition && !pending.routing && !pending.alertKeys)
        throw new DomainError('FLOW_UNCHANGED', 'Não há alterações por ativar.', 409);
      if (flow.active_is_default && !flow.is_default)
        throw new DomainError(
          'FLOW_DEFAULT_REQUIRED',
          'Este fluxo é o «por omissão» em serviço. Ative primeiro o fluxo que o substitui.',
          409,
        );
      assertPinnedReferences(definition);
      const dependencies = await this.agentProfiles.validateFlowDefinition(
        client,
        projectId,
        definition,
      );
      const linked = (
        await client.query<{ alert_key: string }>(
          'SELECT alert_key FROM health_alert_flows WHERE flow_id=$1',
          [flow.id],
        )
      ).rows.map((row) => row.alert_key);
      const claimed = parseAlertKeys(flow.pending_alert_keys);
      const routing = normalizedRouting({
        priority: Number(flow.priority),
        isDefault: Boolean(flow.is_default),
        match: parseMatch(flow.flow_match),
        alertKeys: [...linked, ...claimed],
        policy: parseRoutingPolicy(flow.routing_policy),
      });
      const manifest = buildFlowManifest(definition, routing, dependencies, (key) =>
        this.engine.supportsAction(key),
      );
      const hash = manifestHash(manifest);
      // P07: o que foi testado para este hash exato (informativo; não é requisito de ativação).
      const tests = await activationTestEvidence(client, flow.id, hash);
      const number =
        Number(
          (
            await client.query<{ top: number | null }>(
              'SELECT MAX(number) AS top FROM flow_versions WHERE flow_id=$1',
              [flow.id],
            )
          ).rows[0]?.top ?? 0,
        ) + 1;
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO flow_versions(id,flow_id,project_id,number,flow_definition,logic_hash,published_by,
                                   schema_version,runtime_contract_version,routing,manifest,manifest_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          versionId,
          flow.id,
          projectId,
          number,
          definition,
          manifest.flow.logicHash,
          context.actor.id,
          manifest.flow.schemaVersion,
          manifest.flow.runtimeContractVersion,
          routing,
          manifest,
          hash,
        ],
      );
      // Ativação única por revisão do rascunho (protege repetições e pedidos concorrentes).
      await this.recordActivation(client, {
        projectId,
        flowId: flow.id,
        kind: 'activation',
        versionId,
        actorId: context.actor.id,
        baseDraftVersion: draftVersion,
        previousVersionId: flow.published_version_id,
        manifestHash: hash,
        details: {
          pending,
          claimedAlertKeys: claimed,
          tests,
          capabilities: await linkedCapabilities(client, flow.id),
        },
      });
      if (routing.isDefault) {
        const previousDefault = (
          await client.query<{ id: string; published_version_id: string | null }>(
            'SELECT id,published_version_id FROM flows WHERE project_id=$1 AND active_is_default=1 AND id<>$2 FOR UPDATE',
            [projectId, flow.id],
          )
        ).rows[0];
        if (previousDefault) {
          // Sem isto, o antigo «por omissão» passaria implicitamente a regra ativa (critérios
          // vazios = qualquer ticket). Sai de serviço até ser ativado com as suas próprias regras.
          await client.query(
            'UPDATE flows SET active_is_default=0,active_priority=NULL,active_flow_match=NULL WHERE id=$1',
            [previousDefault.id],
          );
          await this.recordActivation(client, {
            projectId,
            flowId: previousDefault.id,
            kind: 'default_transfer',
            versionId: previousDefault.published_version_id,
            actorId: context.actor.id,
            details: { newDefaultFlowId: flow.id, removedFromService: true },
          });
        }
      }
      await client.query(
        `UPDATE flows SET published_version_id=$2,active_priority=$3,active_is_default=$4,
                active_flow_match=$5,pending_alert_keys=NULL,updated_at=NOW(3)
          WHERE id=$1`,
        [flow.id, versionId, routing.priority, routing.isDefault, routing.match],
      );
      for (const key of claimed)
        await this.saveAlertLink(client, projectId, key, flow.id, context.actor.id);
      return this.detail(client, projectId, flow.id);
    });
  }

  /** O que o rascunho tem por ativar (definição, encaminhamento, alertas pendentes). */
  private async pendingChanges(client: Queryable, row: FlowRow): Promise<FlowPendingChanges> {
    const alertKeys = parseAlertKeys(row.pending_alert_keys).length > 0;
    if (!row.published_version_id) return { definition: true, routing: true, alertKeys };
    const active = (
      await client.query<{ flow_definition: unknown; routing: unknown }>(
        'SELECT flow_definition,routing FROM flow_versions WHERE id=$1',
        [row.published_version_id],
      )
    ).rows[0];
    return {
      definition:
        !active ||
        flowChangeKind(
          parseDefinition(active.flow_definition),
          parseDefinition(row.flow_definition),
        ) !== 'none',
      routing:
        row.active_priority === null ||
        !sameRouting(
          {
            priority: Number(row.active_priority),
            isDefault: Boolean(row.active_is_default),
            match: parseMatch(row.active_flow_match),
            policy: activePolicy(active?.routing),
          },
          {
            priority: Number(row.priority),
            isDefault: Boolean(row.is_default),
            match: parseMatch(row.flow_match),
            policy: parseRoutingPolicy(row.routing_policy),
          },
        ),
      alertKeys,
    };
  }

  /** Tickets do projeto para a simulação («Experimentar com um ticket»). */
  async simulationTickets(actor: User, projectId: string) {
    await requireProjectPermission(this.db, actor, projectId, 'flows.simulate');
    const rows = await this.db.query<{
      id: string;
      key: string;
      title: string;
      status: string;
      category: string;
      origin: TicketOrigin;
      created_at: Date;
    }>(
      'SELECT id,`key`,title,status,category,origin,created_at FROM tickets WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100',
      [projectId],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      key: row.key,
      title: row.title,
      status: row.status,
      category: row.category,
      origin: row.origin,
      createdAt: iso(row.created_at)!,
    }));
  }

  /**
   * Percorre o rascunho (ou a definição em edição) com um ticket existente, sem enviar mensagens,
   * pedir trabalho ao Copilot ou alterar o ticket. Indica também se a regra apanharia o ticket.
   */
  async simulate(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(simulateSchema, raw);
    await requireProjectPermission(this.db, actor, projectId, 'flows.simulate');
    const flow = await this.lockFlow(this.db, projectId, flowId, false);
    const definition = input.definition ?? parseDefinition(flow.flow_definition);
    let ticket: {
      key: string;
      title: string;
      selectedFlow: string | null;
      matches: boolean;
    } | null = null;
    let facts:
      { origin: string; category: string; environment: string; priority: string } | undefined;
    if (input.ticketId) {
      const row = (
        await this.db.query<{
          key: string;
          title: string;
          origin: TicketOrigin;
          category: string;
          environment: string;
          priority: string;
        }>(
          'SELECT `key`,title,origin,category,environment,priority FROM tickets WHERE id=$1 AND project_id=$2',
          [input.ticketId, projectId],
        )
      ).rows[0];
      if (!row) throw new DomainError('TICKET_NOT_FOUND', 'Pedido não encontrado.', 404);
      facts = {
        origin: row.origin,
        category: row.category,
        environment: row.environment,
        priority: row.priority,
      };
      const candidates = (await publishedFlows(this.db, projectId)).filter(
        (item) => item.id !== flow.id,
      );
      const self = {
        id: flow.id,
        name: flow.name,
        priority: Number(flow.priority),
        isDefault: Boolean(flow.is_default),
        match: parseMatch(flow.flow_match),
      };
      const selected = selectFlow([...candidates, self], row);
      ticket = {
        key: row.key,
        title: row.title,
        selectedFlow: selected?.name ?? null,
        matches: self.isDefault ? selected?.id === flow.id : flowMatches(self.match, row),
      };
    }
    return {
      ticket,
      issues: validateFlowDefinition(definition),
      result: simulateFlow(definition, input.scenario, undefined, facts),
    };
  }

  /**
   * Novo turno da sessão de construção (P06): resposta assíncrona pelo Copilot, que altera o
   * rascunho só pelas ferramentas de autoria. O modo fica guardado na sessão (fluxo, utilizador).
   */
  async requestFlowAssistant(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(flowAuthoringRequestSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      const flow = await this.lockFlow(client, projectId, flowId);
      if (!(await copilotReady(client, projectId)))
        throw new DomainError(
          'COPILOT_NOT_CONFIGURED',
          'Configure e verifique a integração Copilot do projeto para usar o assistente.',
          409,
        );
      await this.assertNoPending(client, 'flow_id', flow.id);
      const session = await this.authoringSession(client, flow, context.actor.id, input.mode);
      const id = randomUUID();
      await client.query(
        `INSERT INTO flow_assistant_requests(id,project_id,scope,flow_id,requested_by,message,base_draft_version,
                                             session_id,authoring_mode,known_revision)
         VALUES($1,$2,'flow',$3,$4,$5,$6,$7,$8,$6)`,
        [
          id,
          projectId,
          flow.id,
          context.actor.id,
          input.message,
          flow.draft_version,
          session.id,
          session.mode,
        ],
      );
      await recordAuthoringEvent(client, {
        projectId,
        flowId: flow.id,
        sessionId: session.id,
        requestId: id,
        actorId: context.actor.id,
        type: 'turn_queued',
        payload: {
          message: input.message,
          mode: session.mode,
          revision: Number(flow.draft_version),
        },
      });
      return this.assistantRequest(client, id);
    });
  }

  /** Estado persistente da construção: sessão do utilizador, operações, capacidades e cursor. */
  async authoringState(
    actor: User,
    projectId: string,
    flowId: string,
  ): Promise<FlowAuthoringStateView> {
    const context = await requireProjectPermission(this.db, actor, projectId, 'flows.view');
    const flow = await this.lockFlow(this.db, projectId, flowId, false);
    const session = (
      await this.db.query<{ id: string; mode: FlowAuthoringMode }>(
        'SELECT id,mode FROM flow_authoring_sessions WHERE flow_id=$1 AND created_by=$2',
        [flow.id, context.actor.id],
      )
    ).rows[0];
    return {
      session: session ? { id: session.id, mode: session.mode } : null,
      draftVersion: Number(flow.draft_version),
      operations: await this.authoring.operations(this.db, flow),
      capabilities: await this.authoring.capabilities(this.db, flow.id),
      lastEventId: await this.authoring.lastEventId(this.db, flow.id),
    };
  }

  /** Eventos da construção a partir do cursor `after` (replay, SSE e polling). */
  async authoringEvents(actor: User, projectId: string, flowId: string, after: number) {
    await requireProjectPermission(this.db, actor, projectId, 'flows.view');
    const flow = await this.lockFlow(this.db, projectId, flowId, false);
    return this.authoring.events(this.db, flow.id, Number.isFinite(after) ? after : 0);
  }

  /** Muda o modo da sessão (afeta os próximos turnos; o turno em curso mantém o seu). */
  async setAuthoringMode(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(flowAuthoringModeSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      const flow = await this.lockFlow(client, projectId, flowId);
      const before = (
        await client.query<{ mode: FlowAuthoringMode }>(
          'SELECT mode FROM flow_authoring_sessions WHERE flow_id=$1 AND created_by=$2',
          [flow.id, context.actor.id],
        )
      ).rows[0];
      const session = await this.authoringSession(client, flow, context.actor.id, input.mode);
      if (before?.mode !== input.mode)
        await recordAuthoringEvent(client, {
          projectId,
          flowId: flow.id,
          sessionId: session.id,
          actorId: context.actor.id,
          type: 'mode_changed',
          payload: { mode: input.mode },
        });
      return { id: session.id, mode: session.mode };
    });
  }

  /** Desfaz uma operação aplicada com uma nova revisão auditada (não toca em versões ativas). */
  async undoAuthoringOperation(
    actor: User,
    projectId: string,
    flowId: string,
    operationId: string,
    raw: unknown,
  ) {
    const input = parseInput(flowAuthoringUndoSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      const flow = await this.lockFlow(client, projectId, flowId);
      await this.authoring.undo(
        client,
        flow,
        context.actor.id,
        idSchema.parse(operationId),
        input.expectedDraftVersion,
      );
      return this.detail(client, projectId, flow.id);
    });
  }

  /**
   * Cancela o turno do assistente em espera ou em curso. O pedido deixa de ter posse válida, por
   * isso o executor para no próximo heartbeat ou chamada de ferramenta, sem mais escritas.
   */
  async cancelFlowAssistant(actor: User, projectId: string, flowId: string, requestId: string) {
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      const flow = await this.lockFlow(client, projectId, flowId);
      const request = (
        await client.query<{
          id: string;
          status: string;
          session_id: string | null;
          attempt: number;
          lease_epoch: number;
          worker_id: string | null;
        }>(
          'SELECT id,status,session_id,attempt,lease_epoch,worker_id FROM flow_assistant_requests WHERE id=$1 AND flow_id=$2 FOR UPDATE',
          [idSchema.parse(requestId), flow.id],
        )
      ).rows[0];
      if (!request) throw new DomainError('NOT_FOUND', 'Pedido não encontrado.', 404);
      if (request.status === 'queued' || request.status === 'running') {
        await client.query(
          "UPDATE flow_assistant_requests SET status='failed',error_code='cancelled',finished_at=NOW(3),lease_until=NULL WHERE id=$1",
          [request.id],
        );
        await recordJobEvent(client, {
          kind: 'flow_assistant',
          jobId: request.id,
          projectId,
          attempt: Number(request.attempt),
          epoch: Number(request.lease_epoch),
          workerId: request.worker_id,
          type: 'cancel_requested',
          details: { by: context.actor.id },
        });
        await recordAuthoringEvent(client, {
          projectId,
          flowId: flow.id,
          sessionId: request.session_id,
          requestId: request.id,
          actorId: context.actor.id,
          type: 'turn_cancelled',
          payload: {},
          idempotencyKey: `cancel:${request.id}`,
        });
      }
      return this.assistantRequest(client, request.id);
    });
  }

  /** Conversa do assistente sobre o fluxo (mais recentes primeiro). */
  async flowAssistantHistory(actor: User, projectId: string, flowId: string) {
    await requireProjectPermission(this.db, actor, projectId, 'flows.view');
    const flow = await this.lockFlow(this.db, projectId, flowId, false);
    return this.assistantList(this.db, 'flow_id', flow.id);
  }

  /**
   * Aceita (aplica as operações ao rascunho atual) ou descarta a proposta do assistente.
   * Aceitar não publica: a proposta passa a fazer parte do rascunho.
   */
  async resolveFlowAssistant(
    actor: User,
    projectId: string,
    flowId: string,
    requestId: string,
    raw: unknown,
  ) {
    const input = parseInput(resolutionSchema, raw);
    return this.db.transaction(async (client) => {
      await requireProjectPermission(client, actor, projectId, 'flows.edit', true);
      const flow = await this.lockFlow(client, projectId, flowId);
      const request = (
        await client.query<AssistantRow>(
          `SELECT r.*,u.display_name AS requester FROM flow_assistant_requests r JOIN users u ON u.id=r.requested_by
            WHERE r.id=$1 AND r.flow_id=$2 FOR UPDATE`,
          [idSchema.parse(requestId), flow.id],
        )
      ).rows[0];
      if (!request) throw new DomainError('NOT_FOUND', 'Proposta não encontrada.', 404);
      if (request.resolution !== 'pending' || request.status !== 'succeeded')
        throw new DomainError('FLOW_PROPOSAL_CLOSED', 'Esta proposta já não está pendente.', 409);
      if (request.session_id) {
        if (
          input.resolution === 'accepted' &&
          input.expectedDraftVersion !== undefined &&
          input.expectedDraftVersion !== Number(flow.draft_version)
        )
          throw new DomainError(
            'FLOW_DRAFT_CHANGED',
            'O rascunho foi alterado entretanto. Recarregue antes de aceitar.',
            409,
          );
        const response = flowAssistantResponseSchema.parse(request.assistant_response);
        if (input.resolution === 'accepted')
          try {
            await this.authoring.acceptProposals(
              client,
              flow,
              request.id,
              actor.id,
              response.operations,
            );
          } catch (error) {
            if (error instanceof DomainError) throw error;
            throw new DomainError(
              'FLOW_PROPOSAL_STALE',
              `A proposta já não se aplica ao rascunho: ${error instanceof Error ? error.message : 'erro'}`,
              409,
            );
          }
        else await this.authoring.discardProposals(client, flow, request.id, actor.id);
        await client.query('UPDATE flow_assistant_requests SET resolution=$2 WHERE id=$1', [
          request.id,
          input.resolution,
        ]);
        return this.detail(client, projectId, flow.id);
      }
      if (input.resolution === 'accepted') {
        if (
          input.expectedDraftVersion !== undefined &&
          input.expectedDraftVersion !== Number(flow.draft_version)
        )
          throw new DomainError(
            'FLOW_DRAFT_CHANGED',
            'O rascunho foi alterado entretanto. Recarregue antes de aceitar.',
            409,
          );
        const response = flowAssistantResponseSchema.parse(request.assistant_response);
        if (!response.operations.length)
          throw new DomainError('FLOW_PROPOSAL_EMPTY', 'Esta resposta não propõe alterações.', 409);
        let next: FlowDefinition;
        try {
          next = flowDefinitionSchema.parse(
            applyFlowOperations(parseDefinition(flow.flow_definition), response.operations)
              .definition,
          );
        } catch (error) {
          throw new DomainError(
            'FLOW_PROPOSAL_STALE',
            `A proposta já não se aplica ao rascunho: ${error instanceof Error ? error.message : 'erro'}`,
            409,
          );
        }
        await client.query(
          'UPDATE flows SET flow_definition=$2,draft_version=draft_version+1,updated_at=NOW(3) WHERE id=$1',
          [flow.id, next],
        );
      }
      await client.query('UPDATE flow_assistant_requests SET resolution=$2 WHERE id=$1', [
        request.id,
        input.resolution,
      ]);
      return this.detail(client, projectId, flow.id);
    });
  }

  // ---- Tickets ------------------------------------------------------------------------------

  /** Percurso do ticket no fluxo. O cliente vê só as mensagens públicas de cada etapa. */
  async ticketFlow(actor: User, ticketId: string): Promise<TicketFlowView | null> {
    const member = await requireMember(this.db, actor);
    const ticket = await findTicket(this.db, member, ticketId);
    const execution = (
      await this.db.query<
        ExecutionRow & { flow_name: string; number: number; latest: number | null }
      >(
        `SELECT e.*,f.name AS flow_name,v.number,
                (SELECT MAX(number) FROM flow_versions WHERE flow_id=e.flow_id) AS latest
           FROM flow_executions e JOIN flows f ON f.id=e.flow_id JOIN flow_versions v ON v.id=e.version_id
          WHERE e.ticket_id=$1`,
        [ticket.id],
      )
    ).rows[0];
    if (!execution) return null;
    const definition = parseDefinition(
      (
        await this.db.query<{ flow_definition: unknown }>(
          'SELECT flow_definition FROM flow_versions WHERE id=$1',
          [execution.version_id],
        )
      ).rows[0]?.flow_definition,
    );
    const isClient = member.role === 'client';
    const node = (id: string) => definition.nodes.find((item) => item.id === id);
    const steps = await this.db.query<StepRow & { actor_name: string | null }>(
      `SELECT s.*,u.display_name AS actor_name FROM flow_execution_steps s
         LEFT JOIN users u ON u.id=s.actor_id WHERE s.execution_id=$1 ORDER BY s.step_sequence`,
      [execution.id],
    );
    const stepViews: FlowStepView[] = steps.rows.map((step) => {
      const item = node(step.node_id);
      const output = step.step_output ?? {};
      return {
        id: step.id,
        nodeId: step.node_id,
        label: item?.label ?? step.node_id,
        op: item?.op ?? 'action',
        attempt: Number(step.attempt),
        status: step.status,
        port: step.port,
        assignee: step.step_assignee,
        actor: step.actor_id ? { id: step.actor_id, displayName: step.actor_name ?? '' } : null,
        output: isClient ? publicOutput(output) : this.withFeedback(output, step),
        agentRunId: isClient ? null : step.agent_run_id,
        startedAt: iso(step.started_at)!,
        finishedAt: iso(step.finished_at),
      };
    });
    const events = await this.db.query<{
      id: string;
      kind: string;
      step_id: string | null;
      actor: string | null;
      event_details: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `SELECT ev.id,ev.kind,ev.step_id,u.display_name AS actor,ev.event_details,ev.created_at
         FROM flow_execution_events ev LEFT JOIN users u ON u.id=ev.actor_id
        WHERE ev.execution_id=$1 ORDER BY ev.created_at LIMIT 400`,
      [execution.id],
    );
    const current = steps.rows.find((step) => step.id === execution.current_step_id);
    const currentNode = current ? node(current.node_id) : undefined;
    const active = current && ['waiting', 'active'].includes(current.status) && currentNode;
    const reviewConfig = currentNode && !isClient ? flowReviewConfig(currentNode) : null;
    const reviewHead = reviewConfig
      ? ((
          await this.db.query<{ head_sha: string | null; tests_passed: boolean | number }>(
            `SELECT head_sha,tests_passed FROM development_workspaces WHERE ticket_id=$1 AND node_id=$2
              ORDER BY updated_at DESC LIMIT 1`,
            [ticket.id, reviewConfig.sourceNode],
          )
        ).rows[0] ?? { head_sha: null, tests_passed: false })
      : null;
    return {
      execution: {
        id: execution.id,
        status: execution.status,
        currentNodeId: execution.current_node,
        flow: { id: execution.flow_id, name: execution.flow_name },
        version: {
          id: execution.version_id,
          number: Number(execution.number),
          latestNumber: Number(execution.latest ?? execution.number),
        },
        startedAt: iso(execution.started_at)!,
        finishedAt: iso(execution.finished_at),
      },
      definition,
      steps: stepViews,
      events: events.rows
        .filter((event) => !isClient || ['started', 'completed'].includes(event.kind))
        .map((event) => ({
          id: event.id,
          kind: event.kind,
          stepId: event.step_id,
          actor: event.actor,
          details: isClient ? {} : (event.event_details ?? {}),
          createdAt: iso(event.created_at)!,
        })),
      next:
        active && current && currentNode
          ? (() => {
              const canAct =
                currentNode.op === 'human_decision' &&
                current.status === 'waiting' &&
                canDecide(member, currentNode, ticket);
              return {
                stepId: current.id,
                nodeId: currentNode.id,
                label: currentNode.label,
                assignee:
                  current.step_assignee ??
                  (currentNode.op === 'copilot_task'
                    ? { label: 'Copilot', userIds: [] }
                    : { label: 'Sistema', userIds: [] }),
                options:
                  currentNode.op === 'human_decision' && (canAct || !isClient)
                    ? decisionOptions(currentNode)
                    : [],
                canAct,
                waitingFor:
                  currentNode.op === 'human_decision'
                    ? 'person'
                    : currentNode.op === 'copilot_task'
                      ? 'copilot'
                      : 'system',
                ...(reviewHead
                  ? {
                      review: {
                        headSha: reviewHead.head_sha,
                        testsPassed: Boolean(reviewHead.tests_passed),
                      },
                    }
                  : {}),
              };
            })()
          : null,
      paths:
        active && currentNode
          ? definition.edges
              .filter((edge) => edge.source === currentNode.id)
              .map((edge) => ({
                port: edge.port,
                label: portLabel(currentNode, edge.port),
                target: edge.target,
                targetLabel: node(edge.target)?.label ?? edge.target,
              }))
          : [],
      canUseAssistant: !isClient,
      incident: isClient ? null : await ticketIncidentView(this.db, ticket.id),
    };
  }

  /** Decisão humana na etapa atual (idempotente). */
  async decide(actor: User, ticketId: string, raw: unknown) {
    await this.engine.decide(actor, ticketId, raw);
    return this.ticketFlow(actor, ticketId);
  }

  /** Pergunta ao assistente sobre um ticket concreto (só equipa). */
  async requestTicketAssistant(actor: User, ticketId: string, raw: unknown) {
    const input = parseInput(messageSchema, raw);
    return this.db.transaction(async (client) => {
      const member = await requireMember(client, actor);
      if (member.role === 'client')
        throw new DomainError(
          'FORBIDDEN',
          'O assistente está disponível apenas para a equipa.',
          403,
        );
      const ticket = await findTicket(client, member, ticketId, true);
      const execution = await client.query('SELECT id FROM flow_executions WHERE ticket_id=$1', [
        ticket.id,
      ]);
      if (!execution.rowCount)
        throw new DomainError('FLOW_NOT_FOUND', 'Este pedido não está num fluxo.', 404);
      if (!(await copilotReady(client, ticket.project_id)))
        throw new DomainError(
          'COPILOT_NOT_CONFIGURED',
          'Configure e verifique a integração Copilot do projeto para usar o assistente.',
          409,
        );
      await this.assertNoPending(client, 'ticket_id', ticket.id);
      const id = randomUUID();
      await client.query(
        `INSERT INTO flow_assistant_requests(id,project_id,scope,ticket_id,requested_by,message)
         VALUES($1,$2,'ticket',$3,$4,$5)`,
        [id, ticket.project_id, ticket.id, member.id, input.message],
      );
      return this.assistantRequest(client, id);
    });
  }

  /** Conversa do assistente sobre o ticket (só equipa). */
  async ticketAssistantHistory(actor: User, ticketId: string) {
    const member = await requireMember(this.db, actor);
    if (member.role === 'client') return [];
    const ticket = await findTicket(this.db, member, ticketId);
    return this.assistantList(this.db, 'ticket_id', ticket.id);
  }

  /**
   * Aplica a transição sugerida pelo assistente com as permissões de quem confirma: passa pela
   * mesma decisão idempotente do botão, por isso só afeta esta execução.
   */
  async applyTicketAssistant(actor: User, ticketId: string, requestId: string, raw: unknown) {
    const input = parseInput(applySchema, raw);
    const member = await requireMember(this.db, actor);
    const ticket = await findTicket(this.db, member, ticketId);
    const request = (
      await this.db.query<AssistantRow>(
        `SELECT r.*,u.display_name AS requester FROM flow_assistant_requests r JOIN users u ON u.id=r.requested_by
          WHERE r.id=$1 AND r.ticket_id=$2`,
        [idSchema.parse(requestId), ticket.id],
      )
    ).rows[0];
    const response = flowAssistantResponseSchema.safeParse(request?.assistant_response);
    const transition = response.success ? response.data.transition : null;
    if (!request || !transition)
      throw new DomainError('NOT_FOUND', 'Não há ação proposta neste pedido.', 404);
    const flowStep = idSchema.safeParse(transition.stepId);
    if (!flowStep.success) throw new DomainError('INVALID_INPUT', 'Etapa proposta inválida.', 400);
    await this.engine.decide(member, ticket.id, {
      stepId: flowStep.data,
      port: transition.port,
      ...(transition.comment ? { comment: transition.comment } : {}),
      idempotencyKey: input.idempotencyKey,
    });
    await this.db.query(
      "UPDATE flow_assistant_requests SET resolution='accepted' WHERE id=$1 AND resolution='pending'",
      [request.id],
    );
    return this.ticketFlow(actor, ticketId);
  }

  // ---- internos -----------------------------------------------------------------------------

  private withFeedback(output: FlowStepOutput, step: StepRow): FlowStepOutput {
    const feedback = step.step_input?.feedback;
    return feedback && !output.feedback
      ? { ...output, feedback: `${feedback.actor ?? 'Responsável'}: ${feedback.comment}` }
      : output;
  }

  private async lockFlow(client: Queryable, projectId: string, flowId: string, lock = true) {
    const flow = (
      await client.query<FlowRow>(
        `SELECT * FROM flows WHERE id=$1 AND project_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [idSchema.parse(flowId), projectId],
      )
    ).rows[0];
    if (!flow) throw new DomainError('FLOW_NOT_FOUND', 'Fluxo não encontrado.', 404);
    return flow;
  }

  private async assertNameFree(
    client: Queryable,
    projectId: string,
    name: string,
    except: string | null,
  ) {
    const found = await client.query(
      'SELECT id FROM flows WHERE project_id=$1 AND name=$2 AND id<>$3',
      [projectId, name, except ?? ''],
    );
    if (found.rowCount)
      throw new DomainError('FLOW_NAME_TAKEN', 'Já existe um fluxo com esse nome.', 409);
  }

  private async authoringSession(
    client: Queryable,
    flow: FlowRow,
    userId: string,
    mode: FlowAuthoringMode | undefined,
  ) {
    await client.query(
      `INSERT INTO flow_authoring_sessions(id,project_id,flow_id,created_by,mode) VALUES($1,$2,$3,$4,$5)
       ON DUPLICATE KEY UPDATE mode=COALESCE($6,mode),updated_at=NOW(3)`,
      [randomUUID(), flow.project_id, flow.id, userId, mode ?? 'assisted', mode ?? null],
    );
    return (
      await client.query<{ id: string; mode: FlowAuthoringMode }>(
        'SELECT id,mode FROM flow_authoring_sessions WHERE flow_id=$1 AND created_by=$2',
        [flow.id, userId],
      )
    ).rows[0]!;
  }

  private async assertNoPending(client: Queryable, column: 'flow_id' | 'ticket_id', id: string) {
    const pending = await client.query(
      `SELECT id FROM flow_assistant_requests WHERE ${column}=$1 AND status IN ('queued','running')`,
      [id],
    );
    if (pending.rowCount)
      throw new DomainError(
        'FLOW_ASSISTANT_BUSY',
        'O assistente ainda está a responder ao pedido anterior.',
        409,
      );
  }

  private async members(client: Queryable, projectId: string) {
    return (
      await client.query<{ id: string; display_name: string; role: string }>(
        `SELECT u.id,u.display_name,m.role FROM project_memberships m JOIN users u ON u.id=m.user_id
          WHERE m.project_id=$1 AND NOT m.disabled AND NOT u.disabled ORDER BY u.display_name`,
        [projectId],
      )
    ).rows.map((row) => ({ id: row.id, displayName: row.display_name, role: row.role }));
  }

  private async summary(client: Queryable, row: FlowRow): Promise<FlowSummary> {
    const pending = await this.pendingChanges(client, row);
    const published = row.published_version_id
      ? (
          await client.query<{
            id: string;
            number: number;
            published_at: Date;
            published_by: string | null;
            routing: unknown;
          }>(
            `SELECT v.id,v.number,v.published_at,u.display_name AS published_by,v.routing
               FROM flow_versions v LEFT JOIN users u ON u.id=v.published_by WHERE v.id=$1`,
            [row.published_version_id],
          )
        ).rows[0]
      : undefined;
    const active = (
      await client.query<{ total: number }>(
        "SELECT COUNT(*) AS total FROM flow_executions WHERE flow_id=$1 AND status IN ('running','waiting')",
        [row.id],
      )
    ).rows[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      priority: Number(row.priority),
      isDefault: Boolean(row.is_default),
      match: parseMatch(row.flow_match),
      routingPolicy: parseRoutingPolicy(row.routing_policy),
      template: row.template,
      draftVersion: Number(row.draft_version),
      draftChanged: pending.definition,
      published: published
        ? {
            id: published.id,
            number: Number(published.number),
            publishedAt: iso(published.published_at)!,
            publishedBy: published.published_by,
          }
        : null,
      active:
        published && row.active_priority !== null
          ? {
              priority: Number(row.active_priority),
              isDefault: Boolean(row.active_is_default),
              match: parseMatch(row.active_flow_match),
              routingPolicy: activePolicy(published.routing),
            }
          : null,
      pendingChanges: pending,
      schemaVersion: flowSchemaVersion(parseDefinition(row.flow_definition)),
      activeExecutions: Number(active?.total ?? 0),
      updatedAt: iso(row.updated_at)!,
      alertKeys: (
        await client.query<{ alert_key: string }>(
          'SELECT alert_key FROM health_alert_flows WHERE flow_id=$1 ORDER BY alert_key',
          [row.id],
        )
      ).rows.map((link) => link.alert_key),
      pendingAlertKeys: parseAlertKeys(row.pending_alert_keys),
    };
  }

  private async detail(client: Queryable, projectId: string, flowId: string): Promise<FlowDetail> {
    const row = await this.lockFlow(client, projectId, flowId, false);
    const members = await this.members(client, projectId);
    const versions = await client.query<{
      id: string;
      number: number;
      published_at: Date;
      published_by: string | null;
      active: number;
      schema_version: number;
      runtime_contract_version: number;
      manifest_hash: string | null;
    }>(
      `SELECT v.id,v.number,v.published_at,u.display_name AS published_by,v.schema_version,
              v.runtime_contract_version,v.manifest_hash,
              (SELECT COUNT(*) FROM flow_executions e WHERE e.version_id=v.id AND e.status IN ('running','waiting')) AS active
         FROM flow_versions v LEFT JOIN users u ON u.id=v.published_by
        WHERE v.flow_id=$1 ORDER BY v.number DESC LIMIT 30`,
      [row.id],
    );
    const activations = await client.query<{
      id: string;
      kind: FlowActivationKind;
      version_id: string | null;
      version_number: number | null;
      previous_number: number | null;
      manifest_hash: string | null;
      actor: string | null;
      activation_details: unknown;
      created_at: Date;
    }>(
      `SELECT a.id,a.kind,a.version_id,v.number AS version_number,p.number AS previous_number,
              a.manifest_hash,u.display_name AS actor,a.activation_details,a.created_at
         FROM flow_activations a
         LEFT JOIN flow_versions v ON v.id=a.version_id
         LEFT JOIN flow_versions p ON p.id=a.previous_version_id
         LEFT JOIN users u ON u.id=a.actor_id
        WHERE a.flow_id=$1 ORDER BY a.created_at DESC, a.id LIMIT 50`,
      [row.id],
    );
    const draft = parseDefinition(row.flow_definition);
    return {
      ...(await this.summary(client, row)),
      draft,
      versions: versions.rows.map((version) => ({
        id: version.id,
        number: Number(version.number),
        publishedAt: iso(version.published_at)!,
        publishedBy: version.published_by,
        activeExecutions: Number(version.active),
        schemaVersion: Number(version.schema_version) === 2 ? 2 : 1,
        runtimeContractVersion: Number(version.runtime_contract_version),
        manifestHash: version.manifest_hash,
        active: version.id === row.published_version_id,
      })),
      activations: activations.rows.map((item): FlowActivationView => ({
        id: item.id,
        kind: item.kind,
        versionId: item.version_id,
        versionNumber: item.version_number === null ? null : Number(item.version_number),
        previousVersionNumber: item.previous_number === null ? null : Number(item.previous_number),
        manifestHash: item.manifest_hash,
        actor: item.actor,
        details:
          item.activation_details && typeof item.activation_details === 'object'
            ? (item.activation_details as Record<string, unknown>)
            : {},
        createdAt: iso(item.created_at)!,
      })),
      issues: validateFlowDefinition(draft, {
        members: new Set(members.map((member) => member.id)),
        repositories: await activeRepositoryIds(client, projectId),
        pipelines: await activePipelineIds(client, projectId),
      }),
      members,
      copilotReady: await copilotReady(client, projectId),
    };
  }

  private async assistantRequest(client: Queryable, id: string) {
    const row = (
      await client.query<AssistantRow>(
        `SELECT r.*,u.display_name AS requester FROM flow_assistant_requests r
           JOIN users u ON u.id=r.requested_by WHERE r.id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'Pedido não encontrado.', 404);
    return assistantView(row);
  }

  private async assistantList(client: Queryable, column: 'flow_id' | 'ticket_id', id: string) {
    const rows = await client.query<AssistantRow>(
      `SELECT r.*,u.display_name AS requester FROM flow_assistant_requests r
         JOIN users u ON u.id=r.requested_by WHERE r.${column}=$1 ORDER BY r.created_at DESC LIMIT 30`,
      [id],
    );
    return rows.rows.map(assistantView);
  }
}
