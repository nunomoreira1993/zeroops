import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FlowDefinition,
  FlowSimulationResultView,
  FlowSimulationRunView,
  FlowSimulationsView,
} from '@zeroops/contracts';
import { ActivationEvidence, FlowSimulator } from '../src/features/flows/FlowSimulator';
import { IdentityLocaleProvider } from '../src/lib/identity';
import { ProjectAdminProvider } from '../src/lib/project-admin';
import { SessionProvider } from '../src/lib/session';

const project = { id: 'project', name: 'Projeto', archived: false, logoVersion: null, version: 1 };
const definition: FlowDefinition = {
  start: 'analise',
  nodes: [
    { id: 'analise', op: 'copilot_task', label: 'Análise', config: { mode: 'analysis' } },
    { id: 'fim', op: 'end', label: 'Fim', config: { outcome: 'resolved' } },
  ],
  edges: [
    { id: 'a', source: 'analise', port: 'success', target: 'fim' },
    { id: 'b', source: 'analise', port: 'failure', target: 'fim' },
  ],
  layout: {},
};
const hashes = { definitionHash: 'd1', routingHash: 'r1', manifestHash: 'm1aaaaaaaaaaaaaa' };

function result(overrides: Partial<FlowSimulationResultView> = {}): FlowSimulationResultView {
  return {
    level: 'behavior',
    outcome: 'ended',
    endOutcome: 'resolved',
    stoppedAt: { nodeId: 'fim', label: 'Fim' },
    waitingFor: null,
    message: 'Pedido terminado (resolved).',
    steps: [
      {
        nodeId: 'analise',
        label: 'Análise',
        op: 'copilot_task',
        attempt: 1,
        atMinutes: 0,
        result: 'success',
        port: 'success',
        source: 'fixture',
        detail: null,
      },
      {
        nodeId: 'fim',
        label: 'Fim',
        op: 'end',
        attempt: 1,
        atMinutes: 0,
        result: null,
        port: null,
        source: 'end',
        detail: null,
      },
    ],
    effects: [
      {
        nodeId: 'analise',
        attempt: 1,
        kind: 'copilot_request',
        mode: 'simulated',
        summary: 'Pedido ao Copilot (Análise) — não enviado.',
      },
    ],
    unavailable: [],
    issues: [],
    routing: null,
    notVerified: ['Nenhum efeito externo foi executado.'],
    elapsedMinutes: 0,
    ...overrides,
  };
}

function runView(overrides: Partial<FlowSimulationRunView> = {}): FlowSimulationRunView {
  return {
    id: 'run-1',
    level: 'behavior',
    status: 'completed',
    scenarioId: null,
    scenarioName: 'Sucesso',
    scenarioVersion: null,
    hashes: { ...hashes, scenarioHash: 's1' },
    stale: false,
    staleReasons: [],
    result: result(),
    comparison: {
      verdict: 'passed',
      checks: [{ key: 'outcome', expected: 'ended', observed: 'ended', passed: true }],
    },
    errorCode: null,
    trialTargetId: null,
    requestedBy: 'actor',
    createdAt: '2030-01-01T00:00:00Z',
    finishedAt: '2030-01-01T00:00:00Z',
    ...overrides,
  };
}

function view(runs: FlowSimulationRunView[] = []): FlowSimulationsView {
  return {
    current: hashes,
    scenarios: [],
    runs,
    trialTargets: [],
    examples: [
      {
        name: 'Sucesso',
        description: 'Percurso feliz.',
        spec: { steps: { analise: [{ summary: 'Ok.' }] } },
      },
    ],
    canManageTargets: true,
  };
}

function mockApi(state: { view: FlowSimulationsView }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url);
    if (path === '/api/session')
      return Response.json({
        user: { id: 'actor', projectId: project.id, role: 'admin', displayName: 'Ana' },
        csrfToken: 'csrf',
      });
    if (path.endsWith('/simulation-tickets')) return Response.json([]);
    if (path.endsWith('/simulations')) return Response.json(state.view);
    if (path.endsWith('/simulations/runs') && options?.method === 'POST') {
      const created = runView({ id: 'run-new', staleReasons: [] });
      state.view = view([created, ...state.view.runs]);
      return Response.json(created);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

function wrap(children: React.ReactNode) {
  return (
    <IdentityLocaleProvider>
      <SessionProvider>
        <ProjectAdminProvider project={project} permissions={['flows.view', 'flows.simulate']}>
          {children}
        </ProjectAdminProvider>
      </SessionProvider>
    </IdentityLocaleProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P07 simulador partilhado', () => {
  it('executa um cenário com chave idempotente e mostra percurso, comparação e desatualização', async () => {
    const stale = runView({
      id: 'run-old',
      scenarioName: 'Antigo',
      stale: true,
      staleReasons: ['definition'],
      comparison: { verdict: 'failed', checks: [] },
    });
    const state = { view: view([stale]) };
    const fetch = mockApi(state);
    const onMarks = vi.fn();
    render(
      wrap(
        <FlowSimulator
          basePath="/api/projects/project/flows/flow"
          definition={definition}
          dirty={false}
          onMarks={onMarks}
        />,
      ),
    );
    const runs = await screen.findByRole('region', { name: 'Execuções' });
    expect(within(runs).getByText(/desatualizado/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Executar teste' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, options]) =>
            String(url).endsWith('/simulations/runs') && options?.method === 'POST',
        ),
      ).toBe(true),
    );
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith('/simulations/runs'))!;
    const body = JSON.parse(String(call[1]!.body)) as { level: string; idempotencyKey: string };
    expect(body.level).toBe('behavior');
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);

    // A execução nova fica selecionada: percurso no canvas e comparação esperado/observado.
    await screen.findByRole('table', { name: 'Esperado vs observado' });
    await waitFor(() =>
      expect(onMarks).toHaveBeenLastCalledWith(
        expect.objectContaining({ nodes: expect.objectContaining({ analise: 'done' }) }),
      ),
    );
    expect(screen.getByText(/não enviado/)).toBeTruthy();
  });

  it('não executa um rascunho com alterações por guardar e a evidência separa versões', async () => {
    mockApi({ view: view() });
    render(
      wrap(
        <FlowSimulator
          basePath="/api/projects/project/flows/flow"
          definition={definition}
          dirty
          onMarks={() => {}}
        />,
      ),
    );
    await screen.findByText(/Rascunho gravado/);
    expect(
      (screen.getByRole('button', { name: 'Executar teste' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    render(
      wrap(
        <ActivationEvidence
          view={view([
            runView(),
            runView({ id: 'run-old', stale: true, staleReasons: ['manifest'] }),
          ])}
        />,
      ),
    );
    expect(screen.getByText(/Testes para esta versão/)).toBeTruthy();
    expect(screen.getByText(/1 resultado\(s\) anterior\(es\) são de outra versão/)).toBeTruthy();
  });
});
