import { useEffect, useState } from 'react';
import type { HealthOverview } from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { HealthAlertRules } from './HealthAlertRules';
import { HealthChecksTable } from './HealthPanels';

type AlertRules = HealthOverview['settings']['alertRules'];

export function HealthAlertingTab({
  overview,
  onSaved,
}: {
  overview: HealthOverview;
  onSaved: () => void;
}) {
  const { request } = useSession();
  const { t } = useIdentityLocale();
  const mutation = useMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AlertRules>(overview.settings.alertRules);

  useEffect(() => {
    if (!editing) setDraft(overview.settings.alertRules);
  }, [editing, overview.settings.alertRules]);

  const cancel = () => {
    setDraft(overview.settings.alertRules);
    setEditing(false);
  };

  const save = () =>
    void mutation.run(async () => {
      await request('/monitoring/settings', {
        method: 'POST',
        body: { ...overview.settings, alertRules: draft },
      });
      setEditing(false);
      onSaved();
    });

  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Checks</h2>
        {overview.canManage && !editing && (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setEditing(true)}
          >
            {t('Editar alarmística', 'Edit alerting')}
          </button>
        )}
      </div>
      {mutation.error && <Notice tone="error">{mutation.error}</Notice>}
      {overview.canManage && editing && (
        <>
          <HealthAlertRules overrides={draft} sync={overview.alertRulesSync} onChange={setDraft} />
          <div className="health-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={mutation.busy}
              onClick={cancel}
            >
              {t('Cancelar', 'Cancel')}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={mutation.busy}
              onClick={save}
            >
              {mutation.busy ? t('A gravar…', 'Saving…') : t('Gravar regras', 'Save rules')}
            </button>
          </div>
        </>
      )}
      <HealthChecksTable checks={overview.checks} canManage={overview.canManage} />
    </section>
  );
}
