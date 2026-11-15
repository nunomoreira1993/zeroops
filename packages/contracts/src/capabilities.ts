import { z } from 'zod';
import { copilotToolKeys } from './agent-profiles.js';

/**
 * Catálogo de capacidades (P04): skills versionadas com bundle imutável e especialistas
 * (perfis) delegáveis. Credenciais, conversas e acessos a recursos nunca fazem parte de uma
 * capacidade: ficam nos bindings locais de cada projeto.
 */

/** Nome de skill compatível com o Copilot (minúsculas e hífenes). */
export const skillNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Nome da skill: minúsculas, dígitos e hífenes.')
  .max(64);

export const SKILL_FILE_LIMIT = 40;
export const SKILL_FILE_BYTES = 128 * 1024;
export const SKILL_BUNDLE_BYTES = 768 * 1024;
export const SKILL_MANIFEST_FILE = 'zeroops-skill.json';

/** Caminho relativo seguro dentro do bundle (sem `..`, absolutos, `\` nem ficheiros ocultos). */
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/, 'Caminho inválido.')
  .refine((path) => path.split('/').length <= 6, 'Caminho demasiado profundo.');

/**
 * Regra de segurança do frontmatter do `SKILL.md`, aplicada na importação e na materialização.
 * O runtime lê o frontmatter com um parser YAML completo e auto-aprova `allowed-tools`, por isso
 * só se aceitam chaves de topo simples (`chave: valor`) e qualquer menção a allowed-tools é
 * recusada (chaves com aspas, espaço antes de `:`, mapas em fluxo, escapes). Devolve o motivo
 * da recusa, ou null.
 */
export function skillFrontmatterViolation(content: string): string | null {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  const frontmatter = match[1]!;
  if (/allowed[\s_-]*tools|\\x|\\u/i.test(frontmatter))
    return 'O SKILL.md não pode declarar allowed-tools: as ferramentas são autorizadas pelos bindings do projeto.';
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line) || line.startsWith('#')) continue;
    if (!/^[A-Za-z][A-Za-z0-9_-]*:(?:\s|$)/.test(line))
      return `Linha de frontmatter não suportada no SKILL.md: «${line.slice(0, 80)}».`;
  }
  return null;
}

/** Manifesto complementar opcional (`zeroops-skill.json`) com dependências declaradas. */
export const skillComplementSchema = z.strictObject({
  requires: z
    .strictObject({
      tools: z.array(z.enum(copilotToolKeys)).max(copilotToolKeys.length).default([]),
      skills: z.array(skillNameSchema).max(8).default([]),
    })
    .default({ tools: [], skills: [] }),
  compatibility: z
    .strictObject({
      modes: z
        .array(z.enum(['analysis', 'develop', 'report']))
        .min(1)
        .max(3),
    })
    .optional(),
});
export type SkillComplement = z.infer<typeof skillComplementSchema>;

export const skillUploadFileSchema = z.strictObject({
  path: skillFilePathSchema,
  content: z.string().max(SKILL_FILE_BYTES),
});

/** Importação: do repositório autorizado do projeto ou por envio explícito de ficheiros. */
export const skillImportSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('repository'),
    path: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    source: z.literal('upload'),
    files: z.array(skillUploadFileSchema).min(1).max(SKILL_FILE_LIMIT),
  }),
]);
export type SkillImportInput = z.infer<typeof skillImportSchema>;

/** Nova versão de uma skill existente (editar nunca altera versões anteriores). */
export const skillVersionInputSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  import: skillImportSchema,
});

export const skillBindingsInputSchema = z.strictObject({
  tools: z
    .array(z.enum(copilotToolKeys))
    .max(copilotToolKeys.length)
    .refine((values) => new Set(values).size === values.length, 'Ferramentas repetidas.'),
});

export const agentImportSchema = z.strictObject({
  source: z.enum(['repository', 'upload']),
  /** Caminho do `.agent.md` no repositório (source=repository). */
  path: z.string().trim().min(1).max(240).optional(),
  /** Conteúdo do `.agent.md` (source=upload). */
  content: z
    .string()
    .max(64 * 1024)
    .optional(),
  fileName: z.string().trim().max(120).optional(),
  /** Quando indicado, cria uma nova versão deste perfil em vez de um perfil novo. */
  profileId: z.uuid().optional(),
  expectedVersion: z.number().int().min(1).optional(),
});
export type AgentImportInput = z.infer<typeof agentImportSchema>;

