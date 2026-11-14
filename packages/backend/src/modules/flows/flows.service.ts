import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  applyFlowOperations,
  decisionOptions,
  healthAlertKey,
  flowAssistantResponseSchema,
  flowChangeKind,
  flowDefinitionSchema,
  flowMatches,
  flowScenarioSchema,
  flowSettingsSchema,
  healthAlertFlowCreateSchema,
  healthAlertFlowLinkSchema,
  healthAlertTypes,
  portLabel,
  selectFlow,
  simulateFlow,
  validateFlowDefinition,
  type FlowAssistantRequestView,
  type FlowDefinition,
  type FlowDetail,
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
import { parseInput } from '../identity/identity.validation.js';
import { ticketIncidentView } from '../incidents/incident-view.js';
import { requireMember, requireProjectAdmin, type Queryable } from '../identity/membership.js';
import { HEALTH_CATALOG } from '../health/health-catalog.js';
import { findTicket } from '../tickets/tickets.queries.js';
import { canDecide, FlowEngine, type ExecutionRow, type StepRow } from './flow-engine.js';
import {
  generalFlowTemplate,
  healthFlowTemplate,
  maintenanceFlowTemplate,
} from './flow-templates.js';
import {
  ensureDefaultFlows,
  logicHash,
  parseDefinition,
  parseMatch,
  publishedFlows,
  type FlowRow,
} from './flow-store.js';

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

  /** Fluxos do projeto (cria os modelos por omissão na primeira visita). */
  async list(actor: User, projectId: string): Promise<FlowSummary[]> {
    return this.db.transaction(async (client) => {
      await requireProjectAdmin(client, actor, projectId);
      await ensureDefaultFlows(client, projectId);
      const rows = await client.query<FlowRow>(
        'SELECT * FROM flows WHERE project_id=$1 ORDER BY is_default, priority, name',
        [projectId],
      );
      return Promise.all(rows.rows.map((row) => this.summary(client, row)));
    });
  }

  /** Fluxo com rascunho, versões, problemas de validação e membros (para os responsáveis). */
  async get(actor: User, projectId: string, flowId: string): Promise<FlowDetail> {
    await requireProjectAdmin(this.db, actor, projectId);
    return this.detail(this.db, projectId, idSchema.parse(flowId));
  }

  /** Cria um fluxo vazio ou a partir de um modelo (rascunho, sem regra de seleção ativa). */
  async create(actor: User, projectId: string, raw: unknown): Promise<FlowDetail> {
    const input = parseInput(createSchema, raw);
    return this.db.transaction(async (client) => {
      const admin = await requireProjectAdmin(client, actor, projectId, false, true);
      await ensureDefaultFlows(client, projectId);
      const id = await this.insertFlow(client, projectId, admin.id, input);
      return this.detail(client, projectId, id);
    });
  }

  /** Tipos de alerta da Saúde e o fluxo que trata os tickets de cada um. */
  async alertFlows(actor: User, projectId: string): Promise<HealthAlertFlowLink[]> {
    await requireProjectAdmin(this.db, actor, projectId);
    return this.alertLinks(this.db, projectId);
  }

  /** Associa (ou retira, com `flowId: null`) o fluxo próprio de um tipo de alerta. */
  async linkAlertFlow(actor: User, projectId: string, raw: unknown) {
    const input = parseInput(healthAlertFlowLinkSchema, raw);
    const key = input.alertKey;
    return this.db.transaction(async (client) => {
      const admin = await requireProjectAdmin(client, actor, projectId);
      if (input.flowId) {
        const flow = await this.lockFlow(client, projectId, input.flowId);
        if (!flow.published_version_id)
          throw new DomainError(
            'FLOW_NOT_PUBLISHED',
            'Publique o fluxo antes de o associar a um alerta.',
            409,
          );
        await this.saveAlertLink(client, projectId, key, flow.id, admin.id);
      } else
        await client.query('DELETE FROM health_alert_flows WHERE project_id=$1 AND alert_key=$2', [
          projectId,
          key,
        ]);
      return this.alertLinks(client, projectId);
    });
  }

  /**
   * Cria um fluxo próprio para um tipo de alerta a partir do modelo de incidentes da Saúde,
   * publica-o e associa-o logo (os próximos tickets desse alerta passam a usá-lo).
   */
  async createAlertFlow(actor: User, projectId: string, raw: unknown): Promise<FlowDetail> {
    const key = parseInput(healthAlertFlowCreateSchema, raw).alertKey;
    const type = flowAlertTypes().find((item) => item.key === key);
    return this.db.transaction(async (client) => {
      const admin = await requireProjectAdmin(client, actor, projectId, false, true);
      await ensureDefaultFlows(client, projectId);
      const title = (type?.title ?? key).slice(0, 70);
      const id = await this.insertFlow(client, projectId, admin.id, {
        name: `Alerta: ${title}`,
        template: 'health',
        description: `Tickets abertos pelo alerta «${title}».`,
      });
      const flow = await this.lockFlow(client, projectId, id);
      const definition = parseDefinition(flow.flow_definition);
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO flow_versions(id,flow_id,project_id,number,flow_definition,logic_hash,published_by)
         VALUES($1,$2,$3,1,$4,$5,$6)`,
        [versionId, id, projectId, definition, logicHash(definition), admin.id],
      );
      await client.query('UPDATE flows SET published_version_id=$2 WHERE id=$1', [id, versionId]);
      await this.saveAlertLink(client, projectId, key, id, admin.id);
      return this.detail(client, projectId, id);
    });
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
    return flowAlertTypes().map((type) => {
      const link = rows.find((row) => row.alert_key === type.key);
      return { ...type, flowId: link?.flow_id ?? null, flowName: link?.name ?? null };
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
    const priority =
      Number(
        (
          await client.query<{ top: number | null }>(
            'SELECT MAX(priority) AS top FROM flows WHERE project_id=$1 AND NOT is_default',
            [projectId],
          )
        ).rows[0]?.top ?? 0,
      ) + 10;
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
        Math.min(priority, 998),
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
      await requireProjectAdmin(client, actor, projectId);
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
      return { draftVersion: Number(flow.draft_version) + 1, changeKind: kind };
    });
  }

  /** Nome, descrição e regra de seleção (prioridade única; exatamente um fluxo por omissão). */
  async saveSettings(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(flowSettingsSchema, raw);
    return this.db.transaction(async (client) => {
      await requireProjectAdmin(client, actor, projectId);
      await client.query('SELECT id FROM flows WHERE project_id=$1 FOR UPDATE', [projectId]);
      const flow = await this.lockFlow(client, projectId, flowId);
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
      if (input.isDefault && !flow.is_default) {
        if (!flow.published_version_id)
          throw new DomainError(
            'FLOW_NOT_PUBLISHED',
            'Publique o fluxo antes de o usar por omissão.',
            409,
          );
        await client.query('UPDATE flows SET is_default=0 WHERE project_id=$1 AND is_default=1', [
          projectId,
        ]);
      }
      await client.query(
        `UPDATE flows SET name=$2,description=$3,priority=$4,is_default=$5,flow_match=$6,updated_at=NOW(3)
          WHERE id=$1`,
        [flow.id, input.name, input.description, input.priority, input.isDefault, input.match],
      );
      return this.detail(client, projectId, flow.id);
    });
  }

  /**
   * Publica o rascunho como nova versão, depois de validar destinos, responsáveis e ações.
   * Tickets em curso mantêm a versão com que entraram; os novos usam esta.
   */
  async publish(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(publishSchema, raw);
    return this.db.transaction(async (client) => {
      const admin = await requireProjectAdmin(client, actor, projectId);
      const flow = await this.lockFlow(client, projectId, flowId);
      if (Number(flow.draft_version) !== input.expectedDraftVersion)
        throw new DomainError(
          'FLOW_DRAFT_CHANGED',
          'O rascunho foi alterado entretanto. Recarregue antes de publicar.',
          409,
        );
      const definition = parseDefinition(flow.flow_definition);
      const issues = validateFlowDefinition(definition, {
        members: new Set((await this.members(client, projectId)).map((member) => member.id)),
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
      await this.agentProfiles.validateFlowDefinition(client, projectId, definition);
      const current = flow.published_version_id
        ? (
            await client.query<{ flow_definition: unknown }>(
              'SELECT flow_definition FROM flow_versions WHERE id=$1',
              [flow.published_version_id],
            )
          ).rows[0]
        : undefined;
      if (
        current &&
        flowChangeKind(parseDefinition(current.flow_definition), definition) === 'none'
      )
        throw new DomainError('FLOW_UNCHANGED', 'Não há alterações por publicar.', 409);
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
        `INSERT INTO flow_versions(id,flow_id,project_id,number,flow_definition,logic_hash,published_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [versionId, flow.id, projectId, number, definition, logicHash(definition), admin.id],
      );
      await client.query('UPDATE flows SET published_version_id=$2,updated_at=NOW(3) WHERE id=$1', [
        flow.id,
        versionId,
      ]);
      return this.detail(client, projectId, flow.id);
    });
  }

  /** Tickets do projeto para a simulação («Experimentar com um ticket»). */
  async simulationTickets(actor: User, projectId: string) {
    await requireProjectAdmin(this.db, actor, projectId);
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
    await requireProjectAdmin(this.db, actor, projectId);
    const flow = await this.lockFlow(this.db, projectId, flowId, false);
    const definition = input.definition ?? parseDefinition(flow.flow_definition);
    let ticket: {
      key: string;
      title: string;
      selectedFlow: string | null;
      matches: boolean;
    } | null = null;
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
      result: simulateFlow(definition, input.scenario),
    };
  }

  /** Pede ao assistente uma alteração ao fluxo (resposta assíncrona pelo Copilot). */
  async requestFlowAssistant(actor: User, projectId: string, flowId: string, raw: unknown) {
    const input = parseInput(messageSchema, raw);
    return this.db.transaction(async (client) => {
      const admin = await requireProjectAdmin(client, actor, projectId);
      const flow = await this.lockFlow(client, projectId, flowId);
      if (!(await copilotReady(client, projectId)))
        throw new DomainError(
          'COPILOT_NOT_CONFIGURED',
          'Configure e verifique a integração Copilot do projeto para usar o assistente.',
          409,
        );
      await this.assertNoPending(client, 'flow_id', flow.id);
      const id = randomUUID();
      await client.query(
        `INSERT INTO flow_assistant_requests(id,project_id,scope,flow_id,requested_by,message,base_draft_version)
         VALUES($1,$2,'flow',$3,$4,$5,$6)`,
        [id, projectId, flow.id, admin.id, input.message, flow.draft_version],
      );
      return this.assistantRequest(client, id);
    });
  }

  /** Conversa do assistente sobre o fluxo (mais recentes primeiro). */
  async flowAssistantHistory(actor: User, projectId: string, flowId: string) {
    await requireProjectAdmin(this.db, actor, projectId);
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
      await requireProjectAdmin(client, actor, projectId);
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
    const published = row.published_version_id
      ? (
          await client.query<{
            id: string;
            number: number;
            published_at: Date;
            published_by: string | null;
            flow_definition: unknown;
          }>(
            `SELECT v.id,v.number,v.published_at,u.display_name AS published_by,v.flow_definition
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
      template: row.template,
      draftVersion: Number(row.draft_version),
      draftChanged:
        !published ||
        flowChangeKind(
          parseDefinition(published.flow_definition),
          parseDefinition(row.flow_definition),
        ) !== 'none',
      published: published
        ? {
            id: published.id,
            number: Number(published.number),
            publishedAt: iso(published.published_at)!,
            publishedBy: published.published_by,
          }
        : null,
      activeExecutions: Number(active?.total ?? 0),
      updatedAt: iso(row.updated_at)!,
      alertKeys: (
        await client.query<{ alert_key: string }>(
          'SELECT alert_key FROM health_alert_flows WHERE flow_id=$1 ORDER BY alert_key',
          [row.id],
        )
      ).rows.map((link) => link.alert_key),
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
    }>(
      `SELECT v.id,v.number,v.published_at,u.display_name AS published_by,
              (SELECT COUNT(*) FROM flow_executions e WHERE e.version_id=v.id AND e.status IN ('running','waiting')) AS active
         FROM flow_versions v LEFT JOIN users u ON u.id=v.published_by
        WHERE v.flow_id=$1 ORDER BY v.number DESC LIMIT 30`,
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
      })),
      issues: validateFlowDefinition(draft, {
        members: new Set(members.map((member) => member.id)),
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
