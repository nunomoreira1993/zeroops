import { createHash } from 'node:crypto';
import {
  alertRuleById,
  flowDefinitionSchema,
  flowLogic,
  flowMatchSchema,
  flowRuntimeSupported,
  healthAlertKey,
  parseRoutingPolicy,
  planFlowSelection,
  selectFlow,
  toBinaryFlow,
  type FlowDefinition,
  type FlowMatch,
  type FlowMatchTicket,
  type FlowRoutingPolicy,
  type FlowSelectionPlan,
} from '../../../../contracts/src/index.js';
import type { Queryable } from '../identity/membership.js';
import { defaultFlowTemplates } from './flow-templates.js';

export interface FlowRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  template: string | null;
  priority: number;
  is_default: boolean;
  flow_match: unknown;
  flow_definition: unknown;
  draft_version: number;
  published_version_id: string | null;
  active_priority: number | null;
  active_is_default: boolean;
  active_flow_match: unknown;
  pending_alert_keys: unknown;
  /** Política semântica do rascunho (P05). */
  routing_policy?: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface PublishedFlow {
  id: string;
  name: string;
  priority: number;
  isDefault: boolean;
  match: FlowMatch;
  versionId: string;
  versionNumber: number;
  definition: FlowDefinition;
  /** Política semântica da versão ativa (null sem política). */
  policy: FlowRoutingPolicy | null;
  manifestHash: string | null;
}

/** Hash da parte executável (sem disposição), guardado em cada versão publicada. */
export function logicHash(definition: FlowDefinition) {
  return createHash('sha256').update(flowLogic(definition)).digest('hex');
}

/** UUID determinístico por projeto/modelo: criações concorrentes convergem na mesma linha. */
export function templateUuid(projectId: string, template: string, kind: 'flow' | 'version') {
  const hex = createHash('sha256').update(`${projectId}:${template}:${kind}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Regra guardada (critérios em falta = qualquer valor). */
export function parseMatch(value: unknown): FlowMatch {
  const parsed = flowMatchSchema.safeParse(value ?? {});
  return parsed.success
    ? parsed.data
    : { origins: [], categories: [], environments: [], priorities: [] };
}

/** Definição guardada; as versões publicadas foram validadas antes de gravar. */
export function parseDefinition(value: unknown): FlowDefinition {
  return flowDefinitionSchema.parse(value);
}

/** Lista de chaves de alerta guardada em JSON (valores inválidos são ignorados). */
export function parseAlertKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))].sort()
    : [];
}

/**
 * Cria os modelos por omissão num projeto sem fluxos, todos em RASCUNHO (P02): nada entra em
 * serviço sem «Ativar esta versão». Idempotente e seguro em concorrência (ids determinísticos e
 * `INSERT IGNORE`). Sem fluxo ativo, os tickets novos ficam sem execução até haver uma ativação.
 */
export async function ensureDefaultFlows(client: Queryable, projectId: string) {
  const existing = await client.query('SELECT id FROM flows WHERE project_id=$1 LIMIT 1', [
    projectId,
  ]);
  if (existing.rowCount) return false;
  for (const template of defaultFlowTemplates()) {
    const flowId = templateUuid(projectId, template.template, 'flow');
    await client.query(
      `INSERT IGNORE INTO flows(id,project_id,name,description,template,priority,is_default,flow_match,flow_definition)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        flowId,
        projectId,
        template.name,
        template.description,
        template.template,
        template.priority,
        template.isDefault,
        template.match,
        template.definition,
      ],
    );
  }
  return true;
}

/**
 * Hashes lógicos de versões anteriores dos modelos. Um fluxo cujo rascunho e versão publicada
 * ainda são exatamente um destes modelos (não personalizado) é atualizado para o modelo atual.
 */
