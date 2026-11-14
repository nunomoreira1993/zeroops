import { useEffect, useMemo, useState } from 'react';
import {
  applyFlowOperations,
  flowChangeKind,
  flowOperationLabels,
  ticketOrigins,
  validateFlowDefinition,
  type FlowAssistantRequestView,
  type FlowDefinition,
  type FlowDetail,
  type FlowMatch,
  type FlowNode,
  type FlowOperationKey,
} from '@zeroops/contracts';
import { Loading, Notice, ResourceError } from '../../components/ui';
import { ticketLabels } from '../../lib/format';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectSession } from '../../lib/project-admin';
import { FlowAssistantPanel } from './FlowAssistantPanel';
import { autoLayout, FlowCanvas, type CanvasMarks } from './FlowCanvas';
import { FlowSimulator, simulationMarks, type SimulationResponse } from './FlowSimulator';
import { StepConfigPanel } from './StepConfigPanel';
import { nodeKey, originLabels } from './flow-labels';

type SidePanel = 'step' | 'assistant' | 'simulate' | 'settings';

function newNode(op: FlowOperationKey, label: string, id: string): FlowNode {
  switch (op) {
    case 'human_decision':
      return {
        id,
        op,
        label,
        assignee: { kind: 'team' },
        config: {
          options: [
            { port: 'success', label: 'Aprovar' },
            { port: 'failure', label: 'Rejeitar', requiresComment: true },
          ],
        },
      };
    case 'copilot_task':
      return { id, op, label, assignee: null, config: { mode: 'analysis' } };
    case 'action':
      return { id, op, label, config: { action: 'internal_note', source: 'text', body: '' } };
    case 'end':
      return { id, op, label, config: { outcome: 'resolved' } };
  }
}

