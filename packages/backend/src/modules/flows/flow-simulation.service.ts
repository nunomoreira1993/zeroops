import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  actionKey,
  canonicalJson,
  compareSimulation,
  exampleScenarios,
  flowScenarioFromTicketSchema,
  flowScenarioInputSchema,
  flowScenarioSpecSchema,
  flowSimulationRunInputSchema,
  flowTrialTargetInputSchema,
  parseRoutingPolicy,
  validateFlowDefinition,
  type FlowActivationTestEvidence,
  type FlowDefinition,
  type FlowScenarioSpec,
  type FlowScenarioView,
  type FlowSimulationComparison,
  type FlowSimulationHashes,
  type FlowSimulationLevel,
  type FlowSimulationResultView,
  type FlowSimulationRunView,
  type FlowSimulationsView,
  type FlowTrialTargetView,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { copilotReady, teamRequester } from '../agents/agent-auto-runs.js';
import { AgentProfilesService } from '../agents/agent-profiles.service.js';
import { activeRepositoryIds } from '../development/git-repositories.service.js';
import { activePipelineIds } from '../delivery/pipelines.service.js';
import { parseInput } from '../identity/identity.validation.js';
import type { Queryable } from '../identity/membership.js';
import { requireProjectPermission } from '../identity/project-permissions.js';
import { defaultFlowActions } from './flow-actions.js';
import { buildFlowManifest, manifestHash, normalizedRouting } from './flow-manifest.js';
import {
  applyRoutingReply,
  notVerifiedFor,
  planSimulatedRouting,
  runFlowBehaviour,
  type FlowSimulationEnvironment,
  type SimulatedRoutingFlow,
} from './flow-simulator.js';
import {
  logicHash,
  parseAlertKeys,
  parseDefinition,
  parseMatch,
  publishedFlows,
  type FlowRow,
} from './flow-store.js';
import { buildRoutingPrompt } from './routing-prompt.js';

// ---------------------------------------------------------------------------------------------
// P07 — biblioteca de cenários, execuções de teste com hashes e destinos de ensaio isolado.

const idSchema = z.uuid();
const versionSchema = z.strictObject({ version: z.number().int().min(1) });
const RUN_LIST_LIMIT = 30;

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const iso = (value: Date | string | null) =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

function json<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

interface ScenarioRow {
  id: string;
  project_id: string;
  flow_id: string;
  name: string;
  description: string;
  spec: unknown;
  spec_hash: string;
  version: number;
  archived: boolean | number;
  updated_by: string | null;
  updated_at: Date;
}

/** Linha de `flow_simulation_runs` (também usada pela fila do Copilot real). */
export interface SimulationRunRow {
  id: string;
  project_id: string;
  flow_id: string;
  scenario_id: string | null;
  scenario_version: number | null;
  scenario_name: string;
  scenario_spec: unknown;
  level: FlowSimulationLevel;
  status: FlowSimulationRunView['status'];
  definition_hash: string;
  routing_hash: string;
  manifest_hash: string | null;
  scenario_hash: string;
  run_input: unknown;
  result: unknown;
  comparison: unknown;
  verdict: string | null;
  trial_target_id: string | null;
  idempotency_key: string;
  requested_by: string | null;
  attempt: number;
  worker_id: string | null;
  lease_epoch: number;
  cancel_requested: boolean | number;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
}

/** Entrada fixada de uma avaliação com o Copilot real (o job usa sempre este conjunto). */
export interface CopilotRoutingRunInput {
  prompt: string;
}

/** Conclui o resultado com o encaminhamento observado e recalcula a comparação. */
export function finishSimulationResult(
  result: FlowSimulationResultView,
  spec: FlowScenarioSpec,
): { result: FlowSimulationResultView; comparison: FlowSimulationComparison } {
  const final = { ...result, notVerified: notVerifiedFor(result.level, result.routing) };
  return { result: final, comparison: compareSimulation(spec.expected, final) };
}