const LEGACY_TEMPLATE_LOGIC: Readonly<Record<string, readonly string[]>> = {
  // Geral v1: várias saídas por etapa (aguarda cliente, cancelar).
  general: ['d91397edfa81162956dcfb2c9a76926d76009078330d0c77431581d9170fb031'],
  // Saúde v1: a correção era só uma ação externa, sem tentativa do Copilot numa cópia temporária.
  // Saúde v2: correção por código numa cópia temporária; substituída pelo «Incidente (Health)».
  // Incidente (Health) v1: várias saídas por etapa (forbidden, retry, unknown…).
  health: [
    '787fa13553e84733e9c52d22168737c8045a504b4b21c238dc262dd5fbec8b21',
    'f668cccc88ba841b2d4fafb9a928267c178c5cd8fc5f7b560dbc83b1738b70ce',
    '4e919668f2ab15ab37341c982551798cbd28e978aef441eaf9b32486305a5d93',
  ],
  // Manutenção v1: várias saídas por etapa (recusar, aguarda cliente).
  maintenance: ['c374139737899270d09862788df05a296bea37ce3e8267ce428d9781b0f210a1'],
};

/** Nome antigo dos modelos: só é substituído se o projeto não lhe mudou o nome. */
const LEGACY_TEMPLATE_NAME: Readonly<Record<string, string>> = { health: 'Saúde' };

/**
 * Ids dos fluxos de modelo cujo RASCUNHO ainda é um modelo antigo não personalizado. A versão
 * ativa não é considerada: a atualização é só uma proposta no rascunho (P02).
 */
export async function legacyTemplateFlows(client: Queryable) {
  const templates = Object.keys(LEGACY_TEMPLATE_LOGIC);
  if (!templates.length) return [];
  const rows = await client.query<{ id: string; template: string; flow_definition: unknown }>(
    `SELECT id,template,flow_definition FROM flows
      WHERE template IN (${templates.map((_, index) => `$${index + 1}`).join(',')})`,
    templates,
  );
  return rows.rows
    .filter((row) => {
      const parsed = flowDefinitionSchema.safeParse(row.flow_definition);
      return (
        parsed.success && LEGACY_TEMPLATE_LOGIC[row.template]?.includes(logicHash(parsed.data))
      );
    })
    .map((row) => row.id);
}

/**
 * Propõe o modelo atual no rascunho de um fluxo de modelo não personalizado, sem criar versão nem
 * mudar o que está ativo: a equipa revê e usa «Ativar esta versão». Devolve false se o rascunho
 * foi entretanto personalizado.
 */
export async function upgradeTemplateFlow(client: Queryable, flowId: string) {
  const flow = (
    await client.query<{ id: string; template: string; flow_definition: unknown }>(
      'SELECT id,template,flow_definition FROM flows WHERE id=$1 FOR UPDATE',
      [flowId],
    )
  ).rows[0];
  const legacy = flow ? LEGACY_TEMPLATE_LOGIC[flow.template] : undefined;
  if (!flow || !legacy) return false;
  const draft = flowDefinitionSchema.safeParse(flow.flow_definition);
  if (!draft.success || !legacy.includes(logicHash(draft.data))) return false;
  const template = defaultFlowTemplates().find((item) => item.template === flow.template);
  if (!template) return false;
  await client.query(
    `UPDATE flows SET flow_definition=$2,description=$3,draft_version=draft_version+1,
            name=IF(name=$4,$5,name),updated_at=NOW(3) WHERE id=$1`,
    [
      flow.id,
      template.definition,
      template.description,
      LEGACY_TEMPLATE_NAME[flow.template] ?? template.name,
      template.name,
    ],
  );
  return true;
}

/** Definição convertida para sucesso/erro: modelo atual se for um modelo antigo intacto. */
function binaryDefinition(template: string | null, definition: FlowDefinition) {
  const current = template
    ? defaultFlowTemplates().find((item) => item.template === template)
    : undefined;
  if (current && LEGACY_TEMPLATE_LOGIC[current.template]?.includes(logicHash(definition)))
    return { definition: current.definition, changed: true };
  return toBinaryFlow(definition);
}

