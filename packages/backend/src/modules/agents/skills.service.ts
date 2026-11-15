import { randomUUID } from 'node:crypto';
import {
  capabilityShareSchema,
  skillBindingsInputSchema,
  skillImportSchema,
  skillVersionInputSchema,
  type CapabilityCatalogView,
  type CapabilityShareView,
  type CapabilitySource,
  type SkillImportInput,
  type SkillVersionManifest,
  type SkillView,
  type User,
} from '../../../../contracts/src/index.js';
import type { Database } from '../../database/database.js';
import { DomainError } from '../../errors.js';
import { parseInput } from '../identity/identity.validation.js';
import type { Queryable } from '../identity/membership.js';
import {
  projectPermissionContext,
  requireProjectPermission,
} from '../identity/project-permissions.js';
import type { AgentProfilesService } from './agent-profiles.service.js';
import { skillVersionFiles } from './capability-catalog.js';
import type { RepositoryResources } from './repository-resources.js';
import { buildSkillBundle, sha256, type SkillBundle } from './skill-bundle.js';

interface SkillRow {
  id: string;
  project_id: string;
  name: string;
  current_version: number;
  archived_at: Date | null;
}

interface ShareRow {
  id: string;
  kind: 'skill' | 'agent';
  capability_id: string;
  version: number;
  source_project_id: string;
  source_project_name: string;
  target_project_id: string;
  created_at: Date;
  revoked_at: Date | null;
  adopted_capability_id: string | null;
  capability_name: string | null;
}

const parseJson = <T>(raw: unknown): T => (typeof raw === 'string' ? JSON.parse(raw) : raw) as T;

/**
 * Catálogo de skills do projeto (P04): importação validada, versões imutáveis com hash,
 * bindings locais de ferramentas e partilha explícita entre projetos. Partilhar ou adotar
 * nunca transporta bindings, credenciais, conversas nem acesso a recursos do projeto de origem.
 */
export class SkillsService {
  constructor(
    private readonly db: Database,
    private readonly repository: RepositoryResources,
    private readonly profiles: AgentProfilesService,
  ) {}

  /** Skills, perfis e partilhas visíveis no projeto (exige `flows.view`). */
  async catalog(actor: User, projectId: string): Promise<CapabilityCatalogView> {
    return this.db.transaction(async (client) => {
      await requireProjectPermission(client, actor, projectId, 'flows.view');
      const rows = await client.query<SkillRow>(
        `SELECT id,project_id,name,current_version,archived_at FROM zeroops_skills
          WHERE project_id=$1 ORDER BY archived_at IS NOT NULL,name`,
        [projectId],
      );
      const skills = await Promise.all(rows.rows.map((row) => this.view(client, row)));
      const shares = await client.query<ShareRow>(
        `SELECT s.id,s.kind,s.capability_id,s.version,s.source_project_id,p.name AS source_project_name,
                s.target_project_id,s.created_at,s.revoked_at,s.adopted_capability_id,
                COALESCE(k.name,a.name) AS capability_name
           FROM zeroops_capability_shares s
           JOIN projects p ON p.id=s.source_project_id
           LEFT JOIN zeroops_skills k ON s.kind='skill' AND k.id=s.capability_id
           LEFT JOIN zeroops_agent_profiles a ON s.kind='agent' AND a.id=s.capability_id
          WHERE s.target_project_id=$1 OR s.source_project_id=$1
          ORDER BY s.created_at DESC LIMIT 200`,
        [projectId],
      );
      const views = shares.rows.map(shareView);
      return {
        skills,
        incoming: views.filter(
          (share) => share.targetProjectId === projectId && share.revokedAt === null,
        ),
        outgoing: views.filter((share) => share.sourceProjectId === projectId),
      };
    });
  }

