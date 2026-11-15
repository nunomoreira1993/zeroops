import { createHash } from 'node:crypto';
import { chmod, chown, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CustomAgentConfig } from '@github/copilot-sdk';
import {
  skillFilePathSchema,
  skillFrontmatterViolation,
  skillNameSchema,
  type CapabilityRunManifest,
} from '../../../packages/contracts/src/index.js';

export interface SkillFileContent {
  path: string;
  content: string;
  sha256: string;
}

/** Capacidades fixadas no run e conteúdo das versões de skill (como entregue pelo claim). */
export interface RunCapabilities {
  manifest: CapabilityRunManifest;
  files: Record<string, SkillFileContent[]>;
}

/** Capacidades materializadas para uma sessão (diretório só de leitura removido no fim). */
export interface CompiledCapabilities {
  manifest: CapabilityRunManifest;
  /** Raiz das skills materializadas (`<raiz>/<nome>/SKILL.md`); `null` sem skills. */
  skillDirectory: string | null;
}

export class CapabilityIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityIntegrityError';
  }
}

const sha256 = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

/**
 * Materializa as skills fixadas num diretório próprio do job. Cada ficheiro tem de corresponder
 * exatamente (caminho e sha256) ao manifesto fixado no run; qualquer diferença falha o run em vez
 * de executar conteúdo não aprovado. O diretório fica só de leitura.
 */
