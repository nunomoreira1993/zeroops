import { describe, expect, it } from 'vitest';
import { toBinaryFlow, type FlowDefinition } from '@zeroops/contracts';
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
} from '../src/features/flows/flow-layout';

const definition: FlowDefinition = {
  start: 'start',
  nodes: [
    { id: 'start', op: 'copilot_task', label: 'Start', config: { mode: 'analysis' } },
    { id: 'left', op: 'action', label: 'Left', config: {} },
    { id: 'right', op: 'action', label: 'Right', config: {} },
    { id: 'merge', op: 'end', label: 'Merge', config: {} },
    { id: 'isolated', op: 'action', label: 'Isolated', config: {} },
  ],
  edges: [
    { id: 'start-left', source: 'start', port: 'done', target: 'left' },
    { id: 'start-right', source: 'start', port: 'failed', target: 'right' },
    { id: 'left-merge', source: 'left', port: 'success', target: 'merge' },
    { id: 'right-merge', source: 'right', port: 'success', target: 'merge' },
    { id: 'merge-left', source: 'merge', port: 'failed', target: 'left' },
  ],
  layout: {},
};

// Topology and legacy positions of the affected Pizza Hut Health incident flow.
const legacyIncident: FlowDefinition = {
  start: 'intake',
  nodes: [
    { id: 'intake', op: 'action', label: 'Intake', config: { action: 'incident_intake' } },
    { id: 'analise', op: 'copilot_task', label: 'Analysis', config: { mode: 'analysis' } },
    {
      id: 'autorizar',
      op: 'action',
      label: 'Authorize',
      config: { action: 'authorize_intervention' },
    },
    {
      id: 'aprovacao',
      op: 'human_decision',
      label: 'Approval',
      config: {
        options: [
          { port: 'approve', label: 'Approve' },
          { port: 'reject', label: 'Reject' },
        ],
      },
    },
    { id: 'intervir', op: 'action', label: 'Intervene', config: { action: 'remediate' } },
    { id: 'validar', op: 'action', label: 'Validate', config: { action: 'validate_recovery' } },
    { id: 'email_fecho', op: 'action', label: 'Close email', config: { action: 'email_notify' } },
    {
      id: 'email_escala',
      op: 'action',
      label: 'Escalation email',
      config: { action: 'email_notify' },
    },
    { id: 'atribuir', op: 'action', label: 'Assign', config: { action: 'assign_team' } },
    { id: 'resolvido', op: 'end', label: 'Resolved', config: {} },
    { id: 'escalado', op: 'end', label: 'Escalated', config: {} },
  ],
  edges: [
    ['intake', 'done', 'analise'],
    ['analise', 'done', 'autorizar'],
    ['analise', 'needs_information', 'autorizar'],
    ['analise', 'failed', 'autorizar'],
    ['autorizar', 'auto', 'intervir'],
    ['autorizar', 'needs_approval', 'aprovacao'],
    ['autorizar', 'no_action', 'validar'],
    ['autorizar', 'forbidden', 'email_escala'],
    ['aprovacao', 'approve', 'intervir'],
    ['aprovacao', 'reject', 'email_escala'],
    ['intervir', 'done', 'validar'],
    ['intervir', 'failed', 'email_escala'],
    ['intervir', 'forbidden', 'email_escala'],
    ['validar', 'recovered', 'email_fecho'],
    ['validar', 'retry', 'intervir'],
    ['validar', 'not_recovered', 'email_escala'],
    ['validar', 'unknown', 'email_escala'],
    ['email_fecho', 'done', 'resolvido'],
    ['email_fecho', 'failed', 'resolvido'],
    ['email_escala', 'done', 'atribuir'],
    ['email_escala', 'failed', 'atribuir'],
    ['atribuir', 'done', 'escalado'],
  ].map(([source, port, target]) => ({
    id: `${source}-${port}`,
    source: source!,
    port: port!,
    target: target!,
  })),
  layout: {
    intake: { x: 0, y: 0 },
    analise: { x: 280, y: 0 },
    autorizar: { x: 560, y: 0 },
    aprovacao: { x: 560, y: 180 },
    intervir: { x: 840, y: 0 },
    validar: { x: 1120, y: 0 },
    email_fecho: { x: 1400, y: -120 },
    email_escala: { x: 1400, y: 180 },
    atribuir: { x: 1680, y: 180 },
    resolvido: { x: 1680, y: -120 },
    escalado: { x: 1960, y: 180 },
  },
};
const incident = toBinaryFlow(legacyIncident).definition;

