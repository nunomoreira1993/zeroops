import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  agentProfileDefinitionSchema,
  canonicalJson,
  copilotToolKeys,
  SKILL_BUNDLE_BYTES,
  SKILL_FILE_BYTES,
  SKILL_FILE_LIMIT,
  SKILL_MANIFEST_FILE,
  skillComplementSchema,
  skillFilePathSchema,
  skillFrontmatterViolation,
  skillNameSchema,
  type AgentProfileDefinition,
  type SkillVersionManifest,
} from '../../../../contracts/src/index.js';
import { DomainError } from '../../errors.js';

/** Formato do hash de bundle; muda apenas se a fórmula canónica mudar. */
export const SKILL_BUNDLE_FORMAT = 1;

export const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

type FrontmatterValue = string | string[];

/**
 * Frontmatter YAML mínimo (`chave: valor`, blocos `>`/`|`, listas `- x` e `[a, b]`). Não executa
 * nem interpreta tags YAML: valores desconhecidos ficam como texto.
 */
export function parseFrontmatter(
  content: string,
): { fields: Record<string, FrontmatterValue>; body: string } | null {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  const lines = match[1]!.split(/\r?\n/);
  const fields: Record<string, FrontmatterValue> = {};
  const unquote = (value: string) =>
    value
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const key = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!key) continue;
    const [, name, rest = ''] = key;
    const value = rest.trim();
    const continuation: string[] = [];
    while (index + 1 < lines.length && !/^[A-Za-z][A-Za-z0-9_-]*:/.test(lines[index + 1]!)) {
      continuation.push(lines[index + 1]!);
      index += 1;
    }
    if (value.startsWith('[') && value.endsWith(']'))
      fields[name!] = value.slice(1, -1).split(',').map(unquote).filter(Boolean);
    else if (!value && continuation.some((item) => /^\s*-\s+/.test(item)))
      fields[name!] = continuation
        .filter((item) => /^\s*-\s+/.test(item))
        .map((item) => unquote(item.replace(/^\s*-\s+/, '')))
        .filter(Boolean);
    else if (!value || ['>', '|', '>-', '|-'].includes(value))
      fields[name!] = continuation
        .map((item) => item.trim())
        .filter(Boolean)
        .join(value.startsWith('|') ? '\n' : ' ');
    else fields[name!] = unquote(value);
  }
  return { fields, body: content.slice(match[0].length).trim() };
}

const invalid = (message: string) => new DomainError('SKILL_INVALID', message, 422);
const text = (value: FrontmatterValue | undefined) =>
  Array.isArray(value) ? value.join(' ') : (value ?? '');

export interface SkillBundle {
  name: string;
  description: string;
  manifest: SkillVersionManifest;
  bundleHash: string;
  files: { path: string; content: string; sha256: string; size: number }[];
}