export async function materializeCapabilities(
  root: string,
  capabilities: RunCapabilities,
  owner?: { uid: number; gid: number },
): Promise<{ compiled: CompiledCapabilities; cleanup: () => Promise<void> }> {
  const { manifest } = capabilities;
  if (!manifest.skills.length)
    return { compiled: { manifest, skillDirectory: null }, cleanup: async () => undefined };
  const base = await mkdtemp(join(root, 'skills-'));
  const cleanup = async () => {
    await makeWritable(base).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  };
  try {
    const directory = join(base, 'skills');
    await mkdir(directory);
    for (const skill of manifest.skills) {
      if (!skillNameSchema.safeParse(skill.name).success)
        throw new CapabilityIntegrityError(`Nome de skill inválido: ${skill.name}.`);
      const files = capabilities.files[skill.versionId] ?? [];
      const expected = new Map(skill.files.map((file) => [file.path, file.sha256]));
      if (files.length !== expected.size)
        throw new CapabilityIntegrityError(
          `A skill ${skill.name} não corresponde à versão fixada.`,
        );
      for (const file of files) {
        if (!skillFilePathSchema.safeParse(file.path).success)
          throw new CapabilityIntegrityError(`Caminho inválido na skill ${skill.name}.`);
        const hash = sha256(file.content);
        if (expected.get(file.path) !== hash || file.sha256 !== hash)
          throw new CapabilityIntegrityError(
            `O ficheiro ${file.path} da skill ${skill.name} não corresponde ao hash fixado.`,
          );
        const violation = file.path === 'SKILL.md' ? skillFrontmatterViolation(file.content) : null;
        if (violation) throw new CapabilityIntegrityError(violation);
        const target = join(directory, skill.name, ...file.path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' });
      }
    }
    await makeReadOnly(base, owner);
    return { compiled: { manifest, skillDirectory: directory }, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function walk(path: string, visit: (path: string, directory: boolean) => Promise<void>) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await walk(child, visit);
    await visit(child, entry.isDirectory());
  }
}

async function makeReadOnly(base: string, owner?: { uid: number; gid: number }) {
  const apply = async (path: string, directory: boolean) => {
    if (owner) await chown(path, owner.uid, owner.gid);
    // F02: com dono próprio, as skills ficam ilegíveis para os uids de outros jobs.
    await chmod(path, owner ? (directory ? 0o500 : 0o400) : directory ? 0o555 : 0o444);
  };
  await walk(base, apply);
  await apply(base, true);
}

async function makeWritable(base: string) {
  await chmod(base, 0o755);
  await walk(base, async (path, directory) => {
    await chmod(path, directory ? 0o755 : 0o644);
  });
}

const DELEGATE_TOOLS = ['view', 'grep', 'glob', 'skill', 'report_intent'];

/**
 * Configuração nativa do SDK: o perfil da etapa como agente principal e os especialistas como
 * agentes delegáveis só de leitura (sem `task`: profundidade 1). As skills ficam disponíveis por
 * relevância através da ferramenta `skill`; nunca são concatenadas no prompt.
 */
export function compileSessionCapabilities(
  compiled: CompiledCapabilities,
  shellTool: string | null,
) {
  const { manifest, skillDirectory } = compiled;
  const delegates = manifest.delegates;
  const customAgents: CustomAgentConfig[] = [
    {
      name: manifest.agent.name,
      displayName: manifest.agent.displayName,
      description: manifest.agent.description,
      prompt: manifest.agent.prompt,
      tools: null,
      infer: false,
    },
    ...delegates.map((delegate) => ({
      name: delegate.name,
      displayName: delegate.displayName,
      description: delegate.description,
      prompt: delegate.prompt,
      tools: [
        ...DELEGATE_TOOLS,
        ...(shellTool && delegate.connectorTools.length ? [shellTool] : []),
      ],
      infer: true,
    })),
  ];
  return {
    config: {
      customAgents,
      agent: manifest.agent.name,
      enableConfigDiscovery: false,
      ...(skillDirectory
        ? { enableSkills: true, skillDirectories: [skillDirectory], disabledSkills: [] }
        : {}),
      ...(delegates.length ? { includeSubAgentStreamingEvents: false } : {}),
    },
    tools: [...(skillDirectory ? ['skill'] : []), ...(delegates.length ? ['task'] : [])],
  };
}

export interface ToolGuardDecision {
  permissionDecision: 'deny';
  permissionDecisionReason: string;
}

/**
 * Guarda das ferramentas de capacidades, aplicada no `onPreToolUse` (também nas chamadas dos
 * especialistas): sem posse não há chamadas; só as skills e especialistas fixados; limite de
 * especialistas em simultâneo. Nunca aprova: a decisão final continua na `PermissionPolicy`.
 */
export class CapabilityToolGuard {
  private readonly running = new Set<string>();
  private readonly skills: Set<string>;
  private readonly delegates: Set<string>;

  constructor(
    private readonly manifest: CapabilityRunManifest | null,
    private readonly isActive: () => boolean = () => true,
  ) {
    this.skills = new Set(manifest?.skills.map((skill) => skill.name) ?? []);
    this.delegates = new Set(manifest?.delegates.map((delegate) => delegate.name) ?? []);
  }

  check(input: {
    toolName: string;
    toolArgs: unknown;
    toolCallId?: string;
  }): ToolGuardDecision | undefined {
    const deny = (reason: string): ToolGuardDecision => ({
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    });
    if (!this.isActive()) return deny('A tentativa já não detém o run: sem novos efeitos.');
    const args = (input.toolArgs ?? {}) as Record<string, unknown>;
    if (input.toolName === 'skill') {
      const name = typeof args.skill === 'string' ? args.skill : null;
      if (!name || !this.skills.has(name)) return deny('Skill não autorizada para esta etapa.');
    }
    if (input.toolName === 'task') {
      const agent = typeof args.agent_type === 'string' ? args.agent_type : null;
      if (!agent || !this.delegates.has(agent))
        return deny('Especialista não autorizado para esta etapa.');
      const limit = this.manifest?.delegation.maxConcurrency ?? 0;
      // Sem toolCallId não é possível libertar a vaga no fim: recusar em vez de perder o limite.
      if (!input.toolCallId) return deny('Runtime sem correlação de chamadas: delegação recusada.');
      if (this.running.size >= limit)
        return deny(`Limite de ${limit} especialista(s) em simultâneo atingido; aguarde.`);
      this.running.add(input.toolCallId);
    }
    return undefined;
  }

  /** Liberta a vaga de um especialista (fim da chamada `task`). */
  release(toolCallId: string | undefined) {
    if (toolCallId) this.running.delete(toolCallId);
  }

  get active() {
    return this.running.size;
  }
}
