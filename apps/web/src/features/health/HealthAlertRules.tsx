import {
  alertRuleCatalog,
  alertRuleGroups,
  effectiveAlertRules,
  healthCriticalities,
  type AlertRuleGroup,
  type AlertRuleOverride,
  type AlertRulesSyncStatus,
  type HealthCriticality,
  type AlertRuleDefinition,
} from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useIdentityLocale, type Locale } from '../../lib/identity';
import { healthLabels, formatDate } from './health-labels';

const ruleLabelsEn: Record<string, [string, string, string?]> = {
  PartilhaRedeIndisponivel: [
    'Network share unavailable',
    'The exporter cannot read a mounted network filesystem.',
  ],
  PartilhaRedeQuaseCheia: [
    'Network share nearly full',
    'External share free space below the threshold, excluding internal NFS.',
    'Free space below',
  ],
  ServicoIndisponivel: [
    'Service unavailable',
    'An exporter (server, MySQL, Redis) stopped responding to Prometheus.',
  ],
  EspacoDiscoBaixo: ['Low disk space', 'Free disk space below the threshold.', 'Free space below'],
  EspacoDiscoCritico: [
    'Critical disk space',
    'Free disk space almost exhausted.',
    'Free space below',
  ],
  InodesBaixos: [
    'Low free inodes',
    'Few free inodes (many small files, e.g. sessions or cache).',
    'Free inodes below',
  ],
  CargaCpuElevada: [
    'High CPU load',
    'Average load (5 minutes) per core above the threshold.',
    'Load above',
  ],
  MemoriaElevada: ['High memory usage', 'Memory usage above the threshold.', 'Memory usage above'],
  MetricasProducaoAusentes: [
    'Missing Production metrics',
    'Production Prometheus stopped sending metrics (remote write).',
  ],
  RedisIndisponivel: ['Redis unavailable', 'Redis is not responding to the exporter.'],
  MysqlIndisponivel: ['MySQL unavailable', 'MySQL/MariaDB is not responding to the exporter.'],
  MysqlLigacoesElevadas: [
    'High MySQL connections',
    'Open connections close to the configured maximum.',
    'Connections above',
  ],
  SiteIndisponivel: ['Site unavailable', 'The external HTTP request to the site fails.'],
  RespostaLenta: [
    'Slow response',
    'Average site response time (15 minutes) above the threshold.',
    'Average time above',
  ],
  CertificadoAExpirar: [
    'Certificate expiring',
    'The site TLS certificate expires soon.',
    'Expires in less than',
  ],
  Db2Indisponivel: ['DB2 unavailable', 'The ODBC connection to DB2/IBM i fails.'],
  Db2Lento: [
    'Slow DB2',
    'DB2 connection and test query above the threshold.',
    'Connection and query above',
  ],
  Db2JobsElevados: [
    'IBM i jobs near the maximum',
    'System jobs close to the allowed maximum.',
    'Jobs above',
  ],
  Db2ArmazenamentoElevado: [
    'High IBM i storage usage',
    'System ASP usage above the threshold.',
    'Usage above',
  ],
  Db2MetricasAusentes: [
    'Missing DB2 metrics',
    'Production sends metrics, but the DB2 collector stopped publishing them.',
  ],
  DtqClientesIndisponivel: [
    'Customer DTQ (login) unavailable',
    'The probe using the test account fails the users DTQ (customer login).',
  ],
  DtqClientesLento: [
    'Slow customer DTQ (login)',
    'The users DTQ probe takes longer than the threshold.',
    'Probe time above',
  ],
  DtqClientesTaxaFalhas: [
    'Customer login failures (DTQ users)',
    'Users DTQ reads requested by the site without a response (normally ~0.1%), with at least 10 failures in 10 minutes.',
    'Failures above',
  ],
  DtqErrosNoLog: [
    'DTQ queue log errors',
    '[ERROR] lines in the site dtq.log over 10 minutes.',
    'Errors in 10 min starting at',
  ],
};

