import { createHash, randomUUID } from 'node:crypto';
import {
  agentProfileCreateSchema,
  agentProfileVersionInputSchema,
  agentProfileDefinitionSchema,
  copilotMode,
  flowAgentProfileConfig,
  type AgentProfile,
  type AgentProfileDefinition,
  type AgentProfileRunSnapshot,
  type RepositoryResourceReference,
} from '../../../../contracts/src/index.js';
import type {
  RepositoryResourceSelectionReason,
  RepositoryResourceSnapshot,
} from '../../../../contracts/src/agent-profiles.js';
import type { FlowDefinition, FlowNode, User } from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { parseInput } from '../identity/identity.validation.js';
import { requireProjectAdmin, type Queryable } from '../identity/membership.js';
import { AgentModelsService } from './agent-models.service.js';
import {
  relevantRepositoryResources,
  repositorySnapshotHash,
  RepositoryResources,
} from './repository-resources.js';

interface ProfileRow {
  id: string;
  project_id: string;
  name: string;
  current_version: number;
  archived_at: Date | null;
}

interface VersionRow {
  version: number;
  definition: unknown;
  created_at: Date;
  created_by: string | null;
  author: string | null;
}

const defaultTools = ['sql', 'db2', 'log', 'loki', 'prom'] as const;
const defaults: {
  key: string;
  definition: AgentProfileDefinition;
}[] = [
  {
    key: 'investigate-incident',
    definition: {
      name: 'Investigar incidente',
      description: 'Recolhe evidência e identifica causas sem executar alterações.',
      mission:
        'Investigar o incidente com base em evidência verificável e explicar a causa provável sem executar alterações.',
      expectedInputs: [
        'Pedido e conversa do ticket',
        'Ambiente e prioridade',
        'Ferramentas de leitura disponíveis',
      ],
      expectedOutput: 'Resumo técnico com factos, hipóteses, lacunas de evidência e próximo passo.',
      completionCriteria: [
        'Separar factos confirmados de hipóteses e indicar a respetiva fonte.',
        'Indicar explicitamente o que não foi possível confirmar.',
      ],
      modes: ['analysis', 'report'],
      allowedTools: [...defaultTools],
      model: null,
      fusionTier: null,
      reasoningEffort: null,
    },
  },
  {
    key: 'prepare-correction',
    definition: {
      name: 'Preparar correção',
      description: 'Propõe uma correção isolada para revisão, sem a publicar.',
      mission:
        'Preparar uma proposta de correção mínima baseada na análise e nas instruções técnicas aplicáveis; nunca a publicar.',
      expectedInputs: [
        'Problema reproduzido ou evidência suficiente',
        'Código do projeto em leitura',
      ],
      expectedOutput: 'Proposta de diff não aplicada e lista de testes que a equipa deve executar.',
      completionCriteria: [
        'Limitar a proposta aos ficheiros necessários e explicar cada alteração.',
        'Não executar commit, deploy nem escrita fora do workspace isolado.',
      ],
      modes: ['develop', 'report'],
      allowedTools: ['sql', 'log', 'loki', 'prom'],
      model: null,
      fusionTier: null,
      reasoningEffort: null,
    },
  },
  {
    key: 'validate-qa',
    definition: {
      name: 'Validar em QA',
      description: 'Verifica a proposta em QA e regista os resultados observados.',
      mission:
        'Validar em QA uma alteração ou hipótese aprovada pela equipa, sem modificar Produção nem publicar.',
      expectedInputs: ['Alteração ou hipótese a validar', 'Critérios de aceitação', 'Ambiente QA'],
      expectedOutput: 'Resultado por critério, evidência recolhida e riscos que permanecem.',
      completionCriteria: [
        'Distinguir passagem, falha e teste não executado.',
        'Não tratar dados de QA como evidência de Produção.',
      ],
      modes: ['analysis', 'report'],
      allowedTools: [...defaultTools],
      model: null,
      fusionTier: null,
      reasoningEffort: null,
    },
  },
  {
    key: 'produce-report',
    definition: {
      name: 'Produzir relatório',
      description: 'Consolida resultados já recolhidos num relatório claro.',
      mission:
        'Consolidar resultados verificados no contexto do ticket; não iniciar ações nem inventar evidência.',
      expectedInputs: ['Resultados das etapas anteriores', 'Critérios de conclusão'],
      expectedOutput:
        'Relatório conciso com conclusão, evidência, pontos por confirmar e próximo passo.',
      completionCriteria: [
        'Não apresentar hipóteses como factos.',
        'Omitir informação sensível e dados pessoais desnecessários.',
      ],
      modes: ['report'],
      allowedTools: [],
      model: null,
      fusionTier: null,
      reasoningEffort: null,
    },
  },
];

