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
  type FlowPatchOperation,
  type FlowAuthoringStateView,
  type FlowSimulationsView,
} from '@zeroops/contracts';
import { Loading, Notice, ResourceError } from '../../components/ui';
import { ticketLabels } from '../../lib/format';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectPermission, useProjectSession } from '../../lib/project-admin';
import { FlowAssistantPanel } from './FlowAssistantPanel';
import { autoLayout, FlowCanvas, type CanvasMarks } from './FlowCanvas';
import { ActivationEvidence, FlowSimulator, TestEvidenceList } from './FlowSimulator';
import { StepConfigPanel } from './StepConfigPanel';
import { newConditionConfig } from './ConditionConfig';
import { nodeKey, originLabels } from './flow-labels';
import { useFlowAuthoringEvents } from './useFlowAuthoringEvents';

type SidePanel = 'step' | 'assistant' | 'simulate' | 'settings';

/** Nova revisão do servidor com as posições que o utilizador já tinha mexido (etapas existentes). */
function keepLocalLayout(next: FlowDefinition, local: FlowDefinition): FlowDefinition {
  const ids = new Set(next.nodes.map((node) => node.id));
  const layout = { ...next.layout };
  for (const [id, position] of Object.entries(local.layout)) if (ids.has(id)) layout[id] = position;
  return { ...next, layout };
}

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
    case 'condition':
      return { id, op, label, assignee: null, config: newConditionConfig() };
  }
}

const activationKindLabels = {
  activation: { pt: 'Ativação', en: 'Activation' },
  migration: { pt: 'Em serviço antes do P02', en: 'In service before P02' },
  alert_link: { pt: 'Associação de alerta', en: 'Alert link' },
  default_transfer: { pt: 'Deixou de ser por omissão', en: 'No longer default' },
} as const;