/** Testes concluídos para este hash de manifesto (evidência mostrada e registada na ativação). */
export async function activationTestEvidence(
  client: Queryable,
  flowId: string,
  hash: string,
): Promise<FlowActivationTestEvidence[]> {
  const rows = await client.query<{
    id: string;
    level: FlowSimulationLevel;
    scenario_name: string;
    verdict: FlowActivationTestEvidence['verdict'];
    result: unknown;
    manifest_hash: string;
    finished_at: Date | null;
  }>(
    `SELECT id,level,scenario_name,verdict,result,manifest_hash,finished_at FROM flow_simulation_runs
      WHERE flow_id=$1 AND manifest_hash=$2 AND status='completed'
      ORDER BY finished_at DESC,id LIMIT 20`,
    [flowId, hash],
  );
  return rows.rows.map((row) => ({
    runId: row.id,
    level: row.level,
    scenarioName: row.scenario_name,
    verdict: row.verdict,
    outcome: json<FlowSimulationResultView>(row.result)?.outcome ?? null,
    manifestHash: row.manifest_hash,
    finishedAt: iso(row.finished_at),
  }));
}

interface CurrentState {
  flow: FlowRow;
  definition: FlowDefinition;
  hashes: FlowSimulationHashes;
  /** Dependência em falta: o manifesto não se resolve (o rascunho não é ativável assim). */
  dependencyError: string | null;
}

/**
 * Cenários e execuções de teste dos fluxos. Nenhum nível escreve em tickets, comentários, runs
 * do Copilot ou incidentes: o comportamento corre sem base de dados e o ensaio isolado só entrega
 * no destino de teste (outbox) do próprio projeto.
 */
export class FlowSimulationService {
  constructor(
    private readonly db: Database,
    private readonly supportsAction: (key: string) => boolean = (key) =>
      Object.prototype.hasOwnProperty.call(defaultFlowActions, key),
    private readonly agentProfiles: AgentProfilesService = new AgentProfilesService(db),
  ) {}

  /** Biblioteca do fluxo: hashes atuais, cenários, execuções (com desatualização) e destinos. */
  async list(actor: User, projectId: string, flowId: string): Promise<FlowSimulationsView> {
    const context = await requireProjectPermission(this.db, actor, projectId, 'flows.simulate');
    const current = await this.current(this.db, projectId, flowId);
    const scenarios = await this.scenarioRows(this.db, current.flow.id);
    const runs = await this.db.query<SimulationRunRow>(
      `SELECT * FROM flow_simulation_runs WHERE flow_id=$1 ORDER BY created_at DESC,id LIMIT ${RUN_LIST_LIMIT}`,
      [current.flow.id],
    );
    const scenarioHashes = await this.scenarioHashes(this.db, current.flow.id);
    return {
      current: current.hashes,
      scenarios: scenarios.map(scenarioView),
      runs: runs.rows.map((row) => runView(row, current.hashes, scenarioHashes)),
      trialTargets: await this.targets(this.db, projectId),
      examples: exampleScenarios(current.definition),
      canManageTargets: context.permissions.includes('flows.activate'),
    };
  }

