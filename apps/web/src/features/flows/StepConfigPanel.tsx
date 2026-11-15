import {
  copilotMode,
  copilotStepModel,
  copilotTaskModes,
  decisionOnlyWhen,
  decisionOptions,
  endOutcome,
  flowActionCatalog,
  flowOperationKeys,
  flowOperationLabels,
  nodePorts,
  portLabel,
  type FlowAssignee,
  type FlowDecisionOption,
  type FlowDefinition,
  type FlowDetail,
  type FlowIssue,
  type FlowNode,
} from '@zeroops/contracts';
import { ticketLabels } from '../../lib/format';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectPermission } from '../../lib/project-admin';
import { roleLabels, ticketStatusOptions } from './flow-labels';
import { TechLogo, TechLogos, nodeTechs, techTitles } from './tech-logos';
import { AgentProfileStepConfig } from './AgentProfileStepConfig';
import { ConditionConfig, newConditionConfig } from './ConditionConfig';
import {
  DeliveryStepConfig,
  DevelopmentStepConfig,
  ReviewStepConfig,
} from './DevelopmentStepConfig';

const copilotModeLabels = {
  analysis: { pt: 'Análise', en: 'Analysis' },
  develop: { pt: 'Desenvolvimento (proposta de diff)', en: 'Development (diff proposal)' },
  report: { pt: 'Relatório', en: 'Report' },
};

