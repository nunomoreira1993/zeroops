import { nodePorts, type FlowDefinition, type FlowNode } from '@zeroops/contracts';

export interface FlowSize {
  width: number;
  height: number;
}

export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowEndpoint extends FlowPoint {
  id: string;
}

export interface FlowBounds extends FlowSize {
  id: string;
  x: number;
  y: number;
}

export interface EdgeRoutingChannels {
  returnLane: number;
  sourceChannel: number;
  targetChannel: number;
  targetOffset: number;
  corridorX?: number;
}

/** Running tickets can still display an older published version with detailed output ports. */
export function canvasNodePorts(definition: FlowDefinition, node: FlowNode): string[] {
  const configured = nodePorts(node);
  const connected = definition.edges
    .filter((edge) => edge.source === node.id)
    .map((edge) => edge.port);
  return connected.some((port) => !configured.includes(port))
    ? [...new Set(connected)]
    : configured;
}

const defaultSize: FlowSize = { width: 280, height: 120 };
const nodeGap = 96;
const layerGap = 136;
const obstaclePadding = 12;

/** Stable key for changes that alter graph structure, not labels or node configuration. */
export function flowStructureKey(definition: FlowDefinition): string {
  return JSON.stringify({
    start: definition.start,
    nodes: definition.nodes.map((node) => node.id),
    edges: definition.edges.map(({ source, port, target }) => [source, port, target]),
  });
}

/** Hierarchical top-to-bottom layout that also gives cyclic and unreachable nodes a stable layer. */
export function layoutFlowVertically(
  definition: FlowDefinition,
  sizes: ReadonlyMap<string, FlowSize> = new Map(),
): FlowDefinition['layout'] {
  const nodeOrder = new Map(definition.nodes.map((node, index) => [node.id, index]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of definition.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }

  const levels = new Map<string, number>();
  const assignComponent = (root: string, level: number) => {
    const active = new Set<string>();
    const order: string[] = [];
    const feedback = new Set<string>();
    const visit = (id: string) => {
      if (levels.has(id) || !nodeOrder.has(id)) return;
      active.add(id);
      for (const target of outgoing.get(id) ?? []) {
        if (active.has(target)) feedback.add(JSON.stringify([id, target]));
        else visit(target);
      }
      active.delete(id);
      levels.set(id, level);
      order.push(id);
    };
    visit(root);
    const component = new Set(order);
    // Longest forward paths keep joins below every parent; only genuine cycles go back up.
    for (const source of order.reverse()) {
      for (const target of outgoing.get(source) ?? []) {
        if (!component.has(target) || feedback.has(JSON.stringify([source, target]))) continue;
        levels.set(target, Math.max(levels.get(target)!, levels.get(source)! + 1));
      }
    }
  };
  assignComponent(definition.start, 0);
  let deepest = Math.max(0, ...levels.values());
  for (const node of definition.nodes) {
    if (levels.has(node.id)) continue;
    deepest += 1;
    assignComponent(node.id, deepest);
    deepest = Math.max(deepest, ...levels.values());
  }

  const layers = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const level = levels.get(node.id) ?? 0;
    layers.set(level, [...(layers.get(level) ?? []), node.id]);
  }

  const orderedLayers = [...layers.keys()].sort((a, b) => a - b).map((level) => layers.get(level)!);
  const previousOrder = new Map<string, number>();
  for (let index = 0; index < orderedLayers.length; index += 1) {
    const layer = orderedLayers[index]!;
    if (index > 0) {
      layer.sort((left, right) => {
        const averageParentOrder = (id: string) => {
          const parents = (incoming.get(id) ?? [])
            .filter((parent) => levels.get(parent) === levels.get(id)! - 1)
            .map((parent) => previousOrder.get(parent))
            .filter((position): position is number => position !== undefined);
          return parents.length
            ? parents.reduce((total, position) => total + position, 0) / parents.length
            : Number.POSITIVE_INFINITY;
        };
        const difference = averageParentOrder(left) - averageParentOrder(right);
        return difference || nodeOrder.get(left)! - nodeOrder.get(right)!;
      });
    }
    layer.forEach((id, position) => previousOrder.set(id, position));
  }

  const rows = orderedLayers.map((nodes) => {
    const rowSizes = nodes.map((id) => sizes.get(id) ?? defaultSize);
    return {
      nodes,
      sizes: rowSizes,
      width: rowSizes.reduce((total, size) => total + size.width, 0) + nodeGap * (nodes.length - 1),
      height: Math.max(...rowSizes.map((size) => size.height)),
    };
  });
  const maximumWidth = Math.max(defaultSize.width, ...rows.map((row) => row.width));
  const layout: FlowDefinition['layout'] = {};
  let y = 0;
  for (const row of rows) {
    let x = (maximumWidth - row.width) / 2;
    for (let index = 0; index < row.nodes.length; index += 1) {
      const id = row.nodes[index]!;
      const size = row.sizes[index]!;
      layout[id] = { x: Math.round(x), y: Math.round(y) };
      x += size.width + nodeGap;
    }
    y += row.height + layerGap;
  }
  return layout;
}