  /** Cria ou altera um cenário (controlo otimista pela versão). */
  async saveScenario(
    actor: User,
    projectId: string,
    flowId: string,
    scenarioId: string | null,
    raw: unknown,
  ): Promise<FlowScenarioView> {
    const input = parseInput(flowScenarioInputSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'flows.simulate',
        true,
      );
      const flow = await this.flow(client, projectId, flowId);
      const hash = sha256(input.spec);
      if (!scenarioId) {
        const id = randomUUID();
        await client.query(
          `INSERT INTO flow_simulation_scenarios(id,project_id,flow_id,name,description,spec,spec_hash,created_by,updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
          [
            id,
            projectId,
            flow.id,
            input.name,
            input.description,
            JSON.stringify(input.spec),
            hash,
            context.actor.id,
          ],
        );
        return scenarioView(await this.scenario(client, flow.id, id));
      }
      const row = await this.scenario(client, flow.id, idSchema.parse(scenarioId), true);
      if (input.version !== Number(row.version))
        throw new DomainError(
          'FLOW_SCENARIO_CHANGED',
          'O cenário foi alterado entretanto. Recarregue antes de guardar.',
          409,
        );
      await client.query(
        `UPDATE flow_simulation_scenarios SET name=$2,description=$3,spec=$4,spec_hash=$5,version=version+1,
                updated_by=$6,updated_at=NOW(3) WHERE id=$1`,
        [row.id, input.name, input.description, JSON.stringify(input.spec), hash, context.actor.id],
      );
      return scenarioView(await this.scenario(client, flow.id, row.id));
    });
  }

  /** Arquiva o cenário (as execuções antigas ficam como histórico desatualizado). */
  async archiveScenario(
    actor: User,
    projectId: string,
    flowId: string,
    scenarioId: string,
    raw: unknown,
  ) {
    const input = parseInput(versionSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'flows.simulate',
        true,
      );
      const flow = await this.flow(client, projectId, flowId);
      const row = await this.scenario(client, flow.id, idSchema.parse(scenarioId), true);
      if (input.version !== Number(row.version))
        throw new DomainError(
          'FLOW_SCENARIO_CHANGED',
          'O cenário foi alterado entretanto. Recarregue antes de arquivar.',
          409,
        );
      await client.query(
        'UPDATE flow_simulation_scenarios SET archived=1,version=version+1,updated_by=$2,updated_at=NOW(3) WHERE id=$1',
        [row.id, context.actor.id],
      );
      return { archived: true };
    });
  }

  /**
   * Novo cenário com os factos de um ticket histórico do mesmo projeto. Só leitura: o ticket,
   * os comentários e os recursos reais nunca são alterados nem usados pelos testes.
   */
  async scenarioFromTicket(
    actor: User,
    projectId: string,
    flowId: string,
    raw: unknown,
  ): Promise<FlowScenarioView> {
    const input = parseInput(flowScenarioFromTicketSchema, raw);
    await requireProjectPermission(this.db, actor, projectId, 'flows.simulate');
    const ticket = (
      await this.db.query<{
        id: string;
        key: string;
        title: string;
        description: string | null;
        origin: string;
        category: string;
        environment: string;
        priority: string;
      }>(
        'SELECT id,`key`,title,description,origin,category,environment,priority FROM tickets WHERE id=$1 AND project_id=$2',
        [input.ticketId, projectId],
      )
    ).rows[0];
    if (!ticket) throw new DomainError('TICKET_NOT_FOUND', 'Pedido não encontrado.', 404);
    const spec = flowScenarioSpecSchema.parse({
      ticket: {
        title: ticket.title.slice(0, 300),
        description: (ticket.description ?? '').slice(0, 6000),
        origin: ticket.origin,
        category: ticket.category,
        environment: ticket.environment,
        priority: ticket.priority,
      },
      sourceTicket: { id: ticket.id, key: ticket.key, snapshotAt: new Date().toISOString() },
    });
    return this.saveScenario(actor, projectId, flowId, null, {
      name: (input.name ?? `Pedido ${ticket.key}`).slice(0, 120),
      description: `Factos copiados de ${ticket.key} (só leitura).`,
      spec,
    });
  }

  /**
   * Executa um teste. Estrutural, comportamento e ensaio isolado terminam no pedido; a avaliação
   * com o Copilot real fica em fila (leases do P03). A mesma chave de idempotência devolve a
   * execução existente, sem repetir efeitos nem entregas de ensaio.
   */
  async run(
    actor: User,
    projectId: string,
    flowId: string,
    raw: unknown,
  ): Promise<FlowSimulationRunView> {
    const input = parseInput(flowSimulationRunInputSchema, raw);
    const context = await requireProjectPermission(this.db, actor, projectId, 'flows.simulate');
    const current = await this.current(this.db, projectId, flowId);
    const existing = await this.byKey(this.db, current.flow.id, input.idempotencyKey);
    if (existing) return this.view(this.db, existing, current);

    let spec: FlowScenarioSpec;
    let scenario: ScenarioRow | null = null;
    if (input.scenarioId) {
      scenario = await this.scenario(this.db, current.flow.id, input.scenarioId);
      if (scenario.archived)
        throw new DomainError('FLOW_SCENARIO_ARCHIVED', 'O cenário está arquivado.', 409);
      spec = flowScenarioSpecSchema.parse(json(scenario.spec) ?? {});
    } else if (input.spec) spec = input.spec;
    else throw new DomainError('INVALID_INPUT', 'Indique um cenário.', 400);

    let target: string | null = null;
    if (input.level === 'isolated_trial') {
      const found = input.trialTargetId
        ? (
            await this.db.query<{ id: string }>(
              'SELECT id FROM flow_trial_targets WHERE id=$1 AND project_id=$2 AND active=1',
              [input.trialTargetId, projectId],
            )
          ).rows[0]
        : undefined;
      if (!found)
        throw new DomainError(
          'TRIAL_TARGET_NOT_ALLOWED',
          'O ensaio isolado exige um destino de teste ativo configurado neste projeto.',
          403,
        );
      target = found.id;
    } else if (input.trialTargetId)
      throw new DomainError(
        'INVALID_INPUT',
        'O destino de teste só se aplica ao ensaio isolado.',
        400,
      );

    const deliveries: {
      nodeId: string;
      attempt: number;
      kind: string;
      payload: Record<string, unknown>;
    }[] = [];
    let status: 'completed' | 'queued' = 'completed';
    let runInput: Record<string, unknown> = {};
    let result: FlowSimulationResultView;
    if (input.level === 'structural') result = await this.structural(current);
    else {
      if (input.level === 'routing_copilot' && !(await copilotReady(this.db, projectId)))
        throw new DomainError(
          'COPILOT_NOT_READY',
          'A avaliação com o Copilot real exige a integração Copilot verificada neste projeto.',
          409,
        );
      result = await runFlowBehaviour({
        definition: current.definition,
        spec,
        level: input.level,
        environment: await this.environment(projectId, spec),
        actions: defaultFlowActions,
        supportsAction: this.supportsAction,
        ...(input.level === 'isolated_trial'
          ? { trial: (delivery: (typeof deliveries)[number]) => deliveries.push(delivery) }
          : {}),
      });
      const plan = planSimulatedRouting(await this.routingFlows(current), spec.ticket);
      let routing = plan.view;
      if (routing.decision === 'pending' && plan.prompt) {
        if (input.level === 'routing_copilot') {
          routing = { ...routing, source: 'copilot' };
          status = 'queued';
          runInput = {
            prompt: buildRoutingPrompt({
              ticket: { key: 'SIMULAÇÃO', ...spec.ticket },
              candidates: plan.prompt,
              conversation: [],
              questionsAsked: 0,
            }),
          } satisfies CopilotRoutingRunInput;
        } else if (spec.routing?.recordedReply)
          routing = applyRoutingReply(routing, spec.routing.recordedReply, 'recorded');
      }
      result = { ...result, routing };
    }
    const finished = finishSimulationResult(result, spec);
    const id = randomUUID();
    await this.db.transaction(async (client) => {
      await requireProjectPermission(client, actor, projectId, 'flows.simulate', true);
      const inserted = await client.query(
        `INSERT IGNORE INTO flow_simulation_runs(id,project_id,flow_id,scenario_id,scenario_version,scenario_name,
             scenario_spec,level,status,definition_hash,routing_hash,manifest_hash,scenario_hash,run_input,
             result,comparison,verdict,trial_target_id,idempotency_key,requested_by,started_at,finished_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                CASE WHEN $9='completed' THEN NOW(3) ELSE NULL END,CASE WHEN $9='completed' THEN NOW(3) ELSE NULL END)`,
        [
          id,
          projectId,
          current.flow.id,
          scenario?.id ?? null,
          scenario ? Number(scenario.version) : null,
          scenario?.name ?? 'Cenário não guardado',
          JSON.stringify(spec),
          input.level,
          status,
          current.hashes.definitionHash,
          current.hashes.routingHash,
          current.hashes.manifestHash,
          sha256(spec),
          JSON.stringify(runInput),
          JSON.stringify(finished.result),
          JSON.stringify(finished.comparison),
          status === 'completed' ? finished.comparison.verdict : null,
          target,
          input.idempotencyKey,
          context.actor.id,
        ],
      );
      if (!inserted.rowCount) return;
      for (const delivery of deliveries)
        await client.query(
          `INSERT INTO flow_trial_deliveries(target_id,project_id,simulation_run_id,node_id,attempt,kind,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            target,
            projectId,
            id,
            delivery.nodeId,
            delivery.attempt,
            delivery.kind,
            JSON.stringify(delivery.payload),
          ],
        );
    });
    const row = await this.byKey(this.db, current.flow.id, input.idempotencyKey);
    if (!row) throw new DomainError('FLOW_SIMULATION_NOT_FOUND', 'Execução não encontrada.', 404);
    return this.view(this.db, row, current);
  }

  /** Execução (para acompanhar a avaliação com o Copilot real depois de recarregar). */
  async getRun(actor: User, projectId: string, flowId: string, runId: string) {
    await requireProjectPermission(this.db, actor, projectId, 'flows.simulate');
    const current = await this.current(this.db, projectId, flowId);
    return this.view(this.db, await this.runRow(this.db, current.flow.id, runId), current);
  }

  /** Cancela uma avaliação em fila ou em curso; o executor perde a posse no heartbeat. */
  async cancelRun(actor: User, projectId: string, flowId: string, runId: string) {
    await this.db.transaction(async (client) => {
      await requireProjectPermission(client, actor, projectId, 'flows.simulate', true);
      const flow = await this.flow(client, projectId, flowId);
      const row = await this.runRow(client, flow.id, runId, true);
      if (!['queued', 'running'].includes(row.status)) return;
      await client.query(
        `UPDATE flow_simulation_runs SET status='cancelled',cancel_requested=1,error_code='cancelled',
                lease_until=NULL,finished_at=NOW(3) WHERE id=$1`,
        [row.id],
      );
    });
    return this.getRun(actor, projectId, flowId, runId);
  }

  /** Novo destino de ensaio isolado (outbox do projeto). Exige quem pode ativar fluxos. */
  async createTrialTarget(actor: User, projectId: string, raw: unknown) {
    const input = parseInput(flowTrialTargetInputSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'flows.activate',
        true,
      );
      await client.query(
        'INSERT INTO flow_trial_targets(id,project_id,name,kind,created_by) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), projectId, input.name, 'outbox', context.actor.id],
      );
      return this.targets(client, projectId);
    });
  }

  /** Desativa um destino de ensaio (as entregas ficam como histórico). */
  async deactivateTrialTarget(actor: User, projectId: string, targetId: string) {
    return this.db.transaction(async (client) => {
      await requireProjectPermission(client, actor, projectId, 'flows.activate', true);
      const updated = await client.query(
        'UPDATE flow_trial_targets SET active=0 WHERE id=$1 AND project_id=$2',
        [idSchema.parse(targetId), projectId],
      );
      if (!updated.rowCount)
        throw new DomainError('TRIAL_TARGET_NOT_FOUND', 'Destino de teste não encontrado.', 404);
      return this.targets(client, projectId);
    });
  }

  /** Entregas de um destino de ensaio (o que o ensaio produziu, em vez de efeitos reais). */
  async trialDeliveries(actor: User, projectId: string, targetId: string) {
    await requireProjectPermission(this.db, actor, projectId, 'flows.simulate');
    const rows = await this.db.query<{
      id: number;
      simulation_run_id: string;
      node_id: string;
      attempt: number;
      kind: string;
      payload: unknown;
      created_at: Date;
    }>(
      `SELECT id,simulation_run_id,node_id,attempt,kind,payload,created_at FROM flow_trial_deliveries
        WHERE target_id=$1 AND project_id=$2 ORDER BY id DESC LIMIT 100`,
      [idSchema.parse(targetId), projectId],
    );
    return rows.rows.map((row) => ({
      id: Number(row.id),
      runId: row.simulation_run_id,
      nodeId: row.node_id,
      attempt: Number(row.attempt),
      kind: row.kind,
      payload: json<Record<string, unknown>>(row.payload) ?? {},
      createdAt: iso(row.created_at)!,
    }));
  }

  // -------------------------------------------------------------------------------------------

  /** Grafo, contratos, condições, referências, responsáveis (membros atuais) e dependências. */
  private async structural(current: CurrentState): Promise<FlowSimulationResultView> {
    const members = await this.db.query<{ id: string }>(
      `SELECT u.id FROM project_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.project_id=$1 AND NOT m.disabled AND NOT u.disabled`,
      [current.flow.project_id],
    );
    const issues: FlowSimulationResultView['issues'] = validateFlowDefinition(current.definition, {
      members: new Set(members.rows.map((row) => row.id)),
      repositories: await activeRepositoryIds(this.db, current.flow.project_id),
      pipelines: await activePipelineIds(this.db, current.flow.project_id),
    }).map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
    }));
    if (current.dependencyError)
      issues.push({ code: 'DEPENDENCY_UNAVAILABLE', message: current.dependencyError });
    const unavailable = current.definition.nodes
      .filter((node) => node.op === 'action' && !this.supportsAction(actionKey(node)))
      .map((node) => ({
        nodeId: node.id,
        capability: `action:${actionKey(node)}`,
        reason: 'O runtime deste ZeroOps não tem executor para esta ação.',
      }));
    return {
      level: 'structural',
      outcome: issues.length ? 'invalid' : null,
      endOutcome: null,
      stoppedAt: null,
      waitingFor: null,
      message: issues.length
        ? `${issues.length} problema(s) estrutural(is).`
        : 'Validação estrutural sem problemas.',
      steps: [],
      effects: [],
      unavailable,
      issues,
      routing: null,
      notVerified: [],
      elapsedMinutes: 0,
    };
  }

  private async environment(
    projectId: string,
    spec: FlowScenarioSpec,
  ): Promise<FlowSimulationEnvironment> {
    const project = (
      await this.db.query<{ auto: boolean | number }>(
        'SELECT agent_auto_investigate AS auto FROM projects WHERE id=$1',
        [projectId],
      )
    ).rows[0];
    return {
      copilotReady: spec.environment?.copilotReady ?? (await copilotReady(this.db, projectId)),
      autoInvestigate: spec.environment?.autoInvestigate ?? Boolean(project?.auto),
      hasTeamMember:
        spec.environment?.hasTeamMember ?? Boolean(await teamRequester(this.db, projectId)),
    };
  }

  /** O próprio fluxo entra com as regras do rascunho; os outros com as versões ativas. */
  private async routingFlows(current: CurrentState): Promise<SimulatedRoutingFlow[]> {
    const others = (await publishedFlows(this.db, current.flow.project_id))
      .filter((flow) => flow.id !== current.flow.id)
      .map((flow) => ({
        id: flow.id,
        name: flow.name,
        priority: flow.priority,
        isDefault: flow.isDefault,
        match: flow.match,
        policy: flow.policy,
        draft: false,
      }));
    return [
      ...others,
      {
        id: current.flow.id,
        name: current.flow.name,
        priority: Number(current.flow.priority),
        isDefault: Boolean(current.flow.is_default),
        match: parseMatch(current.flow.flow_match),
        policy: parseRoutingPolicy(current.flow.routing_policy),
        draft: true,
      },
    ];
  }

  /** Hashes do rascunho atual (os mesmos que a ativação calcularia). */
  private async current(client: Queryable, projectId: string, flowId: string) {
    const flow = await this.flow(client, projectId, flowId);
    const definition = parseDefinition(flow.flow_definition);
    const linked = (
      await client.query<{ alert_key: string }>(
        'SELECT alert_key FROM health_alert_flows WHERE flow_id=$1',
        [flow.id],
      )
    ).rows.map((row) => row.alert_key);
    const routing = normalizedRouting({
      priority: Number(flow.priority),
      isDefault: Boolean(flow.is_default),
      match: parseMatch(flow.flow_match),
      alertKeys: [...linked, ...parseAlertKeys(flow.pending_alert_keys)],
      policy: parseRoutingPolicy(flow.routing_policy),
    });
    let manifest: string | null = null;
    let dependencyError: string | null = null;
    try {
      const dependencies = await this.agentProfiles.validateFlowDefinition(
        client,
        projectId,
        definition,
      );
      manifest = manifestHash(
        buildFlowManifest(definition, routing, dependencies, this.supportsAction),
      );
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      dependencyError = error.message;
    }
    return {
      flow,
      definition,
      hashes: {
        definitionHash: logicHash(definition),
        routingHash: sha256(routing),
        manifestHash: manifest,
      },
      dependencyError,
    } satisfies CurrentState;
  }

  private async flow(client: Queryable, projectId: string, flowId: string) {
    const flow = (
      await client.query<FlowRow>('SELECT * FROM flows WHERE id=$1 AND project_id=$2', [
        idSchema.parse(flowId),
        projectId,
      ])
    ).rows[0];
    if (!flow) throw new DomainError('FLOW_NOT_FOUND', 'Fluxo não encontrado.', 404);
    return flow;
  }

  private async scenario(client: Queryable, flowId: string, id: string, lock = false) {
    const row = (
      await client.query<ScenarioRow>(
        `SELECT * FROM flow_simulation_scenarios WHERE id=$1 AND flow_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [idSchema.parse(id), flowId],
      )
    ).rows[0];
    if (!row) throw new DomainError('FLOW_SCENARIO_NOT_FOUND', 'Cenário não encontrado.', 404);
    return row;
  }

  private async scenarioRows(client: Queryable, flowId: string) {
    return (
      await client.query<ScenarioRow>(
        'SELECT * FROM flow_simulation_scenarios WHERE flow_id=$1 AND archived=0 ORDER BY name,id',
        [flowId],
      )
    ).rows;
  }

  /** Hash atual de cada cenário (arquivado = ausente: execuções antigas ficam desatualizadas). */
  private async scenarioHashes(client: Queryable, flowId: string) {
    return new Map(
      (await this.scenarioRows(client, flowId)).map((row) => [row.id, row.spec_hash] as const),
    );
  }

  private async byKey(client: Queryable, flowId: string, key: string) {
    return (
      await client.query<SimulationRunRow>(
        'SELECT * FROM flow_simulation_runs WHERE flow_id=$1 AND idempotency_key=$2',
        [flowId, key],
      )
    ).rows[0];
  }

  private async runRow(client: Queryable, flowId: string, runId: string, lock = false) {
    const row = (
      await client.query<SimulationRunRow>(
        `SELECT * FROM flow_simulation_runs WHERE id=$1 AND flow_id=$2${lock ? ' FOR UPDATE' : ''}`,
        [idSchema.parse(runId), flowId],
      )
    ).rows[0];
    if (!row) throw new DomainError('FLOW_SIMULATION_NOT_FOUND', 'Execução não encontrada.', 404);
    return row;
  }

  private async view(client: Queryable, row: SimulationRunRow, current: CurrentState) {
    return runView(row, current.hashes, await this.scenarioHashes(client, current.flow.id));
  }

  private async targets(client: Queryable, projectId: string): Promise<FlowTrialTargetView[]> {
    const rows = await client.query<{
      id: string;
      name: string;
      active: boolean | number;
      created_at: Date;
      deliveries: number;
    }>(
      `SELECT t.id,t.name,t.active,t.created_at,
              (SELECT COUNT(*) FROM flow_trial_deliveries d WHERE d.target_id=t.id) AS deliveries
         FROM flow_trial_targets t WHERE t.project_id=$1 ORDER BY t.active DESC,t.name`,
      [projectId],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: 'outbox',
      active: Boolean(row.active),
      deliveries: Number(row.deliveries),
      createdAt: iso(row.created_at)!,
    }));
  }
}

function scenarioView(row: ScenarioRow): FlowScenarioView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    spec: flowScenarioSpecSchema.parse(json(row.spec) ?? {}),
    version: Number(row.version),
    hash: row.spec_hash,
    updatedAt: iso(row.updated_at)!,
    updatedBy: row.updated_by,
  };
}

/** Vista da execução com a desatualização calculada contra o rascunho e o cenário atuais. */
export function runView(
  row: SimulationRunRow,
  current: FlowSimulationHashes,
  scenarios: Map<string, string>,
): FlowSimulationRunView {
  const staleReasons: FlowSimulationRunView['staleReasons'] = [];
  if (row.definition_hash !== current.definitionHash) staleReasons.push('definition');
  if (row.routing_hash !== current.routingHash) staleReasons.push('routing');
  if ((row.manifest_hash ?? null) !== current.manifestHash) staleReasons.push('manifest');
  if (row.scenario_id && scenarios.get(row.scenario_id) !== row.scenario_hash)
    staleReasons.push('scenario');
  return {
    id: row.id,
    level: row.level,
    status: row.status,
    scenarioId: row.scenario_id,
    scenarioName: row.scenario_name,
    scenarioVersion: row.scenario_version === null ? null : Number(row.scenario_version),
    hashes: {
      definitionHash: row.definition_hash,
      routingHash: row.routing_hash,
      manifestHash: row.manifest_hash,
      scenarioHash: row.scenario_hash,
    },
    stale: staleReasons.length > 0,
    staleReasons,
    result: json<FlowSimulationResultView>(row.result),
    comparison: json<FlowSimulationComparison>(row.comparison),
    errorCode: row.error_code,
    trialTargetId: row.trial_target_id,
    requestedBy: row.requested_by,
    createdAt: iso(row.created_at)!,
    finishedAt: iso(row.finished_at),
  };
}