/** Editor de um fluxo: desenho, configuração da etapa, assistente, simulação e publicação. */
export function FlowEditor({ flowId, onBack }: { flowId: string; onBack: () => void }) {
  const { locale, t } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const { request } = useProjectSession();
  const canEdit = useProjectPermission('flows.edit');
  const canActivate = useProjectPermission('flows.activate');
  const canSimulate = useProjectPermission('flows.simulate');
  const basePath = `/flows/${encodeURIComponent(flowId)}`;
  const resource = useResource<FlowDetail>(basePath);
  const authoringResource = useResource<FlowAuthoringStateView>(`${basePath}/authoring`);
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [definition, setDefinition] = useState<FlowDefinition | null>(null);
  /** Revisão mais recente do servidor enquanto há edições locais por gravar (nunca sobrescreve). */
  const [conflict, setConflict] = useState<FlowDetail | null>(null);
  const [liveMarks, setLiveMarks] = useState<{
    nodes: string[];
    changed: string[];
    edges: string[];
  }>({ nodes: [], changed: [], edges: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<SidePanel>('assistant');
  const [preview, setPreview] = useState<FlowAssistantRequestView | null>(null);
  const [simulation, setSimulation] = useState<CanvasMarks | null>(null);
  const simulations = useResource<FlowSimulationsView>(
    canSimulate ? `${basePath}/simulations` : null,
  );
  const reloadSimulations = simulations.reload;
  // Novo rascunho gravado ou definições alteradas: a evidência de testes é recalculada por hash.
  useEffect(() => {
    if (detail) reloadSimulations();
  }, [detail?.draftVersion, detail?.updatedAt, reloadSimulations]);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const [organizeRequest, setOrganizeRequest] = useState(0);
  const mutation = useMutation();

  useEffect(() => {
    const next = resource.data;
    if (!next) return;
    if (!detail || !definition) {
      setDetail(next);
      setDefinition(next.draft);
      return;
    }
    const local = flowChangeKind(detail.draft, definition);
    const sameAsServer = flowChangeKind(next.draft, definition) !== 'logic';
    // Sem edições locais (ou só posições, ou já iguais ao servidor): adota o servidor e mantém as
    // posições que o utilizador mexeu. Com edições locais de execução: nunca as apaga.
    if (local === 'none' || local === 'layout' || sameAsServer) {
      setDetail(next);
      setDefinition(local === 'none' ? next.draft : keepLocalLayout(next.draft, definition));
      setConflict(null);
      return;
    }
    if (next.draftVersion === detail.draftVersion) {
      setDetail(next);
      return;
    }
    setConflict(next);
  }, [resource.data]);

  const reloadAuthoring = authoringResource.reload;
  const authoringEvents = useFlowAuthoringEvents(basePath, (event) => {
    if (
      event.type === 'operation_applied' ||
      event.type === 'operation_undone' ||
      event.type === 'proposal_accepted' ||
      event.type === 'draft_saved'
    )
      resource.reload();
    if (event.type === 'operation_applied' && event.payload.kind === 'definition') {
      const ids = (key: string) =>
        Array.isArray(event.payload[key]) ? (event.payload[key] as string[]) : [];
      setLiveMarks({ nodes: ids('added'), changed: ids('changed'), edges: ids('addedEdges') });
    }
    if (event.type !== 'draft_read') reloadAuthoring();
  });
  useEffect(() => {
    if (!liveMarks.nodes.length && !liveMarks.changed.length && !liveMarks.edges.length) return;
    const timer = window.setTimeout(
      () => setLiveMarks({ nodes: [], changed: [], edges: [] }),
      6000,
    );
    return () => window.clearTimeout(timer);
  }, [liveMarks]);
  const lastEvent = authoringEvents.events.at(-1)?.id ?? 0;
  useEffect(() => {
    if (selected && definition && !definition.nodes.some((node) => node.id === selected))
      setSelected(null);
  }, [definition, selected]);

  /** Propostas do turno assistido em curso: crescem no desenho antes de o turno terminar. */
  const liveProposal = useMemo(() => {
    const closed = new Set(
      authoringEvents.events
        .filter((event) =>
          [
            'turn_completed',
            'turn_failed',
            'turn_cancelled',
            'proposal_accepted',
            'proposal_discarded',
          ].includes(event.type),
        )
        .map((event) => event.requestId),
    );
    const operations: FlowPatchOperation[] = [];
    let requestId: string | null = null;
    for (const event of authoringEvents.events) {
      if (event.type !== 'operation_proposed' || event.payload.kind !== 'definition') continue;
      if (!event.requestId || closed.has(event.requestId)) continue;
      if (requestId && requestId !== event.requestId) operations.length = 0;
      requestId = event.requestId;
      if (Array.isArray(event.payload.operations))
        operations.push(...(event.payload.operations as FlowPatchOperation[]));
    }
    return operations;
  }, [authoringEvents.events]);

  const members = useMemo(() => new Set(detail?.members.map((member) => member.id)), [detail]);
  const issues = useMemo(
    () => (definition ? validateFlowDefinition(definition, { members }) : []),
    [definition, members],
  );
  const change = detail && definition ? flowChangeKind(detail.draft, definition) : 'none';
  const layoutOnly = change === 'layout';
  const dirty = change !== 'none';

  const proposal = useMemo(() => {
    const operations = preview?.response?.operations ?? liveProposal;
    if (!operations.length || !detail) return null;
    try {
      return applyFlowOperations(detail.draft, operations);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'erro' };
    }
  }, [preview, liveProposal, detail]);

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
    if (simulation) return simulation;
    const nodes: CanvasMarks['nodes'] = {};
    for (const issue of issues) if (issue.nodeId) nodes[issue.nodeId] = 'issue';
    // Destaque breve do que o Copilot acabou de aplicar (modo automático).
    for (const id of liveMarks.changed) nodes[id] = 'changed';
    for (const id of liveMarks.nodes) nodes[id] = 'added';
    const edges: CanvasMarks['edges'] = {};
    for (const edge of definition?.edges ?? [])
      if (liveMarks.edges.includes(edge.id)) edges[`${edge.source}:${edge.port}`] = 'added';
    return { nodes, edges };
  }, [proposal, simulation, issues, detail, liveMarks, definition]);

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
            : t('Rascunho gravado (ainda não ativo).', 'Draft saved (not active yet).'),
      });
      resource.reload();
    });

  const publish = () =>
    mutation.run(async () => {
      const result = await request<FlowDetail>(`${basePath}/activate`, {
        method: 'POST',
        body: { expectedDraftVersion: detail.draftVersion },
      });
      setNotice({
        tone: 'success',
        text: t(
          `Versão ${result.published?.number ?? ''} ativa para novos tickets. Os tickets em curso continuam na versão com que entraram.`,
          `Version ${result.published?.number ?? ''} is active for new tickets. Tickets in progress keep the version they started with.`,
        ),
      });
      resource.reload();
    });

  const pending = detail.pendingChanges;
  const hasPending = pending.definition || pending.routing || pending.alertKeys;
  const pendingText = [
    pending.definition ? t('etapas/ligações', 'steps/links') : null,
    pending.routing ? t('regras de seleção', 'selection rules') : null,
    pending.alertKeys ? t('alertas a associar', 'alerts to link') : null,
  ]
    .filter(Boolean)
    .join(', ');

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
      // A condição é uma operação do contrato V2: o rascunho passa a declará-lo.
      ...(op === 'condition' ? { schemaVersion: 2 as const } : {}),
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
        <span
          className={`status-badge ${detail.published && detail.active ? 'status-resolved' : 'status-new'}`}
        >
          {detail.published && detail.active
            ? t(`Ativa v${detail.published.number}`, `Active v${detail.published.number}`)
            : detail.published
              ? t(
                  `Fora de serviço (última v${detail.published.number})`,
                  `Out of service (last v${detail.published.number})`,
                )
              : t('Nunca ativado', 'Never activated')}
        </span>
        <span className="flow-chip">
          {t(`Rascunho rev. ${detail.draftVersion}`, `Draft rev. ${detail.draftVersion}`)}
          {definition.schemaVersion === 2 ? ' · V2' : ' · V1'}
        </span>
        {detail.active?.isDefault && (
          <span className="flow-chip">{t('por omissão', 'default')}</span>
        )}
        <span className="flow-toolbar-spacer" />
        <button
          type="button"
          className="button button-secondary"
          disabled={!canEdit || Boolean(previewing) || mutation.busy}
          onClick={() => setOrganizeRequest((requestId) => requestId + 1)}
        >
          {t('Organizar verticalmente', 'Organize vertically')}
        </button>
        <select
          aria-label={t('Acrescentar etapa', 'Add step')}
          value=""
          disabled={!canEdit || Boolean(previewing)}
          onChange={(event) => {
            if (event.target.value) addStep(event.target.value as FlowOperationKey);
          }}
        >
          <option value="">{t('+ Acrescentar etapa', '+ Add step')}</option>
          {(['copilot_task', 'human_decision', 'action', 'condition', 'end'] as const).map((op) => (
            <option key={op} value={op}>
              {flowOperationLabels[op][lang]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button-secondary"
          disabled={!canEdit || !dirty || mutation.busy}
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
          disabled={!canEdit || !dirty || mutation.busy}
          onClick={() => void save()}
        >
          {t('Gravar rascunho', 'Save draft')}
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={!canActivate || dirty || issues.length > 0 || !hasPending || mutation.busy}
          title={
            issues.length
              ? t('Corrija os problemas antes de ativar.', 'Fix the issues before activating.')
              : dirty
                ? t('Grave o rascunho antes de ativar.', 'Save the draft before activating.')
                : undefined
          }
          onClick={() => void publish()}
        >
          {t('Ativar esta versão', 'Activate this version')}
        </button>
      </div>
      {canSimulate && !dirty && hasPending && <ActivationEvidence view={simulations.data} />}
      {hasPending ? (
        <Notice tone="info">
          {t(
            `O rascunho tem alterações por ativar (${pendingText}). Só entram em serviço para novos tickets com «Ativar esta versão».`,
            `The draft has changes not yet active (${pendingText}). They only apply to new tickets after «Activate this version».`,
          )}
        </Notice>
      ) : (
        detail.published && (
          <p className="muted flow-dirty">
            {t(
              'O rascunho gravado é igual à versão ativa.',
              'The saved draft matches the active version.',
            )}
          </p>
        )
      )}
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
      {conflict && (
        <Notice tone="warning">
          {t(
            `O rascunho mudou no servidor (rev. ${conflict.draftVersion}, p. ex. pelo Copilot ou por outra pessoa) enquanto tinha alterações por gravar. As suas alterações foram mantidas e nada foi sobrescrito.`,
            `The draft changed on the server (rev. ${conflict.draftVersion}, e.g. by Copilot or someone else) while you had unsaved changes. Your changes were kept and nothing was overwritten.`,
          )}
          <div className="flow-config-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setDetail(conflict);
                setDefinition(conflict.draft);
                setConflict(null);
              }}
            >
              {t('Recarregar (descarta as minhas alterações)', 'Reload (discard my changes)')}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={!canEdit}
              onClick={() => {
                setDetail(conflict);
                setConflict(null);
                setNotice({
                  tone: 'info',
                  text: t(
                    'Ao gravar, as suas alterações substituem a revisão atual do servidor.',
                    'Saving will replace the current server revision with your changes.',
                  ),
                });
              }}
            >
              {t('Manter as minhas e substituir ao gravar', 'Keep mine and replace on save')}
            </button>
          </div>
        </Notice>
      )}
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
            {...(previewing || !canEdit ? {} : { onChange: setDefinition })}
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
                `${issues.length} problema(s) a corrigir antes de ativar`,
                `${issues.length} issue(s) to fix before activating`,
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
                disabled={id === 'simulate' && !canSimulate}
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
              flowId={flowId}
              draftVersion={detail.draftVersion}
              // Posições só locais (p. ex. etapas novas organizadas no ecrã) são preservadas ao
              // adotar o servidor; só alterações de execução por gravar bloqueiam o assistente.
              dirty={change === 'logic'}
              copilotReady={detail.copilotReady}
              previewId={preview?.id ?? null}
              authoring={authoringResource.data}
              events={authoringEvents.events}
              live={authoringEvents.live}
              eventCursor={lastEvent}
              onPreview={(item) => {
                setPreview(item);
                if (item) setSimulation(null);
              }}
              onResolved={() => {
                resource.reload();
                reloadAuthoring();
              }}
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
          {panel === 'simulate' && canSimulate && (
            <FlowSimulator
              basePath={basePath}
              definition={detail.draft}
              dirty={change === 'logic'}
              onMarks={(marks) => {
                setSimulation(marks);
                if (marks) setPreview(null);
              }}
              onChanged={simulations.reload}
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
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  if (!detail.versions.length && !detail.activations.length) return null;
  const format = (value: string) =>
    new Date(value).toLocaleString(locale === 'en' ? 'en-GB' : 'pt-PT');
  return (
    <>
      {detail.versions.length > 0 && (
        <section className="panel flow-versions">
          <h3>{t('Versões imutáveis', 'Immutable versions')}</h3>
          <ul className="content-list">
            {detail.versions.map((version) => (
              <li key={version.id}>
                <strong>v{version.number}</strong>
                {version.active && (
                  <span className="flow-chip flow-chip-active">{t('ativa', 'active')}</span>
                )}{' '}
                · {format(version.publishedAt)}
                {version.publishedBy ? ` · ${version.publishedBy}` : ''}
                {` · V${version.schemaVersion}`}
                {version.manifestHash && (
                  <code className="flow-hash" title={version.manifestHash}>
                    {' '}
                    {version.manifestHash.slice(0, 12)}
                  </code>
                )}
                {' · '}
                {t(
                  `${version.activeExecutions} ticket(s) em curso nesta versão`,
                  `${version.activeExecutions} ticket(s) in progress on this version`,
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {detail.activations.length > 0 && (
        <section
          className="panel flow-versions"
          aria-label={t('Histórico de ativações', 'Activation history')}
        >
          <h3>{t('Histórico de ativações', 'Activation history')}</h3>
          <ul className="content-list">
            {detail.activations.map((item) => (
              <li key={item.id}>
                <strong>{activationKindLabels[item.kind][lang]}</strong>
                {item.versionNumber !== null && ` · v${item.versionNumber}`}
                {item.previousVersionNumber !== null &&
                  t(
                    ` (antes v${item.previousVersionNumber})`,
                    ` (was v${item.previousVersionNumber})`,
                  )}
                {typeof item.details.alertKey === 'string' && ` · ${item.details.alertKey}`}
                {item.details.action === 'unlinked' && t(' · retirada', ' · removed')}
                {' · '}
                {format(item.createdAt)}
                {item.actor ? ` · ${item.actor}` : ''}
                {item.manifestHash && (
                  <code className="flow-hash" title={item.manifestHash}>
                    {' '}
                    {item.manifestHash.slice(0, 12)}
                  </code>
                )}
                {item.kind === 'activation' && <TestEvidenceList tests={item.details.tests} />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

const categories = ['incident', 'bug', 'improvement', 'question'] as const;
const exampleLines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 3)
    .slice(0, 10);
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
  const canEdit = useProjectPermission('flows.edit');
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description);
  const [priority, setPriority] = useState(detail.priority);
  const [isDefault, setIsDefault] = useState(detail.isDefault);
  const [match, setMatch] = useState<FlowMatch>(detail.match);
  const [instructions, setInstructions] = useState(detail.routingPolicy.instructions);
  const [positive, setPositive] = useState(detail.routingPolicy.positiveExamples.join('\n'));
  const [negative, setNegative] = useState(detail.routingPolicy.negativeExamples.join('\n'));
  const [fallbackOnUnresolved, setFallbackOnUnresolved] = useState(
    detail.routingPolicy.fallbackOnUnresolved,
  );
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
    <fieldset className="flow-fieldset" disabled={!canEdit}>
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
            body: {
              name,
              description,
              priority,
              isDefault,
              match,
              routingPolicy: {
                instructions,
                positiveExamples: exampleLines(positive),
                negativeExamples: exampleLines(negative),
                fallbackOnUnresolved,
              },
            },
          });
          setSaved(true);
          onSaved();
        });
      }}
    >
      <h3>{t('Quando se aplica', 'When it applies')}</h3>
      <p className="muted">
        {t(
          'Um ticket novo segue o fluxo ativo cuja regra coincide e tem o menor número de prioridade. Sem coincidência, segue o fluxo por omissão. Critérios vazios aceitam qualquer valor. Estas regras são do rascunho: só entram em serviço com «Ativar esta versão».',
          'A new ticket follows the active flow whose rule matches with the lowest priority number. Without a match, it follows the default flow. Empty criteria accept any value. These rules belong to the draft: they only apply after «Activate this version».',
        )}
      </p>
      {detail.active && (
        <p className="muted">
          {t('Em serviço', 'In service')}: {t('prioridade', 'priority')} {detail.active.priority}
          {detail.active.isDefault ? ` · ${t('por omissão', 'default')}` : ''}
          {detail.pendingChanges.routing
            ? ` · ${t('o rascunho altera esta regra', 'the draft changes this rule')}`
            : ''}
        </p>
      )}
      <label>
        {t('Nome', 'Name')}
        <input
          value={name}
          disabled={!canEdit}
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
          disabled={!canEdit}
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
          disabled={!canEdit}
          onChange={(event) => setPriority(Number(event.target.value))}
        />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={isDefault}
          disabled={!canEdit}
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
      <fieldset className="flow-fieldset stack" disabled={!canEdit}>
        <legend>{t('Encaminhamento semântico', 'Semantic routing')}</legend>
        <p className="muted">
          {t(
            'Opcional. Quando vários fluxos coincidem e têm instruções, o Copilot escolhe entre eles com base no pedido e pode perguntar ao autor antes de decidir. Sem instruções, a regra acima é aplicada diretamente.',
            'Optional. When several matching flows have instructions, Copilot chooses among them based on the request and may ask the author before deciding. Without instructions, the rule above applies directly.',
          )}
        </p>
        {detail.active?.routingPolicy?.instructions && (
          <p className="muted">
            {t('Em serviço', 'In service')}: {detail.active.routingPolicy.instructions}
          </p>
        )}
        <label>
          {t('Quando usar este fluxo', 'When to use this flow')}
          <textarea
            rows={4}
            maxLength={4000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <label>
          {t('Exemplos que pertencem (um por linha)', 'Examples that belong (one per line)')}
          <textarea
            rows={3}
            value={positive}
            onChange={(event) => setPositive(event.target.value)}
          />
        </label>
        <label>
          {t(
            'Exemplos que não pertencem (um por linha)',
            'Examples that do not belong (one per line)',
          )}
          <textarea
            rows={3}
            value={negative}
            onChange={(event) => setNegative(event.target.value)}
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={fallbackOnUnresolved}
            onChange={(event) => setFallbackOnUnresolved(event.target.checked)}
          />
          {t(
            'Receber os pedidos que o encaminhamento não conseguiu decidir (quando este fluxo é o fallback)',
            'Receive requests the routing could not decide (when this flow is the fallback)',
          )}
        </label>
      </fieldset>
      {saved && <Notice tone="success">{t('Regras gravadas.', 'Rules saved.')}</Notice>}
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <button className="button button-primary align-start" disabled={!canEdit || mutation.busy}>
        {t('Gravar regras', 'Save rules')}
      </button>
    </form>
  );
}