function segments(points: FlowPoint[]) {
  return points.slice(1).map((point, index) => [points[index]!, point] as const);
}

function sharedSegmentLength(left: FlowPoint[], right: FlowPoint[]) {
  let shared = 0;
  for (const [leftStart, leftEnd] of segments(left))
    for (const [rightStart, rightEnd] of segments(right)) {
      if (leftStart.y === leftEnd.y && rightStart.y === rightEnd.y && leftStart.y === rightStart.y)
        shared += Math.max(
          0,
          Math.min(Math.max(leftStart.x, leftEnd.x), Math.max(rightStart.x, rightEnd.x)) -
            Math.max(Math.min(leftStart.x, leftEnd.x), Math.min(rightStart.x, rightEnd.x)),
        );
      if (leftStart.x === leftEnd.x && rightStart.x === rightEnd.x && leftStart.x === rightStart.x)
        shared += Math.max(
          0,
          Math.min(Math.max(leftStart.y, leftEnd.y), Math.max(rightStart.y, rightEnd.y)) -
            Math.max(Math.min(leftStart.y, leftEnd.y), Math.min(rightStart.y, rightEnd.y)),
        );
    }
  return shared;
}

function crossesObstacle(start: FlowPoint, end: FlowPoint, obstacle: FlowBounds, padding = 12) {
  const left = obstacle.x - padding;
  const right = obstacle.x + obstacle.width + padding;
  const top = obstacle.y - padding;
  const bottom = obstacle.y + obstacle.height + padding;
  return start.y === end.y
    ? start.y > top &&
        start.y < bottom &&
        Math.max(start.x, end.x) > left &&
        Math.min(start.x, end.x) < right
    : start.x === end.x
      ? start.x > left &&
        start.x < right &&
        Math.max(start.y, end.y) > top &&
        Math.min(start.y, end.y) < bottom
      : true;
}