const groupLabelsEn: Record<AlertRuleGroup, string> = {
  servidor: 'Servers',
  servicos: 'Services (MySQL, Redis)',
  disponibilidade: 'Site availability',
  ibm_i: 'IBM i (DB2 and DTQ queues)',
};

export const alertRuleGroupLabel = (group: AlertRuleGroup, locale: Locale) =>
  locale === 'en' ? groupLabelsEn[group] : alertRuleGroups[group];

export function localizedAlertRule(rule: AlertRuleDefinition, locale: Locale) {
  const labels = locale === 'en' ? ruleLabelsEn[rule.id] : undefined;
  if (!labels) return rule;
  return {
    ...rule,
    title: labels[0],
    description: labels[1],
    threshold: rule.threshold && {
      ...rule.threshold,
      label: labels[2] ?? rule.threshold.label,
      unit:
        ({ dias: 'days', linhas: 'lines', 'por core': 'per core' } as Record<string, string>)[
          rule.threshold.unit
        ] ?? rule.threshold.unit,
    },
  };
}

type Overrides = Record<string, AlertRuleOverride>;

const catalogById = new Map(alertRuleCatalog.map((rule) => [rule.id, rule]));

/** Guarda só o que difere do catálogo, para que as melhorias futuras do catálogo se apliquem. */
function withChange(overrides: Overrides, id: string, patch: AlertRuleOverride): Overrides {
  const rule = catalogById.get(id)!;
  const merged = { ...overrides[id], ...patch };
  const clean: AlertRuleOverride = {};
  if (merged.enabled === false) clean.enabled = false;
  if (merged.threshold !== undefined && merged.threshold !== rule.threshold?.default)
    clean.threshold = merged.threshold;
  if (merged.forMinutes !== undefined && merged.forMinutes !== rule.forMinutes)
    clean.forMinutes = merged.forMinutes;
  if (merged.criticality !== undefined && merged.criticality !== rule.criticality)
    clean.criticality = merged.criticality;
  const next = { ...overrides };
  if (Object.keys(clean).length > 0) next[id] = clean;
  else delete next[id];
  return next;
}

const syncText = (status: AlertRulesSyncStatus, locale: Locale) => {
  const en = locale === 'en';
  if (status.state === 'disabled')
    return en
      ? 'Prometheus rule generation is disabled on this server.'
      : 'A geração das regras do Prometheus está desligada neste servidor.';
  const when = status.syncedAt ? formatDate(status.syncedAt, locale) : null;
  if (status.state === 'ok')
    return en
      ? when
        ? `Rules applied in Prometheus (${when}).`
        : 'Rules applied in Prometheus.'
      : when
        ? `Regras aplicadas no Prometheus (${when}).`
        : 'Regras aplicadas no Prometheus.';
  return en
    ? `Prometheus rejected the rules: ${status.message ?? 'unknown error'}`
    : `O Prometheus recusou as regras: ${status.message ?? 'erro desconhecido'}`;
};

