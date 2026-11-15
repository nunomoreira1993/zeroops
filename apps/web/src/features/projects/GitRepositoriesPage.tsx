import { useState } from 'react';
import type { DevelopmentCommand, GitRepositoryView } from '@zeroops/contracts';
import { Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';

/** `nome: comando` por linha (o tempo limite usa o valor por omissão do backend). */
export function parseCommands(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(':');
      return index > 0
        ? { name: line.slice(0, index).trim(), command: line.slice(index + 1).trim() }
        : { name: line.slice(0, 40), command: line };
    });
}

const formatCommands = (commands: DevelopmentCommand[]) =>
  commands.map((command) => `${command.name}: ${command.command}`).join('\n');

/** Repositórios Git de desenvolvimento do projeto (P08): referências, comandos e verificação. */
export function GitRepositoriesPage({ projectId }: { projectId: string }) {
  const { t } = useIdentityLocale();
  const path = `/projects/${encodeURIComponent(projectId)}/git-repositories`;
  const resource = useResource<GitRepositoryView[]>(path);
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack">
      <PageHeader
        title={t('Repositórios Git', 'Git repositories')}
        description={t(
          'Repositórios usados pelas etapas de desenvolvimento. Cada trabalho usa um checkout isolado, uma branch zeroops/… e um commit base fixo.',
          'Repositories used by development steps. Each job uses an isolated checkout, a zeroops/… branch and a fixed base commit.',
        )}
        action={
          <button className="button button-primary" onClick={() => setCreating(true)}>
            {t('Novo repositório', 'New repository')}
          </button>
        }
      />
      {creating && (
        <RepositoryForm
          path={path}
          repository={null}
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
        resource.data.map((repository) => (
          <RepositoryCard
            key={`${repository.id}:${repository.version}`}
            path={path}
            repository={repository}
            onChanged={resource.reload}
          />
        ))
      ) : (
        <Notice>{t('Ainda não há repositórios.', 'No repositories yet.')}</Notice>
      )}
    </div>
  );
}