/** Configuração da etapa selecionada; escreve na mesma definição que o desenho e o assistente. */
export function StepConfigPanel({
  definition,
  nodeId,
  members,
  issues,
  onChange,
  onClose,
}: {
  definition: FlowDefinition;
  nodeId: string;
  members: FlowDetail['members'];
  issues: FlowIssue[];
  onChange: (definition: FlowDefinition) => void;
  onClose: () => void;
}) {
  const { locale, t } = useIdentityLocale();
  const canEdit = useProjectPermission('flows.edit');
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const node = definition.nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  const statusLabels = ticketLabels(locale).status;

  const update = (changes: Partial<FlowNode>) => {
    const next = { ...node, ...changes };
    const ports = nodePorts(next);
    onChange({
      ...definition,
      nodes: definition.nodes.map((item) => (item.id === node.id ? next : item)),
      // Saídas que deixaram de existir perdem a ligação.
      edges: definition.edges.filter(
        (edge) => edge.source !== node.id || ports.includes(edge.port),
      ),
    });
  };
  const setConfig = (key: string, value: unknown) =>
    update({ config: { ...node.config, [key]: value } });
  const setConfigValues = (values: Record<string, unknown>) =>
    update({ config: { ...node.config, ...values } });
  const connect = (port: string, target: string) => {
    const kept = definition.edges.filter(
      (edge) => !(edge.source === node.id && edge.port === port),
    );
    const base = `${node.id}-${port}`.replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
    let id = base;
    for (let index = 2; kept.some((edge) => edge.id === id); index += 1) id = `${base}-${index}`;
    onChange({
      ...definition,
      edges: target ? [...kept, { id, source: node.id, port, target }] : kept,
    });
  };
  const remove = () =>
    onChange({
      ...definition,
      nodes: definition.nodes.filter((item) => item.id !== node.id),
      edges: definition.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id),
      layout: Object.fromEntries(
        Object.entries(definition.layout).filter(([id]) => id !== node.id),
      ),
    });
  const options = decisionOptions(node);
  const setOptions = (next: FlowDecisionOption[]) => setConfig('options', next);
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
  const assignee = node.assignee ?? null;
  const setAssignee = (value: FlowAssignee | null) => update({ assignee: value });

  return (
    <section
      className="panel flow-config stack"
      aria-label={t('Configurar etapa', 'Configure step')}
    >
      <div className="panel-heading">
        <h3>{node.label}</h3>
        <button type="button" className="button button-secondary" onClick={onClose}>
          {t('Fechar', 'Close')}
        </button>
      </div>
      {nodeIssues.length > 0 && (
        <ul className="flow-issues">
          {nodeIssues.map((issue, index) => (
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      )}
      <fieldset className="flow-fieldset stack" disabled={!canEdit}>
        <label>
          {t('Nome da etapa', 'Step name')}
          <input
            value={node.label}
            maxLength={120}
            onChange={(event) => update({ label: event.target.value })}
          />
        </label>
        <label>
          {t('Operação', 'Operation')}
          <select
            value={node.op}
            onChange={(event) => {
              const op = event.target.value as FlowNode['op'];
              const next: FlowNode = {
                ...node,
                op,
                config:
                  op === 'human_decision'
                    ? {
                        options: [
                          { port: 'success', label: t('Aprovar', 'Approve') },
                          {
                            port: 'failure',
                            label: t('Rejeitar', 'Reject'),
                            requiresComment: true,
                          },
                        ],
                      }
                    : op === 'action'
                      ? { action: 'internal_note', source: 'text', body: '' }
                      : op === 'end'
                        ? { outcome: 'resolved' }
                        : op === 'condition'
                          ? newConditionConfig()
                          : { mode: 'analysis' },
                ...(op === 'end' || op === 'action' || op === 'condition'
                  ? { assignee: null }
                  : {}),
              };
              const ports = nodePorts(next);
              // A condição é uma operação do contrato V2: o rascunho passa a declará-lo.
              onChange({
                ...definition,
                ...(op === 'condition' ? { schemaVersion: 2 as const } : {}),
                nodes: definition.nodes.map((item) => (item.id === node.id ? next : item)),
                edges: definition.edges.filter(
                  (edge) => edge.source !== node.id || ports.includes(edge.port),
                ),
              });
            }}
          >
            {flowOperationKeys.map((op) => (
              <option key={op} value={op}>
                {flowOperationLabels[op][lang]}
              </option>
            ))}
          </select>
        </label>

        {(node.op === 'human_decision' || node.op === 'copilot_task') && (
          <fieldset className="flow-fieldset">
            <legend>{t('Responsável', 'Owner')}</legend>
            <select
              aria-label={t('Tipo de responsável', 'Owner type')}
              value={assignee?.kind ?? 'team'}
              onChange={(event) => {
                const kind = event.target.value;
                setAssignee(
                  kind === 'role'
                    ? { kind: 'role', role: 'technical' }
                    : kind === 'user'
                      ? members[0]
                        ? { kind: 'user', userId: members[0].id, name: members[0].displayName }
                        : { kind: 'team' }
                      : kind === 'ticket_author'
                        ? { kind: 'ticket_author' }
                        : { kind: 'team' },
                );
              }}
            >
              <option value="team">{t('Equipa do projeto', 'Project team')}</option>
              <option value="role">{t('Papel no projeto', 'Project role')}</option>
              <option value="user">{t('Pessoa concreta', 'Specific person')}</option>
              <option value="ticket_author">{t('Autor do pedido', 'Ticket author')}</option>
            </select>
            {assignee?.kind === 'role' && (
              <select
                aria-label={t('Papel', 'Role')}
                value={assignee.role}
                onChange={(event) =>
                  setAssignee({
                    kind: 'role',
                    role: event.target.value as Extract<FlowAssignee, { kind: 'role' }>['role'],
                  })
                }
              >
                {Object.entries(roleLabels).map(([role, label]) => (
                  <option key={role} value={role}>
                    {label[lang]}
                  </option>
                ))}
              </select>
            )}
            {assignee?.kind === 'user' && (
              <select
                aria-label={t('Pessoa', 'Person')}
                value={assignee.userId}
                onChange={(event) => {
                  const member = members.find((item) => item.id === event.target.value);
                  if (member)
                    setAssignee({ kind: 'user', userId: member.id, name: member.displayName });
                }}
              >
                {!members.some((member) => member.id === assignee.userId) && (
                  <option value={assignee.userId}>
                    {assignee.name ?? t('Utilizador inexistente', 'Unknown user')}
                  </option>
                )}
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName} · {roleLabels[member.role]?.[lang] ?? member.role}
                  </option>
                ))}
              </select>
            )}
            {assignee?.kind === 'role' && (
              <p className="muted">
                {t(
                  'Usa a pessoa atribuída a esse papel no ticket ou, sem atribuição, os membros do projeto com esse papel.',
                  'Uses the person assigned to that role on the ticket or, if none, project members with that role.',
                )}
              </p>
            )}
          </fieldset>
        )}

        {node.op === 'copilot_task' && (
          <>
            <label>
              {t('Tipo de trabalho', 'Kind of work')}
              <select
                value={copilotMode(node)}
                onChange={(event) => setConfig('mode', event.target.value)}
              >
                {copilotTaskModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {copilotModeLabels[mode][lang]}
                  </option>
                ))}
              </select>
            </label>
            {copilotMode(node) === 'analysis' && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={node.config.askClient !== false}
                  onChange={(event) => setConfig('askClient', event.target.checked)}
                />
                {t(
                  'Pode perguntar ao cliente quando faltar informação',
                  'May ask the client when information is missing',
                )}
              </label>
            )}
            {!node.config.agentProfileId && (
              <CopilotModelConfig node={node} setConfig={setConfig} />
            )}
            <DevelopmentStepConfig node={node} setConfigValues={setConfigValues} />
          </>
        )}

        {(node.op === 'copilot_task' || node.op === 'human_decision') && (
          <label>
            {t('Instruções', 'Instructions')}
            <textarea
              rows={4}
              maxLength={3000}
              value={node.instructions ?? ''}
              onChange={(event) => update({ instructions: event.target.value || null })}
            />
          </label>
        )}

        {node.op === 'action' && <ActionConfig node={node} setConfig={setConfig} lang={lang} />}
        <DeliveryStepConfig node={node} definition={definition} setConfigValues={setConfigValues} />

        {node.op === 'condition' && <ConditionConfig node={node} setConfig={setConfig} />}

        {node.op !== 'end' && node.op !== 'condition' && (
          <TechConfig node={node} setConfig={setConfig} />
        )}

        <ReviewStepConfig
          node={node}
          definition={definition}
          members={members}
          setConfigValues={setConfigValues}
        />

        {node.op === 'human_decision' && (
          <fieldset className="flow-fieldset">
            <legend>
              {t(
                'Opções da decisão: sucesso (1.ª) e erro (2.ª)',
                'Decision options: success (1st) and failure (2nd)',
              )}
            </legend>
            {options.map((option, index) => (
              <div key={option.port} className="flow-option-row">
                <input
                  aria-label={t('Texto da opção', 'Option text')}
                  value={option.label}
                  maxLength={80}
                  onChange={(event) =>
                    setOptions(
                      options.map((item, at) =>
                        at === index ? { ...item, label: event.target.value } : item,
                      ),
                    )
                  }
                />
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={option.requiresComment === true}
                    onChange={(event) =>
                      setOptions(
                        options.map((item, at) =>
                          at === index ? { ...item, requiresComment: event.target.checked } : item,
                        ),
                      )
                    }
                  />
                  {t('comentário obrigatório', 'comment required')}
                </label>
                <select
                  aria-label={t('Visibilidade do comentário', 'Comment visibility')}
                  value={option.commentVisibility ?? 'internal'}
                  onChange={(event) =>
                    setOptions(
                      options.map((item, at) =>
                        at === index
                          ? {
                              ...item,
                              commentVisibility: event.target.value as 'internal' | 'public',
                            }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="internal">{t('interno', 'internal')}</option>
                  <option value="public">{t('para o cliente', 'to the client')}</option>
                </select>
              </div>
            ))}
            <label>
              {t(
                'Só pedir a decisão quando a etapa anterior terminar com (vazio = sempre)',
                'Only ask when the previous step ended with (empty = always)',
              )}
              <input
                value={decisionOnlyWhen(node).join(', ')}
                placeholder="needs_approval, manual"
                onChange={(event) =>
                  setConfig(
                    'onlyWhen',
                    event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                }
              />
            </label>
          </fieldset>
        )}

        {node.op === 'end' && (
          <label>
            {t('Resultado', 'Outcome')}
            <select
              value={endOutcome(node)}
              onChange={(event) => setConfig('outcome', event.target.value)}
            >
              <option value="resolved">{t('Resolvido', 'Resolved')}</option>
              <option value="cancelled">{t('Cancelado / recusado', 'Cancelled / rejected')}</option>
              <option value="escalated">{t('Escalado à equipa', 'Escalated to team')}</option>
            </select>
          </label>
        )}

        {node.op !== 'end' && (
          <label>
            {t('Estado do ticket nesta etapa', 'Ticket status at this step')}
            <select
              value={node.ticketStatus ?? ''}
              onChange={(event) =>
                update({
                  ticketStatus: (event.target.value || null) as FlowNode['ticketStatus'],
                })
              }
            >
              <option value="">{t('Automático', 'Automatic')}</option>
              {ticketStatusOptions.map((status) => (
                <option key={status} value={status}>
                  {statusLabels[status]}
                </option>
              ))}
            </select>
          </label>
        )}

        {node.op !== 'end' && (
          <label>
            {t('Máximo de passagens (ciclos)', 'Maximum visits (loops)')}
            <input
              type="number"
              min={1}
              max={50}
              value={Number(node.config.maxVisits) || ''}
              placeholder="6"
              onChange={(event) =>
                setConfig('maxVisits', event.target.value ? Number(event.target.value) : undefined)
              }
            />
          </label>
        )}

        {nodePorts(node).length > 0 && (
          <fieldset className="flow-fieldset">
            <legend>
              {t('Saídas → destino (ordem de execução)', 'Outputs → target (execution order)')}
            </legend>
            {nodePorts(node).map((port) => (
              <label key={port} className="flow-port-row">
                <span>{portLabel(node, port, lang)}</span>
                <select
                  value={
                    definition.edges.find((edge) => edge.source === node.id && edge.port === port)
                      ?.target ?? ''
                  }
                  onChange={(event) => connect(port, event.target.value)}
                >
                  <option value="">{t('— sem destino —', '— no target —')}</option>
                  {definition.nodes
                    .filter((item) => item.id !== node.id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </fieldset>
        )}

        <div className="flow-config-actions">
          {definition.start !== node.id && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onChange({ ...definition, start: node.id })}
            >
              {t('Definir como início', 'Set as start')}
            </button>
          )}
          {definition.start !== node.id && definition.nodes.length > 1 && (
            <button type="button" className="button button-danger" onClick={remove}>
              {t('Apagar etapa', 'Delete step')}
            </button>
          )}
        </div>
      </fieldset>
      {node.op === 'copilot_task' && (
        <AgentProfileStepConfig node={node} setConfigValues={setConfigValues} />
      )}
    </section>
  );
}

function CopilotModelConfig({
  node,
  setConfig,
}: {
  node: FlowNode;
  setConfig: (key: string, value: unknown) => void;
}) {
  const { t } = useIdentityLocale();
  const model = copilotStepModel(node);
  return (
    <fieldset className="flow-fieldset">
      <legend>{t('Modelo nesta etapa', 'Model in this step')}</legend>
      <label>
        {t('Execução', 'Execution')}
        <select
          value={model.executionMode ?? ''}
          onChange={(event) => setConfig('executionMode', event.target.value || undefined)}
        >
          <option value="">{t('A do projeto', 'Project default')}</option>
          <option value="copilot">Copilot</option>
          <option value="local">{t('Local', 'Local')}</option>
        </select>
      </label>
      <label>
        {t('Modelo', 'Model')}
        <input
          list="flow-step-models"
          maxLength={80}
          placeholder={t('vazio = o do projeto', 'empty = project default')}
          value={typeof node.config.model === 'string' ? node.config.model : ''}
          onChange={(event) => setConfig('model', event.target.value || undefined)}
        />
        <datalist id="flow-step-models">
          <option value="auto" />
          <option value="fusion" />
        </datalist>
      </label>
      {model.model === 'fusion' && (
        <label>
          {t('Nível Fusion', 'Fusion tier')}
          <select
            value={model.fusionTier ?? ''}
            onChange={(event) => setConfig('fusionTier', event.target.value || undefined)}
          >
            <option value="">{t('A do projeto', 'Project default')}</option>
            <option value="standard">Standard</option>
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
        </label>
      )}
      {model.model !== 'fusion' && (
        <label>
          {t('Esforço de raciocínio', 'Reasoning effort')}
          <select
            value={model.reasoningEffort ?? ''}
            onChange={(event) => setConfig('reasoningEffort', event.target.value || undefined)}
          >
            <option value="">{t('Por omissão', 'Default')}</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
          </select>
        </label>
      )}
    </fieldset>
  );
}

const techChoices = [
  'prometheus',
  'loki',
  'grafana',
  'linux',
  'mysql',
  'mariadb',
  'db2',
  'nginx',
  'apache',
  'php',
  'redis',
  'git',
  'svn',
  'disk',
  'memory',
  'cpu',
  'network',
  'http',
  'mail',
];

/** Logótipos da etapa no fluxograma (vazio = os da ação). */
function TechConfig({
  node,
  setConfig,
}: {
  node: FlowNode;
  setConfig: (key: string, value: unknown) => void;
}) {
  const { t } = useIdentityLocale();
  const custom = Array.isArray(node.config.engines);
  const current = nodeTechs(node);
  const toggle = (id: string, on: boolean) =>
    setConfig(
      'engines',
      on ? [...current.filter((item) => item !== id), id] : current.filter((item) => item !== id),
    );
  return (
    <details className="flow-fieldset flow-techs">
      <summary>
        {t('Tecnologias no fluxograma', 'Technologies on the flowchart')}{' '}
        <TechLogos ids={current} size={14} />
      </summary>
      <div className="flow-tech-grid">
        {techChoices.map((id) => (
          <label key={id} className="checkbox-row">
            <input
              type="checkbox"
              checked={current.includes(id)}
              onChange={(event) => toggle(id, event.target.checked)}
            />
            <TechLogo id={id} size={14} /> {techTitles[id] ?? id}
          </label>
        ))}
      </div>
      {custom && (
        <button
          type="button"
          className="button button-secondary align-start"
          onClick={() => setConfig('engines', undefined)}
        >
          {t('Repor os da ação', 'Reset to action defaults')}
        </button>
      )}
    </details>
  );
}

function ActionConfig({
  node,
  setConfig,
  lang,
}: {
  node: FlowNode;
  setConfig: (key: string, value: unknown) => void;
  lang: 'pt' | 'en';
}) {
  const { t } = useIdentityLocale();
  const key = typeof node.config.action === 'string' ? node.config.action : '';
  const descriptor = flowActionCatalog[key];
  return (
    <>
      <label>
        {t('Ação', 'Action')}
        <select value={key} onChange={(event) => setConfig('action', event.target.value)}>
          {!descriptor && <option value={key}>{t('— escolher —', '— choose —')}</option>}
          {Object.values(flowActionCatalog).map((item) => (
            <option key={item.key} value={item.key}>
              {item.label[lang]}
            </option>
          ))}
        </select>
      </label>
      {descriptor && <p className="muted">{descriptor.description[lang]}</p>}
      {descriptor?.external && <p className="flow-external">{descriptor.external[lang]}</p>}
      {key !== 'deliver' &&
        descriptor?.fields.map((field) => {
          const value = node.config[field.key];
          const label = `${field.label[lang]}${field.required ? ' *' : ''}`;
          if (field.kind === 'select')
            return (
              <label key={field.key}>
                {label}
                <select
                  value={typeof value === 'string' ? value : (field.options?.[0]?.value ?? '')}
                  onChange={(event) => setConfig(field.key, event.target.value)}
                >
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label[lang]}
                    </option>
                  ))}
                </select>
              </label>
            );
          if (field.kind === 'textarea')
            return (
              <label key={field.key}>
                {label}
                <textarea
                  rows={3}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => setConfig(field.key, event.target.value)}
                />
              </label>
            );
          if (field.kind === 'number')
            return (
              <label key={field.key}>
                {label}
                <input
                  type="number"
                  value={typeof value === 'number' ? value : ''}
                  onChange={(event) =>
                    setConfig(
                      field.key,
                      event.target.value ? Number(event.target.value) : undefined,
                    )
                  }
                />
              </label>
            );
          if (field.kind === 'boolean')
            return (
              <label key={field.key} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) => setConfig(field.key, event.target.checked)}
                />
                {label}
              </label>
            );
          return (
            <label key={field.key}>
              {label}
              <input
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => setConfig(field.key, event.target.value)}
              />
            </label>
          );
        })}
    </>
  );
}
