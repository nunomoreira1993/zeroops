import { useState, type KeyboardEvent } from 'react';
import {
  integrationFields,
  isEnvironmentScopedIntegration,
  storedIntegrationEnvironment,
  type IntegrationEnvironment,
  type IntegrationField,
  type IntegrationKind,
  type IntegrationSetting,
} from '@zeroops/contracts';
import { Icon } from '../../components/Icon';
import { Loading, Notice, ResourceError } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale, useIdentityMutation } from '../../lib/identity';
import { useProjectAdmin, useProjectSession } from '../../lib/project-admin';
import { integrationCatalog, integrationTabOrder } from './integration-catalog';

type Translate = ReturnType<typeof useIdentityLocale>['t'];
type TabState = 'verified' | 'draft' | 'revoked' | 'empty' | 'no-connector';

const tabStateClass: Record<TabState, string> = {
  verified: 'status-resolved',
  draft: 'status-awaiting_information',
  revoked: 'status-blocked',
  empty: 'status-cancelled',
  'no-connector': 'status-cancelled',
};

function tabState(kind: IntegrationKind, rows: IntegrationSetting[]): TabState {
  if (!integrationCatalog[kind].connector) return 'no-connector';
  const own = rows.filter((row) => row.kind === kind);
  if (own.some((row) => row.status === 'verified')) return 'verified';
  if (own.some((row) => row.status === 'draft')) return 'draft';
  if (own.length > 0) return 'revoked';
  return 'empty';
}

function tabStateLabel(state: TabState, t: Translate) {
  switch (state) {
    case 'verified':
      return t('Verificada', 'Verified');
    case 'draft':
      return t('Rascunho', 'Draft');
    case 'revoked':
      return t('Revogada', 'Revoked');
    case 'no-connector':
      return t('Sem conector', 'No connector');
    default:
      return t('Por configurar', 'Not configured');
  }
}

function settingStatusLabel(status: IntegrationSetting['status'], t: Translate) {
  if (status === 'verified') return t('Verificada', 'Verified');
  if (status === 'revoked') return t('Revogada', 'Revoked');
  return t('Rascunho — falta testar', 'Draft — needs a test');
}

function readValues(kind: IntegrationKind, fields: IntegrationField[], data: FormData) {
  const values: Record<string, unknown> = { kind };
  for (const field of fields) {
    const value = data.get(field.key);
    if (field.type === 'password' && !value) continue;
    values[field.key] =
      field.type === 'checkbox'
        ? value === 'on'
        : field.type === 'number'
          ? Number(value)
          : String(value ?? '');
  }
  return values;
}

function FieldInput({
  field,
  current,
  t,
}: {
  field: IntegrationField;
  current: IntegrationSetting | undefined;
  t: Translate;
}) {
  if (field.type === 'checkbox')
    return (
      <label className="integration-check">
        <input
          type="checkbox"
          name={field.key}
          defaultChecked={Boolean(current?.values[field.key] ?? field.defaultValue)}
        />
        <span>{t(field.pt, field.en)}</span>
      </label>
    );
  return (
    <label className={field.type === 'password' ? 'integration-field-wide' : undefined}>
      {t(field.pt, field.en)}
      <input
        name={field.key}
        type={field.type}
        required={field.required}
        maxLength={field.type === 'password' ? 8192 : 1000}
        min={field.type === 'number' ? 1 : undefined}
        max={field.type === 'number' ? 65535 : undefined}
        autoComplete={field.type === 'password' ? 'new-password' : 'off'}
        placeholder={
          field.type === 'password' && current?.secretConfigured
            ? t('Mantém a credencial atual se ficar vazio', 'Keeps the current credential if empty')
            : undefined
        }
        defaultValue={
          field.type === 'password'
            ? ''
            : String(current?.values[field.key] ?? field.defaultValue ?? '')
        }
      />
    </label>
  );
}

