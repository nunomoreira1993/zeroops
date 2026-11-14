import { useEffect, useMemo, useState } from 'react';
import {
  agentProfileModes,
  copilotToolKeys,
  type AgentProfile,
  type AgentProfileDefinition,
  type RepositoryResource,
  type RepositoryResourceCatalog,
  type RepositoryResourceReference,
} from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectSession } from '../../lib/project-admin';
import type { FlowNode } from '@zeroops/contracts';

const blankProfile = (): AgentProfileDefinition => ({
  name: '',
  description: '',
  mission: '',
  expectedInputs: [],
  expectedOutput: '',
  completionCriteria: [],
  modes: ['analysis'],
  allowedTools: [],
  model: null,
  fusionTier: null,
  reasoningEffort: null,
});

function listValue(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function kindLabel(kind: RepositoryResource['kind'], en: boolean) {
  if (kind === 'agent') return en ? 'Repository agent' : 'Agente do repositório';
  if (kind === 'skill') return en ? 'Repository skill' : 'Skill do repositório';
  return en ? 'Project instructions' : 'Instruções do projeto';
}

/** Perfil de missão editável no ZeroOps; os agentes e skills técnicos são referências read-only. */
export function AgentProfileStepConfig({
  node,
  setConfigValues,
}: {
  node: FlowNode;
  setConfigValues: (changes: Record<string, unknown>) => void;
}) {
  const { locale, t } = useIdentityLocale();
  const en = locale === 'en';
  const { request } = useProjectSession();
  const profiles = useResource<AgentProfile[]>('/agent-profiles');
  const resources = useResource<RepositoryResourceCatalog>('/agent-profiles/repository-resources');
  const mutation = useMutation();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentProfileDefinition | null>(null);
  const profileId =
    typeof node.config.agentProfileId === 'string' ? node.config.agentProfileId : '';
  const profileVersion = Number(node.config.agentProfileVersion) || 0;
  const profile = profiles.data?.find((item) => item.id === profileId) ?? null;
  const version =
    profile?.versions.find((item) => item.version === profileVersion) ??
    profile?.versions.find((item) => item.version === profile.currentVersion) ??
    null;
  const selectedResources = useMemo(() => {
    const raw = node.config.repositoryResources;
    return Array.isArray(raw)
      ? raw.filter(
          (item): item is RepositoryResourceReference =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { path?: unknown }).path === 'string' &&
            typeof (item as { required?: unknown }).required === 'boolean',
        )
      : [];
  }, [node.config.repositoryResources]);
  const knownPaths = new Set((resources.data?.resources ?? []).map((item) => item.path));
  const missingPaths = selectedResources.filter((item) => !knownPaths.has(item.path));

  useEffect(() => {
    if (!editing) {
      setDraft(null);
      return;
    }
    if (editing === 'new') {
      setDraft(blankProfile());
      return;
    }
    const selected = profiles.data?.find((item) => item.id === editing);
    const current = selected?.versions.find((item) => item.version === selected.currentVersion);
    setDraft(current ? structuredClone(current.definition) : null);
  }, [editing, profiles.data]);

  const chooseProfile = (id: string) => {
    const selected = profiles.data?.find((item) => item.id === id);
    setConfigValues({
      agentProfileId: selected?.id,
      agentProfileVersion: selected?.currentVersion,
    });
  };
  const setResources = (next: RepositoryResourceReference[]) =>
    setConfigValues({ repositoryResources: next.length ? next : undefined });
  const toggleResource = (resource: RepositoryResource, checked: boolean) => {
    const current = selectedResources.filter((item) => item.path !== resource.path);
    setResources(checked ? [...current, { path: resource.path, required: false }] : current);
  };
  const setRequired = (path: string, required: boolean) =>
    setResources(
      selectedResources.map((item) => (item.path === path ? { ...item, required } : item)),
    );

  const saveProfile = () =>
    mutation.run(async () => {
      if (!draft) return;
      const saved =
        editing === 'new'
          ? await request<AgentProfile>('/agent-profiles', { method: 'POST', body: draft })
          : await request<AgentProfile>(
              `/agent-profiles/${encodeURIComponent(editing!)}/versions`,
              {
                method: 'POST',
                body: {
                  expectedVersion: profile?.currentVersion,
                  definition: draft,
                },
              },
            );
      setConfigValues({
        agentProfileId: saved.id,
        agentProfileVersion: saved.currentVersion,
      });
      setEditing(null);
      setDraft(null);
      profiles.reload();
    });

  const archiveProfile = () =>
    mutation.run(async () => {
      if (!profile) return;
      await request(`/agent-profiles/${encodeURIComponent(profile.id)}/archive`, {
        method: 'POST',
      });
      setConfigValues({ agentProfileId: undefined, agentProfileVersion: undefined });
      setEditing(null);
      profiles.reload();
    });

  const updateDraft = <K extends keyof AgentProfileDefinition>(
    key: K,
    value: AgentProfileDefinition[K],
  ) => setDraft((current) => (current ? { ...current, [key]: value } : current));

  return (
    <div className="stack">
      <fieldset className="flow-fieldset">
        <legend>{t('Agente ZeroOps', 'ZeroOps agent')}</legend>
        <p className="muted">
          {t(
            'Define missão, saída e limites de ferramentas. Não duplica regras técnicas do repositório.',
            'Defines mission, output and tool limits. It does not duplicate repository instructions.',
          )}
        </p>
        <label>
          {t('Perfil de execução', 'Execution profile')}
          <select value={profileId} onChange={(event) => chooseProfile(event.target.value)}>
            <option value="">
              {t('Legado — configuração existente', 'Legacy — existing configuration')}
            </option>
            {(profiles.data ?? [])
              .filter((item) => !item.archivedAt || item.id === profileId)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.versions.find((entry) => entry.version === item.currentVersion)?.definition
                    .name ?? item.id}
                  {item.archivedAt ? ` (${t('arquivado', 'archived')})` : ''}
                </option>
              ))}
          </select>
        </label>
        {profile && (
          <>
            <label>
              {t('Versão fixada no fluxo', 'Version pinned to this flow')}
              <select
                value={profileVersion}
                onChange={(event) =>
                  setConfigValues({ agentProfileVersion: Number(event.target.value) })
                }
              >
                {profile.versions.map((item) => (
                  <option key={item.version} value={item.version}>
                    v{item.version}
                    {item.version === profile.currentVersion ? ` · ${t('atual', 'current')}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {version && (
              <div className="muted">
                <strong>
                  {version.definition.name} · v{version.version}
                </strong>
                <p>{version.definition.mission}</p>
                <p>
                  {t('Saída esperada', 'Expected output')}: {version.definition.expectedOutput}
                </p>
                {!version.definition.modes.includes(
                  String(node.config.mode || 'analysis') as (typeof agentProfileModes)[number],
                ) && (
                  <p role="alert">
                    {t(
                      'O perfil não suporta o modo escolhido nesta etapa.',
                      'The profile does not support this step mode.',
                    )}
                  </p>
                )}
              </div>
            )}
            {!profile.archivedAt && (
              <div className="flow-config-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setEditing(profile.id)}
                >
                  {t('Criar nova versão', 'Create new version')}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={mutation.busy}
                  onClick={() => void archiveProfile()}
                >
                  {t('Arquivar perfil', 'Archive profile')}
                </button>
              </div>
            )}
          </>
        )}
        {!profiles.data?.length && profiles.loading && (
          <p className="muted">{t('A carregar perfis…', 'Loading profiles…')}</p>
        )}
        {profiles.error && <Notice tone="warning">{profiles.error}</Notice>}
        {!editing && (
          <button
            type="button"
            className="button button-secondary align-start"
            onClick={() => setEditing('new')}
          >
            {t('Criar perfil', 'Create profile')}
          </button>
        )}
        {editing && draft && (
          <div className="stack">
            <label>
              {t('Nome', 'Name')}
              <input
                value={draft.name}
                maxLength={80}
                onChange={(event) => updateDraft('name', event.target.value)}
              />
            </label>
            <label>
              {t('Descrição', 'Description')}
              <input
                value={draft.description}
                maxLength={500}
                onChange={(event) => updateDraft('description', event.target.value)}
              />
            </label>
            <label>
              {t('Missão', 'Mission')}
              <textarea
                rows={4}
                maxLength={4000}
                value={draft.mission}
                onChange={(event) => updateDraft('mission', event.target.value)}
              />
            </label>
            <label>
              {t('Entradas esperadas (uma por linha)', 'Expected inputs (one per line)')}
              <textarea
                rows={3}
                value={draft.expectedInputs.join('\n')}
                onChange={(event) => updateDraft('expectedInputs', listValue(event.target.value))}
              />
            </label>
            <label>
              {t('Saída esperada', 'Expected output')}
              <textarea
                rows={3}
                value={draft.expectedOutput}
                onChange={(event) => updateDraft('expectedOutput', event.target.value)}
              />
            </label>
            <label>
              {t('Critérios de conclusão (um por linha)', 'Completion criteria (one per line)')}
              <textarea
                rows={3}
                value={draft.completionCriteria.join('\n')}
                onChange={(event) =>
                  updateDraft('completionCriteria', listValue(event.target.value))
                }
              />
            </label>
            <fieldset className="flow-fieldset">
              <legend>{t('Modos de etapa suportados', 'Supported step modes')}</legend>
              {agentProfileModes.map((mode) => (
                <label key={mode} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={draft.modes.includes(mode)}
                    onChange={(event) =>
                      updateDraft(
                        'modes',
                        event.target.checked
                          ? [...draft.modes, mode]
                          : draft.modes.filter((item) => item !== mode),
                      )
                    }
                  />
                  {mode}
                </label>
              ))}
            </fieldset>
            <fieldset className="flow-fieldset">
              <legend>
                {t('Ferramentas de conector permitidas', 'Permitted connector tools')}
              </legend>
              {copilotToolKeys.map((tool) => (
                <label key={tool} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={draft.allowedTools.includes(tool)}
                    onChange={(event) =>
                      updateDraft(
                        'allowedTools',
                        event.target.checked
                          ? [...draft.allowedTools, tool]
                          : draft.allowedTools.filter((item) => item !== tool),
                      )
                    }
                  />
                  {tool}
                </label>
              ))}
            </fieldset>
            <label>
              {t(
                'Modelo pedido (vazio = predefinição do projeto)',
                'Requested model (empty = project default)',
              )}
              <input
                maxLength={100}
                placeholder="auto / fusion / model-id"
                value={draft.model ?? ''}
                onChange={(event) => updateDraft('model', event.target.value || null)}
              />
            </label>
            {draft.model === 'fusion' ? (
              <label>
                {t('Nível Fusion', 'Fusion tier')}
                <select
                  value={draft.fusionTier ?? ''}
                  onChange={(event) =>
                    updateDraft(
                      'fusionTier',
                      (event.target.value || null) as AgentProfileDefinition['fusionTier'],
                    )
                  }
                >
                  <option value="">{t('Escolher nível', 'Choose tier')}</option>
                  <option value="standard">Standard</option>
                  <option value="high">High</option>
                  <option value="max">Max</option>
                </select>
              </label>
            ) : (
              <label>
                {t('Esforço de raciocínio', 'Reasoning effort')}
                <select
                  value={draft.reasoningEffort ?? ''}
                  onChange={(event) => updateDraft('reasoningEffort', event.target.value || null)}
                >
                  <option value="">{t('Por omissão', 'Default')}</option>
                  {['low', 'medium', 'high', 'xhigh'].map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {mutation.error && <Notice tone="warning">{mutation.error}</Notice>}
            <div className="flow-config-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={mutation.busy}
                onClick={() => void saveProfile()}
              >
                {t('Guardar versão', 'Save version')}
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setEditing(null)}
              >
                {t('Cancelar', 'Cancel')}
              </button>
            </div>
          </div>
        )}
      </fieldset>

      <fieldset className="flow-fieldset">
        <legend>
          {t('Agentes técnicos e skills do repositório', 'Repository agents and skills')}
        </legend>
        <p className="muted">
          {t(
            'As instruções globais são sempre aplicadas. Até três instruções/agentes/skills adicionais são escolhidos por relevância em cada etapa; podes também fixar referências explícitas. O SHA-256 identifica conteúdos, não uma revisão SVN.',
            'Global instructions always apply. Up to three additional instructions/agents/skills are selected by relevance per step; you can also pin explicit references. SHA-256 identifies content, not an SVN revision.',
          )}
        </p>
        {resources.data?.available ? (
          <>
            {(resources.data.resources ?? []).map((resource) => {
              const reference = selectedResources.find((item) => item.path === resource.path);
              const globalInstruction = Boolean(resource.globalInstruction);
              return (
                <div key={resource.path} className="flow-port-row">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={globalInstruction || Boolean(reference)}
                      disabled={globalInstruction}
                      onChange={(event) => toggleResource(resource, event.target.checked)}
                    />
                    <span>
                      <strong>{resource.name}</strong> · {kindLabel(resource.kind, en)}
                      {globalInstruction ? ` · ${t('aplicada sempre', 'always applied')}` : ''}
                      <br />
                      <code>{resource.path}</code> · sha256 {resource.sha256.slice(0, 12)}
                      {resource.description ? <br /> : null}
                      <span className="muted">{resource.description}</span>
                    </span>
                  </label>
                  {reference && !globalInstruction && (
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={reference.required}
                        onChange={(event) => setRequired(resource.path, event.target.checked)}
                      />
                      {t('Obrigatório', 'Mandatory')}
                    </label>
                  )}
                </div>
              );
            })}
            {missingPaths.map((reference) => (
              <div key={reference.path} className="flow-port-row">
                <span role="alert">
                  {reference.path} · {t('não encontrado', 'not found')}
                </span>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={reference.required}
                    onChange={(event) => setRequired(reference.path, event.target.checked)}
                  />
                  {t('Obrigatório', 'Mandatory')}
                </label>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() =>
                    setResources(selectedResources.filter((item) => item.path !== reference.path))
                  }
                >
                  {t('Remover', 'Remove')}
                </button>
              </div>
            ))}
            {!resources.data.resources.length && (
              <p className="muted">
                {t(
                  'O repositório não contém agentes ou skills suportados.',
                  'No supported repository agents or skills were found.',
                )}
              </p>
            )}
          </>
        ) : (
          <Notice tone="warning">
            {resources.data?.reason === 'site_not_linked'
              ? t(
                  'Este projeto não tem um repositório associado.',
                  'This project has no linked repository.',
                )
              : t(
                  'O repositório autorizado não está disponível para leitura.',
                  'The authorized repository is unavailable for reading.',
                )}
          </Notice>
        )}
        {resources.data?.unavailableGlobalInstructions?.length ? (
          <Notice tone="warning">
            {t(
              `Instruções globais existentes não puderam ser lidas: ${resources.data.unavailableGlobalInstructions.join(', ')}. Perfis não poderão ser publicados.`,
              `Existing global instructions could not be read: ${resources.data.unavailableGlobalInstructions.join(', ')}. Profiles cannot be published.`,
            )}
          </Notice>
        ) : null}
        {resources.error && <Notice tone="warning">{resources.error}</Notice>}
        {resources.loading && (
          <p className="muted">{t('A descobrir recursos…', 'Discovering resources…')}</p>
        )}
      </fieldset>
    </div>
  );
}