/** Editor de um fluxo: desenho, configuração da etapa, assistente, simulação e publicação. */
export function FlowEditor({ flowId, onBack }: { flowId: string; onBack: () => void }) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const { request } = useProjectSession();
  const basePath = `/flows/${encodeURIComponent(flowId)}`;
  const resource = useResource<FlowDetail>(basePath);
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [definition, setDefinition] = useState<FlowDefinition | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<SidePanel>('assistant');
  const [preview, setPreview] = useState<FlowAssistantRequestView | null>(null);
  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const [organizeRequest, setOrganizeRequest] = useState(0);
  const mutation = useMutation();

  useEffect(() => {
    if (!resource.data) return;
    setDetail(resource.data);
    setDefinition(resource.data.draft);
  }, [resource.data]);

  const members = useMemo(() => new Set(detail?.members.map((member) => member.id)), [detail]);
  const issues = useMemo(
    () => (definition ? validateFlowDefinition(definition, { members }) : []),
    [definition, members],
  );
  const change = detail && definition ? flowChangeKind(detail.draft, definition) : 'none';
  const layoutOnly = change === 'layout';
  const dirty = change !== 'none';

  const proposal = useMemo(() => {
    if (!preview?.response || !detail) return null;
    try {
      return applyFlowOperations(detail.draft, preview.response.operations);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'erro' };
    }
  }, [preview, detail]);

  const marks = useMemo<CanvasMarks>(() => {
    if (proposal && 'definition' in proposal) {
      const nodes: CanvasMarks['nodes'] = {};
      for (const id of proposal.added) nodes[id] = 'added';
      for (const id of proposal.changed) nodes[id] = 'changed';
      const edges: CanvasMarks['edges'] = {};
      for (const edge of proposal.definition.edges)
        if (proposal.addedEdges.includes(edge.id)) edges[`${edge.source}:${edge.port}`] = 'added';
      return {
        nodes,
        edges,
        ghosts: detail!.draft.nodes.filter((node) => proposal.removed.includes(node.id)),
        ghostLayout: autoLayout(detail!.draft),
      };
    }
    if (simulation) return simulationMarks(simulation.result);
    const nodes: CanvasMarks['nodes'] = {};
    for (const issue of issues) if (issue.nodeId) nodes[issue.nodeId] = 'issue';
    return { nodes };
  }, [proposal, simulation, issues, detail]);

  if (resource.loading && !detail)
    return <Loading label={t('A carregar fluxo…', 'Loading flow…')} />;
  if (resource.error && !detail)
    return <ResourceError error={resource.error} retry={resource.reload} />;
  if (!detail || !definition) return null;

  const previewing = proposal && 'definition' in proposal;
  const canvasDefinition = previewing ? proposal.definition : definition;

  const save = () =>
    mutation.run(async () => {
      const result = await request<{ draftVersion: number; changeKind: string }>(
        `${basePath}/draft`,
        {
          method: 'POST',
          body: { expectedDraftVersion: detail.draftVersion, definition },
        },
      );
      setNotice({
        tone: 'success',
        text:
          result.changeKind === 'layout'
            ? t(
                'Posições gravadas. A ordem de execução não mudou.',
                'Positions saved. The execution order did not change.',
              )
            : t('Rascunho gravado (ainda não publicado).', 'Draft saved (not yet published).'),
      });
      resource.reload();
    });

  const publish = () =>
    mutation.run(async () => {
      const result = await request<FlowDetail>(`${basePath}/publish`, {
        method: 'POST',
        body: { expectedDraftVersion: detail.draftVersion },
      });
      setNotice({
        tone: 'success',
        text: t(
          `Versão ${result.published?.number ?? ''} publicada. Os tickets em curso continuam na versão com que entraram.`,
          `Version ${result.published?.number ?? ''} published. Tickets in progress keep the version they started with.`,
        ),
      });
      resource.reload();
    });

  const addStep = (op: FlowOperationKey) => {
    const label = flowOperationLabels[op][lang];
    const id = nodeKey(
      label,
      definition.nodes.map((node) => node.id),
    );
    const layout = autoLayout(definition);
    const maxY = Math.max(0, ...Object.values(layout).map((item) => item.y));
    setDefinition({
      ...definition,
      nodes: [...definition.nodes, newNode(op, label, id)],
      layout: { ...layout, [id]: { x: 0, y: maxY + 170 } },
    });
    setSelected(id);
    setPanel('step');
  };

  return (
    <div className="flow-editor stack">
      <div className="flow-toolbar">
        <button type="button" className="button button-secondary" onClick={onBack}>
          ← {t('Fluxos', 'Flows')}
        </button>
        <h2>{detail.name}</h2>
        <span className={`status-badge ${detail.published ? 'status-resolved' : 'status-new'}`}>
          {detail.published
            ? t(`Publicado v${detail.published.number}`, `Published v${detail.published.number}`)
            : t('Nunca publicado', 'Never published')}
        </span>
        {detail.isDefault && <span className="flow-chip">{t('por omissão', 'default')}</span>}
        <span className="flow-toolbar-spacer" />
        <button
          type="button"
          className="button button-secondary"
          disabled={Boolean(previewing) || mutation.busy}
          onClick={() => setOrganizeRequest((requestId) => requestId + 1)}
        >
          {t('Organizar verticalmente', 'Organize vertically')}
        </button>
        <select
          aria-label={t('Acrescentar etapa', 'Add step')}
          value=""
          disabled={Boolean(previewing)}
          onChange={(event) => {
            if (event.target.value) addStep(event.target.value as FlowOperationKey);
          }}
        >
          <option value="">{t('+ Acrescentar etapa', '+ Add step')}</option>
          {(['copilot_task', 'human_decision', 'action', 'end'] as const).map((op) => (
            <option key={op} value={op}>
              {flowOperationLabels[op][lang]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button-secondary"
          disabled={!dirty || mutation.busy}
          onClick={() => {
            setDefinition(detail.draft);
            setNotice(null);
          }}
        >
          {t('Desfazer', 'Undo')}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={!dirty || mutation.busy}
          onClick={() => void save()}
        >
          {t('Gravar rascunho', 'Save draft')}
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={dirty || issues.length > 0 || !detail.draftChanged || mutation.busy}
          title={
            issues.length
              ? t('Corrija os problemas antes de publicar.', 'Fix the issues before publishing.')
              : undefined
          }
          onClick={() => void publish()}
        >
          {t('Publicar', 'Publish')}
        </button>
      </div>
      {dirty && (
        <p className="muted flow-dirty">
          {layoutOnly
            ? t(
                'Só mudaram posições no ecrã: a ordem de execução é a mesma.',
                'Only positions on screen changed: the execution order is the same.',
              )
            : t(
                'Há alterações por gravar que mudam a execução (etapas, ligações ou configuração).',
                'There are unsaved changes that affect execution (steps, links or configuration).',
              )}
        </p>
      )}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {mutation.error && <Notice>{mutation.error}</Notice>}
      {proposal && 'error' in proposal && (
        <Notice tone="warning">
          {t(
            'A proposta já não se aplica ao rascunho',
            'The proposal no longer applies to the draft',
          )}
          : {proposal.error}
        </Notice>
      )}
      {previewing && (
        <Notice tone="info">
          {t(
            'A mostrar a proposta do assistente: verde = nova, amarelo = alterada, tracejado = removida. Aceite ou descarte no painel do assistente.',
            'Showing the assistant proposal: green = new, yellow = changed, dashed = removed. Accept or discard in the assistant panel.',
          )}
        </Notice>
      )}
      <div className="flow-workspace">
        <div className="flow-main stack">
          <FlowCanvas
            definition={canvasDefinition}
            marks={marks}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              if (id) setPanel('step');
            }}
            {...(previewing ? {} : { onChange: setDefinition })}
            height={600}
            organizeRequest={organizeRequest}
          />
          <p className="muted">
            {t(
              'Layouts antigos são organizados verticalmente apenas na vista, sem gravar. As saídas identificam os caminhos; selecione uma ligação para destacar o percurso e a legenda, ou carregue em Delete para a remover. Arraste o fundo para navegar. Mover etapas ou organizar permite gravar só as posições, sem mudar a execução.',
              'Legacy layouts are arranged vertically in the view without saving. Outputs identify the paths; select a link to highlight its route and label, or press Delete to remove it. Pan on the background to explore. Moving steps or organizing lets you save positions without changing execution.',
            )}
          </p>
          {issues.length > 0 && (
            <Notice tone="warning">
              {t(
                `${issues.length} problema(s) a corrigir antes de publicar`,
                `${issues.length} issue(s) to fix before publishing`,
              )}
              <ul className="notice-list">
                {issues.slice(0, 8).map((issue, index) => (
                  <li key={index}>
                    {issue.nodeId ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          setSelected(issue.nodeId!);
                          setPanel('step');
                        }}
                      >
                        {issue.message}
                      </button>
                    ) : (
                      issue.message
                    )}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          <FlowVersions detail={detail} />
        </div>
        <div className="flow-side stack">
          <div className="flow-side-tabs" role="tablist">
            {(
              [
                ['assistant', t('Assistente', 'Assistant')],
                ['step', t('Etapa', 'Step')],
                ['simulate', t('Experimentar', 'Try it')],
                ['settings', t('Regras', 'Rules')],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={panel === id}
                className={panel === id ? 'is-active' : undefined}
                onClick={() => setPanel(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {panel === 'assistant' && (
            <FlowAssistantPanel
              basePath={basePath}
              draftVersion={detail.draftVersion}
              dirty={dirty}
              copilotReady={detail.copilotReady}
              previewId={preview?.id ?? null}
              onPreview={(item) => {
                setPreview(item);
                if (item) setSimulation(null);
              }}
              onResolved={() => resource.reload()}
            />
          )}
          {panel === 'step' &&
            (selected && !previewing ? (
              <StepConfigPanel
                definition={definition}
                nodeId={selected}
                members={detail.members}
                issues={issues}
                onChange={setDefinition}
                onClose={() => setSelected(null)}
              />
            ) : (
              <p className="muted panel panel-padding">
                {t('Selecione uma etapa no desenho.', 'Select a step on the diagram.')}
              </p>
            ))}
          {panel === 'simulate' && (
            <FlowSimulator
              basePath={basePath}
              definition={definition}
              onResult={(result) => {
                setSimulation(result);
                if (result) setPreview(null);
              }}
            />
          )}
          {panel === 'settings' && (
            <FlowSettingsForm
              key={detail.updatedAt}
              detail={detail}
              basePath={basePath}
              onSaved={() => resource.reload()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FlowVersions({ detail }: { detail: FlowDetail }) {
  const { locale, t } = useIdentityLocale();
  if (!detail.versions.length) return null;
  const format = (value: string) =>
    new Date(value).toLocaleString(locale === 'en' ? 'en-GB' : 'pt-PT');
  return (
    <section className="panel flow-versions">
      <h3>{t('Versões publicadas', 'Published versions')}</h3>
      <ul className="content-list">
        {detail.versions.map((version) => (
          <li key={version.id}>
            v{version.number} · {format(version.publishedAt)}
            {version.publishedBy ? ` · ${version.publishedBy}` : ''}
            {' · '}
            {t(
              `${version.activeExecutions} ticket(s) em curso nesta versão`,
              `${version.activeExecutions} ticket(s) in progress on this version`,
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const categories = ['incident', 'bug', 'improvement', 'question'] as const;
const environments = ['development', 'quality', 'production'] as const;
const priorities = ['low', 'medium', 'high', 'critical'] as const;

function FlowSettingsForm({
  detail,
  basePath,
  onSaved,
}: {
  detail: FlowDetail;
  basePath: string;
  onSaved: () => void;
}) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const labels = ticketLabels(locale);
  const { request } = useProjectSession();
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description);
  const [priority, setPriority] = useState(detail.priority);
  const [isDefault, setIsDefault] = useState(detail.isDefault);
  const [match, setMatch] = useState<FlowMatch>(detail.match);
  const [saved, setSaved] = useState(false);
  const mutation = useMutation();
  const toggle = <K extends keyof FlowMatch>(key: K, value: FlowMatch[K][number]) => {
    const list = match[key] as string[];
    setMatch({
      ...match,
      [key]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value],
    });
  };
  const group = <K extends keyof FlowMatch>(
    key: K,
    legend: string,
    values: readonly FlowMatch[K][number][],
    label: (value: FlowMatch[K][number]) => string,
  ) => (
    <fieldset className="flow-fieldset">
      <legend>{legend}</legend>
      <div className="flow-checks">
        {values.map((value) => (
          <label key={value} className="checkbox-row">
            <input
              type="checkbox"
              checked={(match[key] as string[]).includes(value)}
              onChange={() => toggle(key, value)}
            />
            {label(value)}
          </label>
        ))}
      </div>
    </fieldset>
  );
  return (
    <form
      className="panel flow-settings stack"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        void mutation.run(async () => {
          await request(`${basePath}/settings`, {
            method: 'POST',
            body: { name, description, priority, isDefault, match },
          });
          setSaved(true);
          onSaved();
        });
      }}
    >
      <h3>{t('Quando se aplica', 'When it applies')}</h3>
      <p className="muted">
        {t(
          'Um ticket novo segue o fluxo publicado cuja regra coincide e tem o menor número de prioridade (cada prioridade só pode ser usada uma vez). Sem coincidência, segue o fluxo por omissão. Critérios vazios aceitam qualquer valor.',
          'A new ticket follows the published flow whose rule matches with the lowest priority number (each priority can only be used once). Without a match, it follows the default flow. Empty criteria accept any value.',
        )}
      </p>
      <label>
        {t('Nome', 'Name')}
        <input
          value={name}
          minLength={2}
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        {t('Descrição', 'Description')}
        <textarea
          rows={2}
          maxLength={500}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        {t('Prioridade da regra (menor ganha)', 'Rule priority (lowest wins)')}
        <input
          type="number"
          min={1}
          max={999}
          value={priority}
          onChange={(event) => setPriority(Number(event.target.value))}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(event) => setIsDefault(event.target.checked)}
        />
        {t('Fluxo por omissão do projeto', 'Project default flow')}
      </label>
      {!isDefault && (
        <>
          {group(
            'origins',
            t('Origem do ticket', 'Ticket origin'),
            ticketOrigins,
            (value) => originLabels[value]?.[lang] ?? value,
          )}
          {group('categories', t('Tipo', 'Type'), categories, (value) => labels.category[value])}
          {group(
            'environments',
            t('Ambiente', 'Environment'),
            environments,
            (value) => labels.environment[value],
          )}
          {group(
            'priorities',
            t('Prioridade do ticket', 'Ticket priority'),
            priorities,
            (value) => labels.priority[value],
          )}
        </>
      )}
      {saved && <Notice tone="success">{t('Regras gravadas.', 'Rules saved.')}</Notice>}
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <button className="button button-primary align-start" disabled={mutation.busy}>
        {t('Gravar regras', 'Save rules')}
      </button>
    </form>
  );
}
