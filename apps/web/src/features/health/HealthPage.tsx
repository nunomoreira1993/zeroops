import { useState } from 'react';
import type { HealthOverview } from '@zeroops/contracts';
import { Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { useMutation, useResource, useRoute } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { HealthChartsTab } from './charts/HealthChartsTab';
import { HealthHistoryPanel, HealthNotificationLog } from './HealthHistory';
import { HealthIncidentPolicy } from './HealthIncidentPolicy';
import { HealthIncidentDemo } from './HealthIncidentDemo';
import { HealthAlerts, HealthSummary } from './HealthPanels';
import { HealthAlertingTab } from './HealthAlertingTab';
import { HealthSettingsForm } from './HealthSettingsForm';
import { HealthSuspensionBanner, HealthSuspensionPanel } from './HealthSuspension';
import { HealthTabBar, healthHref, parseHealthRoute, type HealthSection } from './HealthTabs';
import { formatDate } from './health-labels';

function tabs(data: HealthOverview, t: (pt: string, en: string) => string) {
  const active = data.alerts.filter((alert) => alert.state !== 'resolved').length;
  const failing = data.checks.filter(
    (check) => check.status === 'warning' || check.status === 'critical',
  ).length;
  return [
    { id: 'resumo' as const, label: t('Resumo', 'Summary'), badge: active },
    { id: 'alarmistica' as const, label: t('Alarmística', 'Alerting'), badge: failing },
    { id: 'graficos' as const, label: t('Gráficos', 'Charts') },
    { id: 'historico' as const, label: t('Histórico', 'History') },
    { id: 'notificacoes' as const, label: t('Notificações', 'Notifications') },
    ...(data.canManage
      ? [{ id: 'configuracao' as const, label: t('Configuração', 'Settings') }]
      : []),
  ];
}

/** Pagina Saude, organizada em tabs: resumo, alarmistica, historico, notificacoes e configuracao. */
export function HealthPage() {
  const { request } = useSession();
  const { locale, t } = useIdentityLocale();
  const { section, check } = parseHealthRoute(useRoute());
  const overview = useResource<HealthOverview>('/monitoring', 60000);
  const action = useMutation();
  const data = overview.data;
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'success' | 'warning'>('success');
  const visible: HealthSection =
    section === 'configuracao' && !data?.canManage ? 'resumo' : section;

  const trigger = (path: string, done: string) =>
    void action.run(async () => {
      setMessage(null);
      await request(path, { method: 'POST' });
      setMessageTone('success');
      setMessage(done);
      overview.reload();
    });

  const sendReport = () =>
    void action.run(async () => {
      setMessage(null);
      const result = await request<{
        state?: 'pending' | 'sent' | 'failed' | 'blocked';
        status?: 'not_queued';
      }>('/monitoring/report', { method: 'POST' });
      if (result.state === 'sent') {
        setMessageTone('success');
        setMessage(
          t('O servidor SMTP aceitou o relatório.', 'The SMTP server accepted the report.'),
        );
      } else {
        setMessageTone('warning');
        setMessage(
          result.state === 'pending'
            ? t(
                'Relatório em fila; o envio ainda não foi confirmado.',
                'Report queued; delivery not yet confirmed.',
              )
            : t(
                'O relatório não foi enviado. Verifique a integração SMTP e os destinatários.',
                'The report was not sent. Check the SMTP integration and recipients.',
              ),
        );
      }
      overview.reload();
    });

  return (
    <div className="stack health-page">
      <PageHeader
        title={t('Saúde', 'Health')}
        description={t(
          'Estado da plataforma do projeto, alertas por criticidade e envio de notificações.',
          'Project platform status, alerts by criticality and notification delivery.',
        )}
        action={
          data?.canManage && data.configured ? (
            <div className="health-actions">
              <button
                className="button button-secondary"
                disabled={action.busy}
                onClick={sendReport}
              >
                {t('Enviar relatório', 'Send report')}
              </button>
              <button
                className="button button-primary"
                disabled={action.busy}
                onClick={() =>
                  trigger('/monitoring/run', t('Verificação executada.', 'Check completed.'))
                }
              >
                {t('Executar agora', 'Run now')}
              </button>
            </div>
          ) : undefined
        }
      />
      {action.error && <Notice>{action.error}</Notice>}
      {message && <Notice tone={messageTone}>{message}</Notice>}
      {overview.error && <ResourceError error={overview.error} retry={overview.reload} />}
      {!data && !overview.error && <Loading label={t('A carregar o estado…', 'Loading status…')} />}
      {data && (
        <>
          {!data.configured && (
            <Notice tone="info">
              {t(
                'A monitorização ainda não está configurada.',
                'Monitoring is not configured yet.',
              )}{' '}
              {data.canManage
                ? t(
                    'Preencha a tab Configuração e ative-a.',
                    'Fill in the Settings tab and enable it.',
                  )
                : t(
                    'Peça a um administrador para a configurar.',
                    'Ask an administrator to configure it.',
                  )}
            </Notice>
          )}
          {data.suspension && <HealthSuspensionBanner state={data.suspension} />}
          {data.configured && !data.settings.enabled && (
            <Notice tone="warning">
              {t(
                'Monitorização desativada: o worker não executa ciclos.',
                'Monitoring disabled: the worker does not run cycles.',
              )}
            </Notice>
          )}
          <HealthTabBar
            tabs={tabs(data, t)}
            active={visible}
            onSelect={(id) => {
              window.location.hash = healthHref(id);
            }}
            idPrefix="health"
            label={t('Secções da Saúde', 'Health sections')}
          />
          <div
            id={`health-panel-${visible}`}
            role="tabpanel"
            aria-labelledby={`health-tab-${visible}`}
            className="stack health-page health-tab-panel"
          >
            {visible === 'resumo' && (
              <>
                <p className="health-muted">
                  {t('Último ciclo', 'Last cycle')}: {formatDate(data.lastCycleAt, locale)} ·{' '}
                  {t('Último relatório', 'Last report')}: {formatDate(data.lastReportAt, locale)} ·{' '}
                  {t('Última amostra do agente', 'Last agent sample')}:{' '}
                  {formatDate(data.lastAgentSampleAt, locale)}
                </p>
                <HealthSummary checks={data.checks} />
                <HealthAlerts
                  alerts={data.alerts.filter((alert) => alert.state !== 'resolved')}
                  members={data.members}
                  onChange={overview.reload}
                />
                {data.suspension && (
                  <HealthSuspensionPanel
                    state={data.suspension}
                    canManage={data.canManage}
                    onChange={(done) => {
                      setMessageTone('success');
                      setMessage(done);
                      overview.reload();
                    }}
                  />
                )}
              </>
            )}
            {visible === 'alarmistica' && (
              <HealthAlertingTab
                overview={data}
                onSaved={() => {
                  setMessageTone('success');
                  setMessage(t('Regras de alerta gravadas.', 'Alert rules saved.'));
                  overview.reload();
                }}
              />
            )}
            {visible === 'graficos' && <HealthChartsTab />}
            {visible === 'historico' && <HealthHistoryPanel checks={data.checks} check={check} />}
            {visible === 'notificacoes' && <HealthNotificationLog />}
            {visible === 'configuracao' && (
              <>
                <HealthSettingsForm
                  overview={data}
                  onSaved={() => {
                    setMessageTone('success');
                    setMessage(t('Configuração gravada.', 'Settings saved.'));
                    overview.reload();
                  }}
                />
                <HealthIncidentPolicy
                  onSaved={(done) => {
                    setMessageTone('success');
                    setMessage(done);
                  }}
                />
                {data.canManage && <HealthIncidentDemo />}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
