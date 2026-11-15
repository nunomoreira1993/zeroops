import {
  conditionBranches,
  flowConditionFields,
  flowConditionOperators,
  type FlowCondition,
  type FlowConditionBranch,
  type FlowNode,
} from '@zeroops/contracts';
import { useIdentityLocale } from '../../lib/identity';

/** Configuração inicial de uma etapa «Condição (V2)»: um ramo e o caminho «caso contrário». */
export function newConditionConfig(): Record<string, unknown> {
  return {
    branches: [
      {
        port: 'critico',
        label: 'Crítico',
        conditions: [{ field: 'ticket.priority', operator: 'equals', value: 'critical' }],
      },
    ],
  };
}

const fieldLabels: Record<(typeof flowConditionFields)[number], { pt: string; en: string }> = {
  'ticket.origin': { pt: 'Origem do ticket', en: 'Ticket origin' },
  'ticket.category': { pt: 'Tipo do ticket', en: 'Ticket type' },
  'ticket.environment': { pt: 'Ambiente', en: 'Environment' },
  'ticket.priority': { pt: 'Prioridade', en: 'Priority' },
  'previous.result': { pt: 'Resultado da etapa anterior', en: 'Previous step result' },
  'previous.port': { pt: 'Saída da etapa anterior', en: 'Previous step output' },
};

const operatorLabels: Record<(typeof flowConditionOperators)[number], { pt: string; en: string }> =
  {
    equals: { pt: 'é igual a', en: 'equals' },
    not_equals: { pt: 'é diferente de', en: 'is not' },
    in: { pt: 'é um de', en: 'is one of' },
    not_in: { pt: 'não é nenhum de', en: 'is none of' },
  };

const listOperator = (operator: FlowCondition['operator']) =>
  operator === 'in' || operator === 'not_in';

/**
 * Ramos de uma condição declarativa: cada ramo é uma saída com nome e todas as comparações têm
 * de ser verdadeiras; sem coincidência segue «caso contrário». Não há expressões livres.
 */
export function ConditionConfig({
  node,
  setConfig,
}: {
  node: FlowNode;
  setConfig: (key: string, value: unknown) => void;
}) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const raw = Array.isArray(node.config.branches)
    ? (node.config.branches as FlowConditionBranch[])
    : conditionBranches(node.config);
  const setBranches = (next: FlowConditionBranch[]) => setConfig('branches', next);
  const setBranch = (index: number, changes: Partial<FlowConditionBranch>) =>
    setBranches(raw.map((item, at) => (at === index ? { ...item, ...changes } : item)));
  const setCondition = (branch: number, index: number, condition: FlowCondition) =>
    setBranch(branch, {
      conditions: raw[branch]!.conditions.map((item, at) => (at === index ? condition : item)),
    });

  return (
    <fieldset className="flow-fieldset stack">
      <legend>
        {t(
          'Ramos (o primeiro que coincidir; sem coincidência segue «caso contrário»)',
          'Branches (first match wins; otherwise follows «otherwise»)',
        )}
      </legend>
      {raw.map((branch, branchIndex) => (
        <div key={branchIndex} className="flow-condition-branch stack">
          <div className="flow-option-row">
            <input
              aria-label={t('Nome da saída', 'Output name')}
              value={branch.port}
              maxLength={32}
              pattern="[a-z][a-z0-9_]*"
              onChange={(event) =>
                setBranch(branchIndex, { port: event.target.value.toLowerCase() })
              }
            />
            <input
              aria-label={t('Texto da saída', 'Output label')}
              value={branch.label ?? ''}
              maxLength={80}
              onChange={(event) =>
                setBranch(branchIndex, { label: event.target.value || undefined })
              }
            />
            {raw.length > 1 && (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setBranches(raw.filter((_, at) => at !== branchIndex))}
              >
                {t('Remover ramo', 'Remove branch')}
              </button>
            )}
          </div>
          {branch.conditions.map((condition, index) => (
            <div key={index} className="flow-option-row">
              <select
                aria-label={t('Facto', 'Fact')}
                value={condition.field}
                onChange={(event) =>
                  setCondition(branchIndex, index, {
                    ...condition,
                    field: event.target.value as FlowCondition['field'],
                  })
                }
              >
                {flowConditionFields.map((field) => (
                  <option key={field} value={field}>
                    {fieldLabels[field][lang]}
                  </option>
                ))}
              </select>
              <select
                aria-label={t('Operador', 'Operator')}
                value={condition.operator}
                onChange={(event) => {
                  const operator = event.target.value as FlowCondition['operator'];
                  const values = condition.values ?? (condition.value ? [condition.value] : []);
                  setCondition(
                    branchIndex,
                    index,
                    listOperator(operator)
                      ? { field: condition.field, operator, values }
                      : { field: condition.field, operator, value: values[0] ?? '' },
                  );
                }}
              >
                {flowConditionOperators.map((operator) => (
                  <option key={operator} value={operator}>
                    {operatorLabels[operator][lang]}
                  </option>
                ))}
              </select>
              <input
                aria-label={t('Valor(es)', 'Value(s)')}
                value={
                  listOperator(condition.operator)
                    ? (condition.values ?? []).join(', ')
                    : (condition.value ?? '')
                }
                placeholder={listOperator(condition.operator) ? 'high, critical' : 'critical'}
                onChange={(event) => {
                  const text = event.target.value;
                  setCondition(
                    branchIndex,
                    index,
                    listOperator(condition.operator)
                      ? {
                          field: condition.field,
                          operator: condition.operator,
                          values: text
                            .split(',')
                            .map((item) => item.trim())
                            .filter(Boolean),
                        }
                      : { field: condition.field, operator: condition.operator, value: text },
                  );
                }}
              />
              {branch.conditions.length > 1 && (
                <button
                  type="button"
                  className="button button-secondary"
                  aria-label={t('Remover comparação', 'Remove comparison')}
                  onClick={() =>
                    setBranch(branchIndex, {
                      conditions: branch.conditions.filter((_, at) => at !== index),
                    })
                  }
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="button button-secondary align-start"
            onClick={() =>
              setBranch(branchIndex, {
                conditions: [
                  ...branch.conditions,
                  { field: 'ticket.category', operator: 'equals', value: 'incident' },
                ],
              })
            }
          >
            {t('+ Comparação (E)', '+ Comparison (AND)')}
          </button>
        </div>
      ))}
      {raw.length < 8 && (
        <button
          type="button"
          className="button button-secondary align-start"
          onClick={() => {
            const used = new Set(raw.map((item) => item.port));
            let index = raw.length + 1;
            while (used.has(`ramo_${index}`)) index += 1;
            setBranches([
              ...raw,
              {
                port: `ramo_${index}`,
                label: t(`Ramo ${index}`, `Branch ${index}`),
                conditions: [
                  { field: 'ticket.environment', operator: 'equals', value: 'production' },
                ],
              },
            ]);
          }}
        >
          {t('+ Ramo', '+ Branch')}
        </button>
      )}
    </fieldset>
  );
}
