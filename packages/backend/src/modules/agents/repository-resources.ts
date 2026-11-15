import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSiteKey } from '../../../../contracts/src/index.js';
import type {
  RepositoryResource,
  RepositoryResourceCatalog as RepositoryResourceCatalogView,
  RepositoryResourceReference,
  RepositoryResourceSelectionReason,
  RepositoryResourceSnapshot,
} from '../../../../contracts/src/agent-profiles.js';

const FILE_LIMIT = 64 * 1024;
const SNAPSHOT_LIMIT = 256 * 1024;
const RESOURCE_LIMIT = 160;
const LINK_LIMIT = 10;
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.sh', '.py', '.ts']);
/** Ficheiros de texto aceites num bundle de skill (scripts, referências e exemplos). */
const SKILL_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  '.js',
  '.mjs',
  '.ps1',
  '.sql',
  '.csv',
  '.toml',
  '.ini',
  '.xml',
  '.html',
  '.php',
]);
const SKILL_TREE_LIMIT = 40;
const RELEVANCE_LIMIT = 3;
const relevanceStopWords = new Set([
  'about',
  'after',
  'all',
  'also',
  'and',
  'are',
  'as',
  'at',
  'com',
  'como',
  'das',
  'de',
  'del',
  'dem',
  'do',
  'dos',
  'e',
  'em',
  'for',
  'from',
  'how',
  'its',
  'mais',
  'mas',
  'na',
  'nas',
  'no',
  'nos',
  'not',
  'of',
  'or',
  'para',
  'por',
  'que',
  'se',
  'the',
  'this',
  'to',
  'um',
  'uma',
  'with',
]);

const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const normalize = (path: string) => path.replaceAll('\\', '/');

function tokens(text: string) {
  return new Set(
    (
      text
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .match(/[\p{Letter}\p{Number}]{2,}/gu) ?? []
    ).filter((token) => !relevanceStopWords.has(token)),
  );
}

