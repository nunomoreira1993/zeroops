import { useMemo, useState } from 'react';
import {
  decisionOptions,
  nodePorts,
  portLabel,
  type FlowDefinition,
  type FlowIssue,
  type FlowScenario,
  type SimulationResult,
} from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectSession } from '../../lib/project-admin';
import type { CanvasMarks } from './FlowCanvas';
import { assigneeLabel, originLabels } from './flow-labels';

interface SimulationTicket {
  id: string;
  key: string;
  title: string;
  status: string;
  category: string;
  origin: string;
  createdAt: string;
}

export interface SimulationResponse {
  ticket: { key: string; title: string; selectedFlow: string | null; matches: boolean } | null;
  issues: FlowIssue[];
  result: SimulationResult;
}

/** Marcas do desenho para o percurso simulado. */
export function simulationMarks(result: SimulationResult): CanvasMarks {
  const nodes: CanvasMarks['nodes'] = {};
  const edges: CanvasMarks['edges'] = {};
  const counts: Record<string, number> = {};
  for (const step of result.steps) {
    nodes[step.nodeId] = 'done';
    counts[step.nodeId] = step.attempt;
    if (step.port) edges[`${step.nodeId}:${step.port}`] = 'done';
  }
  if (result.stoppedAt) nodes[result.stoppedAt.nodeId] = 'stopped';
  return { nodes, edges, counts };
}

/**
 * «Experimentar com um ticket»: percorre a definição em edição com um ticket antigo, sem enviar
 * mensagens, pedir trabalho ao Copilot ou alterar o ticket. O cenário diz, por etapa, que saída
 * acontece em cada passagem (p. ex. «o QA reprova duas vezes»).
 */
