import { createHash, randomUUID } from 'node:crypto';
import {
  alertRuleById,
  flowDefinitionSchema,
  flowLogic,
  flowMatchSchema,
  healthAlertKey,
  selectFlow,
  toBinaryFlow,
  type FlowDefinition,
  type FlowMatch,
  type FlowMatchTicket,
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

/**
 * Cria os modelos por omissão num projeto sem fluxos: Geral (por omissão) e Saúde publicados, que
 * reproduzem o percurso anterior; Manutenção em rascunho. Idempotente e seguro em concorrência
 * (ids determinísticos e `INSERT IGNORE`), para poder correr dentro da criação de um ticket.
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
    if (!template.publish) continue;
    const versionId = templateUuid(projectId, template.template, 'version');
    await client.query(
      `INSERT IGNORE INTO flow_versions(id,flow_id,project_id,number,flow_definition,logic_hash)
       VALUES($1,$2,$3,1,$4,$5)`,
      [versionId, flowId, projectId, template.definition, logicHash(template.definition)],
    );
    await client.query(
      'UPDATE flows SET published_version_id=$2 WHERE id=$1 AND published_version_id IS NULL',
      [flowId, versionId],
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

/** Ids dos fluxos de modelo que ainda estão numa versão antiga não personalizada. */
export async function legacyTemplateFlows(client: Queryable) {
  const templates = Object.keys(LEGACY_TEMPLATE_LOGIC);
  if (!templates.length) return [];
  const rows = await client.query<{ id: string; template: string; logic_hash: string }>(
    `SELECT f.id,f.template,v.logic_hash FROM flows f JOIN flow_versions v ON v.id=f.published_version_id
      WHERE f.template IN (${templates.map((_, index) => `$${index + 1}`).join(',')})`,
    templates,
  );
  return rows.rows
    .filter((row) => LEGACY_TEMPLATE_LOGIC[row.template]?.includes(row.logic_hash))
    .map((row) => row.id);
}

/**
 * Publica o modelo atual como nova versão de um fluxo de modelo não personalizado. Os tickets em
 * curso mantêm a versão com que entraram. Devolve false se o fluxo foi entretanto personalizado.
 */
export async function upgradeTemplateFlow(client: Queryable, flowId: string) {
  const flow = (
    await client.query<{
      id: string;
      project_id: string;
      template: string;
      flow_definition: unknown;
      logic_hash: string;
    }>(
      `SELECT f.id,f.project_id,f.template,f.flow_definition,v.logic_hash
         FROM flows f JOIN flow_versions v ON v.id=f.published_version_id
        WHERE f.id=$1 FOR UPDATE`,
      [flowId],
    )
  ).rows[0];
  const legacy = flow ? LEGACY_TEMPLATE_LOGIC[flow.template] : undefined;
  if (!flow || !legacy?.includes(flow.logic_hash)) return false;
  if (!legacy.includes(logicHash(parseDefinition(flow.flow_definition)))) return false;
  const template = defaultFlowTemplates().find((item) => item.template === flow.template);
  if (!template) return false;
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
    `INSERT INTO flow_versions(id,flow_id,project_id,number,flow_definition,logic_hash)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [
      versionId,
      flow.id,
      flow.project_id,
      number,
      template.definition,
      logicHash(template.definition),
    ],
  );
  await client.query(
    `UPDATE flows SET flow_definition=$2,description=$3,draft_version=draft_version+1,
            published_version_id=$4,name=IF(name=$5,$6,name),updated_at=NOW(3) WHERE id=$1`,
    [
      flow.id,
      template.definition,
      template.description,
      versionId,
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

/** Ids dos fluxos cujo rascunho ou versão publicada ainda têm saídas antigas. */
export async function binaryMigrationFlows(client: Queryable) {
  const rows = await client.query<{
    id: string;
    template: string | null;
    flow_definition: unknown;
    published: unknown;
  }>(
    `SELECT f.id,f.template,f.flow_definition,v.flow_definition AS published
       FROM flows f LEFT JOIN flow_versions v ON v.id=f.published_version_id`,
  );
  return rows.rows
    .filter((row) =>
      [row.flow_definition, row.published].some((value) => {
        if (!value) return false;
        const parsed = flowDefinitionSchema.safeParse(value);
        return parsed.success && toBinaryFlow(parsed.data).changed;
      }),
    )
    .map((row) => row.id);
}

/**
 * Converte um fluxo para duas saídas por etapa: rascunho e (se existir) nova versão publicada.
 * Os tickets em curso mantêm a versão com que entraram (o motor aceita as saídas antigas).
 */
export async function migrateFlowToBinary(client: Queryable, flowId: string) {
  const flow = (
    await client.query<{
      id: string;
      project_id: string;
      template: string | null;
      flow_definition: unknown;
      published: unknown;
    }>(
      `SELECT f.id,f.project_id,f.template,f.flow_definition,v.flow_definition AS published
         FROM flows f LEFT JOIN flow_versions v ON v.id=f.published_version_id
        WHERE f.id=$1 FOR UPDATE`,
      [flowId],
    )
  ).rows[0];
  if (!flow) return false;
  const draft = flowDefinitionSchema.safeParse(flow.flow_definition);
  const published = flow.published ? flowDefinitionSchema.safeParse(flow.published) : null;
  const nextDraft = draft.success ? binaryDefinition(flow.template, draft.data) : null;
  const nextPublished = published?.success ? binaryDefinition(flow.template, published.data) : null;
  if (!nextDraft?.changed && !nextPublished?.changed) return false;
  if (nextPublished?.changed) {
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
      `INSERT INTO flow_versions(id,flow_id,project_id,number,flow_definition,logic_hash)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        versionId,
        flow.id,
        flow.project_id,
        number,
        nextPublished.definition,
        logicHash(nextPublished.definition),
      ],
    );
    await client.query('UPDATE flows SET published_version_id=$2 WHERE id=$1', [
      flow.id,
      versionId,
    ]);
  }
  if (nextDraft?.changed)
    await client.query(
      `UPDATE flows SET flow_definition=$2,draft_version=draft_version+1,updated_at=NOW(3)
        WHERE id=$1`,
      [flow.id, nextDraft.definition],
    );
  return true;
}

/** Fluxo do check associado; depois o flow exato do alerta ou a regra geral. */
export async function flowForTicket(
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
  if (linked) return linked;
  // Fluxos próprios de alertas só tratam esses alertas, salvo se forem o fluxo por omissão.
  const reserved = new Set(links.map((link) => link.flow_id));
  return selectFlow(
    flows.filter((flow) => flow.isDefault || !reserved.has(flow.id)),
    ticket,
  );
}

/** Fluxos publicados do projeto com a definição da versão em vigor (candidatos à seleção). */
export async function publishedFlows(
  client: Queryable,
  projectId: string,
): Promise<PublishedFlow[]> {
  const rows = await client.query<{
    id: string;
    name: string;
    priority: number;
    is_default: boolean;
    flow_match: unknown;
    version_id: string;
    number: number;
    flow_definition: unknown;
  }>(
    `SELECT f.id,f.name,f.priority,f.is_default,f.flow_match,v.id AS version_id,v.number,v.flow_definition
       FROM flows f JOIN flow_versions v ON v.id=f.published_version_id
      WHERE f.project_id=$1 ORDER BY f.priority,f.name`,
    [projectId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    name: row.name,
    priority: Number(row.priority),
    isDefault: Boolean(row.is_default),
    match: parseMatch(row.flow_match),
    versionId: row.version_id,
    versionNumber: Number(row.number),
    definition: parseDefinition(row.flow_definition),
  }));
}