/** Relevance ranking is deterministic, bounded, and never selects a path outside the catalog. */
export function relevantRepositoryResources(
  resources: RepositoryResource[],
  context: string,
  limit = RELEVANCE_LIMIT,
) {
  const query = tokens(context);
  if (!query.size) return [];
  return resources
    .filter((resource) => !resource.globalInstruction)
    .map((resource) => {
      const pathTokens = tokens(resource.path);
      const otherTokens = tokens(`${resource.name} ${resource.description}`);
      let score = 0;
      for (const token of query) {
        if (pathTokens.has(token)) score += 3;
        if (otherTokens.has(token)) score += 2;
      }
      return { resource, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.resource.path.localeCompare(right.resource.path),
    )
    .slice(0, Math.max(0, Math.min(10, limit)))
    .map(({ resource }) => resource);
}

/** Calcula o hash estável dos caminhos e conteúdos efetivamente carregados num run. */
export function repositorySnapshotHash(resources: RepositoryResourceSnapshot[]) {
  const entries = resources
    .filter((resource) => resource.status === 'loaded' && resource.sha256)
    .map((resource) => `${resource.path}:${resource.sha256}`)
    .sort();
  return entries.length ? digest(entries.join('\n')) : null;
}

function isWithin(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function resourceKind(path: string): RepositoryResource['kind'] {
  if (/(^|\/)\.github\/agents\//.test(path) && path.endsWith('.agent.md')) return 'agent';
  if (/(^|\/)skills\//.test(path) && path.endsWith('/SKILL.md')) return 'skill';
  if (path.endsWith('/SKILL.md') || path === 'SKILL.md') return 'skill';
  return 'instruction';
}

function frontmatter(content: string, key: 'name' | 'description') {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!block) return null;
  const lines = block.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
  if (index < 0) return null;
  const first = lines[index]!.replace(new RegExp(`^${key}:\\s*`), '').trim();
  const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2').trim();
  if (first && !['>', '|', '>-', '|-'].includes(first)) return unquote(first).slice(0, 240);
  const continuation: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*/.test(line)) break;
    if (line.trim()) continuation.push(line.trim());
  }
  return continuation.join(' ').slice(0, 240) || null;
}

/** Leitura limitada a documentos técnicos reconhecidos do repositório, nunca a caminhos livres. */
export class RepositoryResources {
  constructor(private readonly sitesRoot?: string) {}

  /** Descobre apenas instruções, agentes e skills suportados sob a raiz do site autorizado. */
  async discover(siteKey: string | null): Promise<RepositoryResourceCatalogView> {
    const root = await this.repositoryRoot(siteKey);
    if (!root)
      return {
        available: false,
        siteKey,
        reason: !siteKey || !isSiteKey(siteKey) ? 'site_not_linked' : 'repository_unavailable',
        resources: [],
      };
    const paths = new Set<string>();
    const globalPaths = ['AGENTS.md', '.github/AGENTS.md', '.github/copilot-instructions.md'];
    const unavailableGlobalInstructions: string[] = [];
    for (const path of globalPaths) {
      if (await this.addFile(root, path, paths)) continue;
      if (await lstat(resolve(root, path)).catch(() => null))
        unavailableGlobalInstructions.push(path);
    }
    await this.addTree(root, '.github/agents', (path) => path.endsWith('.agent.md'), paths);
    await this.addTree(
      root,
      '.github/instructions',
      (path) => path.endsWith('.instructions.md'),
      paths,
    );
    await this.addTree(root, '.github/skills', (path) => path.endsWith('/SKILL.md'), paths);
    await this.addTree(root, 'skills', (path) => path.endsWith('/SKILL.md'), paths);

    const resources: RepositoryResource[] = [];
    for (const path of [...paths].sort().slice(0, RESOURCE_LIMIT)) {
      const content = await this.readWithin(root, path);
      if (content === null) continue;
      const kind = resourceKind(path);
      const basename = path.split('/').at(-1) ?? path;
      resources.push({
        path,
        kind,
        name: frontmatter(content, 'name') ?? basename.replace(/\.agent\.md$|\.md$/i, ''),
        description:
          frontmatter(content, 'description') ??
          (kind === 'instruction' ? 'Instruções técnicas aplicáveis ao projeto.' : ''),
        sha256: digest(content),
        ...(globalPaths.includes(path) ? { globalInstruction: true } : {}),
      });
    }
    return {
      available: true,
      siteKey,
      reason: null,
      resources,
      unavailableGlobalInstructions,
    };
  }

  /** Fixa o conteúdo aprovado no início da execução; nenhum caminho chega ao leitor sem catálogo. */
  async snapshot(
    siteKey: string | null,
    references: (RepositoryResourceReference & {
      selectionReason?: RepositoryResourceSelectionReason;
    })[],
  ) {
    if (!references.length) return { snapshotHash: null, resources: [] };
    const catalog = await this.discover(siteKey);
    const known = new Map(catalog.resources.map((resource) => [resource.path, resource]));
    const root = await this.repositoryRoot(siteKey);
    const snapshots: RepositoryResourceSnapshot[] = [];
    let total = 0;

    for (const reference of references) {
      const resource = known.get(reference.path);
      if (!catalog.available || !root || !resource) {
        snapshots.push({
          ...reference,
          kind: resource?.kind ?? resourceKind(reference.path),
          sha256: null,
          content: null,
          status: catalog.available ? 'missing' : 'unavailable',
          selectionReason: reference.selectionReason ?? 'flow_selected',
          reason: catalog.reason ?? 'resource_not_found',
        });
        continue;
      }
      const content = await this.readWithin(root, resource.path);
      if (content === null || Buffer.byteLength(content) > FILE_LIMIT) {
        snapshots.push({
          ...reference,
          kind: resource.kind,
          sha256: null,
          content: null,
          status: 'unavailable',
          selectionReason: reference.selectionReason ?? 'flow_selected',
          reason: content === null ? 'resource_not_readable' : 'resource_too_large',
        });
        continue;
      }
      const linked =
        resource.kind === 'skill' ? await this.skillResources(root, resource.path, content) : [];
      const requiredBytes =
        Buffer.byteLength(content) +
        linked.reduce((sum, item) => sum + Buffer.byteLength(item.content ?? ''), 0);
      if (total + requiredBytes > SNAPSHOT_LIMIT) {
        snapshots.push({
          ...reference,
          kind: resource.kind,
          sha256: null,
          content: null,
          status: 'unavailable',
          selectionReason: reference.selectionReason ?? 'flow_selected',
          reason: 'snapshot_size_limit',
        });
        continue;
      }
      total += requiredBytes;
      snapshots.push({
        ...reference,
        kind: resource.kind,
        sha256: digest(content),
        content,
        status: 'loaded',
        selectionReason: reference.selectionReason ?? 'flow_selected',
      });
      for (const item of linked) {
        total += Buffer.byteLength(item.content ?? '');
        snapshots.push({
          path: item.path,
          required: reference.required,
          kind: 'skill',
          sha256: item.content === null ? null : digest(item.content),
          content: item.content,
          status: item.status,
          selectionReason: reference.selectionReason ?? 'flow_selected',
          reason: item.reason ?? `skill_resource:${resource.path}`,
        });
      }
    }
    return { snapshotHash: repositorySnapshotHash(snapshots), resources: snapshots };
  }

  /**
   * Lê a árvore de uma skill descoberta (diretório do `SKILL.md`) para importação no catálogo.
   * Só aceita um `SKILL.md` presente no catálogo do site; ignora ocultos, symlinks e binários.
   */
  async readSkillTree(siteKey: string | null, skillPath: string) {
    const catalog = await this.discover(siteKey);
    const resource = catalog.resources.find(
      (item) => item.path === skillPath && item.kind === 'skill',
    );
    const root = await this.repositoryRoot(siteKey);
    if (!catalog.available || !root || !resource) return null;
    const directory = skillPath.includes('/') ? skillPath.slice(0, skillPath.lastIndexOf('/')) : '';
    const files: { path: string; content: string }[] = [];
    const visit = async (relativeDirectory: string, depth: number): Promise<void> => {
      if (depth > 5 || files.length > SKILL_TREE_LIMIT) return;
      const info = await lstat(resolve(root, relativeDirectory || '.')).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) return;
      const entries = await readdir(resolve(root, relativeDirectory || '.'), {
        withFileTypes: true,
      }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.')) continue;
        const path = normalize(
          relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
        );
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (entry.isFile()) {
          const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
          if (!SKILL_EXTENSIONS.has(extension)) continue;
          const content = await this.readWithin(root, path);
          if (content === null || content.includes('\u0000')) continue;
          files.push({ path: directory ? path.slice(directory.length + 1) : path, content });
        }
      }
    };
    await visit(directory, 0);
    return { path: skillPath, siteKey, files };
  }

  /** Lê um `.agent.md` descoberto no catálogo do site (importação de especialistas). */
  async readAgentFile(siteKey: string | null, agentPath: string) {
    const catalog = await this.discover(siteKey);
    const resource = catalog.resources.find(
      (item) => item.path === agentPath && item.kind === 'agent',
    );
    const root = await this.repositoryRoot(siteKey);
    if (!catalog.available || !root || !resource) return null;
    const content = await this.readWithin(root, agentPath);
    return content === null ? null : { path: agentPath, siteKey, content };
  }

  private async repositoryRoot(siteKey: string | null) {
    if (!this.sitesRoot || !siteKey || !isSiteKey(siteKey)) return null;
    try {
      const root = await realpath(this.sitesRoot);
      const candidate = await realpath(join(root, siteKey));
      const info = await stat(candidate);
      return info.isDirectory() && isWithin(root, candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  private async addFile(root: string, path: string, paths: Set<string>) {
    if ((await this.readWithin(root, path)) === null) return false;
    paths.add(path);
    return true;
  }

  private async addTree(
    root: string,
    directory: string,
    include: (path: string) => boolean,
    paths: Set<string>,
  ) {
    const visit = async (relativeDirectory: string, depth: number): Promise<void> => {
      if (depth > 6 || paths.size >= RESOURCE_LIMIT) return;
      const full = resolve(root, relativeDirectory);
      const info = await lstat(full).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) return;
      const entries = await readdir(full, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const path = normalize(join(relativeDirectory, entry.name));
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (entry.isFile() && include(path) && (await this.readWithin(root, path)))
          paths.add(path);
      }
    };
    await visit(directory, 0);
  }

  private async readWithin(root: string, path: string) {
    const normalized = normalize(path);
    if (
      normalized.startsWith('/') ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return null;
    const candidate = resolve(root, normalized);
    if (!isWithin(root, candidate)) return null;
    const actual = await realpath(candidate).catch(() => null);
    if (!actual || !isWithin(root, actual)) return null;
    const info = await stat(actual).catch(() => null);
    if (!info?.isFile() || info.size > FILE_LIMIT) return null;
    return readFile(actual, 'utf8').catch(() => null);
  }

  private async skillResources(root: string, skillPath: string, content: string) {
    const links = [...content.matchAll(/\]\(([^)]+)\)/g)]
      .map((match) => match[1]?.trim().split(/[?#]/, 1)[0] ?? '')
      .filter(
        (path) =>
          path &&
          !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
          !path.startsWith('/') &&
          TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase()),
      )
      .slice(0, LINK_LIMIT);
    const result: {
      path: string;
      content: string | null;
      status: 'loaded' | 'missing' | 'unavailable';
      reason?: string;
    }[] = [];
    for (const [index, link] of links.entries()) {
      const resolved = resolve(root, dirname(resolve(root, skillPath)), link);
      if (!isWithin(root, resolved)) {
        result.push({
          path: `${skillPath} -> ${link.slice(0, 160)}`,
          content: null,
          status: 'unavailable',
          reason: `skill_resource:${skillPath}|relative_resource_outside_repository`,
        });
        continue;
      }
      const path = normalize(relative(root, resolved));
      const resource = await this.readWithin(root, path);
      if (resource === null) {
        result.push({
          path: `${skillPath} -> ${link.slice(0, 160)}`,
          content: null,
          status: 'missing',
          reason: `skill_resource:${skillPath}|relative_resource_not_readable:${index + 1}`,
        });
        continue;
      }
      result.push({ path, content: resource, status: 'loaded' });
    }
    return result;
  }
}