/** Ids dos fluxos cujo rascunho ainda tem saídas antigas (a versão ativa não é alterada). */
export async function binaryMigrationFlows(client: Queryable) {
  const rows = await client.query<{ id: string; flow_definition: unknown }>(
    'SELECT id,flow_definition FROM flows',
  );
  return rows.rows
    .filter((row) => {
      const parsed = flowDefinitionSchema.safeParse(row.flow_definition);
      return parsed.success && toBinaryFlow(parsed.data).changed;
    })
    .map((row) => row.id);
}

/**
 * Converte o RASCUNHO para duas saídas por etapa. A versão ativa mantém-se (o motor aceita as
 * saídas antigas) até alguém ativar o rascunho convertido.
 */
export async function migrateFlowToBinary(client: Queryable, flowId: string) {
  const flow = (
    await client.query<{ id: string; template: string | null; flow_definition: unknown }>(
      'SELECT id,template,flow_definition FROM flows WHERE id=$1 FOR UPDATE',
      [flowId],
    )
  ).rows[0];
  if (!flow) return false;
  const draft = flowDefinitionSchema.safeParse(flow.flow_definition);
  const next = draft.success ? binaryDefinition(flow.template, draft.data) : null;
  if (!next?.changed) return false;
  await client.query(
    `UPDATE flows SET flow_definition=$2,draft_version=draft_version+1,updated_at=NOW(3)
      WHERE id=$1`,
    [flow.id, next.definition],
  );
  return true;
}

/** Fluxo do check associado; depois o flow exato do alerta ou os fluxos elegíveis pelas regras. */
async function eligibleFlows(
  client: Queryable,
  ticket: FlowMatchTicket & { project_id: string; alert_key?: string | null },
) {
  const flows = await publishedFlows(client, ticket.project_id);
  const links = (
    await client.query<{ alert_key: string; flow_id: string }>(
      'SELECT alert_key,flow_id FROM health_alert_flows WHERE project_id=$1',
      [ticket.project_id],
    )
  ).rows;
  const ruleId = ticket.alert_key?.startsWith('prometheus:')
    ? ticket.alert_key.slice('prometheus:'.length)
    : null;
  const checkId = ruleId ? alertRuleById.get(ruleId)?.checkId : undefined;
  const checkKey = checkId ? healthAlertKey('check', checkId) : null;
  const checkFlowId = checkKey
    ? links.find((link) => link.alert_key === checkKey)?.flow_id
    : undefined;
  const alertFlowId = ticket.alert_key
    ? links.find((link) => link.alert_key === ticket.alert_key)?.flow_id
    : undefined;
  const linked =
    (checkFlowId && flows.find((flow) => flow.id === checkFlowId)) ||
    (alertFlowId && flows.find((flow) => flow.id === alertFlowId));
  if (linked) return { kind: 'linked' as const, flow: linked };
  // Fluxos próprios de alertas só tratam esses alertas, salvo se forem o fluxo por omissão.
  const reserved = new Set(links.map((link) => link.flow_id));
  const eligible = flows.filter((flow) => flow.isDefault || !reserved.has(flow.id));
  return { kind: 'rules' as const, eligible };
}

/**
 * Seleção determinística (sem classificação semântica): associação da Saúde e depois a regra
 * de menor prioridade. Usada no backfill e quando o Copilot não é necessário.
 */
export async function flowForTicket(
  client: Queryable,
  ticket: FlowMatchTicket & { project_id: string; alert_key?: string | null },
) {
  const resolved = await eligibleFlows(client, ticket);
  return resolved.kind === 'linked' ? resolved.flow : selectFlow(resolved.eligible, ticket);
}

