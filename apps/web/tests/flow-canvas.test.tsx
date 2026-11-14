import { StrictMode, useEffect } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowDefinition } from '@zeroops/contracts';
import type { NodeChange } from '@xyflow/react';
import { FlowCanvas } from '../src/features/flows/FlowCanvas';

const fitView = vi.hoisted(() => vi.fn(async (_options: unknown) => true));

interface CanvasProbeProps {
  nodes: { id: string; position: { x: number; y: number } }[];
  onNodesChange: (changes: NodeChange[]) => void;
  onInit: (instance: { fitView: typeof fitView }) => void;
}

vi.mock('@xyflow/react', async (original) => ({
  ...(await original<typeof import('@xyflow/react')>()),
  ReactFlow: function CanvasProbe({ nodes, onNodesChange, onInit }: CanvasProbeProps) {
    useEffect(() => {
      onInit({ fitView });
      onNodesChange(
        nodes.map(({ id }) => ({
          id,
          type: 'dimensions',
          dimensions: { width: 280, height: id === 'start' ? 190 : 120 },
        })),
      );
    }, []);
    return (
      <div>
        {nodes.map(({ id, position }) => (
          <div key={id} data-testid={id} data-x={position.x} data-y={position.y} />
        ))}
      </div>
    );
  },
}));

const legacy: FlowDefinition = {
  start: 'start',
  nodes: [
    { id: 'start', op: 'action', label: 'Start', config: {} },
    { id: 'end', op: 'end', label: 'End', config: {} },
  ],
  edges: [{ id: 'next', source: 'start', port: 'done', target: 'end' }],
  layout: { start: { x: 0, y: 0 }, end: { x: 300, y: 0 } },
};

afterEach(() => {
  cleanup();
  fitView.mockClear();
});

describe('flow canvas view-only organization', () => {
  it('uses measured vertical positions without dirtying the draft, including selection changes', async () => {
    const onChange = vi.fn<(definition: FlowDefinition) => void>();
    const view = render(
      <StrictMode>
        <FlowCanvas definition={legacy} onChange={onChange} />
      </StrictMode>,
    );
    await waitFor(() => expect(view.getByTestId('end').getAttribute('data-y')).toBe('326'));
    const position = view.getByTestId('end').getAttribute('data-y');
    view.rerender(
      <StrictMode>
        <FlowCanvas definition={legacy} selected="end" onChange={onChange} />
      </StrictMode>,
    );
    await waitFor(() => expect(view.getByTestId('end').getAttribute('data-y')).toBe(position));
    expect(onChange).not.toHaveBeenCalled();
    expect(fitView).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [{ id: 'start' }, { id: 'end' }],
        minZoom: 0.8,
      }),
    );
  });

  it('keeps readable saved positions and persists organization only when explicitly requested', async () => {
    const saved = { ...legacy, layout: { start: { x: 30, y: 20 }, end: { x: 60, y: 500 } } };
    const onChange = vi.fn<(definition: FlowDefinition) => void>();
    const view = render(<FlowCanvas definition={saved} onChange={onChange} />);
    await waitFor(() => expect(fitView).toHaveBeenCalled());
    expect(view.getByTestId('end').getAttribute('data-y')).toBe('500');
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(<FlowCanvas definition={saved} onChange={onChange} organizeRequest={1} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const result = onChange.mock.calls[0]![0];
    expect(result.nodes).toEqual(saved.nodes);
    expect(result.edges).toEqual(saved.edges);
    expect(result.layout.end!.y).toBe(326);
  });
});