export function FlowSimulator({
  basePath,
  definition,
  onResult,
}: {
  basePath: string;
  definition: FlowDefinition;
  onResult: (result: SimulationResponse | null) => void;
}) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const { request } = useProjectSession();
  const tickets = useResource<SimulationTicket[]>(`${basePath}/simulation-tickets`);
  const [ticketId, setTicketId] = useState('');
  const [scenario, setScenario] = useState<FlowScenario>({});
  const [nodeId, setNodeId] = useState('');
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const mutation = useMutation();
  const nodes = definition.nodes.filter((node) => node.op !== 'end');
  const byId = useMemo(
    () => new Map(definition.nodes.map((node) => [node.id, node])),
    [definition],
  );

  const presets = useMemo(() => {
    const list: { label: string; scenario: FlowScenario }[] = [];
    for (const node of definition.nodes) {
      if (node.op !== 'human_decision') continue;
      const [first, ...others] = decisionOptions(node);
      for (const option of others) {
        list.push({
          label: `${node.label}: ${option.label}`,
          scenario: { [node.id]: [option.port] },
        });
        if (first)
          list.push({
            label: `${node.label}: ${option.label} ×2, ${t('depois', 'then')} ${first.label}`,
            scenario: { [node.id]: [option.port, option.port, first.port] },
          });
      }
      list.push({
        label: `${node.label}: ${t('fica à espera', 'stays waiting')}`,
        scenario: { [node.id]: ['wait'] },
      });
    }
    for (const node of definition.nodes)
      if (
        (node.op === 'copilot_task' || node.op === 'action') &&
        nodePorts(node).includes('failure')
      )
        list.push({
          label: `${node.label}: ${t('termina em erro', 'ends in failure')}`,
          scenario: { [node.id]: ['failure'] },
        });
    return list;
  }, [definition, t]);

  const run = (next: FlowScenario) =>
    mutation.run(async () => {
      const response = await request<SimulationResponse>(`${basePath}/simulate`, {
        method: 'POST',
        body: { ...(ticketId ? { ticketId } : {}), scenario: next, definition },
      });
      setResult(response);
      onResult(response);
    });

  const selected = byId.get(nodeId);
  const sequence = selected ? (scenario[selected.id] ?? []) : [];
  const configuredAgents = definition.nodes.filter(
    (node) =>
      node.op === 'copilot_task' &&
      (typeof node.config.agentProfileId === 'string' ||
        (Array.isArray(node.config.repositoryResources) &&
          node.config.repositoryResources.length > 0)),
  );
  const setSequence = (values: string[]) => {
    if (!selected) return;
    const next = { ...scenario };
    if (values.length) next[selected.id] = values;
    else delete next[selected.id];
    setScenario(next);
  };

  return (
    <section
      className="panel flow-simulator stack"
      aria-label={t('Experimentar com um ticket', 'Try with a ticket')}
    >
      <div>
        <h3>{t('Experimentar com um ticket', 'Try with a ticket')}</h3>
        <p className="muted">
          {t(
            'Simula o rascunho atual sem enviar mensagens, chamar o Copilot nem executar ações.',
            'Simulates the current draft without sending messages, calling Copilot or running actions.',
          )}
        </p>
      </div>
      {configuredAgents.length > 0 && (
        <Notice tone="info">
          {t(
            'Contexto técnico previsto (não resolvido nesta simulação):',
            'Predicted technical context (not resolved in this simulation):',
          )}
          <ul className="notice-list">
            {configuredAgents.map((node) => {
              const profile =
                typeof node.config.agentProfileId === 'string'
                  ? ` · perfil ${node.config.agentProfileId} v${Number(node.config.agentProfileVersion) || '?'}`
                  : '';
              const refs = Array.isArray(node.config.repositoryResources)
                ? node.config.repositoryResources
                    .filter(
                      (item): item is { path: string; required?: boolean } =>
                        typeof item === 'object' &&
                        item !== null &&
                        typeof (item as { path?: unknown }).path === 'string',
                    )
                    .map(
                      (item) =>
                        `${item.path}${item.required ? ` (${t('obrigatório', 'mandatory')})` : ''}`,
                    )
                : [];
              return (
                <li key={node.id}>
                  {node.label}
                  {profile}
                  {refs.length ? ` · ${refs.join(', ')}` : ''}
                </li>
              );
            })}
          </ul>
          {t(
            'O run real fixa a revisão/hash e bloqueia recursos obrigatórios em falta; a simulação não lê o repositório nem chama o Copilot.',
            'A real run pins the repository revision/hash and blocks missing mandatory resources; simulation does not read the repository or call Copilot.',
          )}
        </Notice>
      )}
      <label>
        {t('Ticket do cliente', 'Client ticket')}
        <select value={ticketId} onChange={(event) => setTicketId(event.target.value)}>
          <option value="">
            {t('— sem ticket (só o percurso) —', '— no ticket (path only) —')}
          </option>
          {(tickets.data ?? []).map((ticket) => (
            <option key={ticket.id} value={ticket.id}>
              {ticket.key} · {ticket.title.slice(0, 60)} ·{' '}
              {originLabels[ticket.origin]?.[lang] ?? ticket.origin}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('Cenário rápido', 'Quick scenario')}
        <select
          value=""
          onChange={(event) => {
            const preset = presets[Number(event.target.value)];
            if (!preset) return;
            setScenario(preset.scenario);
            void run(preset.scenario);
          }}
        >
          <option value="">{t('— escolher —', '— choose —')}</option>
          {presets.map((preset, index) => (
            <option key={index} value={index}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flow-fieldset">
        <legend>{t('Cenário por etapa', 'Scenario per step')}</legend>
        <select
          aria-label={t('Etapa', 'Step')}
          value={nodeId}
          onChange={(event) => setNodeId(event.target.value)}
        >
          <option value="">{t('— etapa —', '— step —')}</option>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label}
              {scenario[node.id] ? ` (${scenario[node.id]!.length})` : ''}
            </option>
          ))}
        </select>
        {selected && (
          <div className="flow-scenario-row">
            {sequence.map((port, index) => (
              <span key={index} className="flow-chip">
                {index + 1}.{' '}
                {port === 'wait' ? t('fica à espera', 'waits') : portLabel(selected, port, lang)}
              </span>
            ))}
            <select
              aria-label={t('Próxima passagem', 'Next visit')}
              value=""
              onChange={(event) => {
                if (event.target.value) setSequence([...sequence, event.target.value]);
              }}
            >
              <option value="">
                {t('+ passagem', '+ visit')} {sequence.length + 1}
              </option>
              {nodePorts(selected).map((port) => (
                <option key={port} value={port}>
                  {portLabel(selected, port, lang)}
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
          </div>
        )}
        <p className="muted">
          {t(
            'Passagens sem cenário seguem a saída habitual (primeira opção ou resultado esperado).',
            'Visits without a scenario follow the usual output (first option or expected result).',
          )}
        </p>
      </fieldset>
      <div className="flow-config-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={mutation.busy}
          onClick={() => void run(scenario)}
        >
          {t('Simular', 'Simulate')}
        </button>
        {result && (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setResult(null);
              setScenario({});
              onResult(null);
            }}
          >
            {t('Limpar simulação', 'Clear simulation')}
          </button>
        )}
      </div>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {result && (
        <div className="stack flow-simulation-result" aria-live="polite">
          {result.ticket && (
            <Notice tone={result.ticket.matches ? 'info' : 'warning'}>
              {result.ticket.key} · {result.ticket.title}
              <br />
              {result.ticket.matches
                ? t(
                    'A regra deste fluxo apanharia este ticket.',
                    'This flow rule would pick this ticket.',
                  )
                : t(
                    `Este ticket seguiria «${result.ticket.selectedFlow ?? '—'}», não este fluxo (simulação feita na mesma).`,
                    `This ticket would follow «${result.ticket.selectedFlow ?? '—'}», not this flow (simulated anyway).`,
                  )}
            </Notice>
          )}
          <Notice tone={result.result.outcome === 'ended' ? 'success' : 'warning'}>
            <strong>{result.result.message[lang]}</strong>
            {result.result.stoppedAt && result.result.outcome !== 'ended' && (
              <>
                <br />
                {t('Próxima tarefa', 'Next task')}: {result.result.stoppedAt.label} →{' '}
                {assigneeLabel(result.result.stoppedAt.assignee, lang)}
              </>
            )}
          </Notice>
          <ol className="flow-sim-steps">
            {result.result.steps.map((step, index) => (
              <li key={index}>
                <strong>{step.label}</strong>
                {step.attempt > 1 && ` (${t('passagem', 'visit')} ${step.attempt})`}
                {step.port && <> → {portLabel(byId.get(step.nodeId), step.port, lang)}</>}
                {step.assignee && (
                  <span className="muted"> · {assigneeLabel(step.assignee, lang)}</span>
                )}
                <div className="muted">{step.effect[lang]}</div>
              </li>
            ))}
          </ol>
          {result.issues.length > 0 && (
            <Notice tone="warning">
              {t('Problemas a corrigir antes de publicar', 'Issues to fix before publishing')}:
              <ul className="notice-list">
                {result.issues.slice(0, 6).map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            </Notice>
          )}
        </div>
      )}
    </section>
  );
}