/** Links relativos do markdown que têm de existir no bundle (sem URLs nem âncoras). */
function relativeLinks(markdown: string) {
  return [...markdown.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)]
    .map((match) => (match[1] ?? '').split(/[?#]/, 1)[0] ?? '')
    .filter((link) => link && !/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith('#'));
}

/**
 * Valida um bundle de skill e calcula o hash canónico. Rejeita caminhos inseguros, binários,
 * limites excedidos, frontmatter inválido, dependências mal formadas e links relativos em falta.
 */
export function buildSkillBundle(input: { path: string; content: string }[]): SkillBundle {
  if (!input.length) throw invalid('A skill não tem ficheiros.');
  if (input.length > SKILL_FILE_LIMIT)
    throw invalid(`A skill excede o limite de ${SKILL_FILE_LIMIT} ficheiros.`);
  const files = new Map<string, string>();
  let total = 0;
  for (const file of input) {
    const path = file.path.replaceAll('\\', '/');
    if (!skillFilePathSchema.safeParse(path).success || path !== file.path)
      throw invalid(`Caminho de ficheiro inválido na skill: «${file.path.slice(0, 120)}».`);
    if (files.has(path)) throw invalid(`Ficheiro repetido na skill: «${path}».`);
    if (file.content.includes('\u0000'))
      throw invalid(`O ficheiro «${path}» não é texto (só são aceites ficheiros de texto).`);
    const size = Buffer.byteLength(file.content, 'utf8');
    if (size > SKILL_FILE_BYTES) throw invalid(`O ficheiro «${path}» excede o limite de tamanho.`);
    total += size;
    files.set(path, file.content);
  }
  if (total > SKILL_BUNDLE_BYTES) throw invalid('A skill excede o tamanho total permitido.');
  const skill = files.get('SKILL.md');
  if (skill === undefined) throw invalid('A skill tem de ter um SKILL.md na raiz.');
  const frontmatter = parseFrontmatter(skill);
  if (!frontmatter) throw invalid('O SKILL.md tem de começar com frontmatter (name, description).');
  const name = skillNameSchema.safeParse(text(frontmatter.fields.name).trim());
  if (!name.success)
    throw invalid('O campo name do SKILL.md é obrigatório (minúsculas, dígitos e hífenes, ≤64).');
  const description = text(frontmatter.fields.description).trim();
  if (!description || description.length > 1024)
    throw invalid('O campo description do SKILL.md é obrigatório (até 1024 caracteres).');
  if (!frontmatter.body) throw invalid('O SKILL.md não tem instruções após o frontmatter.');
  // O runtime auto-aprova as ferramentas de `allowed-tools`; uma skill não concede permissões.
  const violation = skillFrontmatterViolation(skill);
  if (violation) throw invalid(violation);

  for (const [path, content] of files) {
    if (!path.endsWith('.md')) continue;
    for (const link of relativeLinks(content)) {
      if (link.startsWith('/')) throw invalid(`Link absoluto não suportado em «${path}»: ${link}.`);
      let decoded: string;
      try {
        decoded = decodeURI(link);
      } catch {
        throw invalid(`Link inválido em «${path}»: ${link.slice(0, 120)}.`);
      }
      const target = posix.normalize(posix.join(posix.dirname(path), decoded));
      if (target.startsWith('../') || target === '..')
        throw invalid(`O link «${link}» em «${path}» sai do diretório da skill.`);
      if (!files.has(target) && ![...files.keys()].some((item) => item.startsWith(`${target}/`)))
        throw invalid(`O recurso relativo «${link}» referido em «${path}» não existe na skill.`);
    }
  }

  let complement: { requires: { tools: string[]; skills: string[] }; compatibility?: object } = {
    requires: { tools: [], skills: [] },
  };
  const rawComplement = files.get(SKILL_MANIFEST_FILE);
  if (rawComplement !== undefined) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawComplement);
    } catch {
      throw invalid(`O ${SKILL_MANIFEST_FILE} não é JSON válido.`);
    }
    const parsed = skillComplementSchema.safeParse(parsedJson);
    if (!parsed.success)
      throw invalid(
        `O ${SKILL_MANIFEST_FILE} é inválido: ${parsed.error.issues[0]?.message ?? 'formato'}.`,
      );
    if (parsed.data.requires.skills.includes(name.data))
      throw invalid('Uma skill não pode depender de si própria.');
    complement = parsed.data;
  }
  const entries = [...files.entries()]
    .map(([path, content]) => ({
      path,
      content,
      sha256: sha256(content),
      size: Buffer.byteLength(content, 'utf8'),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest: SkillVersionManifest = {
    name: name.data,
    description,
    files: entries.map(({ path, sha256: hash, size }) => ({ path, sha256: hash, size })),
    requires: {
      tools: [...new Set(complement.requires.tools)].sort(),
      skills: [...new Set(complement.requires.skills)].sort(),
    },
    compatibility:
      'compatibility' in complement && complement.compatibility
        ? (complement.compatibility as { modes: string[] })
        : null,
  };
  return {
    name: name.data,
    description,
    manifest,
    bundleHash: skillBundleHash(manifest),
    files: entries,
  };
}

/** Hash canónico de uma versão de skill (metadados + caminhos e hashes dos ficheiros). */
export function skillBundleHash(manifest: SkillVersionManifest) {
  return sha256(
    canonicalJson({
      format: SKILL_BUNDLE_FORMAT,
      name: manifest.name,
      description: manifest.description,
      files: manifest.files.map(({ path, sha256: hash }) => ({ path, sha256: hash })),
      requires: manifest.requires,
      compatibility: manifest.compatibility,
    }),
  );
}

const defaultExpectedOutput =
  'Resultado da especialidade com factos verificados, evidência e lacunas identificadas.';
const defaultCriteria = [
  'Responder apenas dentro da especialidade e das permissões da etapa.',
  'Separar factos confirmados de hipóteses e indicar as fontes.',
];

/**
 * Converte um `.agent.md` num perfil ZeroOps. O corpo passa a `instructions`; ferramentas fora do
 * catálogo e o modelo de origem são registados como ignorados (nunca concedem acesso).
 */
export function parseAgentMarkdown(
  content: string,
  fileName: string,
): { definition: AgentProfileDefinition; ignored: Record<string, unknown> } {
  if (content.includes('\u0000'))
    throw new DomainError('AGENT_IMPORT_INVALID', 'Ficheiro inválido.', 422);
  const parsed = parseFrontmatter(content);
  const fields = parsed?.fields ?? {};
  const body = (parsed ? parsed.body : content).trim();
  if (!body)
    throw new DomainError('AGENT_IMPORT_INVALID', 'O agente não tem instruções no corpo.', 422);
  const baseName = fileName
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)!
    .replace(/\.agent\.md$|\.md$/i, '');
  const name = (text(fields.name).trim() || baseName).slice(0, 80);
  const description = text(fields.description).trim().slice(0, 500);
  const firstParagraph =
    body
      .split(/\r?\n\s*\r?\n/)
      .map((item) => item.replace(/^#+\s*/gm, '').trim())
      .find((item) => item.length >= 20) ?? '';
  const mission = (description.length >= 20 ? description : firstParagraph || body).slice(0, 4000);
  const tools = Array.isArray(fields.tools) ? fields.tools : fields.tools ? [fields.tools] : [];
  const supported = tools.filter((tool): tool is (typeof copilotToolKeys)[number] =>
    (copilotToolKeys as readonly string[]).includes(tool),
  );
  const ignored: Record<string, unknown> = {};
  const unsupportedTools = tools.filter((tool) => !supported.includes(tool as never));
  if (unsupportedTools.length) ignored.tools = unsupportedTools;
  if (fields.model) ignored.model = fields.model;
  for (const key of Object.keys(fields))
    if (!['name', 'description', 'tools', 'model'].includes(key)) ignored[key] = fields[key];
  const definition = agentProfileDefinitionSchema.safeParse({
    name,
    description,
    mission,
    expectedInputs: ['Pedido e contexto do ticket'],
    expectedOutput: defaultExpectedOutput,
    completionCriteria: defaultCriteria,
    modes: ['analysis', 'report'],
    allowedTools: [...new Set(supported)],
    model: null,
    fusionTier: null,
    reasoningEffort: null,
    instructions: body.slice(0, 20000),
  });
  if (!definition.success)
    throw new DomainError(
      'AGENT_IMPORT_INVALID',
      `O agente importado é inválido: ${definition.error.issues[0]?.message ?? 'formato'} (${definition.error.issues[0]?.path.join('.') ?? ''}).`,
      422,
    );
  if (body.length > 20000) ignored.truncatedInstructions = body.length;
  return { definition: definition.data, ignored };
}
