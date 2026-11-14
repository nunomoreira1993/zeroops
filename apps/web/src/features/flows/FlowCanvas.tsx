import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  flowOperationLabels,
  portLabel,
  type FlowDefinition,
  type FlowNode,
} from '@zeroops/contracts';
import { useIdentityLocale } from '../../lib/identity';
import { assigneeLabel } from './flow-labels';
import { TechLogos, nodeTechs } from './tech-logos';
import {
  edgeLabelPosition,
  canvasNodePorts,
  edgeRoutingChannels,
  flowStructureKey,
  layoutFlowVertically,
  needsAutomaticLayout,
  routeOrthogonalEdge,
  type FlowBounds,
  type FlowPoint,
  type FlowSize,
} from './flow-layout';

/** Marcação visual de uma etapa (proposta do assistente, percurso do ticket ou simulação). */
export type StepMark =
  'added' | 'changed' | 'removed' | 'done' | 'current' | 'possible' | 'issue' | 'stopped';

export interface CanvasMarks {
  nodes?: Record<string, StepMark>;
  /** Ligações destacadas (`source:port`). */
  edges?: Record<string, 'added' | 'removed' | 'done' | 'possible'>;
  /** Etapas removidas pela proposta (mostradas a tracejado). */
  ghosts?: FlowNode[];
  ghostLayout?: FlowDefinition['layout'];
  /** Contadores por etapa (tentativas no ticket ou na simulação). */
  counts?: Record<string, number>;
}

interface StepData extends Record<string, unknown> {
  node: FlowNode;
  ports: string[];
  start: boolean;
  mark?: StepMark;
  count?: number;
  locale: 'pt' | 'en';
  pathRole?: 'origin' | 'destination';
}

interface FlowEdgeData extends Record<string, unknown> {
  label: string;
  routeUnavailable: string;
  obstacles: FlowBounds[];
  returnLane: number;
  sourceChannel: number;
  targetChannel: number;
  targetOffset: number;
  corridorX?: number;
  outcome: 'success' | 'failure' | 'neutral';
}

type StepNode = Node<StepData, 'step'>;
type FlowEdge = Edge<FlowEdgeData, 'orthogonal'>;

const NO_MARKS: CanvasMarks = {};

const opIcons: Record<FlowNode['op'], string> = {
  action: '⚙',
  copilot_task: '✦',
  human_decision: '☑',
  end: '■',
};

