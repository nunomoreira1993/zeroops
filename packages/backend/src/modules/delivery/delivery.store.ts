import { createHash, randomUUID } from 'node:crypto';
import {
  deliveryNodeConfig,
  FLOW_SUCCESS,
  flowReviewConfig,
  type DeliveryEventView,
  type DeliveryRunView,
  type DeliveryState,
  type DevelopmentCommand,
  type FlowNode,
  type PipelineCallback,
  type PipelineCheck,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import {
  eligibleReviewers,
  requiredApprovals,
  reviewArtifact,
  type WorkspaceRow,
} from '../development/development.store.js';
import {
  activeRepository,
  jsonValue,
  repositoryCredentialContext,
} from '../development/git-repositories.service.js';
import type { IdentityCipher } from '../identity/identity-security.js';
import type { Queryable } from '../identity/membership.js';
import { activePipeline, pipelineSecretContext, type PipelineRow } from './pipelines.service.js';
import { capabilityPublishGate } from '../development/capability-gates.js';
import {
  acquireResourceLock,
  canonicalEnvironmentKey,
  canonicalIntegrationKey,
  legacyIntegrationKey,
  normalizeResourceUrl,
  releaseLocksOf,
  releaseResourceLock,
  renewResourceLock,
  type LockAttempt,
} from '../../database/resource-locks.js';

export interface DeliveryRow {
  id: string;
  project_id: string;
  ticket_id: string;
  execution_id: string;
  step_id: string;
  node_id: string;
  pipeline_id: string;
  repository_id: string;
  workspace_id: string;
  review_step_id: string | null;
  environment: string;
  target_branch: string;
  /** F03: chave canónica do repositório real + branch (NULL em entregas anteriores à 047). */
  integration_key: string | null;
  /**
   * F01: impressão digital do destino material fixado na criação (NULL em entregas anteriores à
   * 048, preenchida na primeira posse). Uma configuração diferente nunca redireciona a entrega.
   */
  config_fingerprint: string | null;
  candidate_base_sha: string;
  candidate_head_sha: string;
  candidate_scope_hash: string;
  approvals: unknown;
  target_sha: string | null;
  integrated_sha: string | null;
  revalidated: boolean;
  artifact_digest: string | null;
  state: DeliveryState;
  state_reason: string | null;
  idempotency_key: string;
  external_id: string | null;
  external_url: string | null;
  pipeline_status: string | null;
  last_sequence: number;
  checks: unknown;
  evidence: unknown;
  worker_id: string | null;
  lease_epoch: number;
  lease_until: Date | null;
  attempts: number;
  next_check_at: Date | null;
  cancel_requested: boolean;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** Aprovação válida que autoriza a entrega (registada no momento em que a entrega foi criada). */
export interface DeliveryApproval {
  actorId: string;
  displayName: string;
  override: boolean;
}

export type DeliveryGates =
  | {
      ok: true;
      pipeline: PipelineRow;
      workspace: WorkspaceRow;
      headSha: string;
      scopeHash: string;
      reviewStepId: string;
      approvals: DeliveryApproval[];
      required: number;
    }
  | { ok: false; reason: string; rework?: boolean; pending?: boolean };

/** F01: a configuração material mudou depois de fixada (destino) ou do claim (autorização). */
export type DeliveryConfigChange = {
  ok: false;
  reason: string;
  configChanged: 'target' | 'authorization';
};

/**
 * F01: impressão digital, sem segredos, do destino material da entrega: pipeline, repositório real,
 * branch, ambiente, endpoint efetivamente chamado e alvo canónico do lock. Alterações de nome,
 * política ou segredo não mudam o destino.
 */
export function deliveryTargetFingerprint(input: {
  pipeline: Pick<
    PipelineRow,
    'id' | 'repository_id' | 'target_branch' | 'environment' | 'endpoint_url' | 'target_key'
  >;
  repositoryUrl: string | null;
}) {
  const { pipeline } = input;
  const material = {
    pipeline: pipeline.id,
    repository: pipeline.repository_id,
    repositoryUrl: input.repositoryUrl === null ? null : normalizeResourceUrl(input.repositoryUrl),
    branch: pipeline.target_branch,
    environment: pipeline.environment,
    endpoint: pipeline.endpoint_url.trim().replace(/\/+$/, ''),
    target: canonicalEnvironmentKey({
      targetKey: pipeline.target_key,
      endpointUrl: pipeline.endpoint_url,
      environment: pipeline.environment,
    }),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

const ACTIVE_FLOW = "('running','waiting')";

/**
 * Gates da entrega, avaliados na criação e de novo antes de integrar/publicar: pipeline ativa do
 * mesmo repositório, review concluído com sucesso nesta execução, candidato com testes finais
 * aprovados e aprovações válidas (sobre o head atual, de revisores ainda elegíveis ou override
 * administrativo explícito ainda ativo) em número suficiente, e ticket em curso.
 */
export async function evaluateDeliveryGates(
  client: Queryable,
  input: {
    ticketId: string;
    projectId: string;
    executionId: string;
    nodes: readonly FlowNode[];
    node: FlowNode;
    /** Head aprovado quando a entrega foi criada (mudança = alteração material). */
    expectedHead?: string;
  },
): Promise<DeliveryGates> {
  const config = deliveryNodeConfig(input.node);
  const pipeline = config.pipelineId
    ? await activePipeline(client, input.projectId, config.pipelineId)
    : null;
  if (!pipeline)
    return { ok: false, reason: 'A pipeline da entrega não existe ou está arquivada.' };
  const reviewNode = input.nodes.find((item) => item.id === config.reviewNode);
  const review = reviewNode ? flowReviewConfig(reviewNode) : null;
  if (!reviewNode || !review)
    return { ok: false, reason: 'A entrega não aponta para uma decisão de review configurada.' };
  const ticket = (
    await client.query<{ status: string; created_by: string }>(
      'SELECT status,created_by FROM tickets WHERE id=$1 AND project_id=$2',
      [input.ticketId, input.projectId],
    )
  ).rows[0];
  if (!ticket || ['resolved', 'cancelled'].includes(ticket.status))
    return { ok: false, reason: 'O ticket já não está em curso.' };
  const reviewStep = (
    await client.query<{ id: string; port: string | null }>(
      `SELECT id,port FROM flow_execution_steps WHERE execution_id=$1 AND node_id=$2 AND status='completed'
        ORDER BY step_sequence DESC LIMIT 1`,
      [input.executionId, reviewNode.id],
    )
  ).rows[0];
  if (!reviewStep || reviewStep.port !== FLOW_SUCCESS)
    return { ok: false, reason: `O review «${reviewNode.label}» ainda não foi aprovado.` };
  const artifact = await reviewArtifact(client, input.ticketId, review.sourceNode);
  if (!artifact) return { ok: false, reason: 'Não existe candidato desenvolvido para entregar.' };
  if (input.expectedHead && artifact.headSha !== input.expectedHead)
    return {
      ok: false,
      rework: true,
      reason: `O candidato mudou depois da aprovação (${input.expectedHead.slice(0, 12)} → ${artifact.headSha.slice(0, 12)}): exige novo review.`,
    };
  if (!artifact.workspace.tests_passed)
    return { ok: false, reason: 'Os testes finais do candidato não passaram.' };
  if (artifact.workspace.repository_id !== pipeline.repository_id)
    return { ok: false, reason: 'A pipeline pertence a outro repositório do projeto.' };
  const decisions = await client.query<{
    actor_id: string;
    display_name: string;
    override_used: boolean;
    admin: number;
  }>(
    `SELECT d.actor_id,u.display_name,d.override_used,
            EXISTS(SELECT 1 FROM project_memberships m WHERE m.project_id=$3 AND m.user_id=d.actor_id
                      AND m.role='admin' AND NOT m.disabled AND NOT u.disabled) AS admin
       FROM development_review_decisions d JOIN users u ON u.id=d.actor_id
      WHERE d.step_id=$1 AND d.head_sha=$2 AND d.port=$4 AND d.invalidated_at IS NULL
      ORDER BY d.created_at`,
    [reviewStep.id, artifact.headSha, input.projectId, FLOW_SUCCESS],
  );
  const eligible = await eligibleReviewers(client, input.projectId, review, ticket.created_by);
  const eligibleIds = new Set(eligible.map((item) => item.id));
  const approvals = new Map<string, DeliveryApproval>();
  for (const row of decisions.rows) {
    const valid = row.override_used
      ? review.adminOverride && Boolean(Number(row.admin)) && row.actor_id !== ticket.created_by
      : eligibleIds.has(row.actor_id);
    if (valid)
      approvals.set(row.actor_id, {
        actorId: row.actor_id,
        displayName: row.display_name,
        override: Boolean(row.override_used),
      });
  }
  const required = requiredApprovals(review, eligible.length);
  if (approvals.size < required)
    return {
      ok: false,
      reason: `Faltam aprovações válidas sobre ${artifact.headSha.slice(0, 12)} (${approvals.size}/${required}).`,
    };
  // P10: tickets de desenvolvimento de capacidade exigem também autorização de publicação.
  const capability = await capabilityPublishGate(client, {
    ticketId: input.ticketId,
    projectId: input.projectId,
    pipelineId: pipeline.id,
  });
  if (!capability.ok) return { ok: false, reason: capability.reason, pending: capability.pending };
  return {
    ok: true,
    pipeline,
    workspace: artifact.workspace,
    headSha: artifact.headSha,
    scopeHash: artifact.scopeHash,
    reviewStepId: reviewStep.id,
    approvals: [...approvals.values()],
    required,
  };
}

/** Cria a entrega (fila durável). Idempotente pela etapa do fluxo. */
export async function createDelivery(
  client: Queryable,
  input: {
    ticketId: string;
    projectId: string;
    executionId: string;
    stepId: string;
    nodeId: string;
    gates: Extract<DeliveryGates, { ok: true }>;
  },
) {
  const id = randomUUID();
  const { gates } = input;
  const repository = (
    await client.query<{ url: string }>('SELECT url FROM project_git_repositories WHERE id=$1', [
      gates.pipeline.repository_id,
    ])
  ).rows[0];
  await client.query(
    `INSERT INTO delivery_runs(id,project_id,ticket_id,execution_id,step_id,node_id,pipeline_id,
       repository_id,workspace_id,review_step_id,environment,target_branch,candidate_base_sha,
       candidate_head_sha,candidate_scope_hash,approvals,idempotency_key,state,integration_key,
       config_fingerprint)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'queued',$18,$19)`,
    [
      id,
      input.projectId,
      input.ticketId,
      input.executionId,
      input.stepId,
      input.nodeId,
      gates.pipeline.id,
      gates.pipeline.repository_id,
      gates.workspace.id,
      gates.reviewStepId,
      gates.pipeline.environment,
      gates.pipeline.target_branch,
      gates.workspace.base_sha,
      gates.headSha,
      gates.scopeHash,
      JSON.stringify({ required: gates.required, actors: gates.approvals }),
      randomUUID(),
      repository ? canonicalIntegrationKey(repository.url, gates.pipeline.target_branch) : null,
      deliveryTargetFingerprint({
        pipeline: gates.pipeline,
        repositoryUrl: repository?.url ?? null,
      }),
    ],
  );
  return id;
}

/** Entrega da etapa (bloqueada para a transação do motor). */
export async function deliveryForStep(client: Queryable, stepId: string) {
  return (
    (
      await client.query<DeliveryRow>('SELECT * FROM delivery_runs WHERE step_id=$1 FOR UPDATE', [
        stepId,
      ])
    ).rows[0] ?? null
  );
}

/** Posse do executor sobre uma entrega (época incrementada a cada claim). */
export interface DeliveryLease {
  deliveryId: string;
  workerId: string;
  epoch: number;
}

/** Contexto que o executor precisa para integrar e publicar (segredos só em memória). */
export interface DeliveryJob {
  lease: DeliveryLease;
  delivery: DeliveryRow;
  ticketKey: string;
  pipeline: {
    id: string;
    endpointUrl: string;
    secret: string;
    allowIntegration: boolean;
    holdPolicy: PipelineRow['hold_policy'];
    archived: boolean;
  };
  repository: {
    url: string;
    credential: string | null;
    setupCommands: DevelopmentCommand[];
    testCommands: DevelopmentCommand[];
  } | null;
  workspace: { branch: string };
  /**
   * F03: locks canónicos dos recursos reais, calculados a partir da configuração atual (URL do
   * repositório + branch; alvo explícito ou endpoint + ambiente).
   */
  locks: { integration: string | null; environment: string };
  /** F01: destino material da configuração carregada neste claim (a usada nos efeitos). */
  configFingerprint: string;
}

export type DeliveryWrite = 'accepted' | 'stale';

/** Uma callback/reconciliação depois de aplicada (para a resposta HTTP e testes). */
export type DeliveryEventOutcome = DeliveryEventView['outcome'];

const terminal = (row: Pick<DeliveryRow, 'finished_at'>) => row.finished_at !== null;

/**
 * F01: compara o destino atual com o fixado na entrega e com o do claim; `allowIntegration`
 * (quando indicado) com a autorização carregada no claim.
 */
function configChange(
  row: Pick<DeliveryRow, 'config_fingerprint'>,
  current: string | null,
  claimed: { configFingerprint: string; pipeline?: { allowIntegration: boolean } } | undefined,
  allowIntegration: boolean | null,
): DeliveryConfigChange | null {
  const fixed = row.config_fingerprint ?? claimed?.configFingerprint ?? current;
  if (current === null || current !== fixed || (claimed && claimed.configFingerprint !== current))
    return {
      ok: false,
      configChanged: 'target',
      reason:
        'O destino da entrega (repositório, branch, pipeline, endpoint ou alvo) mudou depois de ter sido fixado: a entrega não é redirecionada e exige decisão humana.',
    };
  if (
    allowIntegration !== null &&
    claimed?.pipeline &&
    claimed.pipeline.allowIntegration !== allowIntegration
  )
    return {
      ok: false,
      configChanged: 'authorization',
      reason:
        'A autorização de integração da pipeline mudou durante a tentativa: nenhum efeito com a configuração anterior; a entrega é retomada com a atual.',
    };
  return null;
}

/**
 * Persistência das entregas. As escritas do executor exigem a posse atual (worker + época +
 * lease válido) e o estado esperado: uma tentativa antiga nunca integra nem publica, e uma
 * callback que já concluiu a entrega nunca é sobreposta.
 */
export class DeliveryStore {
  constructor(
    private readonly db: Database,
    private readonly cipher?: IdentityCipher,
  ) {}

  /** Próxima entrega elegível: fila FIFO por repositório/branch, retomas e reconciliações vencidas. */
  async claimNext(workerId: string, leaseSeconds = 120): Promise<DeliveryJob | null> {
    const candidates = await this.db.query<{ id: string }>(
      `SELECT d.id FROM delivery_runs d
        WHERE d.finished_at IS NULL AND (d.lease_until IS NULL OR d.lease_until<NOW(3))
          AND (d.next_check_at IS NULL OR d.next_check_at<=NOW(3) OR d.cancel_requested)
          AND (d.state<>'queued' OR NOT EXISTS(
                SELECT 1 FROM delivery_runs o WHERE (o.integration_key=d.integration_key
                    OR (o.repository_id=d.repository_id AND o.target_branch=d.target_branch))
                  AND o.finished_at IS NULL
                  AND o.state IN ('queued','integrating')
                  AND (o.created_at<d.created_at OR (o.created_at=d.created_at AND o.id<d.id))))
          AND NOT EXISTS(SELECT 1 FROM ticket_purge_maintenance p WHERE p.project_id=d.project_id AND p.lease_until>NOW(3))
        ORDER BY d.created_at LIMIT 10`,
    );
    for (const { id } of candidates.rows) {
      const claimed = await this.db.query(
        `UPDATE delivery_runs SET worker_id=$2,lease_epoch=lease_epoch+1,
           lease_until=TIMESTAMPADD(SECOND,$3,NOW(3)),updated_at=NOW(3)
          WHERE id=$1 AND finished_at IS NULL AND (lease_until IS NULL OR lease_until<NOW(3))`,
        [id, workerId, leaseSeconds],
      );
      if (!claimed.rowCount) continue;
      const job = await this.job(id, workerId);
      if (job) return job;
    }
    return null;
  }

  /** Renova o lease (operações longas: merge, testes, pedidos HTTP). */
  async heartbeat(lease: DeliveryLease, leaseSeconds = 120): Promise<DeliveryWrite> {
    const result = await this.db.query(
      `UPDATE delivery_runs SET lease_until=TIMESTAMPADD(SECOND,$4,NOW(3))
        WHERE id=$1 AND worker_id=$2 AND lease_epoch=$3 AND lease_until>NOW(3) AND finished_at IS NULL`,
      [lease.deliveryId, lease.workerId, lease.epoch, leaseSeconds],
    );
    return result.rowCount ? 'accepted' : 'stale';
  }

  /**
   * P10: imediatamente antes de pedir a publicação, a autorização de publicação de capacidade
   * (quando o ticket é um desenvolvimento de capacidade) é verificada de novo.
   */
  async publishGate(lease: DeliveryLease) {
    return this.fenced(lease, null, (client, row) =>
      capabilityPublishGate(client, {
        ticketId: row.ticket_id,
        projectId: row.project_id,
        pipelineId: row.pipeline_id,
      }),
    );
  }

  /**
   * Revalida os gates com a definição publicada da execução e a posse da etapa no fluxo. F01: com
   * `claimed` (o contexto efetivamente usado pelo executor), confirma também que o destino material
   * continua o fixado na criação e o do claim, e que a autorização de integração não mudou.
   */
  async revalidate(
    lease: DeliveryLease,
    claimed?: Pick<DeliveryJob, 'configFingerprint'> & {
      pipeline: Pick<DeliveryJob['pipeline'], 'allowIntegration'>;
    },
  ): Promise<
    DeliveryGates | DeliveryConfigChange | { ok: false; reason: string; cancelled: true } | 'stale'
  > {
    return this.fenced(lease, null, async (client, row) => {
      const step = (
        await client.query<{ flow_definition: unknown }>(
          `SELECT v.flow_definition FROM flow_execution_steps s
             JOIN flow_executions e ON e.id=s.execution_id
             JOIN flow_versions v ON v.id=e.version_id
            WHERE s.id=$1 AND e.id=$2 AND e.current_step_id=s.id AND s.status='waiting'
              AND e.status IN ${ACTIVE_FLOW} AND e.suspended_at IS NULL`,
          [row.step_id, row.execution_id],
        )
      ).rows[0];
      if (!step)
        return {
          ok: false as const,
          cancelled: true as const,
          reason: 'A etapa de entrega já não está ativa no fluxo.',
        };
      const definition = jsonValue<{ nodes?: FlowNode[] }>(step.flow_definition, {});
      const nodes = definition.nodes ?? [];
      const node = nodes.find((item) => item.id === row.node_id);
      if (!node) return { ok: false as const, reason: 'A etapa de entrega não existe na versão.' };
      const gates = await evaluateDeliveryGates(client, {
        ticketId: row.ticket_id,
        projectId: row.project_id,
        executionId: row.execution_id,
        nodes,
        node,
        expectedHead: row.candidate_head_sha,
      });
      if (gates.ok && gates.pipeline.id !== row.pipeline_id)
        return { ok: false as const, reason: 'A pipeline da etapa mudou.' };
      if (gates.ok) {
        const repository = await activeRepository(client, row.project_id, row.repository_id);
        const current = deliveryTargetFingerprint({
          pipeline: gates.pipeline,
          repositoryUrl: repository?.url ?? null,
        });
        const change = configChange(
          row,
          current,
          claimed,
          Boolean(gates.pipeline.allow_integration),
        );
        if (change) return change;
      }
      return gates;
    });
  }

  /**
   * F01: antes de um efeito de reconciliação (consulta/cancelamento no fornecedor) confirma que o
   * destino material atual é o fixado e o do claim. Não reavalia os gates do fluxo.
   */
  async targetCheck(
    lease: DeliveryLease,
    claimed: Pick<DeliveryJob, 'configFingerprint'>,
  ): Promise<DeliveryConfigChange | { ok: true } | 'stale'> {
    return this.fenced(lease, null, async (client, row) => {
      const pipeline = (
        await client.query<PipelineRow>('SELECT * FROM project_pipelines WHERE id=$1', [
          row.pipeline_id,
        ])
      ).rows[0];
      const repository = await activeRepository(client, row.project_id, row.repository_id);
      const current = pipeline
        ? deliveryTargetFingerprint({ pipeline, repositoryUrl: repository?.url ?? null })
        : null;
      return configChange(row, current, claimed, null) ?? { ok: true as const };
    });
  }

  /** Atualiza a entrega se a posse for atual e o estado for um dos esperados. */
  async update(
    lease: DeliveryLease,
    from: readonly DeliveryState[],
    patch: Partial<
      Pick<
        DeliveryRow,
        | 'state'
        | 'state_reason'
        | 'target_sha'
        | 'integrated_sha'
        | 'revalidated'
        | 'artifact_digest'
        | 'external_id'
        | 'external_url'
        | 'pipeline_status'
        | 'evidence'
        | 'attempts'
      >
    >,
  ): Promise<DeliveryWrite> {
    return this.fenced(lease, from, async (client) => {
      await this.write(client, lease.deliveryId, patch);
      return 'accepted' as const;
    });
  }

  /** Estado terminal (com libertação de locks e despertar do fluxo). */
  async finish(
    lease: DeliveryLease,
    from: readonly DeliveryState[],
    state: DeliveryState,
    reason: string | null,
    patch: Parameters<DeliveryStore['update']>[2] = {},
  ): Promise<DeliveryWrite> {
    return this.fenced(lease, from, async (client, row) => {
      await this.write(client, row.id, patch);
      await this.close(client, row, state, reason);
      return 'accepted' as const;
    });
  }

  /** Lock durável detido pela entrega (só com a posse atual). */
  async acquireLock(
    lease: DeliveryLease,
    key: string,
    ttlSeconds: number,
  ): Promise<LockAttempt | 'stale'> {
    return this.fenced(lease, null, async (client, row) =>
      acquireResourceLock(
        client,
        key,
        { kind: 'delivery', id: row.id, projectId: row.project_id },
        ttlSeconds,
      ),
    );
  }

  /** Liberta um lock da entrega. */
  async releaseLock(deliveryId: string, key: string) {
    await releaseResourceLock(this.db, key, { kind: 'delivery', id: deliveryId });
  }

  /** F04: renova um lock detido (mesma época) durante operações longas; `false` = perdido. */
  async renewLock(
    lease: DeliveryLease,
    key: string,
    epoch: number,
    ttlSeconds: number,
  ): Promise<boolean | 'stale'> {
    return this.fenced(lease, null, (client, row) =>
      renewResourceLock(client, key, { kind: 'delivery', id: row.id }, epoch, ttlSeconds),
    );
  }

  /** Termina o processamento: liberta o lease e agenda a próxima verificação. */
  async release(lease: DeliveryLease, nextCheckSeconds: number | null) {
    await this.db.query(
      `UPDATE delivery_runs SET worker_id=NULL,lease_until=NULL,
         next_check_at=${nextCheckSeconds === null ? 'NULL' : 'TIMESTAMPADD(SECOND,$4,NOW(3))'},updated_at=NOW(3)
        WHERE id=$1 AND worker_id=$2 AND lease_epoch=$3`,
      [
        lease.deliveryId,
        lease.workerId,
        lease.epoch,
        ...(nextCheckSeconds === null ? [] : [nextCheckSeconds]),
      ],
    );
  }

  /** Regista um evento do executor (pedido enviado, resposta, reconciliação) para auditoria. */
  async recordRunnerEvent(
    lease: DeliveryLease,
    status: string,
    payload: Record<string, unknown>,
  ): Promise<DeliveryWrite> {
    return this.fenced(lease, null, async (client, row) => {
      await client.query(
        `INSERT INTO delivery_events(id,delivery_id,pipeline_id,event_id,source,sequence,status,outcome,payload)
         VALUES($1,$2,$3,$4,'runner',0,$5,'recorded',$6)`,
        [
          randomUUID(),
          row.id,
          row.pipeline_id,
          `runner:${randomUUID()}`,
          status.slice(0, 20),
          JSON.stringify(payload),
        ],
      );
      return 'accepted' as const;
    });
  }

  /** Segredo da pipeline para validar callbacks (só a API; nunca devolvido). */
  async callbackSecret(pipelineId: string) {
    const row = (
      await this.db.query<{ project_id: string; secret_ciphertext: string }>(
        'SELECT project_id,secret_ciphertext FROM project_pipelines WHERE id=$1',
        [pipelineId],
      )
    ).rows[0];
    if (!row || !this.cipher) return null;
    return this.cipher.decrypt(
      row.secret_ciphertext,
      pipelineSecretContext(row.project_id, pipelineId),
    );
  }

  /**
   * Aplica uma callback ou reconciliação: duplicados (mesmo evento), mensagens fora de ordem
   * (sequência não superior) e mensagens depois do estado terminal ficam registadas sem efeito;
   * SHA ou digest diferentes do candidato validado falham a entrega.
   */
  async applyEvent(
    pipelineId: string,
    event: PipelineCallback,
    source: 'callback' | 'reconcile',
  ): Promise<{ outcome: DeliveryEventOutcome; deliveryId: string } | null> {
    return this.db.transaction(async (client) => {
      const row = (
        await client.query<DeliveryRow>(
          'SELECT * FROM delivery_runs WHERE pipeline_id=$1 AND idempotency_key=$2 FOR UPDATE',
          [pipelineId, event.idempotencyKey],
        )
      ).rows[0];
      if (!row) return null;
      return { outcome: await this.applyLocked(client, row, event, source), deliveryId: row.id };
    });
  }

  /**
   * Manutenção: pede cancelamento das entregas cujo fluxo/ticket terminou, liberta locks retidos
   * até ao fim do fluxo e remove locks expirados há muito.
   */
  async maintenance() {
    const cancelled = await this.db.query(
      `UPDATE delivery_runs d SET cancel_requested=1,updated_at=NOW(3)
        WHERE d.finished_at IS NULL AND NOT d.cancel_requested AND NOT EXISTS(
          SELECT 1 FROM flow_executions e JOIN tickets t ON t.id=e.ticket_id
           WHERE e.id=d.execution_id AND e.status IN ${ACTIVE_FLOW} AND e.current_step_id=d.step_id
             AND t.status NOT IN ('resolved','cancelled'))`,
    );
    const ended = await this.db.query<{ id: string }>(
      `SELECT DISTINCT l.holder_id AS id FROM resource_locks l JOIN delivery_runs d ON d.id=l.holder_id
        WHERE l.holder_kind='delivery' AND d.finished_at IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM flow_executions e WHERE e.id=d.execution_id AND e.status IN ${ACTIVE_FLOW})`,
    );
    for (const { id } of ended.rows) await releaseLocksOf(this.db, { kind: 'delivery', id });
    await this.db.query('DELETE FROM resource_locks WHERE expires_at<TIMESTAMPADD(HOUR,-1,NOW(3))');
    return { cancelRequested: cancelled.rowCount, released: ended.rows.length };
  }

  /** Vistas das entregas de um ticket (interno: só equipa). */
  async ticketDeliveries(client: Queryable, ticketId: string): Promise<DeliveryRunView[]> {
    const rows = await client.query<
      DeliveryRow & { pipeline_name: string; queue_position: number | null }
    >(
      `SELECT d.*,p.name AS pipeline_name,
              CASE WHEN d.finished_at IS NULL AND d.state IN ('queued','integrating') THEN
                (SELECT COUNT(*) FROM delivery_runs o WHERE (o.integration_key=d.integration_key
                     OR (o.repository_id=d.repository_id AND o.target_branch=d.target_branch))
                   AND o.finished_at IS NULL
                   AND o.state IN ('queued','integrating')
                   AND (o.created_at<d.created_at OR (o.created_at=d.created_at AND o.id<=d.id)))
              END AS queue_position
         FROM delivery_runs d JOIN project_pipelines p ON p.id=d.pipeline_id
        WHERE d.ticket_id=$1 ORDER BY d.created_at DESC LIMIT 20`,
      [ticketId],
    );
    const views: DeliveryRunView[] = [];
    for (const row of rows.rows) {
      const events = await client.query<{
        id: string;
        event_id: string;
        source: DeliveryEventView['source'];
        sequence: number;
        status: string;
        outcome: DeliveryEventOutcome;
        received_at: Date;
      }>(
        `SELECT id,event_id,source,sequence,status,outcome,received_at FROM delivery_events
          WHERE delivery_id=$1 ORDER BY received_at DESC LIMIT 30`,
        [row.id],
      );
      const approvals = jsonValue<{ actors?: DeliveryApproval[] }>(row.approvals, {});
      views.push({
        id: row.id,
        stepId: row.step_id,
        nodeId: row.node_id,
        workspaceId: row.workspace_id,
        pipeline: {
          id: row.pipeline_id,
          name: row.pipeline_name,
          environment: row.environment,
          targetBranch: row.target_branch,
        },
        state: row.state,
        reason: row.state_reason,
        candidate: {
          baseSha: row.candidate_base_sha,
          headSha: row.candidate_head_sha,
          scopeHash: row.candidate_scope_hash,
        },
        approvals: (approvals.actors ?? []).map((item) => ({
          actorId: item.actorId,
          displayName: item.displayName,
        })),
        targetSha: row.target_sha,
        integratedSha: row.integrated_sha,
        revalidated: Boolean(row.revalidated),
        artifactDigest: row.artifact_digest,
        externalId: row.external_id,
        externalUrl: row.external_url,
        pipelineStatus: row.pipeline_status,
        checks: jsonValue<PipelineCheck[]>(row.checks, []),
        queuePosition: row.queue_position === null ? null : Number(row.queue_position),
        attempts: Number(row.attempts),
        events: events.rows.map((item) => ({
          id: item.id,
          eventId: item.event_id,
          source: item.source,
          sequence: Number(item.sequence),
          status: item.status,
          outcome: item.outcome,
          receivedAt: new Date(item.received_at).toISOString(),
        })),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      });
    }
    return views;
  }

  private async applyLocked(
    client: Queryable,
    row: DeliveryRow,
    event: PipelineCallback,
    source: 'callback' | 'reconcile',
  ): Promise<DeliveryEventOutcome> {
    const known = await client.query(
      'SELECT id FROM delivery_events WHERE delivery_id=$1 AND event_id=$2',
      [row.id, event.eventId],
    );
    if (known.rowCount) return 'duplicate';
    let outcome: DeliveryEventOutcome;
    if (terminal(row)) outcome = 'ignored_terminal';
    else if (!['starting', 'publishing', 'uncertain'].includes(row.state)) outcome = 'recorded';
    else if (event.sequence <= Number(row.last_sequence) && row.pipeline_status !== null)
      outcome = 'out_of_order';
    else if (event.sha !== row.integrated_sha || event.artifactDigest !== row.artifact_digest)
      outcome = 'mismatch';
    else outcome = 'applied';
    if (source === 'reconcile' && outcome === 'out_of_order') return outcome;
    try {
      await client.query(
        `INSERT INTO delivery_events(id,delivery_id,pipeline_id,event_id,source,sequence,status,outcome,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          randomUUID(),
          row.id,
          row.pipeline_id,
          event.eventId,
          source,
          event.sequence,
          event.status,
          outcome,
          JSON.stringify(event),
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return 'duplicate';
      throw error;
    }
    if (outcome === 'mismatch') {
      await this.close(
        client,
        row,
        'failed',
        `O fornecedor reportou ${event.sha.slice(0, 12)}/${event.artifactDigest.slice(7, 19)}, diferente do candidato validado: nada é considerado publicado.`,
      );
      return outcome;
    }
    if (outcome !== 'applied') return outcome;
    await this.write(client, row.id, {
      external_id: event.externalId,
      external_url: event.url ?? row.external_url,
      pipeline_status: event.status,
    });
    await client.query('UPDATE delivery_runs SET last_sequence=$2,checks=$3 WHERE id=$1', [
      row.id,
      event.sequence,
      JSON.stringify(event.checks),
    ]);
    if (event.status === 'succeeded')
      await this.close(
        client,
        row,
        'published',
        event.message ?? 'Publicação confirmada pelo fornecedor.',
      );
    else if (event.status === 'failed')
      await this.close(client, row, 'failed', event.message ?? 'A pipeline falhou.');
    else if (event.status === 'cancelled')
      await this.close(client, row, 'cancelled', event.message ?? 'A pipeline foi cancelada.');
    else if (row.state !== 'publishing')
      await client.query(
        "UPDATE delivery_runs SET state='publishing',state_reason=NULL,updated_at=NOW(3) WHERE id=$1",
        [row.id],
      );
    return outcome;
  }

  private async close(
    client: Queryable,
    row: DeliveryRow,
    state: DeliveryState,
    reason: string | null,
  ) {
    await client.query(
      `UPDATE delivery_runs SET state=$2,state_reason=$3,finished_at=NOW(3),worker_id=NULL,
         lease_until=NULL,next_check_at=NULL,updated_at=NOW(3) WHERE id=$1`,
      [row.id, state, reason?.slice(0, 1000) ?? null],
    );
    const hold = (
      await client.query<{ hold_policy: string }>(
        'SELECT hold_policy FROM project_pipelines WHERE id=$1',
        [row.pipeline_id],
      )
    ).rows[0]?.hold_policy;
    const holder = { kind: 'delivery' as const, id: row.id };
    // O ambiente fica retido enquanto o resultado é incerto ou o fluxo o exige (QA partilhado).
    // Locks de ambiente: chave canónica (F03) e chave legada anterior à 047.
    const environmentKeys = "(lock_key LIKE 'target:%' OR lock_key LIKE 'env:%')";
    if (state === 'uncertain' || (state === 'published' && hold === 'until_flow_end')) {
      await client.query(
        `UPDATE resource_locks SET expires_at=TIMESTAMPADD(DAY,7,NOW(3))
          WHERE holder_kind='delivery' AND holder_id=$1 AND ${environmentKeys}`,
        [row.id],
      );
      await client.query(
        `DELETE FROM resource_locks WHERE holder_kind='delivery' AND holder_id=$1
            AND NOT ${environmentKeys}`,
        [row.id],
      );
    } else await releaseLocksOf(client, holder);
    await client.query(
      `UPDATE flow_executions SET wake_at=NOW(3) WHERE id=$1 AND status IN ${ACTIVE_FLOW}`,
      [row.execution_id],
    );
  }

  private async write(
    client: Queryable,
    id: string,
    patch: Parameters<DeliveryStore['update']>[2],
  ) {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([key], index) => `${key}=$${index + 2}`);
    await client.query(`UPDATE delivery_runs SET ${sets.join(',')},updated_at=NOW(3) WHERE id=$1`, [
      id,
      ...entries.map(([key, value]) =>
        key === 'evidence'
          ? JSON.stringify(value)
          : key === 'revalidated'
            ? value
              ? 1
              : 0
            : value,
      ),
    ]);
  }

  private async fenced<T>(
    lease: DeliveryLease,
    from: readonly DeliveryState[] | null,
    write: (client: Queryable, row: DeliveryRow) => Promise<T>,
  ): Promise<T | 'stale'> {
    return this.db.transaction(async (client) => {
      const row = (
        await client.query<DeliveryRow>(
          `SELECT * FROM delivery_runs WHERE id=$1 AND worker_id=$2 AND lease_epoch=$3
             AND lease_until>NOW(3) AND finished_at IS NULL FOR UPDATE`,
          [lease.deliveryId, lease.workerId, lease.epoch],
        )
      ).rows[0];
      if (!row || (from && !from.includes(row.state))) return 'stale' as const;
      return write(client, row);
    });
  }

  private async job(id: string, workerId: string): Promise<DeliveryJob | null> {
    const row = (
      await this.db.query<DeliveryRow & { ticket_key: string; branch: string }>(
        `SELECT d.*,t.\`key\` AS ticket_key,w.branch FROM delivery_runs d
           JOIN tickets t ON t.id=d.ticket_id JOIN development_workspaces w ON w.id=d.workspace_id
          WHERE d.id=$1 AND d.worker_id=$2`,
        [id, workerId],
      )
    ).rows[0];
    if (!row) return null;
    const pipeline = (
      await this.db.query<PipelineRow>('SELECT * FROM project_pipelines WHERE id=$1', [
        row.pipeline_id,
      ])
    ).rows[0];
    if (!pipeline || !this.cipher) return null;
    const repository = await activeRepository(this.db, row.project_id, row.repository_id);
    if (repository && row.integration_key === null) {
      // F03: entregas anteriores à 047 recebem a chave canónica na primeira posse.
      row.integration_key = canonicalIntegrationKey(repository.url, row.target_branch);
      await this.db.query(
        'UPDATE delivery_runs SET integration_key=$2 WHERE id=$1 AND integration_key IS NULL',
        [row.id, row.integration_key],
      );
    } else if (repository && row.integration_key) {
      const migrated = await this.migrateIntegrationKey(row, repository.url);
      if (migrated) row.integration_key = migrated;
    }
    const configFingerprint = deliveryTargetFingerprint({
      pipeline,
      repositoryUrl: repository?.url ?? null,
    });
    if (row.config_fingerprint === null) {
      // F01: entregas anteriores à 048 fixam o destino na primeira posse.
      await this.db.query(
        'UPDATE delivery_runs SET config_fingerprint=$2 WHERE id=$1 AND config_fingerprint IS NULL',
        [row.id, configFingerprint],
      );
      row.config_fingerprint = (
        await this.db.query<{ config_fingerprint: string }>(
          'SELECT config_fingerprint FROM delivery_runs WHERE id=$1',
          [row.id],
        )
      ).rows[0]!.config_fingerprint;
    }
    return {
      lease: { deliveryId: row.id, workerId, epoch: Number(row.lease_epoch) },
      delivery: row,
      ticketKey: row.ticket_key,
      pipeline: {
        id: pipeline.id,
        endpointUrl: pipeline.endpoint_url,
        secret: this.cipher.decrypt(
          pipeline.secret_ciphertext,
          pipelineSecretContext(pipeline.project_id, pipeline.id),
        ),
        allowIntegration: Boolean(pipeline.allow_integration),
        holdPolicy: pipeline.hold_policy,
        archived: Boolean(pipeline.archived),
      },
      repository: repository
        ? {
            url: repository.url,
            credential: repository.credential_ciphertext
              ? this.cipher.decrypt(
                  repository.credential_ciphertext,
                  repositoryCredentialContext(repository.project_id, repository.id),
                )
              : null,
            setupCommands: jsonValue<DevelopmentCommand[]>(repository.setup_commands, []),
            testCommands: jsonValue<DevelopmentCommand[]>(repository.test_commands, []),
          }
        : null,
      workspace: { branch: row.branch },
      locks: {
        integration: repository ? canonicalIntegrationKey(repository.url, row.target_branch) : null,
        environment: canonicalEnvironmentKey({
          targetKey: pipeline.target_key,
          endpointUrl: pipeline.endpoint_url,
          environment: row.environment,
        }),
      },
      configFingerprint,
    };
  }

  /**
   * F03: a chave anterior à normalização GitHub (caminho com maiúsculas) passa à chave atual. Só
   * altera a chave que corresponde exatamente à legada do URL atual do repositório.
   */
  private async migrateIntegrationKey(
    row: Pick<DeliveryRow, 'id' | 'integration_key' | 'target_branch'>,
    url: string,
  ) {
    const current = canonicalIntegrationKey(url, row.target_branch);
    const legacy = legacyIntegrationKey(url, row.target_branch);
    if (row.integration_key === current || row.integration_key !== legacy) return null;
    await this.db.query(
      'UPDATE delivery_runs SET integration_key=$2 WHERE id=$1 AND integration_key=$3',
      [row.id, current, legacy],
    );
    return current;
  }

  /**
   * F03: migração das chaves de integração das entregas ativas no arranque do executor. Pressupõe
   * a drenagem do deploy (nenhum executor antigo ativo); é idempotente.
   */
  async migrateIntegrationKeys() {
    const rows = await this.db.query<{
      id: string;
      integration_key: string | null;
      target_branch: string;
      url: string;
    }>(
      `SELECT d.id,d.integration_key,d.target_branch,r.url FROM delivery_runs d
         JOIN project_git_repositories r ON r.id=d.repository_id
        WHERE d.finished_at IS NULL AND d.integration_key IS NOT NULL`,
    );
    let migrated = 0;
    for (const row of rows.rows) if (await this.migrateIntegrationKey(row, row.url)) migrated += 1;
    return migrated;
  }
}