function RepositoryCard({
  path,
  repository,
  onChanged,
}: {
  path: string;
  repository: GitRepositoryView;
  onChanged: () => void;
}) {
  const { t } = useIdentityLocale();
  const { request } = useSession();
  const mutation = useMutation();
  const [editing, setEditing] = useState(false);
  const item = `${path}/${encodeURIComponent(repository.id)}`;
  if (editing)
    return (
      <RepositoryForm
        path={path}
        repository={repository}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  return (
    <section className="panel stack" aria-label={repository.name}>
      <header className="development-header">
        <h2>{repository.name}</h2>
        <span
          className={`status-badge ${repository.archived ? 'status-blocked' : repository.verifiedAt ? 'status-resolved' : 'status-awaiting_technical'}`}
        >
          {repository.archived
            ? t('Arquivado', 'Archived')
            : repository.verifiedAt
              ? t('Verificado', 'Verified')
              : t('Por verificar', 'Not verified')}
        </span>
      </header>
      <dl className="development-facts">
        <dt>URL</dt>
        <dd>
          <code>{repository.url}</code>
        </dd>
        <dt>{t('Branch base', 'Base branch')}</dt>
        <dd>
          <code>{repository.baseBranch}</code>
          {repository.verifiedBaseSha && <code> @ {repository.verifiedBaseSha.slice(0, 12)}</code>}
        </dd>
        <dt>{t('Referências autorizadas', 'Allowed refs')}</dt>
        <dd>{repository.allowedRefs.join(', ')}</dd>
        <dt>{t('Testes', 'Tests')}</dt>
        <dd>
          {repository.testCommands.map((command) => (
            <div key={command.name}>
              <strong>{command.name}</strong>: <code>{command.command}</code>
            </div>
          ))}
        </dd>
        <dt>PR</dt>
        <dd>
          {repository.prProvider === 'github' ? 'GitHub' : t('Interno ZeroOps', 'ZeroOps internal')}
        </dd>
        <dt>{t('Credencial', 'Credential')}</dt>
        <dd>{repository.hasCredential ? t('Configurada', 'Configured') : t('Nenhuma', 'None')}</dd>
      </dl>
      {repository.verificationError && <Notice>{repository.verificationError}</Notice>}
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {!repository.archived && (
        <div className="form-actions">
          <button
            className="button button-secondary"
            disabled={mutation.busy}
            onClick={() =>
              void mutation.run(async () => {
                await request(`${item}/verify`, { method: 'POST', body: {} });
                onChanged();
              })
            }
          >
            {t('Verificar acesso', 'Verify access')}
          </button>
          <button className="button button-secondary" onClick={() => setEditing(true)}>
            {t('Editar', 'Edit')}
          </button>
          <button
            className="button button-secondary"
            disabled={mutation.busy}
            onClick={() =>
              void mutation.run(async () => {
                await request(`${item}/archive`, {
                  method: 'POST',
                  body: { expectedVersion: repository.version },
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

function RepositoryForm({
  path,
  repository,
  onDone,
  onCancel,
}: {
  path: string;
  repository: GitRepositoryView | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useIdentityLocale();
  const { request } = useSession();
  const mutation = useMutation();
  const [name, setName] = useState(repository?.name ?? '');
  const [url, setUrl] = useState(repository?.url ?? '');
  const [baseBranch, setBaseBranch] = useState(repository?.baseBranch ?? 'main');
  const [allowedRefs, setAllowedRefs] = useState(repository?.allowedRefs.join(', ') ?? 'main');
  const [tests, setTests] = useState(formatCommands(repository?.testCommands ?? []));
  const [setup, setSetup] = useState(formatCommands(repository?.setupCommands ?? []));
  const [prProvider, setPrProvider] = useState(repository?.prProvider ?? 'zeroops');
  const [credential, setCredential] = useState('');
  return (
    <form
      className="panel stack"
      aria-label={t('Repositório Git', 'Git repository')}
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.run(async () => {
          await request(repository ? `${path}/${encodeURIComponent(repository.id)}` : path, {
            method: 'POST',
            body: {
              name,
              url,
              baseBranch,
              allowedRefs: allowedRefs
                .split(',')
                .map((ref) => ref.trim())
                .filter(Boolean),
              testCommands: parseCommands(tests),
              setupCommands: parseCommands(setup),
              prProvider,
              ...(credential ? { credential } : {}),
              ...(repository ? { expectedVersion: repository.version } : {}),
            },
          });
          onDone();
        });
      }}
    >
      <h2>{repository ? repository.name : t('Novo repositório', 'New repository')}</h2>
      <label>
        <span>{t('Nome', 'Name')}</span>
        <input required value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>URL (https:// ou file://)</span>
        <input required value={url} onChange={(event) => setUrl(event.target.value)} />
      </label>
      <label>
        <span>{t('Branch base', 'Base branch')}</span>
        <input
          required
          value={baseBranch}
          onChange={(event) => setBaseBranch(event.target.value)}
        />
      </label>
      <label>
        <span>
          {t('Referências autorizadas (separadas por vírgulas)', 'Allowed refs (comma separated)')}
        </span>
        <input
          required
          value={allowedRefs}
          onChange={(event) => setAllowedRefs(event.target.value)}
        />
      </label>
      <label>
        <span>
          {t(
            'Comandos de teste (nome: comando, um por linha)',
            'Test commands (name: command, one per line)',
          )}
        </span>
        <textarea
          required
          rows={3}
          value={tests}
          onChange={(event) => setTests(event.target.value)}
        />
      </label>
      <label>
        <span>{t('Comandos de preparação (opcional)', 'Setup commands (optional)')}</span>
        <textarea rows={2} value={setup} onChange={(event) => setSetup(event.target.value)} />
      </label>
      <label>
        <span>PR</span>
        <select
          value={prProvider}
          onChange={(event) => setPrProvider(event.target.value as 'zeroops' | 'github')}
        >
          <option value="zeroops">{t('Interno ZeroOps', 'ZeroOps internal')}</option>
          <option value="github">GitHub</option>
        </select>
      </label>
      <label>
        <span>
          {repository?.hasCredential
            ? t('Nova credencial (vazio mantém a atual)', 'New credential (empty keeps current)')
            : t('Credencial (opcional)', 'Credential (optional)')}
        </span>
        <input
          type="password"
          autoComplete="off"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
        />
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