/** Regras do Prometheus do projeto: ativar, limiar, duração e criticidade de cada alerta. */
export function HealthAlertRules({
  overrides,
  sync,
  onChange,
}: {
  overrides: Overrides;
  sync: AlertRulesSyncStatus;
  onChange: (overrides: Overrides) => void;
}) {
  const { locale, t } = useIdentityLocale();
  const labels = healthLabels(locale);
  const rules = effectiveAlertRules(overrides);
  const changed = Object.keys(overrides).length;

  return (
    <fieldset>
      <legend>{t('Regras de alerta', 'Alert rules')}</legend>
      <p className="health-muted">
        {t(
          `Regras avaliadas pelo Prometheus a cada 30 segundos. O alerta dispara quando a condição se
        mantém durante a duração indicada. Ao gravar, as regras são geradas e recarregadas no
        Prometheus. As regras de servidores, serviços e IBM i são partilhadas e só se aplicam no
        projeto principal.`,
          'Rules are evaluated by Prometheus every 30 seconds. An alert fires when the condition persists for the specified duration. Saving generates and reloads the rules in Prometheus. Server, service and IBM i rules are shared and only apply to the main project.',
        )}
      </p>
      <Notice tone={sync.state === 'error' ? 'error' : 'info'}>{syncText(sync, locale)}</Notice>
      {(Object.keys(alertRuleGroups) as AlertRuleGroup[]).map((group) => (
        <div className="health-rule-group" key={group}>
          <h3>{alertRuleGroupLabel(group, locale)}</h3>
          <div className="health-routing">
            <table className="health-rules-table">
              <thead>
                <tr>
                  <th scope="col">{t('Ativa', 'Enabled')}</th>
                  <th scope="col">{t('Regra', 'Rule')}</th>
                  <th scope="col">{t('Limiar', 'Threshold')}</th>
                  <th scope="col">{t('Duração (min)', 'Duration (min)')}</th>
                  <th scope="col">{t('Criticidade', 'Criticality')}</th>
                </tr>
              </thead>
              <tbody>
                {rules
                  .filter((rule) => rule.group === group)
                  .map((rule) => ({ ...rule, ...localizedAlertRule(rule, locale) }))
                  .map((rule) => (
                    <tr key={rule.id} className={rule.enabled ? undefined : 'health-rule-off'}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${t('Ativar', 'Enable')} ${rule.title}`}
                          checked={rule.enabled}
                          onChange={(event) =>
                            onChange(
                              withChange(overrides, rule.id, {
                                enabled: event.target.checked ? undefined : false,
                              }),
                            )
                          }
                        />
                      </td>
                      <td>
                        <strong>{rule.title}</strong>
                        <div className="health-muted">{rule.description}</div>
                        <code className="health-rule-id">{rule.id}</code>
                      </td>
                      <td>
                        {rule.threshold ? (
                          <label className="health-rule-field">
                            <span className="health-muted">{rule.threshold.label}</span>
                            <span className="health-inline">
                              <input
                                type="number"
                                required
                                min={rule.threshold.min}
                                max={rule.threshold.max}
                                step={rule.threshold.step}
                                value={
                                  Number.isNaN(rule.thresholdValue)
                                    ? ''
                                    : (rule.thresholdValue ?? '')
                                }
                                onChange={(event) =>
                                  onChange(
                                    withChange(overrides, rule.id, {
                                      threshold: event.target.valueAsNumber,
                                    }),
                                  )
                                }
                              />
                              {rule.threshold.unit}
                            </span>
                          </label>
                        ) : (
                          <span className="health-muted">—</span>
                        )}
                      </td>
                      <td>
                        <input
                          type="number"
                          required
                          min={0}
                          max={1440}
                          step={1}
                          aria-label={t(
                            `Duração de ${rule.title} em minutos`,
                            `Duration of ${rule.title} in minutes`,
                          )}
                          value={Number.isNaN(rule.forMinutes) ? '' : rule.forMinutes}
                          onChange={(event) =>
                            onChange(
                              withChange(overrides, rule.id, {
                                forMinutes: event.target.valueAsNumber,
                              }),
                            )
                          }
                        />
                      </td>
                      <td>
                        <select
                          aria-label={`${t('Criticidade de', 'Criticality of')} ${rule.title}`}
                          value={rule.criticality}
                          onChange={(event) =>
                            onChange(
                              withChange(overrides, rule.id, {
                                criticality: event.target.value as HealthCriticality,
                              }),
                            )
                          }
                        >
                          {healthCriticalities.map((criticality) => (
                            <option key={criticality} value={criticality}>
                              {labels.criticality[criticality]}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="button button-secondary align-start"
        disabled={changed === 0}
        onClick={() => onChange({})}
      >
        {t('Repor valores do catálogo', 'Restore catalog defaults')}
        {changed > 0 ? ` (${changed} ${t('alteradas', 'changed')})` : ''}
      </button>
    </fieldset>
  );
}
