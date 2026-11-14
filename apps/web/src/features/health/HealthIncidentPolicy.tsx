import { useEffect, useState } from 'react';
import {
  incidentEnvironments,
  incidentResourceKinds,
  interventionActionLabels,
  interventionActions,
  interventionDecisions,
  interventionParameters,
  type IncidentPolicy,
  type IncidentPolicyView,
  type InterventionAction,
  type InterventionDecision,
  type InterventionParameter,
} from '@zeroops/contracts';
import { Loading, Notice, ResourceError } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { formatDate } from './health-labels';

type Scope = 'any' | (typeof incidentEnvironments)[number];
type ParameterDraft = { unit: string; property: InterventionParameter; allowed: string };
type Draft = Omit<IncidentPolicy, 'parameters' | 'unmanagedEngines'> & {
  parameters: ParameterDraft[];
  unmanagedEngines: string;
};

const list = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

const toDraft = (policy: IncidentPolicy): Draft => ({
  ...policy,
  parameters: policy.parameters.map((item) => ({ ...item, allowed: item.allowed.join(', ') })),
  unmanagedEngines: policy.unmanagedEngines.join(', '),
});

const fromDraft = (draft: Draft): IncidentPolicy => ({
  ...draft,
  parameters: draft.parameters.map((item) => ({ ...item, allowed: list(item.allowed) })),
  unmanagedEngines: list(draft.unmanagedEngines),
});

const decisionLabels: Record<InterventionDecision, { pt: string; en: string }> = {
  auto: { pt: 'Automática', en: 'Automatic' },
  approval: { pt: 'Com aprovação', en: 'Needs approval' },
  forbidden: { pt: 'Proibida', en: 'Forbidden' },
};

const roleLabels: Record<IncidentPolicy['escalationRole'], { pt: string; en: string }> = {
  technical: { pt: 'Equipa técnica', en: 'Technical team' },
  admin: { pt: 'Administração', en: 'Administrators' },
  qa: { pt: 'Qualidade', en: 'Quality' },
  release: { pt: 'Gestão de release', en: 'Release managers' },
};

function ScopeSelect({ value, onChange }: { value: Scope; onChange: (value: Scope) => void }) {
  const { t } = useIdentityLocale();
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as Scope)}>
      <option value="any">{t('Qualquer', 'Any')}</option>
      <option value="quality">{t('Qualidade', 'Quality')}</option>
      <option value="production">{t('Produção', 'Production')}</option>
    </select>
  );
}

/**
 * Política de intervenção dos incidentes: o que o agente pode fazer sozinho, o que precisa de
 * aprovação e o que é proibido, por ambiente, tipo de recurso e motor; validação e escalada.
 */