/**
 * Plano de encaminhamento (P05): associações explícitas da Saúde são diretas; depois as regras
 * estruturadas e, quando há políticas semânticas coincidentes, os candidatos a classificar.
 */
export async function flowSelectionPlan(
  client: Queryable,
  ticket: FlowMatchTicket & { project_id: string; alert_key?: string | null },
): Promise<FlowSelectionPlan<PublishedFlow>> {
  const resolved = await eligibleFlows(client, ticket);
  if (resolved.kind === 'linked') return { kind: 'direct', flow: resolved.flow };
  return planFlowSelection(resolved.eligible, ticket);
}

/** Fluxos ATIVOS do projeto com a definição da versão em vigor (candidatos à seleção). */
export async function publishedFlows(
  client: Queryable,
  projectId: string,
): Promise<PublishedFlow[]> {
  const rows = await client.query<{
    id: string;
    name: string;
    active_priority: number;
    active_is_default: boolean;
    active_flow_match: unknown;
    version_id: string;
    number: number;
    flow_definition: unknown;
    runtime_contract_version: number;
    routing: unknown;
    manifest_hash: string | null;
  }>(
    `SELECT f.id,f.name,f.active_priority,f.active_is_default,f.active_flow_match,v.id AS version_id,
            v.number,v.flow_definition,v.runtime_contract_version,v.routing,v.manifest_hash
       FROM flows f JOIN flow_versions v ON v.id=f.published_version_id
      WHERE f.project_id=$1 AND f.active_priority IS NOT NULL
      ORDER BY f.active_priority,f.name,f.id`,
    [projectId],
  );
  // Versões que este runtime não sabe executar nunca recebem tickets novos.
  return rows.rows
    .filter((row) => flowRuntimeSupported(Number(row.runtime_contract_version ?? 1)))
    .map((row) => ({
      id: row.id,
      name: row.name,
      priority: Number(row.active_priority),
      isDefault: Boolean(row.active_is_default),
      match: parseMatch(row.active_flow_match),
      versionId: row.version_id,
      versionNumber: Number(row.number),
      definition: parseDefinition(row.flow_definition),
      policy: activePolicy(row.routing),
      manifestHash: row.manifest_hash ?? null,
    }));
}

/** Política da versão ativa (gravada em `flow_versions.routing.policy` na ativação). */
export function activePolicy(routing: unknown): FlowRoutingPolicy | null {
  let raw = routing;
  if (typeof raw === 'string')
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  const policy = raw && typeof raw === 'object' ? (raw as { policy?: unknown }).policy : undefined;
  return policy === undefined || policy === null ? null : parseRoutingPolicy(policy);
}

/**
 * Versão fixada (por id) de um fluxo do projeto, mesmo que já não seja a ativa: o encaminhamento
 * de um ticket usa sempre os candidatos fixados na criação. Null se não existir ou se este runtime
 * não a souber executar.
 */
export async function pinnedFlow(
  client: Queryable,
  projectId: string,
  flowId: string,
  versionId: string,
): Promise<Pick<
  PublishedFlow,
  'id' | 'name' | 'versionId' | 'versionNumber' | 'definition'
> | null> {
  const row = (
    await client.query<{
      id: string;
      name: string;
      version_id: string;
      number: number;
      flow_definition: unknown;
      runtime_contract_version: number | null;
    }>(
      `SELECT f.id,f.name,v.id AS version_id,v.number,v.flow_definition,v.runtime_contract_version
         FROM flow_versions v JOIN flows f ON f.id=v.flow_id
        WHERE v.id=$1 AND f.id=$2 AND f.project_id=$3`,
      [versionId, flowId, projectId],
    )
  ).rows[0];
  if (!row || !flowRuntimeSupported(Number(row.runtime_contract_version ?? 1))) return null;
  return {
    id: row.id,
    name: row.name,
    versionId: row.version_id,
    versionNumber: Number(row.number),
    definition: parseDefinition(row.flow_definition),
  };
}