export const capabilityShareSchema = z.strictObject({
  kind: z.enum(['skill', 'agent']),
  capabilityId: z.uuid(),
  version: z.number().int().min(1),
  targetProjectId: z.uuid(),
});

export interface SkillFileEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface SkillVersionManifest {
  name: string;
  description: string;
  files: SkillFileEntry[];
  requires: { tools: string[]; skills: string[] };
  compatibility: { modes: string[] } | null;
}

export interface CapabilitySource {
  kind: 'repository' | 'upload' | 'share';
  /** Caminho de origem (repositório ou nome do ficheiro enviado). */
  path?: string;
  siteKey?: string | null;
  /** Projeto, capacidade e versão de origem quando adotada por partilha. */
  projectId?: string;
  capabilityId?: string;
  version?: number;
  /** Hash do conteúdo original importado (proveniência). */
  sha256?: string;
  /** Campos da origem não suportados pelo ZeroOps (registados, não aplicados). */
  ignored?: Record<string, unknown>;
}

export interface SkillVersionView {
  id: string;
  version: number;
  description: string;
  bundleHash: string;
  manifest: SkillVersionManifest;
  source: CapabilitySource;
  createdAt: string;
  createdBy: string | null;
}

export interface SkillView {
  id: string;
  projectId: string;
  name: string;
  currentVersion: number;
  archivedAt: string | null;
  /** Ferramentas do projeto autorizadas para a skill (bindings locais). */
  boundTools: string[];
  versions: SkillVersionView[];
}

export interface CapabilityShareView {
  id: string;
  kind: 'skill' | 'agent';
  capabilityId: string;
  name: string;
  version: number;
  sourceProjectId: string;
  sourceProjectName: string;
  targetProjectId: string;
  createdAt: string;
  revokedAt: string | null;
  adoptedCapabilityId: string | null;
}

export interface CapabilityCatalogView {
  skills: SkillView[];
  /** Partilhas recebidas de outros projetos (por adotar ou já adotadas). */
  incoming: CapabilityShareView[];
  /** Partilhas emitidas por este projeto. */
  outgoing: CapabilityShareView[];
}

/** Referência fixada a uma skill numa etapa ou no manifesto. */
export const capabilitySkillRefSchema = z.strictObject({
  skillId: z.uuid(),
  version: z.number().int().min(1),
});
export type CapabilitySkillRef = z.infer<typeof capabilitySkillRefSchema>;

/** Especialista delegável: outro perfil do projeto, numa versão fixada. */
export const capabilityDelegateRefSchema = z.strictObject({
  profileId: z.uuid(),
  version: z.number().int().min(1),
});
export type CapabilityDelegateRef = z.infer<typeof capabilityDelegateRefSchema>;

export const capabilityDelegationSchema = z.strictObject({
  maxConcurrency: z.number().int().min(1).max(3),
});

/** Profundidade de delegação suportada: os especialistas não delegam (sem a ferramenta `task`). */
export const CAPABILITY_MAX_DEPTH = 1;
export const CAPABILITY_MANIFEST_FORMAT = 1;

/** Skill fixada para um run: versão imutável, hash do bundle e lista de ficheiros. */
export interface RunSkill {
  skillId: string;
  versionId: string;
  version: number;
  name: string;
  description: string;
  bundleHash: string;
  files: SkillFileEntry[];
  requiredTools: string[];
}

export interface RunAgent {
  /** Nome técnico do agente no SDK (slug estável). */
  name: string;
  displayName: string;
  description: string;
  profileId: string;
  version: number;
  definitionHash: string;
  /** Prompt compilado (missão, instruções, contrato e critérios). */
  prompt: string;
  /** Ferramentas de conector autorizadas ao agente (⊆ ferramentas da etapa). */
  connectorTools: string[];
  model: string | null;
}

/**
 * Capacidades fixadas no run (compiladas a partir do manifesto do fluxo). O executor só pode
 * materializar/expor o que está aqui; permissões efetivas continuam a ser as do run (P03).
 */
export interface CapabilityRunManifest {
  format: number;
  agent: RunAgent;
  skills: RunSkill[];
  delegates: RunAgent[];
  delegation: { maxConcurrency: number; maxDepth: number };
}
