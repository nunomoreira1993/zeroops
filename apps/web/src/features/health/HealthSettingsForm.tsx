import { useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import type { HealthOverview, HealthSettings } from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { REVEAL_FIELD_EVENT } from '../../lib/form-validation';
import { useMutation } from '../../lib/hooks';
import { useProjectSession } from '../../lib/project-admin';
import { useIdentityLocale } from '../../lib/identity';
import {
  fromRoutingDraft,
  HealthRecipientLists,
  splitList,
  toRoutingDraft,
} from './HealthRecipientLists';
import { thresholdBounds, healthLabels, numberValue } from './health-labels';
import { HealthTabBar, type HealthTab } from './HealthTabs';
import { HealthQuietWindows } from './HealthQuietWindows';

type SettingsTab = 'geral' | 'paragens' | 'destinatarios' | 'limites' | 'agente';
const settingsTabs: HealthTab<SettingsTab>[] = [
  { id: 'geral', label: 'Geral e URLs' },
  { id: 'paragens', label: 'Paragens planeadas' },
  { id: 'destinatarios', label: 'Destinatários' },
  { id: 'limites', label: 'Limites' },
  { id: 'agente', label: 'Agente do servidor' },
];

/** Configuracao da monitorizacao (apenas administradores). */
export function HealthSettingsForm({
  overview,
  onSaved,
}: {
  overview: HealthOverview;
  onSaved: () => void;
}) {
  const { locale, t } = useIdentityLocale();
  const labels = healthLabels(locale);
  const tabLabels: Record<SettingsTab, string> = {
    geral: t('Geral e URLs', 'General and URLs'),
    paragens: t('Paragens planeadas', 'Planned downtime'),
    destinatarios: t('Destinatários', 'Recipients'),
    limites: t('Limites', 'Limits'),
    agente: t('Agente do servidor', 'Server agent'),
  };
  const { request } = useProjectSession();
  const mutation = useMutation();
  const [draft, setDraft] = useState<HealthSettings>(overview.settings);
  const [apiUrls, setApiUrls] = useState(overview.settings.apiUrls.join('\n'));
  const [routing, setRouting] = useState(() => toRoutingDraft(overview.settings));
  const [token, setToken] = useState<string | null>(null);
  const [tab, setTab] = useState<SettingsTab>('geral');
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const reveal = (event: Event) => {
      const panelId = (event.target as HTMLElement).closest('[role="tabpanel"]')?.id;
      const next = settingsTabs.find((item) => panelId === `health-settings-panel-${item.id}`);
      if (next) flushSync(() => setTab(next.id));
    };
    form.addEventListener(REVEAL_FIELD_EVENT, reveal);
    return () => form.removeEventListener(REVEAL_FIELD_EVENT, reveal);
  }, []);
  const panel = (id: SettingsTab) => ({
    id: `health-settings-panel-${id}`,
    role: 'tabpanel',
    'aria-labelledby': `health-settings-tab-${id}`,
    className: 'health-settings-panel',
    hidden: tab !== id,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void mutation.run(async () => {
      const body: HealthSettings = {
        ...draft,
        siteUrl: draft.siteUrl || undefined,
        appUrl: draft.appUrl || undefined,
        apiUrls: splitList(apiUrls),
        ...fromRoutingDraft(routing),
      };
      await request<HealthOverview>('/monitoring/settings', { method: 'POST', body });
      onSaved();
    });
  };

  const rotate = () =>
    void mutation.run(async () => {
      const result = await request<{ token: string }>('/monitoring/agent-token', {
        method: 'POST',
      });
      setToken(result.token);
    });

  return (
    <form ref={formRef} className="panel health-settings" onSubmit={submit}>
      <div className="section-heading">
        <h2>{t('Configuração', 'Settings')}</h2>
      </div>
      {mutation.error && <Notice>{mutation.error}</Notice>}

      <HealthTabBar
        tabs={settingsTabs.map((item) => ({ ...item, label: tabLabels[item.id] }))}
        active={tab}
        onSelect={setTab}
        idPrefix="health-settings"
        label={t('Secções da configuração', 'Settings sections')}
        variant="sub"
      />

      <div {...panel('geral')}>
        <fieldset>
          <legend>{t('Geral', 'General')}</legend>
          <label className="health-inline">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            {t(
              'Monitorização ativa (ciclo a cada minuto no worker)',
              'Monitoring enabled (worker cycle every minute)',
            )}
          </label>
          <div className="health-form-grid">
            <label>
              {t('Dados recolhidos de', 'Data collected from')}
              <select
                value={draft.sourceEnvironment}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    sourceEnvironment: event.target.value as HealthSettings['sourceEnvironment'],
                  })
                }
              >
                <option value="production">{t('Produção', 'Production')}</option>
                <option value="quality">{t('Qualidade', 'Quality')}</option>
              </select>
            </label>
            <label>
              {t('Hora do relatório diário (UTC)', 'Daily report hour (UTC)')}
              <input
                type="number"
                required
                min={0}
                max={23}
                step={1}
                value={numberValue(draft.reportHourUtc)}
                onChange={(event) =>
                  setDraft({ ...draft, reportHourUtc: event.target.valueAsNumber })
                }
              />
            </label>
            <label>
              {t('Seletor LogQL dos logs PHP', 'PHP logs LogQL selector')}
              <input
                required
                maxLength={200}
                pattern="\{.*\}"
                title={t(
                  'O seletor LogQL começa por { e termina em }.',
                  'The LogQL selector starts with { and ends with }.',
                )}
                value={draft.logSelector}
                onChange={(event) => setDraft({ ...draft, logSelector: event.target.value })}
              />
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>{t('Monitorização externa', 'External monitoring')}</legend>
          <div className="health-form-grid">
            <label>
              {t('URL do site', 'Site URL')}
              <input
                type="url"
                placeholder="https://encomendar.pizzahut.pt/"
                value={draft.siteUrl ?? ''}
                onChange={(event) => setDraft({ ...draft, siteUrl: event.target.value })}
              />
            </label>
            <label>
              {t('URL da app', 'App URL')}
              <input
                type="url"
                value={draft.appUrl ?? ''}
                onChange={(event) => setDraft({ ...draft, appUrl: event.target.value })}
              />
            </label>
            <label className="health-span">
              {t('URLs de APIs (um por linha)', 'API URLs (one per line)')}
              <textarea
                rows={3}
                value={apiUrls}
                onChange={(event) => setApiUrls(event.target.value)}
              />
            </label>
          </div>
        </fieldset>
      </div>

      <div {...panel('paragens')}>
        <HealthQuietWindows
          windows={draft.quietWindows}
          checks={overview.checks}
          onChange={(quietWindows) => setDraft({ ...draft, quietWindows })}
        />
      </div>

      <div {...panel('destinatarios')}>
        <HealthRecipientLists draft={routing} checks={overview.checks} onChange={setRouting} />
        {Object.values(draft.recipients).some((emails) => emails.length > 0) && (
          <p className="health-muted">
            {t(
              'Existem também e-mails diretos por criticidade (formato anterior), que continuam a receber os alertas além das listas.',
              'There are also direct email recipients by criticality (legacy format), who continue to receive alerts in addition to the lists.',
            )}
          </p>
        )}
      </div>

      <div {...panel('limites')}>
        <fieldset>
          <legend>{t('Limites', 'Limits')}</legend>
          <div className="health-form-grid">
            {labels.thresholdFields.map((field) => {
              const bounds = thresholdBounds(field.key);
              return (
                <label key={field.key}>
                  {field.label}
                  <input
                    type="number"
                    required
                    min={bounds.min}
                    max={bounds.max}
                    step={field.step ?? 1}
                    value={numberValue(draft.thresholds[field.key])}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        thresholds: {
                          ...draft.thresholds,
                          [field.key]: event.target.valueAsNumber,
                        },
                      })
                    }
                  />
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div {...panel('agente')}>
        <fieldset>
          <legend>{t('Agente do servidor', 'Server agent')}</legend>
          <p className="health-muted">
            {overview.agentTokenConfigured
              ? t(
                  'Token configurado. Gerar um novo invalida o anterior.',
                  'Token configured. Generating a new one invalidates the previous token.',
                )
              : t(
                  'Ainda sem token. Gere-o e coloque-o em /etc/zeroops-health/health-agent.env no servidor.',
                  'No token yet. Generate one and place it in /etc/zeroops-health/health-agent.env on the server.',
                )}
          </p>
          {token && (
            <Notice tone="warning">
              {t(
                'Copie agora, não volta a ser mostrado:',
                'Copy it now; it will not be shown again:',
              )}{' '}
              <code className="health-token">{token}</code>
            </Notice>
          )}
          <button
            type="button"
            className="button button-secondary align-start"
            disabled={mutation.busy}
            onClick={rotate}
          >
            {t('Gerar token do agente', 'Generate agent token')}
          </button>
        </fieldset>
      </div>

      <button type="submit" className="button button-primary align-start" disabled={mutation.busy}>
        {t('Gravar configuração', 'Save settings')}
      </button>
    </form>
  );
}
