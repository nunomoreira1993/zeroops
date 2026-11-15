import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  flowRoutingExpectations,
  flowSimulationOutcomes,
  nodePorts,
  portLabel,
  type FlowActivationTestEvidence,
  type FlowDefinition,
  type FlowScenarioSpecInput,
  type FlowScenarioView,
  type FlowSimulationLevel,
  type FlowSimulationResultView,
  type FlowSimulationRunView,
  type FlowSimulationsView,
  type FlowStepFixture,
} from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectSession } from '../../lib/project-admin';
import type { CanvasMarks } from './FlowCanvas';
import { originLabels } from './flow-labels';

interface SimulationTicket {
  id: string;
  key: string;
  title: string;
  origin: string;
}

interface TrialDelivery {
  id: number;
  runId: string;
  nodeId: string;
  attempt: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const POLL_MS = 2000;

const levelLabels: Record<FlowSimulationLevel, { pt: string; en: string; hint: string }> = {
  structural: {
    pt: 'Validação estrutural',
    en: 'Structural validation',
    hint: 'Grafo, contratos, condições, referências, responsáveis e dependências.',
  },
  behavior: {
    pt: 'Simulação (fixtures)',
    en: 'Simulation (fixtures)',
    hint: 'Percorre o fluxo com os resultados do cenário; nenhuma operação externa é executada.',
  },
  routing_copilot: {
    pt: 'Avaliação Copilot real',
    en: 'Real Copilot evaluation',
    hint: 'Classifica o encaminhamento com o Copilot real; a resposta observada pode variar.',
  },
  isolated_trial: {
    pt: 'Ensaio isolado',
    en: 'Isolated trial',
    hint: 'Entrega mensagens e notas só no destino de teste do projeto; o resto fica indisponível.',
  },
};

const routingSourceLabels = {
  rules: 'regras',
  recorded: 'resposta gravada',
  copilot: 'Copilot real',
  none: 'sem candidatos',
} as const;

const staleLabels = {
  definition: 'definição',
  routing: 'encaminhamento',
  manifest: 'dependências',
  scenario: 'cenário',
} as const;

const emptySpec = (): FlowScenarioSpecInput => ({ steps: {}, expected: {} });

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** Marcas do desenho para o percurso de uma execução de teste. */
export function simulationMarks(result: FlowSimulationResultView): CanvasMarks {
  const nodes: CanvasMarks['nodes'] = {};
  const edges: CanvasMarks['edges'] = {};
  const counts: Record<string, number> = {};
  for (const step of result.steps) {
    nodes[step.nodeId] = 'done';
    counts[step.nodeId] = step.attempt;
    if (step.port) edges[`${step.nodeId}:${step.port}`] = 'done';
  }
  for (const issue of result.issues) if (issue.nodeId) nodes[issue.nodeId] = 'issue';
  for (const item of result.unavailable) if (item.nodeId) nodes[item.nodeId] = 'issue';
  if (result.stoppedAt && result.outcome !== 'ended') nodes[result.stoppedAt.nodeId] = 'stopped';
  return { nodes, edges, counts };
}

/**
 * Simulador partilhado com o runtime (P07): biblioteca de cenários do fluxo, quatro níveis de
 * validação identificados, comparação esperado/observado, ensaio isolado e evidência por hash.
 * Testa sempre o rascunho gravado (o mesmo que «Ativar esta versão» publicaria).
 */
export function FlowSimulator({
  basePath,
  definition,
  dirty,
  onMarks,
  onChanged,
}: {
  basePath: string;
  definition: FlowDefinition;
  dirty: boolean;
  onMarks: (marks: CanvasMarks | null) => void;
  onChanged?: () => void;
}) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const { request } = useProjectSession();
  const tickets = useResource<SimulationTicket[]>(
    `${basePath.replace(/\/[^/]+$/, '')}/simulation-tickets`,
  );
  const [view, setView] = useState<FlowSimulationsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [spec, setSpec] = useState<FlowScenarioSpecInput>(emptySpec);
  const [json, setJson] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [level, setLevel] = useState<FlowSimulationLevel>('behavior');
  const [targetId, setTargetId] = useState('');
  const [targetName, setTargetName] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<TrialDelivery[] | null>(null);
  const pendingKey = useRef<string | null>(null);
  const mutation = useMutation();
  const byId = useMemo(
    () => new Map(definition.nodes.map((node) => [node.id, node])),
    [definition],
  );