describe('flow vertical layout and routing', () => {
  it('uses measured sizes, orders branches, and assigns cyclic and unreachable nodes', () => {
    const layout = layoutFlowVertically(
      definition,
      new Map([
        ['start', { width: 240, height: 88 }],
        ['left', { width: 320, height: 180 }],
        ['right', { width: 220, height: 80 }],
        ['merge', { width: 250, height: 96 }],
        ['isolated', { width: 220, height: 100 }],
      ]),
    );

    expect(layout.start).toEqual({ x: expect.any(Number), y: 0 });
    expect(layout.left!.y).toBe(layout.right!.y);
    expect(layout.left!.x + 320).toBeLessThanOrEqual(layout.right!.x);
    expect(layout.merge!.y).toBeGreaterThanOrEqual(layout.left!.y + 180 + 136);
    expect(layout.isolated!.y).toBeGreaterThan(layout.merge!.y);
    expect(Object.keys(layout)).toHaveLength(definition.nodes.length);
  });

  it('does not treat saved positions or labels as functional structural changes', () => {
    const changedLayout = {
      ...definition,
      layout: { start: { x: 900, y: 700 } },
    };
    const changedLabel = {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id === 'start' ? { ...node, label: 'Renamed' } : node,
      ),
    };
    const changedConnection = {
      ...definition,
      edges: definition.edges.map((edge) =>
        edge.id === 'start-left' ? { ...edge, target: 'right' } : edge,
      ),
    };

    expect(flowStructureKey(changedLayout)).toBe(flowStructureKey(definition));
    expect(flowStructureKey(changedLabel)).toBe(flowStructureKey(definition));
    expect(flowStructureKey(changedConnection)).not.toBe(flowStructureKey(definition));
  });

  it('recognizes legacy and crowded layouts without replacing readable manual positions', () => {
    expect(needsAutomaticLayout(incident)).toBe(true);
    const layout = layoutFlowVertically(incident);
    expect(needsAutomaticLayout({ ...incident, layout })).toBe(false);
    expect(
      needsAutomaticLayout({
        ...incident,
        layout: { ...layout, analise: { ...layout.intake! } },
      }),
    ).toBe(true);
  });

  it.each([
    { name: 'legacy', flow: legacyIncident, returns: ['validar-retry'] },
    { name: 'binary', flow: incident, returns: [] },
  ])(
    'puts $name incident joins below all parents and keeps routes separated and bounded',
    ({ flow: incident, returns }) => {
      const sizes = new Map(incident.nodes.map((node) => [node.id, { width: 280, height: 180 }]));
      const layout = layoutFlowVertically(incident, sizes);
      const bounds = incident.nodes.map(({ id }) => ({ id, ...layout[id]!, ...sizes.get(id)! }));
      const channels = edgeRoutingChannels(incident, bounds);
      const routes: FlowPoint[][] = [];
      const before = JSON.stringify(incident);
      expect(Math.max(...bounds.map((box) => box.x + box.width))).toBeLessThanOrEqual(700);
      expect(
        incident.edges
          .filter((edge) => layout[edge.target]!.y <= layout[edge.source]!.y)
          .map((edge) => edge.id),
      ).toEqual(returns);
      for (const edge of incident.edges) {
        const source = bounds.find((box) => box.id === edge.source)!;
        const target = bounds.find((box) => box.id === edge.target)!;
        const ports = canvasNodePorts(
          incident,
          incident.nodes.find((node) => node.id === edge.source)!,
        );
        const sourceIndex = ports.indexOf(edge.port);
        const route = routeOrthogonalEdge({
          source: {
            id: source.id,
            x: source.x + ((sourceIndex + 0.5) * source.width) / ports.length,
            y: source.y + source.height,
          },
          target: { id: target.id, x: target.x + target.width / 2, y: target.y },
          obstacles: bounds,
          ...channels.get(edge.id)!,
        });
        expect(route, edge.id).not.toBeNull();
        if (!route) throw new Error(`Missing route: ${edge.id}`);
        routes.push(route);
        expect(
          segments(route)
            .slice(1, -1)
            .some(([start, end]) => bounds.some((box) => crossesObstacle(start, end, box, 0))),
          edge.id,
        ).toBe(false);
        expect(
          Math.max(...route.map((point) => point.x)) - Math.min(...route.map((point) => point.x)),
          edge.id,
        ).toBeLessThan(800);
      }
      for (let index = 0; index < routes.length; index += 1) {
        for (const [otherIndex, other] of routes.slice(index + 1).entries())
          expect(
            sharedSegmentLength(routes[index]!, other),
            `${incident.edges[index]!.id} overlaps ${incident.edges[index + otherIndex + 1]!.id}`,
          ).toBeLessThanOrEqual(100);
      }
      expect(
        Math.max(...routes.flat().map((point) => point.x)) -
          Math.min(...routes.flat().map((point) => point.x)),
      ).toBeLessThan(900);
      expect(JSON.stringify(incident)).toBe(before);
    },
  );

  it('retains detailed ports in old ticket views and two ports in migrated flows', () => {
    expect(
      canvasNodePorts(
        legacyIncident,
        legacyIncident.nodes.find((node) => node.id === 'analise')!,
      ),
    ).toEqual(['done', 'needs_information', 'failed']);
    expect(
      canvasNodePorts(
        incident,
        incident.nodes.find((node) => node.id === 'analise')!,
      ),
    ).toEqual(['success', 'failure']);
  });

  it('separates parallel paths into a join until the final short connector', () => {
    const bounds = [
      { id: 'source', x: 0, y: 0, width: 280, height: 180 },
      { id: 'target', x: 0, y: 316, width: 280, height: 180 },
    ];
    const routes = [0, 1, 2].map((index) =>
      routeOrthogonalEdge({
        source: { id: 'source', x: ((index + 0.5) * 280) / 3, y: 180 },
        target: { id: 'target', x: 140, y: 316 },
        obstacles: bounds,
        sourceChannel: index * 24,
        targetOffset: (index - 1) * 24,
      }),
    );
    for (let index = 0; index < routes.length; index += 1) {
      expect(routes[index]).not.toBeNull();
      for (const other of routes.slice(index + 1))
        expect(sharedSegmentLength(routes[index]!, other!)).toBeLessThanOrEqual(60);
    }
  });

  it('routes forward edges around measured boxes with orthogonal segments and distinct return lanes', () => {
    const obstacle = { id: 'blocker', x: 72, y: 132, width: 56, height: 56 };
    const bounds: FlowBounds[] = [
      { id: 'source', x: 80, y: 0, width: 40, height: 72 },
      obstacle,
      { id: 'target', x: 80, y: 250, width: 40, height: 72 },
    ];
    const forward = routeOrthogonalEdge({
      source: { id: 'source', x: 100, y: 72 },
      target: { id: 'target', x: 100, y: 250 },
      obstacles: bounds,
    });

    expect(forward).not.toBeNull();
    if (!forward) throw new Error('Expected a safe forward route.');
    expect(forward[0]).toEqual({ x: 100, y: 72 });
    expect(forward.at(-1)).toEqual({ x: 100, y: 250 });
    expect(segments(forward).every(([start, end]) => start.x === end.x || start.y === end.y)).toBe(
      true,
    );
    expect(segments(forward).some(([start, end]) => crossesObstacle(start, end, obstacle))).toBe(
      false,
    );

    const backwards = {
      ...obstacle,
      y: 95,
    };
    const returnBounds: FlowBounds[] = [
      { id: 'upper', x: 80, y: 0, width: 40, height: 72 },
      backwards,
      { id: 'lower', x: 80, y: 250, width: 40, height: 72 },
      { id: 'below-lower', x: 20, y: 330, width: 40, height: 50 },
    ];
    const returnPath = routeOrthogonalEdge({
      source: { id: 'lower', x: 100, y: 322 },
      target: { id: 'upper', x: 100, y: 0 },
      obstacles: returnBounds,
    });
    const secondReturnPath = routeOrthogonalEdge({
      source: { id: 'lower', x: 100, y: 322 },
      target: { id: 'upper', x: 100, y: 0 },
      obstacles: returnBounds,
      returnLane: 1,
    });

    expect(returnPath).not.toBeNull();
    expect(secondReturnPath).not.toBeNull();
    if (!returnPath || !secondReturnPath) throw new Error('Expected safe return routes.');

    expect(Math.min(...returnPath.map((point) => point.x))).toBeLessThan(
      Math.min(...forward.map((point) => point.x)),
    );
    expect(Math.min(...secondReturnPath.map((point) => point.x))).toBeLessThan(
      Math.min(...returnPath.map((point) => point.x)),
    );
    expect(
      segments(returnPath).every(([start, end]) => start.x === end.x || start.y === end.y),
    ).toBe(true);
    expect(
      segments(returnPath).some(([start, end]) => crossesObstacle(start, end, backwards)),
    ).toBe(false);
    for (const [path, pathBounds] of [
      [forward, bounds],
      [returnPath, returnBounds],
    ] as const) {
      expect(
        segments(path)
          .slice(1, -1)
          .some(([start, end]) =>
            pathBounds.some((bounds) => crossesObstacle(start, end, bounds, 0)),
          ),
      ).toBe(false);
    }
    const labelPosition = edgeLabelPosition(returnPath, returnBounds, 88, 28);
    expect(labelPosition).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    expect(
      returnBounds.some(
        (bounds) =>
          labelPosition.x + 44 > bounds.x &&
          labelPosition.x - 44 < bounds.x + bounds.width &&
          labelPosition.y + 14 > bounds.y &&
          labelPosition.y - 14 < bounds.y + bounds.height,
      ),
    ).toBe(false);
  });

  it('keeps forward branches on separate routes without a long shared trunk', () => {
    const bounds: FlowBounds[] = [
      { id: 'source', x: 100, y: 0, width: 220, height: 90 },
      { id: 'left', x: 0, y: 240, width: 220, height: 90 },
      { id: 'right', x: 300, y: 240, width: 220, height: 90 },
    ];
    const left = routeOrthogonalEdge({
      source: { id: 'source', x: 155, y: 90 },
      target: { id: 'left', x: 110, y: 240 },
      obstacles: bounds,
    });
    const right = routeOrthogonalEdge({
      source: { id: 'source', x: 265, y: 90 },
      target: { id: 'right', x: 410, y: 240 },
      obstacles: bounds,
    });

    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    if (!left || !right) throw new Error('Expected safe forward routes.');
    expect(sharedSegmentLength(left, right)).toBeLessThan(24);
  });

  it('returns an unroutable result instead of drawing a path through an obstruction', () => {
    const route = routeOrthogonalEdge({
      source: { id: 'source', x: 20, y: 40 },
      target: { id: 'target', x: 120, y: 200 },
      obstacles: [
        { id: 'source', x: 0, y: 0, width: 40, height: 40 },
        { id: 'target', x: 100, y: 200, width: 40, height: 40 },
        { id: 'blocker', x: 10, y: 45, width: 20, height: 30 },
      ],
    });

    expect(route).toBeNull();
  });
});