export function HealthIncidentPolicy({ onSaved }: { onSaved: (message: string) => void }) {
  const { request } = useSession();
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const resource = useResource<IncidentPolicyView>('/monitoring/incident-policy');
  const mutation = useMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!resource.data) return;
    setDraft(toDraft(resource.data.policy));
    setVersion(resource.data.version);
  }, [resource.data]);

  if (resource.error) return <ResourceError error={resource.error} retry={resource.reload} />;
  if (!draft) return <Loading />;

  const patch = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    void mutation.run(async () => {
      const saved = await request<IncidentPolicyView>('/monitoring/incident-policy', {
        method: 'POST',
        body: { policy: fromDraft(draft), expectedVersion: version },
      });
      setDraft(toDraft(saved.policy));
      setVersion(saved.version);
      onSaved(t('Política de intervenção gravada.', 'Intervention policy saved.'));
    });
  };
  const validation = draft.validation;
  const number = (key: keyof typeof validation, value: string) =>
    patch({ validation: { ...validation, [key]: Number(value) } });

  return (
    <form
      className="panel health-settings health-policy"
      onSubmit={save}
      data-testid="incident-policy"
    >
      <div className="section-heading">
        <div>
          <h2>
            {t(
              'Política de intervenção (Incidente Health)',
              'Intervention policy (Health incident)',
            )}
          </h2>
          <p className="health-muted">
            {t(
              'Define o que o agente pode fazer sozinho, o que precisa de aprovação e o que é proibido. Sem regra aplicável, a ação precisa de aprovação humana. Recursos não geridos, serviços fora da lista e valores não permitidos são sempre recusados. Apagar ficheiros ou dados nunca é uma ação disponível.',
              'Defines what the agent may do on its own, what needs approval and what is forbidden. Without a matching rule the action needs human approval. Unmanaged resources, unlisted services and disallowed values are always refused. Deleting files or data is never an available action.',
            )}{' '}
            {version > 0 && resource.data?.updatedAt
              ? `${t('Versão', 'Version')} ${version} · ${formatDate(resource.data.updatedAt, locale)}`
              : t('A usar a política por omissão.', 'Using the default policy.')}
          </p>
        </div>
      </div>
      {mutation.error && <Notice>{mutation.error}</Notice>}

      <fieldset>
        <legend>{t('Regras de decisão', 'Decision rules')}</legend>
        <p className="health-muted">
          {t(
            'A regra mais específica ganha; em empate prevalece a mais restritiva.',
            'The most specific rule wins; on a tie the most restrictive prevails.',
          )}
        </p>
        <div className="table-scroll">
          <table className="identity-table health-policy-table">
            <thead>
              <tr>
                <th>{t('Ambiente', 'Environment')}</th>
                <th>{t('Recurso', 'Resource')}</th>
                <th>{t('Motor', 'Engine')}</th>
                <th>{t('Ação', 'Action')}</th>
                <th>{t('Decisão', 'Decision')}</th>
                <th aria-label={t('Remover', 'Remove')} />
              </tr>
            </thead>
            <tbody>
              {draft.rules.map((rule, index) => {
                const setRule = (change: Partial<typeof rule>) =>
                  patch({
                    rules: draft.rules.map((item, at) =>
                      at === index ? { ...item, ...change } : item,
                    ),
                  });
                return (
                  <tr key={index}>
                    <td>
                      <ScopeSelect
                        value={rule.environment}
                        onChange={(environment) => setRule({ environment })}
                      />
                    </td>
                    <td>
                      <select
                        value={rule.kind}
                        onChange={(event) => setRule({ kind: event.target.value })}
                      >
                        <option value="any">{t('Qualquer', 'Any')}</option>
                        {Object.values(incidentResourceKinds).map((kind) => (
                          <option key={kind.key} value={kind.key}>
                            {kind.label[lang]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        value={rule.engine}
                        maxLength={32}
                        aria-label={t('Motor', 'Engine')}
                        onChange={(event) => setRule({ engine: event.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        value={rule.action}
                        onChange={(event) =>
                          setRule({ action: event.target.value as InterventionAction })
                        }
                      >
                        {interventionActions.map((action) => (
                          <option key={action} value={action}>
                            {interventionActionLabels[action][lang]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={rule.decision}
                        onChange={(event) =>
                          setRule({ decision: event.target.value as InterventionDecision })
                        }
                      >
                        {interventionDecisions.map((decision) => (
                          <option key={decision} value={decision}>
                            {decisionLabels[decision][lang]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          patch({ rules: draft.rules.filter((_, at) => at !== index) })
                        }
                      >
                        {t('Remover', 'Remove')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="button button-secondary align-start"
          onClick={() =>
            patch({
              rules: [
                ...draft.rules,
                {
                  environment: 'any',
                  kind: 'any',
                  engine: 'any',
                  action: 'service_restart',
                  decision: 'approval',
                },
              ],
            })
          }
        >
          {t('Acrescentar regra', 'Add rule')}
        </button>
      </fieldset>

      <fieldset>
        <legend>
          {t('Serviços que o agente pode reiniciar', 'Services the agent may restart')}
        </legend>
        <p className="health-muted">
          {t(
            'Têm de coincidir com a lista permitida no relay de Produção.',
            'Must match the allowlist on the Production relay.',
          )}
        </p>
        {draft.services.map((service, index) => {
          const setService = (change: Partial<typeof service>) =>
            patch({
              services: draft.services.map((item, at) =>
                at === index ? { ...item, ...change } : item,
              ),
            });
          return (
            <div className="health-form-grid health-policy-row" key={index}>
              <label>
                {t('Unidade systemd', 'systemd unit')}
                <input
                  value={service.unit}
                  placeholder="php-fpm.service"
                  onChange={(event) => setService({ unit: event.target.value })}
                />
              </label>
              <label>
                {t('Motor', 'Engine')}
                <input
                  value={service.engine ?? ''}
                  placeholder="php"
                  onChange={(event) => setService({ engine: event.target.value || null })}
                />
              </label>
              <label>
                {t('Ambiente', 'Environment')}
                <ScopeSelect
                  value={service.environment}
                  onChange={(environment) => setService({ environment })}
                />
              </label>
              <button
                type="button"
                className="link-button"
                onClick={() => patch({ services: draft.services.filter((_, at) => at !== index) })}
              >
                {t('Remover', 'Remove')}
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="button button-secondary align-start"
          onClick={() =>
            patch({ services: [...draft.services, { unit: '', engine: null, environment: 'any' }] })
          }
        >
          {t('Acrescentar serviço', 'Add service')}
        </button>
      </fieldset>

      <fieldset>
        <legend>
          {t('Parâmetros que o agente pode alterar', 'Parameters the agent may change')}
        </legend>
        {draft.parameters.map((parameter, index) => {
          const setParameter = (change: Partial<ParameterDraft>) =>
            patch({
              parameters: draft.parameters.map((item, at) =>
                at === index ? { ...item, ...change } : item,
              ),
            });
          return (
            <div className="health-form-grid health-policy-row" key={index}>
              <label>
                {t('Unidade systemd', 'systemd unit')}
                <input
                  value={parameter.unit}
                  placeholder="php-fpm.service"
                  onChange={(event) => setParameter({ unit: event.target.value })}
                />
              </label>
              <label>
                {t('Propriedade', 'Property')}
                <select
                  value={parameter.property}
                  onChange={(event) =>
                    setParameter({ property: event.target.value as InterventionParameter })
                  }
                >
                  {interventionParameters.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('Valores permitidos', 'Allowed values')}
                <input
                  value={parameter.allowed}
                  placeholder="1G, 2G"
                  onChange={(event) => setParameter({ allowed: event.target.value })}
                />
              </label>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  patch({ parameters: draft.parameters.filter((_, at) => at !== index) })
                }
              >
                {t('Remover', 'Remove')}
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="button button-secondary align-start"
          onClick={() =>
            patch({
              parameters: [...draft.parameters, { unit: '', property: 'MemoryMax', allowed: '' }],
            })
          }
        >
          {t('Acrescentar parâmetro', 'Add parameter')}
        </button>
        <label>
          {t('Motores não geridos (só diagnóstico)', 'Unmanaged engines (diagnosis only)')}
          <input
            value={draft.unmanagedEngines}
            placeholder="db2"
            onChange={(event) => patch({ unmanagedEngines: event.target.value })}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>{t('Validação da recuperação', 'Recovery validation')}</legend>
        <div className="health-form-grid">
          <label>
            {t('Janela de observação (min)', 'Observation window (min)')}
            <input
              type="number"
              min={0}
              max={240}
              value={validation.observationMinutes}
              onChange={(event) => number('observationMinutes', event.target.value)}
            />
          </label>
          <label>
            {t('Prazo máximo (min)', 'Timeout (min)')}
            <input
              type="number"
              min={1}
              max={1440}
              value={validation.timeoutMinutes}
              onChange={(event) => number('timeoutMinutes', event.target.value)}
            />
          </label>
          <label>
            {t('Tentativas antes de escalar', 'Attempts before escalating')}
            <input
              type="number"
              min={1}
              max={5}
              value={validation.maxAttempts}
              onChange={(event) => number('maxAttempts', event.target.value)}
            />
          </label>
          <label>
            {t('Disco livre mínimo (%)', 'Minimum free disk (%)')}
            <input
              type="number"
              min={1}
              max={90}
              value={validation.diskFreePercent}
              onChange={(event) => number('diskFreePercent', event.target.value)}
            />
          </label>
          <label>
            {t('Memória disponível mínima (%)', 'Minimum available memory (%)')}
            <input
              type="number"
              min={1}
              max={90}
              value={validation.memoryAvailablePercent}
              onChange={(event) => number('memoryAvailablePercent', event.target.value)}
            />
          </label>
          <label>
            {t('Carga de CPU máxima por núcleo', 'Maximum CPU load per core')}
            <input
              type="number"
              min={0.1}
              max={20}
              step={0.1}
              value={validation.cpuLoadPerCore}
              onChange={(event) => number('cpuLoadPerCore', event.target.value)}
            />
          </label>
          <label className="health-span">
            {t('URL da verificação HTTP (aplicação)', 'HTTP check URL (application)')}
            <input
              type="url"
              value={validation.httpUrl ?? ''}
              placeholder="https://"
              onChange={(event) =>
                patch({ validation: { ...validation, httpUrl: event.target.value.trim() || null } })
              }
            />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>{t('Encaminhamento', 'Escalation')}</legend>
        <label>
          {t(
            'Equipa responsável quando o incidente escala',
            'Team responsible when the incident escalates',
          )}
          <select
            value={draft.escalationRole}
            onChange={(event) =>
              patch({ escalationRole: event.target.value as IncidentPolicy['escalationRole'] })
            }
          >
            {Object.entries(roleLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label[lang]}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <button type="submit" className="button button-primary align-start" disabled={mutation.busy}>
        {mutation.busy ? t('A gravar…', 'Saving…') : t('Gravar política', 'Save policy')}
      </button>
    </form>
  );
}
