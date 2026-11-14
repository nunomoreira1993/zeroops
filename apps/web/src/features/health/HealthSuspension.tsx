import { useState } from 'react';
import {
  incidentEnvironments,
  type HealthSuspensionState,
  type IncidentEnvironmentKey,
} from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { IdentityDialog } from '../auth/IdentityForms';
import { formatDate } from './health-labels';

const environmentLabel = (env: IncidentEnvironmentKey, t: (pt: string, en: string) => string) =>
  env === 'production' ? t('Produção', 'Production') : t('Qualidade', 'Quality');

/** Faixa no topo da Saúde quando algum ambiente está suspenso. */
export function HealthSuspensionBanner({ state }: { state: HealthSuspensionState }) {
  const { locale, t } = useIdentityLocale();
  const active = incidentEnvironments.flatMap((env) => {
    const item = state.active[env];
    return item ? [item] : [];
  });
  if (active.length === 0) return null;
  return (
    <Notice tone="warning">
      {active.map((item) => (
        <span className="health-suspension-line" key={item.id}>
          <strong>
            {t('Saúde suspensa em', 'Health suspended in')} {environmentLabel(item.environment, t)}
          </strong>{' '}
          · {item.reason} · {item.suspendedBy} · {formatDate(item.suspendedAt, locale)}.{' '}
          {t(
            'Os alertas ficam só registados; não há sondas, tickets, intervenções nem e-mails.',
            'Alerts are only recorded; no probes, tickets, interventions or emails.',
          )}
        </span>
      ))}
    </Notice>
  );
}

/** Suspender/retomar os processos automáticos da Saúde por ambiente, com histórico. */
export function HealthSuspensionPanel({
  state,
  canManage,
  onChange,
}: {
  state: HealthSuspensionState;
  canManage: boolean;
  onChange: (message: string) => void;
}) {
  const { request } = useSession();
  const { locale, t } = useIdentityLocale();
  const mutation = useMutation();
  const [target, setTarget] = useState<IncidentEnvironmentKey | null>(null);
  const [reason, setReason] = useState('');

  const resume = (environment: IncidentEnvironmentKey) =>
    void mutation.run(async () => {
      await request('/monitoring/resume', { method: 'POST', body: { environment } });
      onChange(
        t(
          `Saúde retomada em ${environmentLabel(environment, t)}.`,
          `Health resumed in ${environmentLabel(environment, t)}.`,
        ),
      );
    });

  const suspend = (environment: IncidentEnvironmentKey) =>
    void mutation.run(async () => {
      await request('/monitoring/suspend', {
        method: 'POST',
        body: { environment, reason: reason.trim() },
      });
      setTarget(null);
      setReason('');
      onChange(
        t(
          `Saúde suspensa em ${environmentLabel(environment, t)}.`,
          `Health suspended in ${environmentLabel(environment, t)}.`,
        ),
      );
    });

  return (
    <section className="panel stack health-suspension" aria-labelledby="health-suspension-title">
      <h2 id="health-suspension-title">{t('Processos automáticos', 'Automatic processes')}</h2>
      <p className="health-muted">
        {t(
          'Suspender pára as sondas, os ciclos de verificação, a abertura de tickets, o Copilot e as intervenções nos servidores do ambiente. O trabalho em curso é cancelado de imediato. Os alertas continuam a ser registados. A retoma é manual.',
          'Suspending stops probes, check cycles, ticket creation, Copilot and server interventions for the environment. Work in progress is cancelled immediately. Alerts are still recorded. Resuming is manual.',
        )}
      </p>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <div className="health-suspension-envs">
        {incidentEnvironments.map((env) => {
          const active = state.active[env];
          return (
            <div
              className={`health-suspension-env${active ? ' is-suspended' : ''}`}
              key={env}
              data-testid={`health-suspension-${env}`}
            >
              <div>
                <strong>{environmentLabel(env, t)}</strong>
                <span className="health-muted">
                  {active
                    ? `${t('Suspensa desde', 'Suspended since')} ${formatDate(active.suspendedAt, locale)}`
                    : t('Ativa', 'Active')}
                </span>
              </div>
              {canManage &&
                (active ? (
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={mutation.busy}
                    onClick={() => resume(env)}
                  >
                    {t('Retomar', 'Resume')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button-danger"
                    disabled={mutation.busy}
                    onClick={() => setTarget(env)}
                  >
                    {t('Suspender', 'Suspend')}
                  </button>
                ))}
            </div>
          );
        })}
      </div>
      {state.history.length > 0 && (
        <details className="health-suspension-history">
          <summary>{t('Histórico de suspensões', 'Suspension history')}</summary>
          <table className="identity-table">
            <thead>
              <tr>
                <th>{t('Ambiente', 'Environment')}</th>
                <th>{t('Motivo', 'Reason')}</th>
                <th>{t('Suspensa', 'Suspended')}</th>
                <th>{t('Retomada', 'Resumed')}</th>
                <th>{t('Runs cancelados', 'Cancelled runs')}</th>
              </tr>
            </thead>
            <tbody>
              {state.history.map((item) => (
                <tr key={item.id}>
                  <td>{environmentLabel(item.environment, t)}</td>
                  <td>{item.reason}</td>
                  <td>
                    {formatDate(item.suspendedAt, locale)} · {item.suspendedBy}
                  </td>
                  <td>
                    {item.resumedAt
                      ? `${formatDate(item.resumedAt, locale)} · ${item.resumedBy ?? ''}`
                      : '—'}
                  </td>
                  <td>{item.cancelledRuns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {target && (
        <IdentityDialog
          title={t(
            `Suspender a Saúde em ${environmentLabel(target, t)}`,
            `Suspend Health in ${environmentLabel(target, t)}`,
          )}
          busy={mutation.busy}
          onClose={() => {
            setTarget(null);
            setReason('');
          }}
        >
          <Notice tone="warning">
            {t(
              'O Copilot e as intervenções em curso são cancelados de imediato e nada volta a correr até retomar.',
              'Copilot and interventions in progress are cancelled immediately and nothing runs again until you resume.',
            )}
          </Notice>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              suspend(target);
            }}
          >
            <label>
              {t('Motivo', 'Reason')}
              <textarea
                required
                minLength={5}
                maxLength={500}
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('Ex.: manutenção do servidor web01', 'E.g. web01 maintenance')}
              />
            </label>
            <button
              type="submit"
              className="button button-danger"
              disabled={mutation.busy || reason.trim().length < 5}
            >
              {t('Suspender agora', 'Suspend now')}
            </button>
          </form>
        </IdentityDialog>
      )}
    </section>
  );
}