  const load = useCallback(async () => {
    try {
      setView(await request<FlowSimulationsView>(`${basePath}/simulations`));
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [basePath, request]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = view?.runs.some((run) => run.status === 'queued' || run.status === 'running');
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const selectedRun = view?.runs.find((run) => run.id === selectedRunId) ?? null;
  useEffect(() => {
    onMarks(selectedRun?.result ? simulationMarks(selectedRun.result) : null);
  }, [selectedRun?.id, selectedRun?.status, selectedRun?.result?.steps.length]);

  const openScenario = (
    item: FlowScenarioView | null,
    example?: FlowSimulationsView['examples'][number],
  ) => {
    setScenarioId(item?.id ?? null);
    setVersion(item?.version);
    setName(item?.name ?? example?.name ?? '');
    setDescription(item?.description ?? example?.description ?? '');
    setSpec(item ? (item.spec as FlowScenarioSpecInput) : (example?.spec ?? emptySpec()));
    setJson(null);
    setNodeId('');
  };

  const patchSpec = (patch: Partial<FlowScenarioSpecInput>) => setSpec({ ...spec, ...patch });
  const ticket = spec.ticket ?? {};
  const expected = spec.expected ?? {};
  const steps = spec.steps ?? {};
  const selectedNode = byId.get(nodeId);
  const sequence: FlowStepFixture[] = selectedNode ? (steps[selectedNode.id] ?? []) : [];
  const setSequence = (values: FlowStepFixture[]) => {
    if (!selectedNode) return;
    const next = { ...steps };
    if (values.length) next[selectedNode.id] = values;
    else delete next[selectedNode.id];
    patchSpec({ steps: next });
  };

  const done = async () => {
    await load();
    onChanged?.();
  };

  const saveScenario = (asNew: boolean) =>
    mutation.run(async () => {
      const saved = await request<FlowScenarioView>(
        asNew || !scenarioId
          ? `${basePath}/simulations/scenarios`
          : `${basePath}/simulations/scenarios/${encodeURIComponent(scenarioId)}`,
        {
          method: 'POST',
          body: {
            name: name.trim() || t('Cenário', 'Scenario'),
            description,
            spec,
            ...(!asNew && scenarioId ? { version } : {}),
          },
        },
      );
      openScenario(saved);
      await done();
    });

  const archiveScenario = () =>
    mutation.run(async () => {
      if (!scenarioId) return;
      await request(`${basePath}/simulations/scenarios/${encodeURIComponent(scenarioId)}/archive`, {
        method: 'POST',
        body: { version },
      });
      openScenario(null);
      await done();
    });

  const fromTicket = () =>
    mutation.run(async () => {
      if (!ticketId) return;
      const saved = await request<FlowScenarioView>(
        `${basePath}/simulations/scenarios/from-ticket`,
        { method: 'POST', body: { ticketId } },
      );
      openScenario(saved);
      await done();
    });

  const run = () =>
    mutation.run(async () => {
      // A mesma chave numa repetição (rede, duplo clique) devolve a execução já registada.
      pendingKey.current ??= newKey();
      const response = await request<FlowSimulationRunView>(`${basePath}/simulations/runs`, {
        method: 'POST',
        body: {
          level,
          idempotencyKey: pendingKey.current,
          ...(scenarioId ? { scenarioId } : { spec }),
          ...(level === 'isolated_trial' && targetId ? { trialTargetId: targetId } : {}),
        },
      });
      pendingKey.current = null;
      setSelectedRunId(response.id);
      await done();
    });

  const cancelRun = (id: string) =>
    mutation.run(async () => {
      await request(`${basePath}/simulations/runs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: {},
      });
      await done();
    });

  const targetsPath = `${basePath.replace(/\/[^/]+$/, '')}/trial-targets`;
  const createTarget = () =>
    mutation.run(async () => {
      await request(targetsPath, { method: 'POST', body: { name: targetName.trim() } });
      setTargetName('');
      await done();
    });
  const deactivateTarget = (id: string) =>
    mutation.run(async () => {
      await request(`${targetsPath}/${encodeURIComponent(id)}/deactivate`, {
        method: 'POST',
        body: {},
      });
      await done();
    });
  const showDeliveries = (id: string) =>
    mutation.run(async () => {
      setDeliveries(
        await request<TrialDelivery[]>(`${targetsPath}/${encodeURIComponent(id)}/deliveries`),
      );
    });

  const edited = scenarioId
    ? JSON.stringify(view?.scenarios.find((item) => item.id === scenarioId)?.spec) !==
      JSON.stringify(spec)
    : false;
  const activeTargets = view?.trialTargets.filter((target) => target.active) ?? [];
  const canRun =
    !dirty &&
    !mutation.busy &&
    !(scenarioId && edited) &&
    (level !== 'isolated_trial' || Boolean(targetId));
  const nodes = definition.nodes.filter((node) => node.op !== 'end');

  return (
    <section
      className="panel flow-simulator stack"
      aria-label={t('Testar o fluxo', 'Test the flow')}
    >
      <div>
        <h3>{t('Testar o fluxo', 'Test the flow')}</h3>
        <p className="muted">
          {t(
            'Testa o rascunho gravado com as mesmas regras do runtime. Cada execução fica associada ao hash exato da definição, encaminhamento, dependências e cenário.',
            'Tests the saved draft with the same rules as the runtime. Each run is bound to the exact hash of the definition, routing, dependencies and scenario.',
          )}
        </p>
        {view && (
          <p className="muted">
            {t('Rascunho gravado', 'Saved draft')}:{' '}
            <code className="flow-hash" title={view.current.manifestHash ?? ''}>
              {view.current.manifestHash?.slice(0, 12) ??
                t('dependências em falta', 'missing dependencies')}
            </code>
          </p>
        )}
      </div>
      {dirty && (
        <Notice tone="warning">
          {t(
            'Há alterações por gravar: os testes correm sobre o rascunho gravado. Grave antes de testar.',
            'There are unsaved changes: tests run on the saved draft. Save before testing.',
          )}
        </Notice>
      )}
      {loadError && <Notice>{loadError}</Notice>}

      <fieldset className="flow-fieldset stack">
        <legend>{t('Cenário', 'Scenario')}</legend>
        <label>
          {t('Abrir', 'Open')}
          <select
            aria-label={t('Abrir cenário', 'Open scenario')}
            value=""
            onChange={(event) => {
              const [kind, key] = event.target.value.split(':');
              if (kind === 'new') openScenario(null);
              if (kind === 'saved')
                openScenario(view?.scenarios.find((item) => item.id === key) ?? null);
              if (kind === 'example') openScenario(null, view?.examples[Number(key)]);
            }}
          >
            <option value="">{t('— escolher —', '— choose —')}</option>
            <option value="new:">{t('Novo cenário vazio', 'New empty scenario')}</option>
            {(view?.scenarios.length ?? 0) > 0 && (
              <optgroup label={t('Guardados', 'Saved')}>
                {view!.scenarios.map((item) => (
                  <option key={item.id} value={`saved:${item.id}`}>
                    {item.name} (v{item.version})
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label={t('Exemplos para este fluxo', 'Examples for this flow')}>
              {(view?.examples ?? []).map((item, index) => (
                <option key={index} value={`example:${index}`}>
                  {item.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <div className="flow-scenario-row">
          <select
            aria-label={t('Pedido histórico', 'Historical ticket')}
            value={ticketId}
            onChange={(event) => setTicketId(event.target.value)}
          >
            <option value="">{t('— pedido histórico —', '— historical ticket —')}</option>
            {(tickets.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.key} · {item.title.slice(0, 50)} ·{' '}
                {originLabels[item.origin]?.[lang] ?? item.origin}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button button-secondary"
            disabled={!ticketId || mutation.busy}
            onClick={() => void fromTicket()}
          >
            {t('Criar a partir do pedido', 'Create from ticket')}
          </button>
        </div>
        <p className="muted">
          {t(
            'Copia só os factos do pedido; o pedido e os seus recursos nunca são alterados.',
            'Copies only the ticket facts; the ticket and its resources are never changed.',
          )}
        </p>
        <label>
          {t('Nome', 'Name')}
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          {t('Descrição', 'Description')}
          <input
            value={description}
            maxLength={1000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {spec.sourceTicket && (
          <p className="muted">
            {t('Factos de', 'Facts from')} {spec.sourceTicket.key} ({t('só leitura', 'read only')})
          </p>
        )}
        <label>
          {t('Título do pedido', 'Ticket title')}
          <input
            value={ticket.title ?? ''}
            maxLength={300}
            onChange={(event) => patchSpec({ ticket: { ...ticket, title: event.target.value } })}
          />
        </label>
        <label>
          {t('Descrição do pedido', 'Ticket description')}
          <textarea
            rows={3}
            value={ticket.description ?? ''}
            maxLength={6000}
            onChange={(event) =>
              patchSpec({ ticket: { ...ticket, description: event.target.value } })
            }
          />
        </label>
        <div className="flow-scenario-row">
          <select
            aria-label={t('Etapa', 'Step')}
            value={nodeId}
            onChange={(event) => setNodeId(event.target.value)}
          >
            <option value="">{t('— resultado por etapa —', '— result per step —')}</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
                {steps[node.id] ? ` (${steps[node.id]!.length})` : ''}
              </option>
            ))}
          </select>
          {selectedNode && (
            <>
              {sequence.map((fixture, index) => (
                <span key={index} className="flow-chip">
                  {index + 1}.{' '}
                  {fixture.wait
                    ? t('fica à espera', 'waits')
                    : fixture.result
                      ? portLabel(selectedNode, fixture.result, lang)
                      : '—'}
                  {fixture.afterMinutes ? ` +${fixture.afterMinutes} min` : ''}
                </span>
              ))}
              <select
                aria-label={t('Próxima passagem', 'Next visit')}
                value=""
                onChange={(event) => {
                  const value = event.target.value;
                  if (value)
                    setSequence([
                      ...sequence,
                      value === 'wait' ? { wait: true } : { result: value },
                    ]);
                }}
              >
                <option value="">
                  {t('+ passagem', '+ visit')} {sequence.length + 1}
                </option>
                {nodePorts(selectedNode).map((port) => (
                  <option key={port} value={port}>
                    {portLabel(selectedNode, port, lang)}
                  </option>
                ))}
                <option value="wait">{t('fica à espera', 'waits')}</option>
              </select>
              {sequence.length > 0 && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setSequence([])}
                >
                  {t('Limpar', 'Clear')}
                </button>
              )}
            </>
          )}
        </div>
        <div className="flow-scenario-row">
          <label>
            {t('Resultado esperado', 'Expected outcome')}
            <select
              value={expected.outcome ?? ''}
              onChange={(event) =>
                patchSpec({
                  expected: {
                    ...expected,
                    outcome: (event.target.value || undefined) as typeof expected.outcome,
                  },
                })
              }
            >
              <option value="">—</option>
              {flowSimulationOutcomes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Para em', 'Stops at')}
            <select
              value={expected.stopsAt ?? ''}
              onChange={(event) =>
                patchSpec({
                  expected: { ...expected, stopsAt: event.target.value || undefined },
                })
              }
            >
              <option value="">—</option>
              {definition.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Encaminhamento', 'Routing')}
            <select
              value={expected.routing ?? ''}
              onChange={(event) =>
                patchSpec({
                  expected: {
                    ...expected,
                    routing: (event.target.value || undefined) as typeof expected.routing,
                  },
                })
              }
            >
              <option value="">—</option>
              {flowRoutingExpectations.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <details>
          <summary>{t('Cenário completo (JSON)', 'Full scenario (JSON)')}</summary>
          <p className="muted">
            {t(
              'Resultados de ferramentas e agentes, respostas, decisões, tempo (afterMinutes, horizonMinutes), incidente, ambiente e resposta gravada do classificador.',
              'Tool and agent results, replies, decisions, time (afterMinutes, horizonMinutes), incident, environment and recorded classifier reply.',
            )}
          </p>
          <textarea
            aria-label={t('Cenário JSON', 'Scenario JSON')}
            rows={10}
            className="flow-json"
            value={json ?? JSON.stringify(spec, null, 2)}
            onChange={(event) => setJson(event.target.value)}
          />
          <button
            type="button"
            className="button button-secondary"
            disabled={json === null}
            onClick={() => {
              try {
                setSpec(JSON.parse(json ?? '{}') as FlowScenarioSpecInput);
                setJson(null);
              } catch {
                mutation.run(async () => {
                  throw new Error(t('JSON inválido.', 'Invalid JSON.'));
                });
              }
            }}
          >
            {t('Aplicar JSON', 'Apply JSON')}
          </button>
        </details>
        <div className="flow-config-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={mutation.busy}
            onClick={() => void saveScenario(false)}
          >
            {scenarioId
              ? t('Guardar cenário', 'Save scenario')
              : t('Guardar como cenário', 'Save as scenario')}
          </button>
          {scenarioId && (
            <>
              <button
                type="button"
                className="button button-secondary"
                disabled={mutation.busy}
                onClick={() => void saveScenario(true)}
              >
                {t('Guardar como novo', 'Save as new')}
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={mutation.busy}
                onClick={() => void archiveScenario()}
              >
                {t('Arquivar', 'Archive')}
              </button>
            </>
          )}
        </div>
        {scenarioId && edited && (
          <p className="muted">
            {t(
              'Cenário alterado: guarde para o executar (as execuções ficam ligadas à versão guardada).',
              'Scenario changed: save it to run it (runs are bound to the saved version).',
            )}
          </p>
        )}
      </fieldset>

      <fieldset className="flow-fieldset stack">
        <legend>{t('Executar', 'Run')}</legend>
        {(Object.keys(levelLabels) as FlowSimulationLevel[]).map((value) => (
          <label key={value} className="flow-radio">
            <input
              type="radio"
              name="simulation-level"
              value={value}
              checked={level === value}
              onChange={() => setLevel(value)}
            />
            <span>
              <strong>{levelLabels[value][lang]}</strong>
              <span className="muted"> — {levelLabels[value].hint}</span>
            </span>
          </label>
        ))}
        {level === 'isolated_trial' && (
          <label>
            {t('Destino de teste', 'Test target')}
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">{t('— escolher —', '— choose —')}</option>
              {activeTargets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name} ({target.deliveries})
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="button button-primary"
          disabled={!canRun}
          onClick={() => void run()}
        >
          {t('Executar teste', 'Run test')}
        </button>
      </fieldset>
      {mutation.error && <Notice>{mutation.error}</Notice>}

      {view && view.runs.length > 0 && (
        <section className="stack" aria-label={t('Execuções', 'Runs')}>
          <h4>{t('Execuções', 'Runs')}</h4>
          <ul className="flow-sim-runs">
            {view.runs.map((item) => (
              <li key={item.id} className={item.id === selectedRunId ? 'is-selected' : undefined}>
                <button
                  type="button"
                  className="flow-sim-run"
                  onClick={() => setSelectedRunId(item.id === selectedRunId ? null : item.id)}
                >
                  <span className="flow-chip">{levelLabels[item.level][lang]}</span>{' '}
                  <strong>{item.scenarioName}</strong> · {item.status}
                  {item.comparison && item.status === 'completed' && (
                    <span className={`flow-chip flow-sim-verdict-${item.comparison.verdict}`}>
                      {item.comparison.verdict}
                    </span>
                  )}
                  {item.result?.routing && item.result.routing.source !== 'rules' && (
                    <span className="flow-chip">
                      {routingSourceLabels[item.result.routing.source]}
                    </span>
                  )}
                  {item.stale && (
                    <span className="flow-chip flow-sim-stale">
                      {t('desatualizado', 'stale')}:{' '}
                      {item.staleReasons.map((reason) => staleLabels[reason]).join(', ')}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {selectedRun && (
        <RunDetail
          run={selectedRun}
          definition={definition}
          onCancel={() => void cancelRun(selectedRun.id)}
          busy={mutation.busy}
        />
      )}

      <fieldset className="flow-fieldset stack">
        <legend>{t('Destinos de ensaio isolado', 'Isolated trial targets')}</legend>
        {(view?.trialTargets ?? []).length === 0 && (
          <p className="muted">
            {t(
              'Sem destinos: o ensaio isolado não pode correr neste projeto.',
              'No targets: isolated trials cannot run in this project.',
            )}
          </p>
        )}
        <ul className="content-list">
          {(view?.trialTargets ?? []).map((target) => (
            <li key={target.id}>
              {target.name} · outbox · {target.deliveries} {t('entregas', 'deliveries')}
              {!target.active && ` · ${t('inativo', 'inactive')}`}{' '}
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void showDeliveries(target.id)}
              >
                {t('Ver entregas', 'Deliveries')}
              </button>
              {view?.canManageTargets && target.active && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void deactivateTarget(target.id)}
                >
                  {t('Desativar', 'Deactivate')}
                </button>
              )}
            </li>
          ))}
        </ul>
        {view?.canManageTargets && (
          <div className="flow-scenario-row">
            <input
              aria-label={t('Nome do destino', 'Target name')}
              value={targetName}
              maxLength={120}
              placeholder={t('Outbox de teste', 'Test outbox')}
              onChange={(event) => setTargetName(event.target.value)}
            />
            <button
              type="button"
              className="button button-secondary"
              disabled={!targetName.trim() || mutation.busy}
              onClick={() => void createTarget()}
            >
              {t('Criar destino', 'Create target')}
            </button>
          </div>
        )}
        {deliveries && (
          <ol className="flow-sim-steps">
            {deliveries.length === 0 && <li>{t('Sem entregas.', 'No deliveries.')}</li>}
            {deliveries.map((item) => (
              <li key={item.id}>
                {item.kind} · {byId.get(item.nodeId)?.label ?? item.nodeId}
                <div className="muted">{JSON.stringify(item.payload).slice(0, 200)}</div>
              </li>
            ))}
          </ol>
        )}
      </fieldset>
    </section>
  );
}

/**
 * Junto de «Ativar esta versão»: o que foi testado para o hash exato do rascunho gravado.
 * Informativo — a validação estrutural continua obrigatória e os ensaios não são exigidos.
 */
export function ActivationEvidence({ view }: { view: FlowSimulationsView | null }) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  if (!view) return null;
  const current = view.runs.filter((run) => run.status === 'completed' && !run.stale);
  const historical = view.runs.filter((run) => run.status === 'completed' && run.stale).length;
  const hash = view.current.manifestHash;
  return (
    <Notice tone={current.length ? 'info' : 'warning'}>
      {hash ? (
        <>
          {t('Testes para esta versão', 'Tests for this version')}{' '}
          <code className="flow-hash" title={hash}>
            {hash.slice(0, 12)}
          </code>
          :{' '}
          {current.length
            ? current
                .slice(0, 6)
                .map(
                  (run) =>
                    `${levelLabels[run.level][lang]} «${run.scenarioName}» ${run.comparison?.verdict ?? ''}`,
                )
                .join(' · ')
            : t('nenhum teste executado para este hash.', 'no test run for this hash.')}
        </>
      ) : (
        t(
          'Dependências em falta: o manifesto não se resolve e esta versão não pode ser ativada.',
          'Missing dependencies: the manifest cannot be resolved and this version cannot be activated.',
        )
      )}
      {historical > 0 && (
        <>
          <br />
          {t(
            `${historical} resultado(s) anterior(es) são de outra versão e não certificam esta.`,
            `${historical} earlier result(s) belong to another version and do not certify this one.`,
          )}
        </>
      )}
    </Notice>
  );
}

/** Testes registados no momento da ativação (histórico). */
export function TestEvidenceList({ tests }: { tests: unknown }) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const items = Array.isArray(tests) ? (tests as FlowActivationTestEvidence[]) : null;
  if (!items) return null;
  return (
    <div className="muted">
      {items.length
        ? `${t('Testado', 'Tested')}: ${items
            .map(
              (item) =>
                `${levelLabels[item.level][lang]} «${item.scenarioName}» ${item.verdict ?? ''}`,
            )
            .join(' · ')}`
        : t('Ativada sem testes para este hash.', 'Activated without tests for this hash.')}
    </div>
  );
}

function RunDetail({
  run,
  definition,
  onCancel,
  busy,
}: {
  run: FlowSimulationRunView;
  definition: FlowDefinition;
  onCancel: () => void;
  busy: boolean;
}) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const result = run.result;
  const pending = run.status === 'queued' || run.status === 'running';
  return (
    <div className="stack flow-simulation-result" aria-live="polite">
      <div>
        <strong>{levelLabels[run.level][lang]}</strong> · {run.scenarioName}
        {run.scenarioVersion ? ` v${run.scenarioVersion}` : ''} ·{' '}
        <code className="flow-hash" title={run.hashes.manifestHash ?? ''}>
          {run.hashes.manifestHash?.slice(0, 12) ?? '—'}
        </code>
      </div>
      {run.stale && (
        <Notice tone="warning">
          {t(
            `Resultado histórico: ${run.staleReasons.map((reason) => staleLabels[reason]).join(', ')} mudou desde esta execução. Não certifica o rascunho atual.`,
            `Historical result: ${run.staleReasons.join(', ')} changed since this run. It does not certify the current draft.`,
          )}
        </Notice>
      )}
      {pending && (
        <Notice tone="info">
          {t('A aguardar o Copilot real…', 'Waiting for real Copilot…')}{' '}
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {t('Cancelar', 'Cancel')}
          </button>
        </Notice>
      )}
      {run.status === 'failed' && (
        <Notice>
          {t('Falhou', 'Failed')}: {run.errorCode}.{' '}
          {t('Nenhuma escolha foi assumida.', 'No choice was assumed.')}
        </Notice>
      )}
      {run.status === 'cancelled' && (
        <Notice tone="warning">{t('Cancelada.', 'Cancelled.')}</Notice>
      )}
      {result && (
        <>
          <Notice tone={result.outcome === 'ended' ? 'success' : 'warning'}>
            <strong>{result.message}</strong>
            {result.stoppedAt && result.outcome !== 'ended' && (
              <>
                <br />
                {t('Etapa', 'Step')}: {result.stoppedAt.label}
                {result.waitingFor ? ` · ${t('espera', 'waits for')}: ${result.waitingFor}` : ''}
              </>
            )}
            {result.elapsedMinutes > 0 && (
              <>
                <br />
                {t('Tempo simulado', 'Simulated time')}: {result.elapsedMinutes} min
              </>
            )}
          </Notice>
          {run.comparison && run.comparison.checks.length > 0 && (
            <table
              className="flow-table"
              aria-label={t('Esperado vs observado', 'Expected vs observed')}
            >
              <thead>
                <tr>
                  <th>{t('Verificação', 'Check')}</th>
                  <th>{t('Esperado', 'Expected')}</th>
                  <th>{t('Observado', 'Observed')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {run.comparison.checks.map((check) => (
                  <tr key={check.key}>
                    <td>{check.key}</td>
                    <td>{check.expected}</td>
                    <td>{check.observed}</td>
                    <td>{check.passed ? '✓' : '✗'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.routing && (
            <div className="flow-sim-routing">
              <strong>{t('Encaminhamento', 'Routing')}</strong> (
              {routingSourceLabels[result.routing.source]}): {result.routing.decision}
              {result.routing.chosenName ? ` → ${result.routing.chosenName}` : ''}
              {result.routing.reason && <div className="muted">{result.routing.reason}</div>}
              {result.routing.question && (
                <div className="flow-assistant-question">{result.routing.question}</div>
              )}
              {result.routing.observedReply && (
                <details>
                  <summary>{t('Resposta observada', 'Observed reply')}</summary>
                  <pre className="flow-json">{result.routing.observedReply}</pre>
                </details>
              )}
            </div>
          )}
          {result.steps.length > 0 && (
            <ol className="flow-sim-steps">
              {result.steps.map((step, index) => (
                <li key={index}>
                  <strong>{step.label}</strong>
                  {step.attempt > 1 && ` (${t('passagem', 'visit')} ${step.attempt})`}
                  {step.port && <> → {portLabel(byId.get(step.nodeId), step.port, lang)}</>}
                  <span className="muted">
                    {' '}
                    · {step.source} · {step.atMinutes} min
                  </span>
                  {step.detail && <div className="muted">{step.detail}</div>}
                </li>
              ))}
            </ol>
          )}
          {result.effects.length > 0 && (
            <div>
              <strong>{t('Efeitos', 'Effects')}</strong>
              <ul className="notice-list">
                {result.effects.map((effect, index) => (
                  <li key={index}>
                    <span className="flow-chip">
                      {effect.mode === 'trial'
                        ? t('entregue no destino de teste', 'delivered to test target')
                        : t('simulado', 'simulated')}
                    </span>{' '}
                    {effect.kind}: {effect.summary}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.unavailable.length > 0 && (
            <Notice tone="warning">
              {t('Indisponível (sem sucesso fictício)', 'Unavailable (no fake success)')}:
              <ul className="notice-list">
                {result.unavailable.map((item, index) => (
                  <li key={index}>
                    {item.nodeId ? `${byId.get(item.nodeId)?.label ?? item.nodeId}: ` : ''}
                    {item.capability} — {item.reason}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {result.issues.length > 0 && (
            <Notice tone="warning">
              {t('Problemas estruturais', 'Structural issues')}:
              <ul className="notice-list">
                {result.issues.slice(0, 10).map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            </Notice>
          )}
          {result.notVerified.length > 0 && (
            <details>
              <summary>{t('Não verificado neste nível', 'Not verified at this level')}</summary>
              <ul className="notice-list">
                {result.notVerified.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