function StepCard({ data, selected }: NodeProps<StepNode>) {
  const { node, ports, start, mark, count, locale, pathRole } = data;
  return (
    <div
      className={`flow-step flow-op-${node.op}${mark ? ` flow-mark-${mark}` : ''}${selected ? ' is-selected' : ''}${pathRole ? ` flow-path-${pathRole}` : ''}`}
    >
      {!start && <Handle type="target" position={Position.Top} className="flow-handle-in" />}
      <div className="flow-step-head">
        <span className="flow-step-op" aria-hidden="true">
          {opIcons[node.op]}
        </span>
        <span className="flow-step-kind">{flowOperationLabels[node.op][locale]}</span>
        {start && <span className="flow-step-badge">{locale === 'pt' ? 'início' : 'start'}</span>}
        {count ? <span className="flow-step-badge">×{count}</span> : null}
      </div>
      <strong className="flow-step-label">{node.label}</strong>
      <TechLogos ids={nodeTechs(node)} size={14} />
      {node.op !== 'end' && node.op !== 'action' && (
        <span className="flow-step-assignee">{assigneeLabel(node.assignee, locale)}</span>
      )}
      {ports.length > 0 && (
        <>
          <div className="flow-step-ports">
            {ports.map((port) => (
              <span key={port} className={`flow-port flow-port-${outcomeFor(port)}`}>
                {portLabel(node, port, locale)}
              </span>
            ))}
          </div>
          {ports.map((port, index) => (
            <Handle
              key={port}
              type="source"
              id={port}
              position={Position.Bottom}
              className="flow-handle-out"
              style={{ left: `${((index + 0.5) * 100) / ports.length}%` }}
              aria-label={portLabel(node, port, locale)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function pointsToPath(points: FlowPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function OrthogonalEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  selected,
  data,
}: EdgeProps<FlowEdge>) {
  const points = routeOrthogonalEdge({
    source: { id: source, x: sourceX, y: sourceY },
    target: { id: target, x: targetX, y: targetY },
    obstacles: data?.obstacles ?? [],
    returnLane: data?.returnLane ?? 0,
    sourceChannel: data?.sourceChannel ?? 0,
    targetChannel: data?.targetChannel ?? 0,
    targetOffset: data?.targetOffset ?? 0,
    corridorX: data?.corridorX,
  });
  const label = data?.label ?? '';
  const routeUnavailable = data?.routeUnavailable ?? 'Route unavailable';
  const labelWidth = Math.min(152, Math.max(68, label.length * 7 + 16));
  const labelHeight = Math.min(
    110,
    Math.max(28, Math.ceil((label.length * 7 + 16) / 152) * 18 + 10),
  );
  const labelPosition = points
    ? edgeLabelPosition(points, data?.obstacles ?? [], labelWidth, labelHeight)
    : { x: sourceX, y: sourceY + 36 };
  const selectedClass = selected ? ' flow-edge-selected' : '';
  return (
    <>
      <BaseEdge
        id={id}
        path={points ? pointsToPath(points) : ''}
        markerEnd={points ? markerEnd : undefined}
        interactionWidth={24}
        className={`flow-orthogonal-path${selectedClass}`}
      />
      {(!points || selected) && (
        <EdgeLabelRenderer>
          <span
            className={`flow-edge-label${data?.outcome ? ` flow-edge-label-${data.outcome}` : ''}${selectedClass}${points ? '' : ' flow-edge-label-unroutable'}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelPosition.x}px, ${labelPosition.y}px)`,
            }}
            aria-label={points ? label : `${routeUnavailable}: ${label}`}
          >
            {points ? label : `⚠ ${routeUnavailable}: ${label}`}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { step: StepCard };
const edgeTypes = { orthogonal: OrthogonalEdge };

/** Compatibilidade para os restantes consumidores; dimensões reais são usadas pelo canvas. */
export function autoLayout(definition: FlowDefinition): FlowDefinition['layout'] {
  return layoutFlowVertically(definition);
}

function measuredSizes(nodes: StepNode[]): Map<string, FlowSize> {
  return new Map(
    nodes.map((node) => [
      node.id,
      {
        width: node.measured?.width ?? node.width ?? 280,
        height: node.measured?.height ?? node.height ?? 120,
      },
    ]),
  );
}

function measuredBounds(nodes: StepNode[]): FlowBounds[] {
  return nodes.map((node) => {
    const size = measuredSizes([node]).get(node.id)!;
    return { id: node.id, x: node.position.x, y: node.position.y, ...size };
  });
}

function hasMeasuredDefinitionNodes(definition: FlowDefinition, nodes: StepNode[]): boolean {
  return definition.nodes.every((definitionNode) => {
    const node = nodes.find((item) => item.id === definitionNode.id);
    return Boolean(node?.measured?.width && node.measured?.height);
  });
}

function sameLayout(left: FlowDefinition['layout'], right: FlowDefinition['layout']): boolean {
  const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const id of ids) {
    if (left[id]?.x !== right[id]?.x || left[id]?.y !== right[id]?.y) return false;
  }
  return true;
}

function buildNodes(
  definition: FlowDefinition,
  marks: CanvasMarks,
  locale: 'pt' | 'en',
  selected: string | null,
  selectedEdgeId: string | null,
): StepNode[] {
  const layout = autoLayout(definition);
  const useSavedLayout = !needsAutomaticLayout(definition);
  const selectedEdge = definition.edges.find((edge) => edge.id === selectedEdgeId);
  const nodes: StepNode[] = definition.nodes.map((node) => {
    const mark = marks.nodes?.[node.id];
    const count = marks.counts?.[node.id];
    const pathRole =
      selectedEdge?.source === node.id
        ? 'origin'
        : selectedEdge?.target === node.id
          ? 'destination'
          : undefined;
    return {
      id: node.id,
      type: 'step',
      position: (useSavedLayout ? definition.layout[node.id] : layout[node.id]) ?? { x: 0, y: 0 },
      selected: node.id === selected,
      data: {
        node,
        ports: canvasNodePorts(definition, node),
        start: node.id === definition.start,
        ...(mark ? { mark } : {}),
        ...(count ? { count } : {}),
        locale,
        ...(pathRole ? { pathRole } : {}),
      },
    };
  });
  for (const ghost of marks.ghosts ?? [])
    nodes.push({
      id: `ghost:${ghost.id}`,
      type: 'step',
      position: marks.ghostLayout?.[ghost.id] ?? { x: -280, y: 0 },
      draggable: false,
      selectable: false,
      data: { node: ghost, ports: [], start: false, mark: 'removed', locale },
    });
  return nodes;
}

function outcomeFor(port: string): FlowEdgeData['outcome'] {
  if (/(fail|error|reject|recus|cancel|negative|needs_information)/i.test(port)) return 'failure';
  if (/(done|success|approved|aprova|ok)/i.test(port)) return 'success';
  return 'neutral';
}

function buildEdges(
  definition: FlowDefinition,
  marks: CanvasMarks,
  locale: 'pt' | 'en',
  nodes: StepNode[],
  selectedEdgeId: string | null,
): FlowEdge[] {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const obstacles = measuredBounds(nodes);
  const channels = edgeRoutingChannels(definition, obstacles);
  return definition.edges.map((edge) => {
    const mark = marks.edges?.[`${edge.source}:${edge.port}`];
    return {
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.port,
      target: edge.target,
      type: 'orthogonal',
      label: portLabel(byId.get(edge.source), edge.port, locale),
      selected: edge.id === selectedEdgeId,
      ...(mark ? { className: `flow-edge-${mark}` } : {}),
      animated: mark === 'possible',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        label: portLabel(byId.get(edge.source), edge.port, locale),
        routeUnavailable: locale === 'pt' ? 'Rota indisponível' : 'Route unavailable',
        obstacles,
        ...channels.get(edge.id)!,
        outcome: outcomeFor(edge.port),
      },
    };
  });
}

/**
 * Desenho do fluxo. Arrastar muda só `layout`; ligar uma saída muda `edges`.
 * Layouts antigos ilegíveis são organizados apenas na vista; abrir não grava nem publica.
 */
export function FlowCanvas({
  definition,
  marks = NO_MARKS,
  selected = null,
  onSelect,
  onChange,
  height = 520,
  organizeRequest = 0,
}: {
  definition: FlowDefinition;
  marks?: CanvasMarks;
  selected?: string | null;
  onSelect?: (nodeId: string | null) => void;
  onChange?: (definition: FlowDefinition) => void;
  height?: number;
  organizeRequest?: number;
}) {
  const { locale } = useIdentityLocale();
  const lang: 'pt' | 'en' = locale === 'en' ? 'en' : 'pt';
  const editable = Boolean(onChange);
  const structure = useMemo(() => flowStructureKey(definition), [definition]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const built = useMemo(
    () => buildNodes(definition, marks, lang, selected, selectedEdgeId),
    [definition, marks, lang, selected, selectedEdgeId],
  );
  const [nodes, setNodes] = useState<StepNode[]>(built);
  const [instance, setInstance] = useState<ReactFlowInstance<StepNode, FlowEdge> | null>(null);
  const previousLayout = useRef(definition.layout);
  const initialLayoutPending = useRef(true);
  const focusPending = useRef(true);
  const previousStructure = useRef(structure);
  const previousOrganizeRequest = useRef(organizeRequest);
  const structuralLayoutPending = useRef(false);
  const manualLayoutPending = useRef(false);

  useEffect(() => {
    const layoutChanged = !sameLayout(previousLayout.current, definition.layout);
    previousLayout.current = definition.layout;
    setNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      return built.map((node) => {
        const previous = currentById.get(node.id);
        return previous?.measured
          ? {
              ...node,
              position: layoutChanged ? node.position : previous.position,
              measured: previous.measured,
              width: previous.width,
              height: previous.height,
            }
          : node;
      });
    });
  }, [built, definition.layout]);

  useEffect(() => {
    if (previousStructure.current === structure) return;
    previousStructure.current = structure;
    structuralLayoutPending.current = true;
  }, [structure]);

  useEffect(() => {
    if (previousOrganizeRequest.current === organizeRequest) return;
    previousOrganizeRequest.current = organizeRequest;
    manualLayoutPending.current = true;
  }, [organizeRequest]);

  useEffect(() => {
    if (
      !initialLayoutPending.current &&
      !structuralLayoutPending.current &&
      !manualLayoutPending.current
    )
      return;
    if (!hasMeasuredDefinitionNodes(definition, nodes)) return;

    const persist = structuralLayoutPending.current || manualLayoutPending.current;
    const organize = persist || needsAutomaticLayout(definition, measuredSizes(nodes));
    initialLayoutPending.current = false;
    if (!organize) return;
    const layout = layoutFlowVertically(definition, measuredSizes(nodes));
    structuralLayoutPending.current = false;
    manualLayoutPending.current = false;
    focusPending.current = true;
    setNodes((current) =>
      current.map((node) => (layout[node.id] ? { ...node, position: layout[node.id]! } : node)),
    );
    if (persist && onChange && !sameLayout(definition.layout, layout))
      onChange({ ...definition, layout });
  }, [definition, nodes, onChange, organizeRequest, structure]);

  useEffect(() => {
    if (!instance || initialLayoutPending.current || !focusPending.current) return;
    focusPending.current = false;
    const start = nodes.find((node) => node.id === definition.start);
    if (!start) return;
    const firstRows = nodes.filter(
      (node) => node.position.y <= start.position.y + (start.measured?.height ?? 120) + 136,
    );
    void instance.fitView({
      nodes: firstRows.map(({ id }) => ({ id })),
      padding: 0.18,
      minZoom: 0.8,
      maxZoom: 1,
    });
  }, [definition.start, instance, nodes]);

  useEffect(() => {
    if (selectedEdgeId && !definition.edges.some((edge) => edge.id === selectedEdgeId))
      setSelectedEdgeId(null);
  }, [definition.edges, selectedEdgeId]);

  const edges = useMemo(
    () => buildEdges(definition, marks, lang, nodes, selectedEdgeId),
    [definition, marks, lang, nodes, selectedEdgeId],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<StepNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      if (changes.some((change) => change.type === 'select' && change.selected))
        setSelectedEdgeId(null);
      if (!onChange) return;

      const layout = { ...autoLayout(definition) };
      for (const node of nodes) layout[node.id] = node.position;
      let moved = false;
      for (const change of changes)
        if (change.type === 'position' && change.dragging === false && change.position) {
          layout[change.id] = {
            x: Math.round(change.position.x),
            y: Math.round(change.position.y),
          };
          moved = true;
        }
      if (moved) onChange({ ...definition, layout });
    },
    [definition, nodes, onChange],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!onChange || !connection.sourceHandle || connection.source === connection.target) return;
      const port = connection.sourceHandle;
      const kept = definition.edges.filter(
        (edge) => !(edge.source === connection.source && edge.port === port),
      );
      const base = `${connection.source}-${port}`.replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
      let id = base;
      for (let index = 2; kept.some((edge) => edge.id === id); index += 1) id = `${base}-${index}`;
      onChange({
        ...definition,
        edges: [...kept, { id, source: connection.source, port, target: connection.target }],
      });
    },
    [definition, onChange],
  );

  return (
    <div className="flow-canvas" style={{ height }}>
      <ReactFlow<StepNode, FlowEdge>
        nodes={nodes}
        onInit={setInstance}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => {
          setSelectedEdgeId(null);
          if (!node.id.startsWith('ghost:')) onSelect?.(node.id);
        }}
        onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
        onSelectionChange={({ edges: selectedEdges }) =>
          setSelectedEdgeId(selectedEdges.at(-1)?.id ?? null)
        }
        onPaneClick={() => {
          setSelectedEdgeId(null);
          onSelect?.(null);
        }}
        onEdgesDelete={(removed) => {
          if (!onChange) return;
          const ids = new Set(removed.map((edge) => edge.id));
          onChange({ ...definition, edges: definition.edges.filter((edge) => !ids.has(edge.id)) });
        }}
        // Etapas removem-se no painel da etapa; a tecla Delete apaga só ligações selecionadas.
        onBeforeDelete={async ({ nodes: removing, edges: removingEdges }) =>
          editable && !removing.length && removingEdges.length > 0
        }
        nodesDraggable={editable}
        nodesConnectable={editable}
        edgesFocusable
        deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
        minZoom={0.2}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
