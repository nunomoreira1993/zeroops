import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FlowAuthoringEventView,
  FlowAuthoringStateView,
  FlowDefinition,
  FlowDetail,
} from '@zeroops/contracts';
import { FlowEditor } from '../src/features/flows/FlowEditor';
import { IdentityLocaleProvider } from '../src/lib/identity';
import { ProjectAdminProvider } from '../src/lib/project-admin';
import { SessionProvider } from '../src/lib/session';

vi.mock('../src/features/flows/FlowCanvas', () => ({
  FlowCanvas: ({
    definition,
    marks,
    onChange,
  }: {
    definition: FlowDefinition;
    marks?: { nodes?: Record<string, string> };
    onChange?: (next: FlowDefinition) => void;
  }) => (
    <div>
      <ul aria-label="Desenho">
        {definition.nodes.map((node) => (
          <li key={node.id} data-mark={marks?.nodes?.[node.id] ?? ''}>
            {node.label}
          </li>
        ))}
      </ul>
      {onChange && (
        <button
          type="button"
          onClick={() =>
            onChange({
              ...definition,
              nodes: [
                ...definition.nodes,
                {
                  id: 'manual',
                  op: 'copilot_task',
                  label: 'Etapa manual',
                  config: { mode: 'analysis' },
                },
              ],
            })
          }
        >
          Edição manual
        </button>
      )}
      {onChange && (
        <button
          type="button"
          onClick={() =>
            onChange({
              ...definition,
              layout: { ...definition.layout, [definition.start]: { x: 40, y: 80 } },
            })
          }
        >
          Mover etapa
        </button>
      )}
    </div>
  ),
  autoLayout: () => ({}),
}));