const stableId = (projectId: string, key: string) => {
  const hex = createHash('sha256')
    .update(`${projectId}:zeroops-agent-profile:${key}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const parseDefinition = (raw: unknown) =>
  agentProfileDefinitionSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
const date = (value: Date | null) => value?.toISOString() ?? null;

/** Catálogo ZeroOps versionado e descoberta read-only da documentação do projeto. */
export class AgentProfilesService {
  private readonly models: AgentModelsService;

  constructor(
    private readonly db: Database,
    private readonly repository: RepositoryResources = new RepositoryResources(
      process.env.ZEROOPS_AGENT_SITES_ROOT,
    ),
  ) {
    this.models = new AgentModelsService(db);
  }

  /** Lista o catálogo versionado do projeto; cria os quatro perfis iniciais na primeira consulta. */
  async list(actor: User, projectId: string): Promise<AgentProfile[]> {
    return this.db.transaction(async (client) => {
      await requireProjectAdmin(client, actor, projectId);
      await this.seed(client, projectId, actor.id);
      const profiles = await client.query<ProfileRow>(
        `SELECT id,project_id,name,current_version,archived_at FROM zeroops_agent_profiles
          WHERE project_id=$1 ORDER BY archived_at IS NOT NULL,name`,
        [projectId],
      );
      return Promise.all(profiles.rows.map((row) => this.profile(client, row)));
    });
  }

  /** Cria um perfil na versão 1 após validar permissões, nome e disponibilidade do modelo. */
  async create(actor: User, projectId: string, raw: unknown) {
    const definition = parseInput(agentProfileCreateSchema, raw);
    return this.db.transaction(async (client) => {
      const admin = await requireProjectAdmin(client, actor, projectId, false, true);
      await this.assertNameAvailable(client, projectId, definition.name);
      await this.validateModel(client, projectId, definition);
      const id = randomUUID();
      await client.query(
        'INSERT INTO zeroops_agent_profiles(id,project_id,name,current_version,created_by) VALUES($1,$2,$3,1,$4)',
        [id, projectId, definition.name, admin.id],
      );
      await client.query(
        'INSERT INTO zeroops_agent_profile_versions(id,profile_id,project_id,version,definition,created_by) VALUES($1,$2,$3,1,$4,$5)',
        [randomUUID(), id, projectId, definition, admin.id],
      );
      await this.audit(client, admin.id, projectId, 'agent.profile.created', { profileId: id });
      return this.getProfile(client, projectId, id);
    });
  }

  /** Publica uma versão imutável nova com controlo otimista da versão editada. */
  async addVersion(actor: User, projectId: string, profileId: string, raw: unknown) {
    const input = parseInput(agentProfileVersionInputSchema, raw);
    return this.db.transaction(async (client) => {
      const admin = await requireProjectAdmin(client, actor, projectId, false, true);
      const profile = (
        await client.query<ProfileRow>(
          'SELECT id,project_id,name,current_version,archived_at FROM zeroops_agent_profiles WHERE id=$1 AND project_id=$2 FOR UPDATE',
          [profileId, projectId],
        )
      ).rows[0];
      if (!profile) throw new DomainError('AGENT_PROFILE_NOT_FOUND', 'Perfil não encontrado.', 404);
      if (profile.archived_at)
        throw new DomainError('AGENT_PROFILE_ARCHIVED', 'O perfil está arquivado.', 409);
      if (Number(profile.current_version) !== input.expectedVersion)
        throw new DomainError('CONFLICT', 'O perfil mudou. Recarregue antes de editar.', 409);
      await this.assertNameAvailable(client, projectId, input.definition.name, profileId);
      await this.validateModel(client, projectId, input.definition);
      const version = Number(profile.current_version) + 1;
      await client.query(
        'INSERT INTO zeroops_agent_profile_versions(id,profile_id,project_id,version,definition,created_by) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), profileId, projectId, version, input.definition, admin.id],
      );
      await client.query(
        'UPDATE zeroops_agent_profiles SET name=$2,current_version=$3,updated_at=NOW(3) WHERE id=$1',
        [profileId, input.definition.name, version],
      );
      await this.audit(client, admin.id, projectId, 'agent.profile.version_created', {
        profileId,
        version,
      });
      return this.getProfile(client, projectId, profileId);
    });
  }

  /** Arquiva o perfil para novas publicações sem alterar versões já fixadas em flows. */
  async archive(actor: User, projectId: string, profileId: string) {
    return this.db.transaction(async (client) => {
      const admin = await requireProjectAdmin(client, actor, projectId, false, true);
      const result = await client.query(
        'UPDATE zeroops_agent_profiles SET archived_at=COALESCE(archived_at,NOW(3)),updated_at=NOW(3) WHERE id=$1 AND project_id=$2',
        [profileId, projectId],
      );
      if (!result.rowCount)
        throw new DomainError('AGENT_PROFILE_NOT_FOUND', 'Perfil não encontrado.', 404);
      await this.audit(client, admin.id, projectId, 'agent.profile.archived', { profileId });
      return this.getProfile(client, projectId, profileId);
    });
  }

  /** Lista metadados allowlisted do repositório; conteúdos são carregados apenas no snapshot do run. */
  async repositoryResources(actor: User, projectId: string) {
    await requireProjectAdmin(this.db, actor, projectId);
    const site =
      (
        await this.db.query<{ site_key: string | null }>(
          'SELECT site_key FROM projects WHERE id=$1',
          [projectId],
        )
      ).rows[0]?.site_key ?? null;
    return this.repository.discover(site);
  }

  /** Validates profile and repository references while the published version is being created. */
  async validateFlowDefinition(client: Queryable, projectId: string, definition: FlowDefinition) {
    const hasReferences = this.hasRepositoryReferences(definition);
    const hasProfiles = definition.nodes.some(
      (node) => flowAgentProfileConfig(node).agentProfileId !== undefined,
    );
    const hasCopilot = definition.nodes.some((node) => node.op === 'copilot_task');
    const siteKey =
      hasReferences || hasProfiles || hasCopilot
        ? ((
            await client.query<{ site_key: string | null }>(
              'SELECT site_key FROM projects WHERE id=$1',
              [projectId],
            )
          ).rows[0]?.site_key ?? null)
        : null;
    const catalog =
      hasReferences || hasProfiles || hasCopilot ? await this.repository.discover(siteKey) : null;
    const availableResources = new Set(catalog?.resources.map((item) => item.path) ?? []);
    if ((hasProfiles || hasReferences) && !catalog?.available)
      throw new DomainError(
        'REPOSITORY_UNAVAILABLE',
        'Não foi possível ler o repositório técnico configurado para este projeto.',
        422,
      );
    if (hasProfiles && catalog?.unavailableGlobalInstructions?.length)
      throw new DomainError(
        'GLOBAL_INSTRUCTIONS_UNAVAILABLE',
        `Não foi possível ler as instruções globais: ${catalog.unavailableGlobalInstructions.join(', ')}.`,
        422,
      );
    for (const node of definition.nodes) {
      const profile = await this.profileForNode(client, projectId, node, true);
      if (profile) {
        if (node.op !== 'copilot_task')
          throw new DomainError(
            'AGENT_PROFILE_STEP_INVALID',
            'Os perfis ZeroOps só podem ser associados a etapas Copilot.',
            422,
          );
        const mode = copilotMode(node);
        if (!profile.definition.modes.includes(mode))
          throw new DomainError(
            'AGENT_PROFILE_MODE_UNSUPPORTED',
            `O perfil «${profile.definition.name}» não suporta o modo ${mode} na etapa «${node.label}».`,
            422,
          );
        await this.validateModel(client, projectId, profile.definition);
      }
      const refs = this.nodeResources(node);
      if (refs.length && node.op !== 'copilot_task')
        throw new DomainError(
          'REPOSITORY_RESOURCE_STEP_INVALID',
          'Os recursos técnicos só podem ser associados a etapas Copilot.',
          422,
        );
      for (const ref of refs) {
        if (!availableResources.has(ref.path))
          throw new DomainError(
            'REPOSITORY_RESOURCE_NOT_FOUND',
            `O recurso técnico «${ref.path}» não existe ou não está autorizado neste projeto.`,
            422,
          );
      }
    }
  }

  /** Resolve regras globais e recursos relevantes uma vez; os snapshots ficam fixos no ticket. */
  async snapshotForExecution(
    client: Queryable,
    projectId: string,
    definition: FlowDefinition,
    ticketId?: string,
  ) {
    const siteKey =
      (
        await client.query<{ site_key: string | null }>(
          'SELECT site_key FROM projects WHERE id=$1',
          [projectId],
        )
      ).rows[0]?.site_key ?? null;
    const profiles: Record<string, AgentProfileRunSnapshot> = {};
    const references = new Map<
      string,
      RepositoryResourceReference & { selectionReason: RepositoryResourceSelectionReason }
    >();
    const pathsByNode = new Map<string, Set<string>>();
    for (const node of definition.nodes) {
      const profile = await this.profileForNode(client, projectId, node, false);
      if (profile) profiles[node.id] = profile;
    }
    const copilotNodes = definition.nodes.filter((node) => node.op === 'copilot_task');
    const hasProfiles = Object.keys(profiles).length > 0;
    const catalog = copilotNodes.length > 0 ? await this.repository.discover(siteKey) : null;
    if (hasProfiles && (!catalog?.available || catalog.unavailableGlobalInstructions?.length))
      return {
        agentProfiles: profiles,
        repositorySnapshotHash: null,
        repositoryResources: [],
        repositoryResourcePathsByNode: {},
        repositorySnapshotHashesByNode: {},
        error: {
          code: catalog?.unavailableGlobalInstructions?.length
            ? 'global_instructions_unavailable'
            : 'repository_unavailable',
          message: catalog?.unavailableGlobalInstructions?.length
            ? `Não foi possível ler as instruções globais: ${catalog.unavailableGlobalInstructions.join(', ')}.`
            : 'O repositório técnico deste projeto não está disponível; o perfil não pode executar sem as instruções globais.',
        },
      };
    const ticket = ticketId
      ? (
          await client.query<{
            title: string;
            description: string;
            category: string;
            environment: string;
            priority: string;
          }>(
            'SELECT title,description,category,environment,priority FROM tickets WHERE id=$1 AND project_id=$2',
            [ticketId, projectId],
          )
        ).rows[0]
      : undefined;
    const addReference = (
      nodeId: string,
      reference: RepositoryResourceReference,
      selectionReason: RepositoryResourceSelectionReason,
    ) => {
      const byNode = pathsByNode.get(nodeId) ?? new Set<string>();
      byNode.add(reference.path);
      pathsByNode.set(nodeId, byNode);
      const previous = references.get(reference.path);
      const priority: Record<RepositoryResourceSelectionReason, number> = {
        relevance: 1,
        flow_selected: 2,
        global_instruction: 3,
      };
      references.set(reference.path, {
        path: reference.path,
        required: Boolean(previous?.required || reference.required),
        selectionReason:
          previous && priority[previous.selectionReason] > priority[selectionReason]
            ? previous.selectionReason
            : selectionReason,
      });
    };
    for (const node of copilotNodes) {
      for (const resource of catalog?.resources.filter((item) => item.globalInstruction) ?? [])
        addReference(node.id, { path: resource.path, required: hasProfiles }, 'global_instruction');
      for (const reference of this.nodeResources(node))
        addReference(node.id, reference, 'flow_selected');
      const profile = profiles[node.id];
      if (catalog?.available) {
        const definitionText = profile
          ? [
              profile.definition.name,
              profile.definition.description,
              profile.definition.mission,
              ...profile.definition.expectedInputs,
              profile.definition.expectedOutput,
              ...profile.definition.completionCriteria,
            ].join(' ')
          : '';
        const query = [
          ticket?.title,
          ticket?.description,
          ticket?.category,
          ticket?.environment,
          ticket?.priority,
          node.label,
          node.instructions,
          definitionText,
        ]
          .filter(Boolean)
          .join('\n');
        for (const resource of relevantRepositoryResources(catalog.resources, query))
          addReference(node.id, { path: resource.path, required: false }, 'relevance');
      }
    }
    if (!references.size)
      return {
        agentProfiles: profiles,
        repositorySnapshotHash: null,
        repositoryResources: [],
        repositoryResourcePathsByNode: {},
        repositorySnapshotHashesByNode: {},
        error: null,
      };
    const snapshot = await this.repository.snapshot(siteKey, [...references.values()]);
    const missing = snapshot.resources.find((item) => item.required && item.status !== 'loaded');
    const resourcesByNode = Object.fromEntries(
      [...pathsByNode.entries()].map(([nodeId, paths]) => [
        nodeId,
        snapshot.resources.filter(
          (resource) =>
            paths.has(resource.path) ||
            (resource.reason?.startsWith('skill_resource:') &&
              paths.has(resource.reason.slice('skill_resource:'.length).split('|', 1)[0] ?? '')),
        ),
      ]),
    ) as Record<string, RepositoryResourceSnapshot[]>;
    const pathsByNodeRecord = Object.fromEntries(
      [...pathsByNode.entries()].map(([nodeId, paths]) => [nodeId, [...paths]]),
    );
    const snapshotHashesByNode = Object.fromEntries(
      copilotNodes.map((node) => [node.id, repositorySnapshotHash(resourcesByNode[node.id] ?? [])]),
    );
    return {
      agentProfiles: profiles,
      repositorySnapshotHash: snapshot.snapshotHash,
      repositoryResources: snapshot.resources,
      repositoryResourcePathsByNode: pathsByNodeRecord,
      repositorySnapshotHashesByNode: snapshotHashesByNode,
      error: missing
        ? {
            code: 'repository_resource_unavailable',
            message: `O recurso técnico obrigatório «${missing.path}» não pôde ser carregado (${missing.reason ?? missing.status}).`,
          }
        : null,
    };
  }

  /** Retorna perfil imutável do projeto; `requireActive` serve a novas publicações. */
  async profileForNode(
    client: Queryable,
    projectId: string,
    node: FlowNode,
    requireActive: boolean,
  ): Promise<AgentProfileRunSnapshot | null> {
    const config = flowAgentProfileConfig(node);
    const { agentProfileId: id, agentProfileVersion: version } = config;
    if (id === undefined) return null;
    const row = (
      await client.query<{
        definition: unknown;
        name: string;
        current_version: number;
        archived_at: Date | null;
      }>(
        `SELECT v.definition,p.name,p.current_version,p.archived_at
           FROM zeroops_agent_profile_versions v
           JOIN zeroops_agent_profiles p ON p.id=v.profile_id AND p.project_id=v.project_id
          WHERE v.profile_id=$1 AND v.project_id=$2 AND v.version=$3`,
        [id, projectId, version],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        'AGENT_PROFILE_REFERENCE_INVALID',
        'O perfil ou a versão selecionada não existe neste projeto.',
        422,
      );
    if (requireActive && row.archived_at)
      throw new DomainError('AGENT_PROFILE_ARCHIVED', 'O perfil selecionado está arquivado.', 422);
    return { id, version: Number(version), definition: parseDefinition(row.definition) };
  }

  /** Devolve referências únicas e validadas da configuração de uma etapa do flow. */
  nodeResources(node: FlowNode): RepositoryResourceReference[] {
    const refs = flowAgentProfileConfig(node).repositoryResources ?? [];
    if (new Set(refs.map((ref) => ref.path)).size !== refs.length)
      throw new DomainError('REPOSITORY_RESOURCE_REFERENCE_INVALID', 'Referência duplicada.', 422);
    return refs;
  }

  private hasRepositoryReferences(definition: FlowDefinition) {
    return definition.nodes.some((node) => this.nodeResources(node).length > 0);
  }

  /** Recusa modelos, tiers e esforço que não estejam disponíveis para o projeto. */
  async validateModel(client: Queryable, projectId: string, definition: AgentProfileDefinition) {
    try {
      await this.models.validate(
        client,
        projectId,
        definition.model,
        definition.reasoningEffort,
        'copilot',
        definition.fusionTier,
      );
    } catch (error) {
      if (error instanceof DomainError)
        throw new DomainError(
          'AGENT_PROFILE_MODEL_UNAVAILABLE',
          `Modelo do perfil «${definition.name}» indisponível: ${error.message}`,
          422,
        );
      throw error;
    }
  }

  private async seed(client: Queryable, projectId: string, actorId: string) {
    for (const item of defaults) {
      const id = stableId(projectId, item.key);
      const existing = await client.query('SELECT id FROM zeroops_agent_profiles WHERE id=$1', [
        id,
      ]);
      if (existing.rowCount) continue;
      const name = (
        await client.query<{ id: string }>(
          'SELECT id FROM zeroops_agent_profiles WHERE project_id=$1 AND name=$2',
          [projectId, item.definition.name],
        )
      ).rows[0]
        ? `${item.definition.name} (ZeroOps)`
        : item.definition.name;
      const definition = { ...item.definition, name };
      await client.query(
        'INSERT IGNORE INTO zeroops_agent_profiles(id,project_id,name,current_version,created_by) VALUES($1,$2,$3,1,$4)',
        [id, projectId, name, actorId],
      );
      if (!(await client.query('SELECT id FROM zeroops_agent_profiles WHERE id=$1', [id])).rowCount)
        continue;
      await client.query(
        'INSERT IGNORE INTO zeroops_agent_profile_versions(id,profile_id,project_id,version,definition,created_by) VALUES($1,$2,$3,1,$4,$5)',
        [randomUUID(), id, projectId, definition, actorId],
      );
    }
  }

  private async profile(client: Queryable, row: ProfileRow): Promise<AgentProfile> {
    const versions = await client.query<VersionRow>(
      `SELECT v.version,v.definition,v.created_at,v.created_by,u.display_name AS author
         FROM zeroops_agent_profile_versions v LEFT JOIN users u ON u.id=v.created_by
        WHERE v.profile_id=$1 ORDER BY v.version DESC LIMIT 20`,
      [row.id],
    );
    return {
      id: row.id,
      projectId: row.project_id,
      currentVersion: Number(row.current_version),
      archivedAt: date(row.archived_at),
      versions: versions.rows
        .map((version) => ({
          version: Number(version.version),
          definition: parseDefinition(version.definition),
          createdAt: version.created_at.toISOString(),
          createdBy: version.author ?? version.created_by,
        }))
        .sort((a, b) => a.version - b.version),
    };
  }

  private async getProfile(client: Queryable, projectId: string, profileId: string) {
    const row = (
      await client.query<ProfileRow>(
        'SELECT id,project_id,name,current_version,archived_at FROM zeroops_agent_profiles WHERE id=$1 AND project_id=$2',
        [profileId, projectId],
      )
    ).rows[0];
    if (!row) throw new DomainError('AGENT_PROFILE_NOT_FOUND', 'Perfil não encontrado.', 404);
    return this.profile(client, row);
  }

  private async assertNameAvailable(
    client: Queryable,
    projectId: string,
    name: string,
    exceptId?: string,
  ) {
    const found = await client.query(
      'SELECT id FROM zeroops_agent_profiles WHERE project_id=$1 AND name=$2 AND id<>$3',
      [projectId, name, exceptId ?? ''],
    );
    if (found.rowCount)
      throw new DomainError('AGENT_PROFILE_NAME_EXISTS', 'Já existe um perfil com este nome.', 409);
  }

  private async audit(
    client: Queryable,
    actorId: string,
    projectId: string,
    action: string,
    details: object,
  ) {
    await client.query(
      'INSERT INTO audit_events(id,actor_id,ticket_id,action,details) VALUES($1,$2,NULL,$3,$4)',
      [randomUUID(), actorId, action, { projectId, ...details }],
    );
  }
}