/** Legacy horizontal or crowded positions need a view-only organization on opening. */
export function needsAutomaticLayout(
  definition: FlowDefinition,
  sizes: ReadonlyMap<string, FlowSize> = new Map(),
): boolean {
  const generated = layoutFlowVertically(definition, sizes);
  const bounds: FlowBounds[] = [];
  for (const node of definition.nodes) {
    const position = definition.layout[node.id];
    if (!position) return true;
    const size = sizes.get(node.id) ?? defaultSize;
    if (
      bounds.some(
        (other) =>
          position.x < other.x + other.width + 32 &&
          position.x + size.width + 32 > other.x &&
          position.y < other.y + other.height + 32 &&
          position.y + size.height + 32 > other.y,
      )
    )
      return true;
    bounds.push({ id: node.id, ...position, ...size });
  }
  return definition.edges.some((edge) => {
    const source = definition.layout[edge.source];
    const target = definition.layout[edge.target];
    const generatedSource = generated[edge.source];
    const generatedTarget = generated[edge.target];
    if (!generatedSource || !generatedTarget) return true;
    return (
      source &&
      target &&
      generatedTarget.y > generatedSource.y &&
      target.y < source.y + (sizes.get(edge.source) ?? defaultSize).height + 32
    );
  });
}

/** Allocate separate departure, arrival and bypass lanes across the whole diagram. */
export function edgeRoutingChannels(
  definition: FlowDefinition,
  obstacles: FlowBounds[],
): Map<string, EdgeRoutingChannels> {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const byId = new Map(obstacles.map((bounds) => [bounds.id, bounds]));
  const channels = new Map<string, EdgeRoutingChannels>();
  let returnLane = 0;
  let outsideLane = 0;
  for (const edge of definition.edges) {
    const sourceNode = nodes.get(edge.source);
    const ports = sourceNode ? canvasNodePorts(definition, sourceNode) : [];
    const portIndex = Math.max(0, ports.indexOf(edge.port));
    const incoming = definition.edges.filter((item) => item.target === edge.target);
    const targetIndex = incoming.findIndex((item) => item.id === edge.id);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const intermediate =
      source && target
        ? obstacles.filter((bounds) => bounds.y > source.y && bounds.y < target.y)
        : [];
    let corridorX: number | undefined;
    if (source && target && intermediate.length) {
      const bounds = [source, target, ...intermediate];
      const difference = target.x + target.width / 2 - source.x - source.width / 2;
      const right =
        Math.abs(difference) > source.width / 2 ? difference > 0 : portIndex >= ports.length / 2;
      const margin = 56 + outsideLane++ * 24;
      corridorX = right
        ? Math.max(...bounds.map((box) => box.x + box.width)) + margin
        : Math.min(...bounds.map((box) => box.x)) - margin;
    }
    channels.set(edge.id, {
      returnLane: source && target && target.y <= source.y ? returnLane++ : 0,
      sourceChannel: ports.length > 1 ? (portIndex * 48) / (ports.length - 1) : 0,
      targetChannel: incoming.length > 1 ? (targetIndex * 48) / (incoming.length - 1) : 0,
      targetOffset:
        incoming.length > 1
          ? (targetIndex / (incoming.length - 1) - 0.5) *
            Math.min((target?.width ?? defaultSize.width) - 48, (incoming.length - 1) * 24)
          : 0,
      ...(corridorX === undefined ? {} : { corridorX }),
    });
  }
  return channels;
}

interface SearchState {
  index: number;
  direction: 0 | 1 | 2;
  cost: number;
  estimate: number;
}

function push(heap: SearchState[], state: SearchState) {
  heap.push(state);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]!.estimate <= state.estimate) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = state;
}

function pop(heap: SearchState[]): SearchState | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && heap[child + 1]!.estimate < heap[child]!.estimate) child += 1;
    if (heap[child]!.estimate >= last.estimate) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

function isInside(point: FlowPoint, bounds: FlowBounds): boolean {
  return (
    point.x > bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y > bounds.y &&
    point.y < bounds.y + bounds.height
  );
}

function crossesBounds(start: FlowPoint, end: FlowPoint, bounds: FlowBounds): boolean {
  if (start.y === end.y)
    return (
      start.y > bounds.y &&
      start.y < bounds.y + bounds.height &&
      Math.max(start.x, end.x) > bounds.x &&
      Math.min(start.x, end.x) < bounds.x + bounds.width
    );
  if (start.x === end.x)
    return (
      start.x > bounds.x &&
      start.x < bounds.x + bounds.width &&
      Math.max(start.y, end.y) > bounds.y &&
      Math.min(start.y, end.y) < bounds.y + bounds.height
    );
  return true;
}