export function IntegrationSettingsPanel() {
  const { session, request } = useProjectSession();
  const projectAdmin = useProjectAdmin();
  const { t } = useIdentityLocale();
  const allowed = !!session && (session.user.role === 'admin' || session.user.instanceAdmin);
  const resource = useResource<IntegrationSetting[]>(allowed ? '/integration-settings' : null);
  const [selectedKind, setKind] = useState<IntegrationKind | null>(null);
  const [environment, setEnvironment] = useState<IntegrationEnvironment>('quality');
  const [message, setMessage] = useState<string | null>(null);
  const mutation = useIdentityMutation();
  if (!allowed) return null;

  const kinds = integrationTabOrder.filter(
    (value) => value !== 'smtp' || (session?.user.instanceAdmin && !projectAdmin),
  );
  const kind: IntegrationKind =
    selectedKind && kinds.includes(selectedKind) ? selectedKind : (kinds[0] ?? 'database');
  const entry = integrationCatalog[kind];
  const scoped = isEnvironmentScopedIntegration(kind);
  const storedEnvironment = storedIntegrationEnvironment(kind, environment);
  const rows = resource.data ?? [];
  const current = rows.find((item) => item.kind === kind && item.environment === storedEnvironment);
  const fields = integrationFields[kind];
  const textFields = fields.filter((field) => field.type !== 'checkbox');
  const checkFields = fields.filter((field) => field.type === 'checkbox');

  const execute = (path: string, body: Record<string, unknown>, success: string) =>
    mutation.run(async () => {
      setMessage(null);
      try {
        await request(path, { method: 'POST', body });
        setMessage(success);
      } finally {
        resource.reload();
      }
    });
  const audited = t(
    'Configuração atualizada e operação auditada.',
    'Settings updated and operation audited.',
  );
  const selectTab = (next: IntegrationKind) => {
    setKind(next);
    setMessage(null);
  };
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = kinds[(kinds.indexOf(kind) + step + kinds.length) % kinds.length];
    if (!next) return;
    selectTab(next);
    document.getElementById(`integration-tab-${next}`)?.focus();
  };

  return (
    <section className="panel integration-settings">
      <header className="integration-settings-head">
        <div>
          <h2>{t('Configuração das integrações', 'Integration settings')}</h2>
          <p className="muted">
            {t(
              'Os segredos são cifrados e nunca voltam a ser mostrados. Guardar deixa a integração em rascunho; só um teste bem-sucedido a ativa.',
              'Secrets are encrypted and never shown again. Saving leaves the integration as a draft; only a successful test activates it.',
            )}
          </p>
        </div>
      </header>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : (
        <div className="integration-layout">
          <div
            className="integration-tabs"
            role="tablist"
            aria-label={t('Integrações', 'Integrations')}
            aria-orientation="vertical"
            onKeyDown={onTabKey}
          >
            {kinds.map((value) => {
              const state = tabState(value, rows);
              const active = value === kind;
              return (
                <button
                  key={value}
                  id={`integration-tab-${value}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls="integration-tabpanel"
                  tabIndex={active ? 0 : -1}
                  className={`integration-tab${active ? ' is-active' : ''}`}
                  onClick={() => selectTab(value)}
                >
                  <Icon name={integrationCatalog[value].icon} size={18} />
                  <span className="integration-tab-label">
                    {t(integrationCatalog[value].label.pt, integrationCatalog[value].label.en)}
                  </span>
                  <span className={`status-badge ${tabStateClass[state]}`}>
                    <span />
                    {tabStateLabel(state, t)}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            className="integration-tabpanel"
            id="integration-tabpanel"
            role="tabpanel"
            aria-labelledby={`integration-tab-${kind}`}
          >
            <div className="integration-tabpanel-head">
              <span className="feature-icon">
                <Icon name={entry.icon} size={22} />
              </span>
              <div>
                <h3>{t(entry.label.pt, entry.label.en)}</h3>
                <p className="muted">{t(entry.purpose.pt, entry.purpose.en)}</p>
              </div>
            </div>

            {scoped && entry.environments && (
              <div className="integration-environment">
                <div className="segmented" role="group" aria-label={t('Ambiente', 'Environment')}>
                  {(['quality', 'production'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={environment === value}
                      className={environment === value ? 'is-active' : undefined}
                      onClick={() => {
                        setEnvironment(value);
                        setMessage(null);
                      }}
                    >
                      {value === 'quality'
                        ? t('Qualidade', 'Quality')
                        : t('Produção', 'Production')}
                    </button>
                  ))}
                </div>
                <p className="muted">
                  {t(entry.environments[environment].pt, entry.environments[environment].en)}
                </p>
              </div>
            )}

            {!entry.connector && (
              <Notice tone="info">
                {t(
                  'Ainda não existe conector para esta integração. Pode guardar a referência, mas o teste devolve "conector não validado" e o agente não a usa.',
                  'There is no connector for this integration yet. You can save the reference, but the test reports "connector not validated" and the agent does not use it.',
                )}
              </Notice>
            )}
            {message && <Notice tone="success">{message}</Notice>}
            {mutation.error && <Notice>{mutation.error}</Notice>}

            {current && (
              <dl className="integration-meta">
                <div>
                  <dt>{t('Estado', 'Status')}</dt>
                  <dd>{settingStatusLabel(current.status, t)}</dd>
                </div>
                <div>
                  <dt>{t('Versão', 'Version')}</dt>
                  <dd>{current.version}</dd>
                </div>
                <div>
                  <dt>{t('Credencial', 'Credential')}</dt>
                  <dd>
                    {current.secretConfigured
                      ? t('Cifrada e guardada', 'Encrypted and stored')
                      : t('Nenhuma', 'None')}
                  </dd>
                </div>
                {current.testCode && (
                  <div>
                    <dt>{t('Último teste', 'Last test')}</dt>
                    <dd>
                      <code>{current.testCode}</code>
                    </dd>
                  </div>
                )}
              </dl>
            )}

            <form
              key={`${kind}:${storedEnvironment}:${current?.version ?? 0}`}
              className="integration-form"
              onSubmit={(event) => {
                event.preventDefault();
                const values = readValues(kind, fields, new FormData(event.currentTarget));
                void execute(
                  '/integration-settings',
                  {
                    scope: kind === 'smtp' ? 'instance' : 'project',
                    environment: storedEnvironment,
                    expectedVersion: current?.version ?? 0,
                    values,
                  },
                  audited,
                );
              }}
            >
              <div className="integration-form-grid">
                {textFields.map((field) => (
                  <FieldInput key={field.key} field={field} current={current} t={t} />
                ))}
              </div>
              {checkFields.length > 0 && (
                <fieldset className="integration-checks">
                  <legend>{t('Segurança da ligação', 'Connection security')}</legend>
                  {checkFields.map((field) => (
                    <FieldInput key={field.key} field={field} current={current} t={t} />
                  ))}
                </fieldset>
              )}
              <p className="muted integration-hint">
                {t(
                  'Deixar a nova credencial vazia preserva a existente. Alterações regressam a rascunho e exigem novo teste. Revogar remove a credencial guardada.',
                  'Leaving a new credential blank preserves the current one. Changes return to draft and require a new test. Revocation removes the stored credential.',
                )}
              </p>
              <div className="integration-actions">
                <button className="button button-primary" disabled={mutation.busy}>
                  {t('Guardar / rodar credencial', 'Save / rotate credential')}
                </button>
                {current && current.status !== 'revoked' && (
                  <>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={mutation.busy || !entry.connector}
                      onClick={() =>
                        void execute(
                          `/integration-settings/${encodeURIComponent(current.id)}/test`,
                          { expectedVersion: current.version },
                          t(
                            'Ligação verificada. Isto não ativa GenOps.',
                            'Connection verified. This does not enable GenOps.',
                          ),
                        )
                      }
                    >
                      {t('Testar ligação', 'Test connection')}
                    </button>
                    <button
                      type="button"
                      className="button button-secondary integration-revoke"
                      disabled={mutation.busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            t(
                              'Revogar esta configuração? A credencial guardada será removida.',
                              'Revoke this configuration? The stored credential will be removed.',
                            ),
                          )
                        )
                          void execute(
                            `/integration-settings/${encodeURIComponent(current.id)}/revoke`,
                            { expectedVersion: current.version },
                            audited,
                          );
                      }}
                    >
                      {t('Revogar', 'Revoke')}
                    </button>
                  </>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
