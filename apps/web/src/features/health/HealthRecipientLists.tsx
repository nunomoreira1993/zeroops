import type {
  HealthCheckView,
  HealthRecipientList,
  HealthRecipientTarget,
  HealthSettings,
} from '@zeroops/contracts';
import { useIdentityLocale } from '../../lib/identity';
import { healthLabels } from './health-labels';

export type RoutingDraft = Pick<HealthSettings, 'defaults' | 'routes'> & {
  lists: (Omit<HealthRecipientList, 'emails'> & { emailsText: string })[];
};

const targets: HealthRecipientTarget[] = [
  'urgente',
  'critica',
  'preventiva',
  'informativa',
  'report',
];

export const splitList = (value: string) =>
  value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

export function toRoutingDraft(settings: HealthSettings): RoutingDraft {
  return {
    defaults: settings.defaults,
    routes: settings.routes,
    lists: settings.lists.map(({ emails, ...list }) => ({
      ...list,
      emailsText: emails.join(', '),
    })),
  };
}

export function fromRoutingDraft(
  draft: RoutingDraft,
): Pick<HealthSettings, 'lists' | 'defaults' | 'routes'> {
  return {
    defaults: draft.defaults,
    routes: Object.fromEntries(Object.entries(draft.routes).filter(([, ids]) => ids.length)),
    lists: draft.lists.map(({ emailsText, ...list }) => ({
      ...list,
      emails: splitList(emailsText),
    })),
  };
}

/** Identificador estavel a partir do nome (minúsculas, sem acentos). */
function slug(name: string, taken: Set<string>) {
  const base =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'lista';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

const toggle = (values: string[], id: string) =>
  values.includes(id) ? values.filter((item) => item !== id) : [...values, id];

/**
 * Listas de distribuicao e encaminhamento: cada alarme usa as listas marcadas na sua linha ou,
 * sem nenhuma, as listas por defeito da sua criticidade.
 */
export function HealthRecipientLists({
  draft,
  checks,
  onChange,
}: {
  draft: RoutingDraft;
  checks: HealthCheckView[];
  onChange: (draft: RoutingDraft) => void;
}) {
  const { locale, t } = useIdentityLocale();
  const { criticality: criticalityLabels } = healthLabels(locale);
  const targetLabel = (target: HealthRecipientTarget) =>
    target === 'report' ? t('Relatório periódico', 'Periodic report') : criticalityLabels[target];
  const ids = draft.lists.map((list) => list.id);
  const updateList = (index: number, patch: Partial<RoutingDraft['lists'][number]>) =>
    onChange({
      ...draft,
      lists: draft.lists.map((list, position) =>
        position === index ? { ...list, ...patch } : list,
      ),
    });
  const removeList = (id: string) =>
    onChange({
      lists: draft.lists.filter((list) => list.id !== id),
      defaults: Object.fromEntries(
        Object.entries(draft.defaults).map(([target, values]) => [
          target,
          values.filter((item) => item !== id),
        ]),
      ) as HealthSettings['defaults'],
      routes: Object.fromEntries(
        Object.entries(draft.routes).map(([checkId, values]) => [
          checkId,
          values.filter((item) => item !== id),
        ]),
      ),
    });
  const addList = () =>
    onChange({
      ...draft,
      lists: [
        ...draft.lists,
        { id: slug('nova lista', new Set(ids)), name: t('Nova lista', 'New list'), emailsText: '' },
      ],
    });

  return (
    <>
      <fieldset>
        <legend>{t('Listas de distribuição', 'Distribution lists')}</legend>
        {draft.lists.length === 0 && (
          <p className="health-muted">
            {t(
              'Ainda sem listas. Crie pelo menos uma para receber alertas.',
              'No lists yet. Create at least one to receive alerts.',
            )}
          </p>
        )}
        <div className="health-lists">
          {draft.lists.map((list, index) => (
            <div className="health-list-row" key={list.id}>
              <label>
                {t('Nome', 'Name')}
                <input
                  required
                  maxLength={80}
                  value={list.name}
                  onChange={(event) => updateList(index, { name: event.target.value })}
                />
              </label>
              <label className="health-list-emails">
                {t('E-mails', 'Emails')}
                <input
                  placeholder="email@ibersol.pt, …"
                  value={list.emailsText}
                  onChange={(event) => updateList(index, { emailsText: event.target.value })}
                />
              </label>
              <code className="health-muted" title={t('Identificador da lista', 'List identifier')}>
                {list.id}
              </code>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => removeList(list.id)}
              >
                {t('Remover', 'Remove')}
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="button button-secondary align-start" onClick={addList}>
          {t('Adicionar lista', 'Add list')}
        </button>
      </fieldset>

      {draft.lists.length > 0 && (
        <fieldset>
          <legend>{t('Encaminhamento', 'Routing')}</legend>
          <p className="health-muted">
            {t(
              'Por defeito cada criticidade envia para as listas marcadas em cima. Marcar listas num alarme substitui o defeito só para esse alarme.',
              'By default each criticality sends to the lists ticked above. Ticking lists on an alarm overrides the default for that alarm only.',
            )}
          </p>
          <div className="health-routing">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('Destino', 'Target')}</th>
                  {draft.lists.map((list) => (
                    <th scope="col" key={list.id}>
                      {list.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {targets.map((target) => (
                  <tr key={target} className="health-routing-default">
                    <th scope="row">
                      {t('Defeito', 'Default')} · {targetLabel(target)}
                    </th>
                    {draft.lists.map((list) => (
                      <td key={list.id}>
                        <input
                          type="checkbox"
                          aria-label={`${targetLabel(target)}: ${list.name}`}
                          checked={draft.defaults[target].includes(list.id)}
                          onChange={() =>
                            onChange({
                              ...draft,
                              defaults: {
                                ...draft.defaults,
                                [target]: toggle(draft.defaults[target], list.id),
                              },
                            })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                {checks.map((check) => (
                  <tr key={check.id}>
                    <th scope="row">
                      {check.title}{' '}
                      <span className="health-muted">({criticalityLabels[check.criticality]})</span>
                    </th>
                    {draft.lists.map((list) => (
                      <td key={list.id}>
                        <input
                          type="checkbox"
                          aria-label={`${check.title}: ${list.name}`}
                          checked={(draft.routes[check.id] ?? []).includes(list.id)}
                          onChange={() =>
                            onChange({
                              ...draft,
                              routes: {
                                ...draft.routes,
                                [check.id]: toggle(draft.routes[check.id] ?? [], list.id),
                              },
                            })
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </fieldset>
      )}
    </>
  );
}
