import { useState, type ChangeEvent } from 'react';
import {
  copilotToolKeys,
  type AgentProfile,
  type CapabilityCatalogView,
  type CapabilityShareView,
  type CapabilitySource,
  type ProjectAccess,
  type ProjectPermissionAccess,
  type RepositoryResourceCatalog,
  type SkillView,
} from '@zeroops/contracts';
import { Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import {
  ProjectAdminProvider,
  useProjectPermission,
  useProjectSession,
} from '../../lib/project-admin';

export const CAPABILITIES_ROUTE = 'capabilities';

type UploadFile = { path: string; content: string };

/** Lê os ficheiros escolhidos; numa pasta, os caminhos ficam relativos à pasta da skill. */
async function readUpload(list: FileList | null): Promise<UploadFile[]> {
  const files = Array.from(list ?? []);
  return Promise.all(
    files.map(async (file) => {
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      const path = relative ? relative.split('/').slice(1).join('/') : file.name;
      return { path, content: await file.text() };
    }),
  );
}

function SourceLabel({ source }: { source: CapabilitySource | null | undefined }) {
  const { t } = useIdentityLocale();
  if (!source) return <span className="muted">{t('criado no ZeroOps', 'created in ZeroOps')}</span>;
  const origin =
    source.kind === 'repository'
      ? t('repositório', 'repository')
      : source.kind === 'upload'
        ? t('envio', 'upload')
        : t('partilha', 'share');
  return (
    <span className="muted">
      {origin}
      {source.path ? ` · ${source.path}` : ''}
      {source.kind === 'share' && source.version ? ` · v${source.version}` : ''}
    </span>
  );
}

/** Catálogo de capacidades (skills e agentes) do projeto ativo. */
export function CapabilitiesPage({ projectId }: { projectId: string }) {
  const { t } = useIdentityLocale();
  const resource = useResource<ProjectPermissionAccess>(
    `/projects/${encodeURIComponent(projectId)}/access`,
    15000,
  );
  const access = resource.data;
  const project = access?.project;
  return (
    <div className="stack">
      <PageHeader
        title={t('Agentes e skills', 'Agents and skills')}
        description={t(
          'Capacidades versionadas do projeto: importação, versões imutáveis, ferramentas autorizadas e partilha explícita entre projetos.',
          'Versioned project capabilities: import, immutable versions, authorized tools and explicit sharing between projects.',
        )}
      />
      {resource.loading ? (
        <Loading label={t('A carregar projeto…', 'Loading project…')} />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : !project || project.id !== projectId || !access.permissions.includes('flows.view') ? (
        <Notice>{t('Projeto indisponível.', 'Project unavailable.')}</Notice>
      ) : (
        <ProjectAdminProvider key={project.id} project={project} permissions={access.permissions}>
          <CapabilityCatalog projectId={project.id} />
        </ProjectAdminProvider>
      )}
    </div>
  );
}

function CapabilityCatalog({ projectId }: { projectId: string }) {
  const { t } = useIdentityLocale();
  const { request } = useProjectSession();
  const canManageSkills = useProjectPermission('skills.manage');
  const canManageAgents = useProjectPermission('agents.manage');
  const catalog = useResource<CapabilityCatalogView>('/skills');
  const profiles = useResource<AgentProfile[]>('/agent-profiles');
  const resources = useResource<RepositoryResourceCatalog>('/agent-profiles/repository-resources');
  const projects = useResource<ProjectAccess[]>('/projects');
  const mutation = useMutation();
  const [notice, setNotice] = useState<string | null>(null);
  const reload = () => {
    catalog.reload();
    profiles.reload();
  };
  const run = (operation: () => Promise<unknown>, done: string) =>
    mutation.run(async () => {
      setNotice(null);
      await operation();
      setNotice(done);
      reload();
    });
  const repositorySkills = (resources.data?.resources ?? []).filter(
    (item) => item.kind === 'skill',
  );
  const repositoryAgents = (resources.data?.resources ?? []).filter(
    (item) => item.kind === 'agent',
  );
  const targets = (projects.data ?? []).filter((item) => item.id !== projectId);

  const importSkillRepository = (path: string) =>
    run(
      () => request('/skills/import', { method: 'POST', body: { source: 'repository', path } }),
      t('Skill importada.', 'Skill imported.'),
    );
  const importSkillUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = await readUpload(event.target.files);
    event.target.value = '';
    if (files.length)
      await run(
        () => request('/skills/import', { method: 'POST', body: { source: 'upload', files } }),
        t('Skill importada.', 'Skill imported.'),
      );
  };
  const importAgentRepository = (path: string) =>
    run(
      () =>
        request('/agent-profiles/import', { method: 'POST', body: { source: 'repository', path } }),
      t('Agente importado como perfil.', 'Agent imported as a profile.'),
    );
  const importAgentUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const [file] = await readUpload(event.target.files);
    event.target.value = '';
    if (file)
      await run(
        () =>
          request('/agent-profiles/import', {
            method: 'POST',
            body: { source: 'upload', content: file.content, fileName: file.path },
          }),
        t('Agente importado como perfil.', 'Agent imported as a profile.'),
      );
  };

  if (catalog.loading && !catalog.data)
    return <Loading label={t('A carregar catálogo…', 'Loading catalog…')} />;
  if (catalog.error) return <ResourceError error={catalog.error} retry={catalog.reload} />;
  const data = catalog.data ?? { skills: [], incoming: [], outgoing: [] };

  return (
    <div className="stack capability-catalog">
      {notice && <Notice tone="success">{notice}</Notice>}
      {mutation.error && <Notice tone="warning">{mutation.error}</Notice>}

      <section className="panel stack" aria-labelledby="capability-skills">
        <h2 id="capability-skills">{t('Skills', 'Skills')}</h2>
        <p className="muted">
          {t(
            'Cada importação ou edição cria uma versão nova e imutável (hash SHA-256 do bundle). As skills não concedem ferramentas: só as autorizadas aqui e no perfil da etapa ficam disponíveis.',
            'Each import or edit creates a new immutable version (bundle SHA-256). Skills grant no tools: only those authorized here and in the step profile are available.',
          )}
        </p>
        {data.skills.length ? (
          data.skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              canManage={canManageSkills}
              busy={mutation.busy}
              targets={targets}
              run={run}
              repositorySkills={repositorySkills.map((item) => item.path)}
            />
          ))
        ) : (
          <p className="muted">{t('Ainda não há skills.', 'No skills yet.')}</p>
        )}
        {canManageSkills && (
          <fieldset className="flow-fieldset" disabled={mutation.busy}>
            <legend>{t('Importar skill', 'Import skill')}</legend>
            {repositorySkills.length ? (
              <label>
                {t('Do repositório do projeto', 'From the project repository')}
                <select
                  value=""
                  onChange={(event) =>
                    event.target.value && void importSkillRepository(event.target.value)
                  }
                >
                  <option value="">{t('Escolher SKILL.md…', 'Choose SKILL.md…')}</option>
                  {repositorySkills.map((item) => (
                    <option key={item.path} value={item.path}>
                      {item.name} · {item.path}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              {t(
                'Enviar pasta da skill (SKILL.md, scripts, referências)',
                'Upload skill folder (SKILL.md, scripts, references)',
              )}
              <input
                type="file"
                multiple
                {...({ webkitdirectory: '' } as Record<string, string>)}
                onChange={(event) => void importSkillUpload(event)}
              />
            </label>
          </fieldset>
        )}
      </section>

      <section className="panel stack" aria-labelledby="capability-agents">
        <h2 id="capability-agents">{t('Agentes', 'Agents')}</h2>
        <p className="muted">
          {t(
            'Agentes são perfis versionados (missão, instruções, contrato, critérios, modelo e ferramentas). Usam-se como agente da etapa ou como especialista delegável.',
            'Agents are versioned profiles (mission, instructions, contract, criteria, model and tools). They serve as the step agent or as a delegable specialist.',
          )}
        </p>
        {(profiles.data ?? []).map((profile) => {
          const current = profile.versions.find((item) => item.version === profile.currentVersion);
          return (
            <div key={profile.id} className="flow-port-row">
              <span>
                <strong>{current?.definition.name ?? profile.id}</strong> · v
                {profile.currentVersion}
                {profile.archivedAt ? ` · ${t('arquivado', 'archived')}` : ''}
                <br />
                <SourceLabel source={current?.source} />
                <br />
                <span className="muted">
                  {t('Modos', 'Modes')}: {current?.definition.modes.join(', ')} ·{' '}
                  {t('Ferramentas', 'Tools')}:{' '}
                  {current?.definition.allowedTools.join(', ') || t('nenhuma', 'none')}
                </span>
              </span>
              {canManageAgents && !profile.archivedAt && targets.length > 0 && (
                <ShareControl
                  kind="agent"
                  capabilityId={profile.id}
                  version={profile.currentVersion}
                  targets={targets}
                  busy={mutation.busy}
                  run={run}
                />
              )}
            </div>
          );
        })}
        {canManageAgents && (
          <fieldset className="flow-fieldset" disabled={mutation.busy}>
            <legend>{t('Importar .agent.md', 'Import .agent.md')}</legend>
            {repositoryAgents.length ? (
              <label>
                {t('Do repositório do projeto', 'From the project repository')}
                <select
                  value=""
                  onChange={(event) =>
                    event.target.value && void importAgentRepository(event.target.value)
                  }
                >
                  <option value="">{t('Escolher agente…', 'Choose agent…')}</option>
                  {repositoryAgents.map((item) => (
                    <option key={item.path} value={item.path}>
                      {item.name} · {item.path}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              {t('Enviar ficheiro .agent.md', 'Upload .agent.md file')}
              <input type="file" accept=".md" onChange={(event) => void importAgentUpload(event)} />
            </label>
          </fieldset>
        )}
      </section>

      <section className="panel stack" aria-labelledby="capability-shares">
        <h2 id="capability-shares">{t('Partilhas', 'Sharing')}</h2>
        <p className="muted">
          {t(
            'Partilhar transfere apenas o conteúdo de uma versão. Credenciais, conversas, bindings de ferramentas e acesso aos recursos do projeto de origem nunca são transferidos.',
            'Sharing transfers only the content of one version. Credentials, conversations, tool bindings and access to the source project resources are never transferred.',
          )}
        </p>
        <h3>{t('Recebidas', 'Received')}</h3>
        {data.incoming.length ? (
          data.incoming.map((share) => (
            <ShareRow
              key={share.id}
              share={share}
              action={
                !share.revokedAt &&
                !share.adoptedCapabilityId &&
                (share.kind === 'skill' ? canManageSkills : canManageAgents)
                  ? {
                      label: t('Adotar neste projeto', 'Adopt in this project'),
                      onClick: () =>
                        void run(
                          () =>
                            request(`/capability-shares/${encodeURIComponent(share.id)}/adopt`, {
                              method: 'POST',
                            }),
                          t('Capacidade adotada.', 'Capability adopted.'),
                        ),
                    }
                  : null
              }
              busy={mutation.busy}
            />
          ))
        ) : (
          <p className="muted">{t('Sem partilhas recebidas.', 'No received shares.')}</p>
        )}
        <h3>{t('Emitidas', 'Sent')}</h3>
        {data.outgoing.length ? (
          data.outgoing.map((share) => (
            <ShareRow
              key={share.id}
              share={share}
              target={projects.data?.find((item) => item.id === share.targetProjectId)?.name}
              action={
                !share.revokedAt && (share.kind === 'skill' ? canManageSkills : canManageAgents)
                  ? {
                      label: t('Revogar', 'Revoke'),
                      onClick: () =>
                        void run(
                          () =>
                            request(`/capability-shares/${encodeURIComponent(share.id)}/revoke`, {
                              method: 'POST',
                            }),
                          t('Partilha revogada.', 'Share revoked.'),
                        ),
                    }
                  : null
              }
              busy={mutation.busy}
            />
          ))
        ) : (
          <p className="muted">{t('Sem partilhas emitidas.', 'No sent shares.')}</p>
        )}
      </section>
    </div>
  );
}

function ShareRow({
  share,
  target,
  action,
  busy,
}: {
  share: CapabilityShareView;
  target?: string | undefined;
  action: { label: string; onClick: () => void } | null;
  busy: boolean;
}) {
  const { t } = useIdentityLocale();
  const state = share.revokedAt
    ? t('revogada', 'revoked')
    : share.adoptedCapabilityId
      ? t('adotada', 'adopted')
      : t('por adotar', 'pending adoption');
  return (
    <div className="flow-port-row">
      <span>
        <strong>{share.name}</strong> · {share.kind === 'skill' ? 'skill' : t('agente', 'agent')} ·
        v{share.version} · {state}
        <br />
        <span className="muted">
          {target
            ? `${t('Para', 'To')} ${target}`
            : `${t('De', 'From')} ${share.sourceProjectName}`}
        </span>
      </span>
      {action && (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function ShareControl({
  kind,
  capabilityId,
  version,
  targets,
  busy,
  run,
}: {
  kind: 'skill' | 'agent';
  capabilityId: string;
  version: number;
  targets: ProjectAccess[];
  busy: boolean;
  run: (operation: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const { t } = useIdentityLocale();
  const { request } = useProjectSession();
  return (
    <label>
      {t('Partilhar v', 'Share v')}
      {version} {t('com', 'with')}
      <select
        value=""
        disabled={busy}
        onChange={(event) => {
          const targetProjectId = event.target.value;
          if (targetProjectId)
            void run(
              () =>
                request('/capability-shares', {
                  method: 'POST',
                  body: { kind, capabilityId, version, targetProjectId },
                }),
              t('Partilha criada.', 'Share created.'),
            );
        }}
      >
        <option value="">{t('Escolher projeto…', 'Choose project…')}</option>
        {targets.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function SkillCard({
  skill,
  canManage,
  busy,
  targets,
  run,
  repositorySkills,
}: {
  skill: SkillView;
  canManage: boolean;
  busy: boolean;
  targets: ProjectAccess[];
  run: (operation: () => Promise<unknown>, done: string) => Promise<void>;
  repositorySkills: string[];
}) {
  const { t } = useIdentityLocale();
  const { request } = useProjectSession();
  const [tools, setTools] = useState<string[]>(skill.boundTools);
  const current = skill.versions.find((item) => item.version === skill.currentVersion);
  const required = current?.manifest.requires.tools ?? [];
  const missing = required.filter((tool) => !skill.boundTools.includes(tool));
  const path = `/skills/${encodeURIComponent(skill.id)}`;
  const newVersion = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = await readUpload(event.target.files);
    event.target.value = '';
    if (files.length)
      await run(
        () =>
          request(`${path}/versions`, {
            method: 'POST',
            body: {
              expectedVersion: skill.currentVersion,
              import: { source: 'upload', files },
            },
          }),
        t('Nova versão criada.', 'New version created.'),
      );
  };
  const sourcePath = current?.source.kind === 'repository' ? current.source.path : undefined;
  return (
    <article className="flow-fieldset stack">
      <div className="flow-port-row">
        <span>
          <strong>{skill.name}</strong> · v{skill.currentVersion}
          {skill.archivedAt ? ` · ${t('arquivada', 'archived')}` : ''}
          <br />
          <span className="muted">{current?.description}</span>
          <br />
          <SourceLabel source={current?.source} /> ·{' '}
          <code>sha256 {current?.bundleHash.slice(0, 12)}</code> ·{' '}
          {current?.manifest.files.length ?? 0} {t('ficheiros', 'files')}
        </span>
      </div>
      <p className="muted">
        {t('Requer ferramentas', 'Requires tools')}: {required.join(', ') || t('nenhuma', 'none')}
        {current?.manifest.requires.skills.length
          ? ` · ${t('Requer skills', 'Requires skills')}: ${current.manifest.requires.skills.join(', ')}`
          : ''}
        {current?.manifest.compatibility
          ? ` · ${t('Modos', 'Modes')}: ${current.manifest.compatibility.modes.join(', ')}`
          : ''}
      </p>
      {missing.length > 0 && (
        <Notice tone="warning">
          {t(
            `Indisponível em etapas até autorizar: ${missing.join(', ')}.`,
            `Unavailable in steps until authorized: ${missing.join(', ')}.`,
          )}
        </Notice>
      )}
      <details>
        <summary>{t('Versões', 'Versions')}</summary>
        <ul>
          {skill.versions.map((version) => (
            <li key={version.id}>
              v{version.version} · <code>{version.bundleHash.slice(0, 12)}</code> ·{' '}
              {new Date(version.createdAt).toLocaleString()} ·{' '}
              <SourceLabel source={version.source} />
            </li>
          ))}
        </ul>
      </details>
      {canManage && !skill.archivedAt && (
        <fieldset className="flow-fieldset" disabled={busy}>
          <legend>
            {t('Ferramentas autorizadas neste projeto', 'Tools authorized in this project')}
          </legend>
          {copilotToolKeys.map((tool) => (
            <label key={tool} className="checkbox-row">
              <input
                type="checkbox"
                checked={tools.includes(tool)}
                onChange={(event) =>
                  setTools((list) =>
                    event.target.checked ? [...list, tool] : list.filter((item) => item !== tool),
                  )
                }
              />
              {tool}
            </label>
          ))}
          <div className="flow-config-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() =>
                void run(
                  () => request(`${path}/bindings`, { method: 'POST', body: { tools } }),
                  t('Ferramentas atualizadas.', 'Tools updated.'),
                )
              }
            >
              {t('Guardar ferramentas', 'Save tools')}
            </button>
            {sourcePath && repositorySkills.includes(sourcePath) && (
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  void run(
                    () =>
                      request(`${path}/versions`, {
                        method: 'POST',
                        body: {
                          expectedVersion: skill.currentVersion,
                          import: { source: 'repository', path: sourcePath },
                        },
                      }),
                    t('Versão sincronizada com o repositório.', 'Version synced from repository.'),
                  )
                }
              >
                {t('Nova versão do repositório', 'New version from repository')}
              </button>
            )}
            <button
              type="button"
              className="button button-secondary"
              onClick={() =>
                void run(
                  () => request(`${path}/archive`, { method: 'POST' }),
                  t('Skill arquivada.', 'Skill archived.'),
                )
              }
            >
              {t('Arquivar', 'Archive')}
            </button>
          </div>
          <label>
            {t('Nova versão por envio (pasta)', 'New version by upload (folder)')}
            <input
              type="file"
              multiple
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(event) => void newVersion(event)}
            />
          </label>
          {targets.length > 0 && (
            <ShareControl
              kind="skill"
              capabilityId={skill.id}
              version={skill.currentVersion}
              targets={targets}
              busy={busy}
              run={run}
            />
          )}
        </fieldset>
      )}
    </article>
  );
}
