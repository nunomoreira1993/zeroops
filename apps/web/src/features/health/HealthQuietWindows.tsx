import {
  alertRuleCatalog,
  alertRuleGroups,
  healthProbes,
  healthWeekdays,
  type AlertRuleGroup,
  type HealthCheckView,
  type HealthQuietWindow,
} from '@zeroops/contracts';
import { useIdentityLocale, type Locale } from '../../lib/identity';
import { alertRuleGroupLabel, localizedAlertRule } from './HealthAlertRules';

const weekdayLabels: Record<number, string> = {
  0: 'Dom',
  1: 'Seg',
  2: 'Ter',
  3: 'Qua',
  4: 'Qui',
  5: 'Sex',
  6: 'Sáb',
};

const newWindow = (locale: Locale): HealthQuietWindow => ({
  name: locale === 'en' ? 'Planned downtime' : 'Paragem planeada',
  start: '01:00',
  end: '07:00',
  timezone: 'Europe/Lisbon',
  days: [...healthWeekdays],
  checks: [],
});

interface TargetGroup {
  title: string;
  targets: { id: string; label: string; hint?: string }[];
}

const targetGroups = (checks: HealthCheckView[], locale: Locale): TargetGroup[] => [
  {
    title: locale === 'en' ? 'ZeroOps checks' : 'Verificações do ZeroOps',
    targets: checks.map((check) => ({ id: check.id, label: check.title })),
  },
  ...(Object.keys(alertRuleGroups) as AlertRuleGroup[]).map((group) => ({
    title: `${locale === 'en' ? 'Alert rules' : 'Regras de alerta'}: ${alertRuleGroupLabel(group, locale)}`,
    targets: alertRuleCatalog
      .filter((rule) => rule.group === group)
      .map((rule) => ({
        id: `rule:${rule.id}`,
        label: localizedAlertRule(rule, locale).title,
        hint: rule.id,
      })),
  })),
  {
    title: locale === 'en' ? 'Server probes' : 'Sondas nos servidores',
    targets: healthProbes.map((probe) => ({
      id: `probe:${probe.id}`,
      label: locale === 'en' && probe.id === 'dtq' ? 'DTQ users probe (Production)' : probe.title,
      hint:
        locale === 'en' && probe.id === 'dtq'
          ? 'Login using the test account every 5 minutes; does not call the site while suspended.'
          : probe.description,
    })),
  },
];

/** Paragens planeadas: nos dias e horas escolhidos, os alvos não alertam nem notificam. */
export function HealthQuietWindows({
  windows,
  checks,
  onChange,
}: {
  windows: HealthQuietWindow[];
  checks: HealthCheckView[];
  onChange: (windows: HealthQuietWindow[]) => void;
}) {
  const { locale, t } = useIdentityLocale();
  const groups = targetGroups(checks, locale);
  const update = (index: number, patch: Partial<HealthQuietWindow>) =>
    onChange(windows.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  const toggleList = <T,>(list: readonly T[], value: T, on: boolean): T[] =>
    on ? [...list.filter((item) => item !== value), value] : list.filter((item) => item !== value);

  return (
    <fieldset>
      <legend>{t('Paragens planeadas', 'Planned downtime')}</legend>
      <p className="health-muted">
        {t(
          `Nos dias escolhidos, entre o início e o fim, os alvos marcados não enviam e-mails nem abrem
        tickets e as sondas ficam suspensas. Se o problema continuar quando a janela fechar, o
        alerta é enviado nessa altura. O painel continua a mostrar o estado real. Uma janela que
        passa da meia-noite (ex.: 23:00–07:00) pertence ao dia em que começa.`,
          'On the selected days, between the start and end times, selected targets do not send emails or open tickets, and probes are suspended. If the problem persists when the window closes, the alert is sent then. The dashboard continues to show the actual state. A window crossing midnight (e.g. 23:00–07:00) belongs to the day it starts.',
        )}
      </p>
      <div className="health-lists">
        {windows.map((window, index) => (
          <div className="health-quiet-window" key={index}>
            <div className="health-quiet-row">
              <label>
                {t('Nome', 'Name')}
                <input
                  required
                  maxLength={80}
                  value={window.name}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
              </label>
              <label>
                {t('Início', 'Start')}
                <input
                  type="time"
                  required
                  value={window.start}
                  onChange={(event) => update(index, { start: event.target.value })}
                />
              </label>
              <label>
                {t('Fim', 'End')}
                <input
                  type="time"
                  required
                  value={window.end}
                  onChange={(event) => update(index, { end: event.target.value })}
                />
              </label>
              <label>
                {t('Fuso horário', 'Time zone')}
                <input
                  required
                  maxLength={60}
                  value={window.timezone}
                  onChange={(event) => update(index, { timezone: event.target.value })}
                />
              </label>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => onChange(windows.filter((_, position) => position !== index))}
              >
                {t('Remover', 'Remove')}
              </button>
            </div>
            <div
              className="health-quiet-days"
              role="group"
              aria-label={t('Dias da semana', 'Days of the week')}
            >
              {healthWeekdays.map((day) => (
                <label className="health-inline" key={day}>
                  <input
                    type="checkbox"
                    checked={window.days.includes(day)}
                    onChange={(event) =>
                      update(index, { days: toggleList(window.days, day, event.target.checked) })
                    }
                  />
                  {locale === 'en'
                    ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]
                    : weekdayLabels[day]}
                </label>
              ))}
            </div>
            {groups.map(
              (group) =>
                group.targets.length > 0 && (
                  <details
                    className="health-quiet-group"
                    key={group.title}
                    open={group.targets.some((target) => window.checks.includes(target.id))}
                  >
                    <summary>
                      {group.title}{' '}
                      <span className="health-muted">
                        ({group.targets.filter((t) => window.checks.includes(t.id)).length}/
                        {group.targets.length})
                      </span>
                    </summary>
                    <div className="health-quiet-checks" role="group" aria-label={group.title}>
                      {group.targets.map((target) => (
                        <label className="health-inline" key={target.id} title={target.hint}>
                          <input
                            type="checkbox"
                            checked={window.checks.includes(target.id)}
                            onChange={(event) =>
                              update(index, {
                                checks: toggleList(window.checks, target.id, event.target.checked),
                              })
                            }
                          />
                          {target.label}
                        </label>
                      ))}
                    </div>
                  </details>
                ),
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="button button-secondary align-start"
        onClick={() => onChange([...windows, newWindow(locale)])}
      >
        {t('Adicionar paragem', 'Add downtime')}
      </button>
    </fieldset>
  );
}