/** EventSource controlado pelo teste (jsdom não tem SSE). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(data === undefined ? {} : { data: JSON.stringify(data) });
  }
}

const project = { id: 'project', name: 'Projeto', archived: false, logoVersion: null, version: 1 };
const end = { id: 'end', op: 'end' as const, label: 'Fim', config: { outcome: 'resolved' } };
const dev = {
  id: 'dev',
  op: 'copilot_task' as const,
  label: 'Desenvolvimento',
  config: { mode: 'develop' },
};

function detailAt(revision: number, nodes: FlowDetail['draft']['nodes']): FlowDetail {
  return {
    id: 'flow',
    name: 'Teste P06',
    description: '',
    template: null,
    priority: 1,
    isDefault: false,
    match: { origins: [], categories: [], environments: [], priorities: [] },
    routingPolicy: {
      instructions: '',
      positiveExamples: [],
      negativeExamples: [],
      fallbackOnUnresolved: false,
    },
    draftVersion: revision,
    draftChanged: true,
    published: null,
    active: null,
    pendingChanges: { definition: true, routing: false, alertKeys: false },
    schemaVersion: 1,
    pendingAlertKeys: [],
    activeExecutions: 0,
    updatedAt: '2030-01-01T00:00:00Z',
    alertKeys: [],
    copilotReady: true,
    members: [],
    versions: [],
    activations: [],
    issues: [],
    draft: { start: nodes[0]!.id, nodes, edges: [], layout: {} },
  };
}

let server: { detail: FlowDetail; authoring: FlowAuthoringStateView };
function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url);
    if (path === '/api/session')
      return Response.json({
        user: { id: 'actor', projectId: project.id, role: 'admin', displayName: 'Ana' },
        csrfToken: 'csrf',
      });
    if (options?.method === 'POST') return Response.json(server.detail);
    if (path.includes('/authoring/events')) return Response.json([]);
    if (path.endsWith('/authoring')) return Response.json(server.authoring);
    if (path.endsWith('/flows/flow')) return Response.json(server.detail);
    if (path.endsWith('/repository-resources'))
      return Response.json({ available: false, resources: [] });
    if (path.endsWith('/flows') || path.endsWith('/assistant') || path.endsWith('/agent-profiles'))
      return Response.json([]);
    throw new Error(`Unexpected request: ${path}`);
  });
}

function event(
  id: number,
  type: FlowAuthoringEventView['type'],
  payload = {},
): FlowAuthoringEventView {
  return {
    id,
    type,
    requestId: 'r1',
    sessionId: 's1',
    actor: 'Ana',
    payload,
    createdAt: '2030-01-01T00:00:00Z',
  };
}

function renderEditor() {
  render(
    <IdentityLocaleProvider>
      <SessionProvider>
        <ProjectAdminProvider project={project} permissions={['flows.view', 'flows.edit']}>
          <FlowEditor flowId="flow" onBack={() => {}} />
        </ProjectAdminProvider>
      </SessionProvider>
    </IdentityLocaleProvider>,
  );
}

async function stream() {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  const source = FakeEventSource.instances.filter((item) => !item.closed).at(-1)!;
  act(() => source.emit('open'));
  return source;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  server = {
    detail: detailAt(1, [end]),
    authoring: {
      session: { id: 's1', mode: 'auto' },
      draftVersion: 1,
      operations: [],
      capabilities: [],
      lastEventId: 0,
    },
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('P06 construção em tempo real', () => {
  it('mostra etapas aplicadas pelo Copilot durante o turno, capacidades em falta e permite desfazer', async () => {
    const fetch = mockApi();
    renderEditor();
    await screen.findByRole('heading', { name: 'Teste P06' });
    const source = await stream();
    expect(source.url).toBe(
      '/api/project-admin/project/flows/flow/authoring/events/stream?after=0',
    );
    expect(screen.getByText('em direto')).toBeTruthy();

    const detailCalls = () =>
      fetch.mock.calls.filter(([url]) => String(url).endsWith('/flows/flow')).length;
    const beforeEvents = detailCalls();
    server.detail = detailAt(2, [dev, end]);
    server.authoring = {
      ...server.authoring,
      draftVersion: 2,
      lastEventId: 2,
      operations: [
        {
          id: 'op1',
          requestId: 'r1',
          sessionId: 's1',
          actor: 'Ana',
          source: 'assistant',
          kind: 'definition',
          status: 'applied',
          baseRevision: 1,
          resultRevision: 2,
          operations: [{ type: 'add_node', node: dev }],
          routing: null,
          summary: 'Etapa de desenvolvimento',
          error: null,
          undoOf: null,
          undoneBy: null,
          undoable: true,
          createdAt: '2030-01-01T00:00:00Z',
        },
      ],
      capabilities: [
        {
          id: 'c1',
          kind: 'tool',
          capability: 'Consulta ao ERP',
          reason: 'Validar stock',
          nodeId: null,
          status: 'open',
          requestedBy: 'Ana',
          requestId: 'r1',
          createdAt: '2030-01-01T00:00:00Z',
        },
      ],
    };
    act(() => {
      source.emit('authoring', event(1, 'turn_started'));
      source.emit(
        'authoring',
        event(2, 'operation_applied', { kind: 'definition', added: ['dev'] }),
      );
      // Replay repetido após reconexão: ignorado (deduplicado pelo cursor).
      source.emit(
        'authoring',
        event(2, 'operation_applied', { kind: 'definition', added: ['dev'] }),
      );
    });
    const drawing = screen.getByRole('list', { name: 'Desenho' });
    const node = await within(drawing).findByText('Desenvolvimento');
    expect(node.getAttribute('data-mark')).toBe('added');
    await screen.findByText('Consulta ao ERP');
    // Um único reload do detalhe apesar do evento repetido.
    expect(detailCalls()).toBe(beforeEvents + 1);

    const applied = await screen.findByRole('region', { name: 'Alterações aplicadas' });
    fireEvent.click(within(applied).getByRole('button', { name: 'Desfazer' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, options]) =>
            String(url).endsWith('/authoring/operations/op1/undo') && options?.method === 'POST',
        ),
      ).toBe(true),
    );
    const undo = fetch.mock.calls.find(([url]) => String(url).endsWith('/undo'))!;
    expect(JSON.parse(String(undo[1]?.body))).toEqual({ expectedDraftVersion: 2 });
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/activate'))).toBe(false);
  });

  it('alteração do servidor durante edição manual gera conflito sem perder o trabalho local', async () => {
    mockApi();
    renderEditor();
    await screen.findByRole('heading', { name: 'Teste P06' });
    const source = await stream();
    fireEvent.click(screen.getByRole('button', { name: 'Edição manual' }));
    expect(screen.getByText('Etapa manual')).toBeTruthy();

    server.detail = detailAt(2, [dev, end]);
    act(() =>
      source.emit(
        'authoring',
        event(1, 'operation_applied', { kind: 'definition', added: ['dev'] }),
      ),
    );
    await screen.findByText(/O rascunho mudou no servidor \(rev\. 2/);
    const drawing = screen.getByRole('list', { name: 'Desenho' });
    expect(within(drawing).getByText('Etapa manual')).toBeTruthy();
    expect(within(drawing).queryByText('Desenvolvimento')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Recarregar (descarta as minhas alterações)' }),
    );
    expect(within(drawing).getByText('Desenvolvimento')).toBeTruthy();
    expect(within(drawing).queryByText('Etapa manual')).toBeNull();
  });

  it('posições só locais não bloqueiam o assistente; alterações de execução por gravar bloqueiam', async () => {
    mockApi();
    renderEditor();
    await screen.findByRole('heading', { name: 'Teste P06' });
    await stream();
    const assistant = screen.getByRole('complementary', { name: 'Assistente do fluxo' });
    fireEvent.change(within(assistant).getByRole('textbox', { name: 'Pedido' }), {
      target: { value: 'Acrescenta uma aprovação' },
    });
    const send = within(assistant).getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;

    fireEvent.click(screen.getByRole('button', { name: 'Mover etapa' }));
    expect(screen.getByText(/Só mudaram posições no ecrã/)).toBeTruthy();
    expect(within(assistant).queryByText(/Grave o rascunho antes de pedir/)).toBeNull();
    expect(send.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Edição manual' }));
    expect(within(assistant).getByText(/Grave o rascunho antes de pedir/)).toBeTruthy();
    expect(send.disabled).toBe(true);
  });

  it('a perda da ligação SSE recupera os eventos em falta pelo cursor', async () => {
    const fetch = mockApi();
    renderEditor();
    await screen.findByRole('heading', { name: 'Teste P06' });
    const source = await stream();
    act(() => source.emit('authoring', event(5, 'turn_started')));
    act(() => source.emit('error'));
    expect(source.closed).toBe(true);
    await waitFor(
      () =>
        expect(
          fetch.mock.calls.some(([url]) => String(url).endsWith('/authoring/events?after=5')),
        ).toBe(true),
      { timeout: 3000 },
    );
    await waitFor(
      () => expect(FakeEventSource.instances.filter((item) => !item.closed)).toHaveLength(1),
      { timeout: 3000 },
    );
    expect(FakeEventSource.instances.filter((item) => !item.closed)[0]!.url).toMatch(/after=5$/);
  });
});
