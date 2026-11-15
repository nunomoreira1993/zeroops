import { useState } from 'react';
import type { GitRepositoryView, ProjectPipelineView } from '@zeroops/contracts';
import { Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { CapabilitySettingsCard } from '../flows/CapabilityDevelopmentPanel';

/**
 * Pipelines de entrega do projeto (P09): repositório e branch de destino, ambiente, endpoint do
 * fornecedor, política de integração e URL de callback. O segredo HMAC é só de escrita.
 */
export function PipelinesPage({ projectId }: { projectId: string }) {
  const { t } = useIdentityLocale();
  const path = `/projects/${encodeURIComponent(projectId)}/pipelines`;
  const resource = useResource<ProjectPipelineView[]>(path);
  const repositories = useResource<GitRepositoryView[]>(
    `/projects/${encodeURIComponent(projectId)}/git-repositories`,
  );
  const [creating, setCreating] = useState(false);
  const active = (repositories.data ?? []).filter((item) => !item.archived);
  return (
    <div className="stack">
      <PageHeader
        title={t('Pipelines de entrega', 'Delivery pipelines')}
        description={t(
          'Usadas pela etapa «Entrega por pipeline» dos fluxos. O ZeroOps só pede a publicação do commit revisto e integrado; o fornecedor confirma o resultado por callbacks assinadas.',
          'Used by the «Pipeline delivery» flow step. ZeroOps only requests the release of the reviewed and integrated commit; the provider confirms the result through signed callbacks.',
        )}
        action={
          <button
            className="button button-primary"
            disabled={!active.length}
            onClick={() => setCreating(true)}
          >
            {t('Nova pipeline', 'New pipeline')}
          </button>
        }
      />
      {!repositories.loading && !active.length && (
        <Notice>
          {t(
            'Configure primeiro um repositório Git do projeto.',
            'Configure a project Git repository first.',
          )}
        </Notice>
      )}
      {creating && (
        <PipelineForm
          path={path}
          pipeline={null}
          repositories={active}
          onDone={() => {
            setCreating(false);
            resource.reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : resource.data?.length ? (
        resource.data.map((pipeline) => (
          <PipelineCard
            key={`${pipeline.id}:${pipeline.version}`}
            path={path}
            pipeline={pipeline}
            repositories={active}
            onChanged={resource.reload}
          />
        ))
      ) : (
        <Notice>{t('Ainda não há pipelines.', 'No pipelines yet.')}</Notice>
      )}
      {resource.data && (
        <CapabilitySettingsCard
          projectId={projectId}
          pipelines={resource.data}
          repositories={active}
        />
      )}
    </div>
  );
}

function PipelineCard({
  path,
  pipeline,
  repositories,
  onChanged,
}: {
  path: string;
  pipeline: ProjectPipelineView;
  repositories: GitRepositoryView[];
  onChanged: () => void;
}) {
  const { t } = useIdentityLocale();
  const { request } = useSession();
  const mutation = useMutation();
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <PipelineForm
        path={path}
        pipeline={pipeline}
        repositories={repositories}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  return (
    <section className="panel stack" aria-label={pipeline.name}>
      <header className="development-header">
        <h2>{pipeline.name}</h2>
        <span
          className={`status-badge ${pipeline.archived ? 'status-blocked' : 'status-resolved'}`}
        >
          {pipeline.archived ? t('Arquivada', 'Archived') : t('Ativa', 'Active')}
        </span>
      </header>
      <dl className="development-facts">
        <dt>{t('Repositório', 'Repository')}</dt>
        <dd>
          {pipeline.repository.name} → <code>{pipeline.targetBranch}</code>
        </dd>
        <dt>{t('Ambiente', 'Environment')}</dt>
        <dd>{pipeline.environment}</dd>
        <dt>{t('Fornecedor', 'Provider')}</dt>
        <dd>
          {pipeline.provider} · <code>{pipeline.endpointUrl}</code>
        </dd>
        <dt>Callback</dt>
        <dd>
          <code>{pipeline.callbackUrl}</code>
        </dd>
        <dt>{t('Integração', 'Integration')}</dt>
        <dd>
          {pipeline.allowIntegration
            ? t(
                'O ZeroOps integra na branch de destino (sem force push).',
                'ZeroOps integrates into the target branch (no force push).',
              )
            : t(
                'Manual: o ZeroOps só publica commits já integrados.',
                'Manual: ZeroOps only releases commits already integrated.',
              )}
        </dd>
        <dt>{t('Ambiente reservado', 'Environment held')}</dt>
        <dd>
          {pipeline.holdPolicy === 'until_flow_end'
            ? t('até ao fim do fluxo do ticket', 'until the ticket flow ends')
            : t('até à publicação', 'until released')}
        </dd>
      </dl>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {!pipeline.archived && (
        <div className="form-actions">
          <button className="button button-secondary" onClick={() => setEditing(true)}>
            {t('Editar', 'Edit')}
          </button>
          <button
            className="button button-secondary"
            disabled={mutation.busy}
            onClick={() =>
              void mutation.run(async () => {
                await request(`${path}/${encodeURIComponent(pipeline.id)}/archive`, {
                  method: 'POST',
                  body: { expectedVersion: pipeline.version },
                });
                onChanged();
              })
            }
          >
            {t('Arquivar', 'Archive')}
          </button>
        </div>
      )}
    </section>
  );
}

function PipelineForm({
  path,
  pipeline,
  repositories,
  onDone,
  onCancel,
}: {
  path: string;
  pipeline: ProjectPipelineView | null;
  repositories: GitRepositoryView[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useIdentityLocale();
  const { request } = useSession();
  const mutation = useMutation();
  const [name, setName] = useState(pipeline?.name ?? '');
  const [repositoryId, setRepositoryId] = useState(
    pipeline?.repository.id ?? repositories[0]?.id ?? '',
  );
  const repository = repositories.find((item) => item.id === repositoryId);
  const [targetBranch, setTargetBranch] = useState(
    pipeline?.targetBranch ?? repository?.baseBranch ?? 'main',
  );
  const [environment, setEnvironment] = useState(pipeline?.environment ?? 'quality');
  const [endpointUrl, setEndpointUrl] = useState(pipeline?.endpointUrl ?? '');
  const [secret, setSecret] = useState('');
  const [allowIntegration, setAllowIntegration] = useState(pipeline?.allowIntegration ?? false);
  const [holdPolicy, setHoldPolicy] = useState(pipeline?.holdPolicy ?? 'until_published');
  return (
    <form
      className="panel stack"
      aria-label={t('Pipeline de entrega', 'Delivery pipeline')}
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.run(async () => {
          await request(pipeline ? `${path}/${encodeURIComponent(pipeline.id)}` : path, {
            method: 'POST',
            body: {
              name,
              repositoryId,
              targetBranch,
              environment,
              endpointUrl,
              allowIntegration,
              holdPolicy,
              ...(secret ? { secret } : {}),
              ...(pipeline ? { expectedVersion: pipeline.version } : {}),
            },
          });
          onDone();
        });
      }}
    >
      <h2>{pipeline ? pipeline.name : t('Nova pipeline', 'New pipeline')}</h2>
      <label>
        <span>{t('Nome', 'Name')}</span>
        <input required value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>{t('Repositório', 'Repository')}</span>
        <select
          required
          value={repositoryId}
          onChange={(event) => setRepositoryId(event.target.value)}
        >
          {repositories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>
          {t('Branch de destino', 'Target branch')}
          {repository && ` (${repository.allowedRefs.join(', ')})`}
        </span>
        <input
          required
          value={targetBranch}
          onChange={(event) => setTargetBranch(event.target.value)}
        />
      </label>
      <label>
        <span>{t('Ambiente', 'Environment')}</span>
        <select
          value={environment}
          onChange={(event) => setEnvironment(event.target.value as 'quality' | 'production')}
        >
          <option value="quality">{t('Qualidade', 'Quality')}</option>
          <option value="production">{t('Produção', 'Production')}</option>
        </select>
      </label>
      <label>
        <span>{t('Endpoint do fornecedor', 'Provider endpoint')}</span>
        <input
          required
          value={endpointUrl}
          placeholder="https://ci.example.pt/zeroops"
          onChange={(event) => setEndpointUrl(event.target.value)}
        />
      </label>
      <label>
        <span>
          {pipeline
            ? t('Novo segredo HMAC (vazio mantém o atual)', 'New HMAC secret (empty keeps current)')
            : t(
                'Segredo HMAC partilhado (mín. 32 caracteres)',
                'Shared HMAC secret (min. 32 chars)',
              )}
        </span>
        <input
          type="password"
          autoComplete="off"
          required={!pipeline}
          minLength={32}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={allowIntegration}
          onChange={(event) => setAllowIntegration(event.target.checked)}
        />
        <span>
          {t(
            'Autorizar o ZeroOps a integrar na branch de destino (push sem force)',
            'Allow ZeroOps to integrate into the target branch (push without force)',
          )}
        </span>
      </label>
      <label>
        <span>{t('Reservar o ambiente', 'Hold the environment')}</span>
        <select
          value={holdPolicy}
          onChange={(event) =>
            setHoldPolicy(event.target.value as 'until_published' | 'until_flow_end')
          }
        >
          <option value="until_published">{t('até à publicação', 'until released')}</option>
          <option value="until_flow_end">
            {t('até ao fim do fluxo (QA partilhado)', 'until the flow ends (shared QA)')}
          </option>
        </select>
      </label>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <div className="form-actions">
        <button className="button button-primary" disabled={mutation.busy}>
          {t('Gravar', 'Save')}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel}>
          {t('Cancelar', 'Cancel')}
        </button>
      </div>
    </form>
  );
}