  /** Importa uma skill nova (repositório autorizado do projeto ou envio de ficheiros). */
  async importSkill(actor: User, projectId: string, raw: unknown) {
    const input = parseInput(skillImportSchema, raw);
    await requireProjectPermission(this.db, actor, projectId, 'skills.manage');
    const { bundle, provenance } = await this.loadBundle(projectId, input);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'skills.manage',
        true,
      );
      const id = await this.insertSkill(client, context.actor.id, projectId, bundle, provenance);
      await this.audit(client, context.actor.id, projectId, 'skill.imported', {
        skillId: id,
        name: bundle.name,
        version: 1,
        bundleHash: bundle.bundleHash,
        source: provenance.kind,
      });
      return this.get(client, projectId, id);
    });
  }

  /** Publica uma nova versão imutável (mesmo nome); repetir o mesmo bundle é idempotente. */
  async addVersion(actor: User, projectId: string, skillId: string, raw: unknown) {
    const input = parseInput(skillVersionInputSchema, raw);
    await requireProjectPermission(this.db, actor, projectId, 'skills.manage');
    const { bundle, provenance } = await this.loadBundle(projectId, input.import);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'skills.manage',
        true,
      );
      const skill = await this.lock(client, projectId, skillId);
      if (skill.name !== bundle.name)
        throw new DomainError(
          'SKILL_NAME_MISMATCH',
          `A nova versão tem de manter o nome «${skill.name}».`,
          422,
        );
      const current = await this.versionHash(client, skillId, Number(skill.current_version));
      if (current === bundle.bundleHash) return this.get(client, projectId, skillId);
      if (Number(skill.current_version) !== input.expectedVersion)
        throw new DomainError('CONFLICT', 'A skill mudou. Recarregue antes de editar.', 409);
      const version = await this.appendVersion(client, context.actor.id, skill, bundle, provenance);
      await this.audit(client, context.actor.id, projectId, 'skill.version_created', {
        skillId,
        version,
        bundleHash: bundle.bundleHash,
        source: provenance.kind,
      });
      return this.get(client, projectId, skillId);
    });
  }

  /** Arquiva a skill: deixa de ser selecionável e bloqueia ativações; runs fixados mantêm-na. */
  async archive(actor: User, projectId: string, skillId: string) {
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'skills.manage',
        true,
      );
      await this.lock(client, projectId, skillId);
      await client.query(
        'UPDATE zeroops_skills SET archived_at=COALESCE(archived_at,NOW(3)),updated_at=NOW(3) WHERE id=$1',
        [skillId],
      );
      await this.audit(client, context.actor.id, projectId, 'skill.archived', { skillId });
      return this.get(client, projectId, skillId);
    });
  }

  /** Define as ferramentas do projeto autorizadas para a skill (substitui o conjunto atual). */
  async setBindings(actor: User, projectId: string, skillId: string, raw: unknown) {
    const input = parseInput(skillBindingsInputSchema, raw);
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        'skills.manage',
        true,
      );
      await this.lock(client, projectId, skillId);
      const before = (
        await client.query<{ tool_key: string }>(
          'SELECT tool_key FROM zeroops_skill_bindings WHERE project_id=$1 AND skill_id=$2',
          [projectId, skillId],
        )
      ).rows.map((row) => row.tool_key);
      const added = input.tools.filter((tool) => !before.includes(tool));
      const removed = before.filter((tool) => !(input.tools as string[]).includes(tool));
      for (const tool of removed)
        await client.query(
          'DELETE FROM zeroops_skill_bindings WHERE project_id=$1 AND skill_id=$2 AND tool_key=$3',
          [projectId, skillId, tool],
        );
      for (const tool of added)
        await client.query(
          'INSERT INTO zeroops_skill_bindings(project_id,skill_id,tool_key,created_by) VALUES($1,$2,$3,$4)',
          [projectId, skillId, tool, context.actor.id],
        );
      if (added.length || removed.length)
        await this.audit(client, context.actor.id, projectId, 'skill.bindings_changed', {
          skillId,
          added,
          removed,
        });
      return this.get(client, projectId, skillId);
    });
  }

  /**
   * Partilha uma versão com outro projeto. Exige gestão da capacidade na origem; o destino só a
   * vê como proposta até um gestor desse projeto a adotar.
   */
  async share(actor: User, projectId: string, raw: unknown) {
    const input = parseInput(capabilityShareSchema, raw);
    if (input.targetProjectId === projectId)
      throw new DomainError('INVALID_INPUT', 'Escolha outro projeto como destino.', 400);
    const permission = input.kind === 'skill' ? 'skills.manage' : 'agents.manage';
    return this.db.transaction(async (client) => {
      const context = await requireProjectPermission(client, actor, projectId, permission, true);
      const exists =
        input.kind === 'skill'
          ? await client.query(
              `SELECT v.id FROM zeroops_skill_versions v JOIN zeroops_skills s ON s.id=v.skill_id
                WHERE v.skill_id=$1 AND v.project_id=$2 AND v.version=$3 AND s.archived_at IS NULL`,
              [input.capabilityId, projectId, input.version],
            )
          : await client.query(
              `SELECT v.id FROM zeroops_agent_profile_versions v JOIN zeroops_agent_profiles p ON p.id=v.profile_id
                WHERE v.profile_id=$1 AND v.project_id=$2 AND v.version=$3 AND p.archived_at IS NULL`,
              [input.capabilityId, projectId, input.version],
            );
      if (!exists.rowCount)
        throw new DomainError(
          'CAPABILITY_NOT_FOUND',
          'A capacidade ou versão não existe neste projeto.',
          404,
        );
      const target = await client.query('SELECT id FROM projects WHERE id=$1 AND NOT archived', [
        input.targetProjectId,
      ]);
      if (!target.rowCount)
        throw new DomainError('PROJECT_NOT_FOUND', 'Projeto de destino não encontrado.', 404);
      // Só se partilha com projetos a que o próprio ator tem acesso (sem revelar outros).
      await projectPermissionContext(client, actor, input.targetProjectId);
      const active = (
        await client.query<{ id: string }>(
          `SELECT id FROM zeroops_capability_shares WHERE kind=$1 AND capability_id=$2 AND version=$3
             AND source_project_id=$4 AND target_project_id=$5 AND revoked_at IS NULL FOR UPDATE`,
          [input.kind, input.capabilityId, input.version, projectId, input.targetProjectId],
        )
      ).rows[0];
      const id = active?.id ?? randomUUID();
      if (!active) {
        await client.query(
          `INSERT INTO zeroops_capability_shares(id,kind,capability_id,version,source_project_id,target_project_id,shared_by)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            input.kind,
            input.capabilityId,
            input.version,
            projectId,
            input.targetProjectId,
            context.actor.id,
          ],
        );
        await this.audit(client, context.actor.id, projectId, 'capability.shared', {
          shareId: id,
          kind: input.kind,
          capabilityId: input.capabilityId,
          version: input.version,
          targetProjectId: input.targetProjectId,
        });
      }
      return this.share_(client, id);
    });
  }

  /** Revoga a partilha (impede novas adoções; cópias já adotadas pertencem ao destino). */
  async revokeShare(actor: User, projectId: string, shareId: string) {
    return this.db.transaction(async (client) => {
      const share = await this.share_(client, shareId);
      if (share.sourceProjectId !== projectId)
        throw new DomainError('CAPABILITY_SHARE_NOT_FOUND', 'Partilha não encontrada.', 404);
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        share.kind === 'skill' ? 'skills.manage' : 'agents.manage',
        true,
      );
      await client.query(
        'UPDATE zeroops_capability_shares SET revoked_at=COALESCE(revoked_at,NOW(3)),revoked_by=COALESCE(revoked_by,$2) WHERE id=$1',
        [shareId, context.actor.id],
      );
      await this.audit(client, context.actor.id, projectId, 'capability.share_revoked', {
        shareId,
      });
      return this.share_(client, shareId);
    });
  }

  /**
   * Adota no projeto atual uma capacidade partilhada: cria uma cópia local imutável com
   * proveniência. Bindings ficam vazios e têm de ser autorizados por este projeto.
   */
  async adopt(actor: User, projectId: string, shareId: string) {
    return this.db.transaction(async (client) => {
      const locked = (
        await client.query<{ id: string }>(
          'SELECT id FROM zeroops_capability_shares WHERE id=$1 AND target_project_id=$2 FOR UPDATE',
          [shareId, projectId],
        )
      ).rows[0];
      if (!locked)
        throw new DomainError('CAPABILITY_SHARE_NOT_FOUND', 'Partilha não encontrada.', 404);
      const share = await this.share_(client, shareId);
      const context = await requireProjectPermission(
        client,
        actor,
        projectId,
        share.kind === 'skill' ? 'skills.manage' : 'agents.manage',
        true,
      );
      if (share.revokedAt)
        throw new DomainError('CAPABILITY_SHARE_REVOKED', 'A partilha foi revogada.', 409);
      const provenance: CapabilitySource = {
        kind: 'share',
        projectId: share.sourceProjectId,
        capabilityId: share.capabilityId,
        version: share.version,
      };
      let adoptedId: string;
      if (share.kind === 'skill') {
        const version = (
          await client.query<{ id: string }>(
            'SELECT id FROM zeroops_skill_versions WHERE skill_id=$1 AND project_id=$2 AND version=$3',
            [share.capabilityId, share.sourceProjectId, share.version],
          )
        ).rows[0];
        if (!version)
          throw new DomainError('CAPABILITY_NOT_FOUND', 'A versão partilhada já não existe.', 404);
        const files =
          (await skillVersionFiles(client, share.sourceProjectId, [version.id])).get(version.id) ??
          [];
        const bundle = buildSkillBundle(files.map(({ path, content }) => ({ path, content })));
        adoptedId = await this.adoptBundle(client, context.actor.id, projectId, bundle, {
          ...provenance,
          sha256: bundle.bundleHash,
        });
      } else {
        const source = await this.profiles.loadProfileVersion(
          client,
          share.sourceProjectId,
          share.capabilityId,
          share.version,
          false,
        );
        if (!source)
          throw new DomainError('CAPABILITY_NOT_FOUND', 'A versão partilhada já não existe.', 404);
        adoptedId = await this.profiles.adoptVersion(
          client,
          context.actor.id,
          projectId,
          source.definition,
          provenance,
        );
      }
      await client.query(
        'UPDATE zeroops_capability_shares SET adopted_capability_id=$2 WHERE id=$1',
        [shareId, adoptedId],
      );
      await this.audit(client, context.actor.id, projectId, 'capability.adopted', {
        shareId,
        kind: share.kind,
        sourceProjectId: share.sourceProjectId,
        capabilityId: adoptedId,
      });
      return this.share_(client, shareId);
    });
  }

  private async adoptBundle(
    client: Queryable,
    actorId: string,
    projectId: string,
    bundle: SkillBundle,
    provenance: CapabilitySource,
  ) {
    const existing = (
      await client.query<SkillRow>(
        'SELECT id,project_id,name,current_version,archived_at FROM zeroops_skills WHERE project_id=$1 AND name=$2 FOR UPDATE',
        [projectId, bundle.name],
      )
    ).rows[0];
    if (!existing) return this.insertSkill(client, actorId, projectId, bundle, provenance);
    if (existing.archived_at)
      throw new DomainError(
        'SKILL_ARCHIVED',
        `Já existe uma skill arquivada «${bundle.name}» neste projeto.`,
        409,
      );
    const current = await this.versionHash(client, existing.id, Number(existing.current_version));
    if (current !== bundle.bundleHash)
      await this.appendVersion(client, actorId, existing, bundle, provenance);
    return existing.id;
  }

  private async loadBundle(projectId: string, input: SkillImportInput) {
    if (input.source === 'upload')
      return {
        bundle: buildSkillBundle(input.files),
        provenance: { kind: 'upload' } as CapabilitySource,
      };
    const siteKey =
      (
        await this.db.query<{ site_key: string | null }>(
          'SELECT site_key FROM projects WHERE id=$1',
          [projectId],
        )
      ).rows[0]?.site_key ?? null;
    const tree = await this.repository.readSkillTree(siteKey, input.path);
    if (!tree)
      throw new DomainError(
        'SKILL_SOURCE_NOT_FOUND',
        'A skill indicada não existe no repositório autorizado deste projeto.',
        422,
      );
    const bundle = buildSkillBundle(tree.files);
    const skillFile = tree.files.find((file) => file.path === 'SKILL.md');
    return {
      bundle,
      provenance: {
        kind: 'repository',
        path: tree.path,
        siteKey,
        sha256: skillFile ? sha256(skillFile.content) : undefined,
      } as CapabilitySource,
    };
  }

  private async insertSkill(
    client: Queryable,
    actorId: string,
    projectId: string,
    bundle: SkillBundle,
    provenance: CapabilitySource,
  ) {
    const duplicate = await client.query(
      'SELECT id FROM zeroops_skills WHERE project_id=$1 AND name=$2',
      [projectId, bundle.name],
    );
    if (duplicate.rowCount)
      throw new DomainError(
        'SKILL_NAME_EXISTS',
        `Já existe a skill «${bundle.name}» neste projeto; publique uma nova versão.`,
        409,
      );
    const id = randomUUID();
    await client.query(
      'INSERT INTO zeroops_skills(id,project_id,name,current_version,created_by) VALUES($1,$2,$3,1,$4)',
      [id, projectId, bundle.name, actorId],
    );
    await this.insertVersion(client, actorId, id, projectId, 1, bundle, provenance);
    return id;
  }

  private async appendVersion(
    client: Queryable,
    actorId: string,
    skill: SkillRow,
    bundle: SkillBundle,
    provenance: CapabilitySource,
  ) {
    if (skill.archived_at) throw new DomainError('SKILL_ARCHIVED', 'A skill está arquivada.', 409);
    const version = Number(skill.current_version) + 1;
    await this.insertVersion(
      client,
      actorId,
      skill.id,
      skill.project_id,
      version,
      bundle,
      provenance,
    );
    await client.query(
      'UPDATE zeroops_skills SET current_version=$2,updated_at=NOW(3) WHERE id=$1',
      [skill.id, version],
    );
    return version;
  }

  private async insertVersion(
    client: Queryable,
    actorId: string,
    skillId: string,
    projectId: string,
    version: number,
    bundle: SkillBundle,
    provenance: CapabilitySource,
  ) {
    const versionId = randomUUID();
    await client.query(
      `INSERT INTO zeroops_skill_versions(id,skill_id,project_id,version,description,bundle_hash,manifest,provenance,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        versionId,
        skillId,
        projectId,
        version,
        bundle.description,
        bundle.bundleHash,
        JSON.stringify(bundle.manifest),
        JSON.stringify(provenance),
        actorId,
      ],
    );
    for (const file of bundle.files)
      await client.query(
        'INSERT INTO zeroops_skill_version_files(version_id,path,sha256,size,content) VALUES($1,$2,$3,$4,$5)',
        [versionId, file.path, file.sha256, file.size, file.content],
      );
  }

  private async versionHash(client: Queryable, skillId: string, version: number) {
    return (
      (
        await client.query<{ bundle_hash: string }>(
          'SELECT bundle_hash FROM zeroops_skill_versions WHERE skill_id=$1 AND version=$2',
          [skillId, version],
        )
      ).rows[0]?.bundle_hash ?? null
    );
  }

  private async lock(client: Queryable, projectId: string, skillId: string) {
    const row = (
      await client.query<SkillRow>(
        'SELECT id,project_id,name,current_version,archived_at FROM zeroops_skills WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [skillId, projectId],
      )
    ).rows[0];
    if (!row) throw new DomainError('SKILL_NOT_FOUND', 'Skill não encontrada.', 404);
    return row;
  }

  private async get(client: Queryable, projectId: string, skillId: string) {
    const row = (
      await client.query<SkillRow>(
        'SELECT id,project_id,name,current_version,archived_at FROM zeroops_skills WHERE id=$1 AND project_id=$2',
        [skillId, projectId],
      )
    ).rows[0];
    if (!row) throw new DomainError('SKILL_NOT_FOUND', 'Skill não encontrada.', 404);
    return this.view(client, row);
  }

  private async view(client: Queryable, row: SkillRow): Promise<SkillView> {
    const versions = await client.query<{
      id: string;
      version: number;
      description: string;
      bundle_hash: string;
      skill_manifest: unknown;
      provenance: unknown;
      created_at: Date;
      created_by: string | null;
      author: string | null;
    }>(
      `SELECT v.id,v.version,v.description,v.bundle_hash,v.manifest AS skill_manifest,v.provenance,
              v.created_at,v.created_by,u.display_name AS author
         FROM zeroops_skill_versions v LEFT JOIN users u ON u.id=v.created_by
        WHERE v.skill_id=$1 ORDER BY v.version DESC LIMIT 20`,
      [row.id],
    );
    const bindings = await client.query<{ tool_key: string }>(
      'SELECT tool_key FROM zeroops_skill_bindings WHERE project_id=$1 AND skill_id=$2 ORDER BY tool_key',
      [row.project_id, row.id],
    );
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      currentVersion: Number(row.current_version),
      archivedAt: row.archived_at?.toISOString() ?? null,
      boundTools: bindings.rows.map((item) => item.tool_key),
      versions: versions.rows
        .map((version) => ({
          id: version.id,
          version: Number(version.version),
          description: version.description,
          bundleHash: version.bundle_hash,
          manifest: parseJson<SkillVersionManifest>(version.skill_manifest),
          source: parseJson<CapabilitySource>(version.provenance),
          createdAt: version.created_at.toISOString(),
          createdBy: version.author ?? version.created_by,
        }))
        .sort((left, right) => left.version - right.version),
    };
  }

  private async share_(client: Queryable, shareId: string): Promise<CapabilityShareView> {
    const row = (
      await client.query<ShareRow>(
        `SELECT s.id,s.kind,s.capability_id,s.version,s.source_project_id,p.name AS source_project_name,
                s.target_project_id,s.created_at,s.revoked_at,s.adopted_capability_id,
                COALESCE(k.name,a.name) AS capability_name
           FROM zeroops_capability_shares s
           JOIN projects p ON p.id=s.source_project_id
           LEFT JOIN zeroops_skills k ON s.kind='skill' AND k.id=s.capability_id
           LEFT JOIN zeroops_agent_profiles a ON s.kind='agent' AND a.id=s.capability_id
          WHERE s.id=$1`,
        [shareId],
      )
    ).rows[0];
    if (!row) throw new DomainError('CAPABILITY_SHARE_NOT_FOUND', 'Partilha não encontrada.', 404);
    return shareView(row);
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

function shareView(row: ShareRow): CapabilityShareView {
  return {
    id: row.id,
    kind: row.kind,
    capabilityId: row.capability_id,
    name: row.capability_name ?? '—',
    version: Number(row.version),
    sourceProjectId: row.source_project_id,
    sourceProjectName: row.source_project_name,
    targetProjectId: row.target_project_id,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    adoptedCapabilityId: row.adopted_capability_id,
  };
}