function simplify(points: FlowPoint[]): FlowPoint[] {
  const result: FlowPoint[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    const beforePrevious = result.at(-2);
    if (
      previous &&
      beforePrevious &&
      ((beforePrevious.x === previous.x && previous.x === point.x) ||
        (beforePrevious.y === previous.y && previous.y === point.y))
    )
      result[result.length - 1] = point;
    else result.push(point);
  }
  return result;
}

function shortestOrthogonalPath(
  start: FlowPoint,
  finish: FlowPoint,
  obstacles: FlowBounds[],
  biasDownward: boolean,
): FlowPoint[] | null {
  const routingObstacles = obstacles.map((obstacle) => ({
    ...obstacle,
    x: obstacle.x - obstaclePadding,
    y: obstacle.y - obstaclePadding,
    width: obstacle.width + obstaclePadding * 2,
    height: obstacle.height + obstaclePadding * 2,
  }));
  if (routingObstacles.some((bounds) => isInside(start, bounds) || isInside(finish, bounds)))
    return null;

  const xs = new Set([start.x, finish.x]);
  const ys = new Set([start.y, finish.y]);
  for (const obstacle of routingObstacles) {
    xs.add(obstacle.x);
    xs.add(obstacle.x + obstacle.width);
    ys.add(obstacle.y);
    ys.add(obstacle.y + obstacle.height);
  }
  const xValues = [...xs].sort((a, b) => a - b);
  const yValues = [...ys].sort((a, b) => a - b);
  const xIndex = new Map(xValues.map((value, index) => [value, index]));
  const yIndex = new Map(yValues.map((value, index) => [value, index]));
  const startCell = yIndex.get(start.y)! * xValues.length + xIndex.get(start.x)!;
  const finishCell = yIndex.get(finish.y)! * xValues.length + xIndex.get(finish.x)!;
  const statesPerCell = 3;
  const stateIndex = (cell: number, direction: number) => cell * statesPerCell + direction;
  const startState = stateIndex(startCell, 0);
  const best = new Map<number, number>([[startState, 0]]);
  const previous = new Map<number, number>();
  const heap: SearchState[] = [];
  const heuristic = (point: FlowPoint) =>
    Math.abs(finish.x - point.x) + Math.abs(finish.y - point.y);
  push(heap, { index: startState, direction: 0, cost: 0, estimate: heuristic(start) });

  while (heap.length) {
    const state = pop(heap)!;
    if (state.cost !== best.get(state.index)) continue;
    const cell = Math.floor(state.index / statesPerCell);
    if (cell === finishCell) {
      const path: FlowPoint[] = [];
      let current: number | undefined = state.index;
      while (current !== undefined) {
        const currentCell = Math.floor(current / statesPerCell);
        path.push({
          x: xValues[currentCell % xValues.length]!,
          y: yValues[Math.floor(currentCell / xValues.length)]!,
        });
        current = previous.get(current);
      }
      return simplify(path.reverse());
    }

    const x = cell % xValues.length;
    const y = Math.floor(cell / xValues.length);
    const currentPoint = { x: xValues[x]!, y: yValues[y]! };
    const neighbors: { x: number; y: number; direction: 1 | 2 }[] = [];
    if (x > 0) neighbors.push({ x: x - 1, y, direction: 1 });
    if (x + 1 < xValues.length) neighbors.push({ x: x + 1, y, direction: 1 });
    if (y > 0) neighbors.push({ x, y: y - 1, direction: 2 });
    if (y + 1 < yValues.length) neighbors.push({ x, y: y + 1, direction: 2 });

    for (const neighbor of neighbors) {
      const nextPoint = { x: xValues[neighbor.x]!, y: yValues[neighbor.y]! };
      if (
        routingObstacles.some(
          (bounds) => isInside(nextPoint, bounds) || crossesBounds(currentPoint, nextPoint, bounds),
        )
      )
        continue;
      const nextCell = neighbor.y * xValues.length + neighbor.x;
      const nextState = stateIndex(nextCell, neighbor.direction);
      const distance =
        Math.abs(nextPoint.x - currentPoint.x) + Math.abs(nextPoint.y - currentPoint.y);
      const turnPenalty = state.direction && state.direction !== neighbor.direction ? 24 : 0;
      const uphillPenalty = biasDownward && nextPoint.y < currentPoint.y ? 32 : 0;
      const cost = state.cost + distance + turnPenalty + uphillPenalty;
      if (cost >= (best.get(nextState) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(nextState, cost);
      previous.set(nextState, state.index);
      push(heap, {
        index: nextState,
        direction: neighbor.direction,
        cost,
        estimate: cost + heuristic(nextPoint),
      });
    }
  }

  return null;
}

/** Route an edge around measured node boxes; backward edges use a distinct outside return lane. */
export function routeOrthogonalEdge({
  source,
  target,
  obstacles: allBounds,
  returnLane = 0,
  sourceChannel = 0,
  targetOffset = 0,
  targetChannel = 0,
  corridorX,
}: {
  source: FlowEndpoint;
  target: FlowEndpoint;
  obstacles: FlowBounds[];
  returnLane?: number;
  sourceChannel?: number;
  targetOffset?: number;
  targetChannel?: number;
  corridorX?: number;
}): FlowPoint[] | null {
  const sourceNode = allBounds.find((bounds) => bounds.id === source.id);
  const targetNode = allBounds.find((bounds) => bounds.id === target.id);
  const sourcePoint = { x: source.x, y: source.y };
  const targetPoint = { x: target.x, y: target.y };
  const sourceStub = { x: source.x, y: source.y + 18 };
  const targetStub = { x: target.x, y: target.y - 18 };
  const obstacles = allBounds;
  const sourceConnectorBlocked = allBounds.some(
    (bounds) =>
      bounds.id !== source.id &&
      (isInside(sourcePoint, bounds) ||
        isInside(sourceStub, bounds) ||
        crossesBounds(sourcePoint, sourceStub, bounds)),
  );
  const targetConnectorBlocked = allBounds.some(
    (bounds) =>
      bounds.id !== target.id &&
      (isInside(targetStub, bounds) ||
        isInside(targetPoint, bounds) ||
        crossesBounds(targetStub, targetPoint, bounds)),
  );
  if (sourceConnectorBlocked || targetConnectorBlocked) return null;
  const isReturn = targetStub.y <= sourceStub.y;

  if (!isReturn) {
    const departure = { x: source.x, y: source.y + 36 + sourceChannel };
    const arrival = { x: target.x + targetOffset, y: target.y - 42 - targetChannel };
    const waypoints = [
      sourceStub,
      departure,
      ...(corridorX === undefined
        ? []
        : [
            { x: corridorX, y: departure.y },
            { x: corridorX, y: arrival.y },
          ]),
      arrival,
      targetStub,
    ];
    const legs = waypoints
      .slice(1)
      .map((point, index) => shortestOrthogonalPath(waypoints[index]!, point, obstacles, true));
    if (legs.some((leg) => !leg)) return null;
    return simplify([sourcePoint, ...legs.flatMap((leg) => leg!), targetPoint]);
  }

  const leftmost = Math.min(
    sourceNode?.x ?? source.x,
    targetNode?.x ?? target.x,
    ...allBounds
      .filter((bounds) => bounds.y + bounds.height >= targetStub.y && bounds.y <= sourceStub.y)
      .map((bounds) => bounds.x),
  );
  const laneX = leftmost - 56 - Math.max(0, returnLane) * 24;
  const laneEntry = { x: laneX, y: sourceStub.y };
  const laneExit = { x: laneX, y: targetStub.y };
  const toLane = shortestOrthogonalPath(sourceStub, laneEntry, obstacles, false);
  const fromLane = shortestOrthogonalPath(laneExit, targetStub, obstacles, false);
  if (!toLane || !fromLane) return null;
  return simplify([
    sourcePoint,
    sourceStub,
    ...toLane.slice(1, -1),
    laneEntry,
    laneExit,
    ...fromLane.slice(1, -1),
    targetStub,
    targetPoint,
  ]);
}

function labelOverlapsBounds(
  point: FlowPoint,
  bounds: FlowBounds[],
  width: number,
  height: number,
): boolean {
  return bounds.some(
    (box) =>
      point.x + width / 2 > box.x &&
      point.x - width / 2 < box.x + box.width &&
      point.y + height / 2 > box.y &&
      point.y - height / 2 < box.y + box.height,
  );
}

export function edgeLabelPosition(
  points: FlowPoint[],
  bounds: FlowBounds[] = [],
  width = 96,
  height = 28,
): FlowPoint {
  let best: { start: FlowPoint; end: FlowPoint; length: number } | null = null;
  let bestClear: { point: FlowPoint; length: number } | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    if (!best || length > best.length) best = { start, end, length };
    for (const fraction of [0.5, 0.35, 0.65]) {
      const point = {
        x: start.x + (end.x - start.x) * fraction,
        y: start.y + (end.y - start.y) * fraction,
      };
      if (labelOverlapsBounds(point, bounds, width, height)) continue;
      if (!bestClear || length > bestClear.length) bestClear = { point, length };
    }
  }
  if (bestClear) return bestClear.point;
  if (!best) return points[0] ?? { x: 0, y: 0 };
  return { x: (best.start.x + best.end.x) / 2, y: (best.start.y + best.end.y) / 2 };
}
