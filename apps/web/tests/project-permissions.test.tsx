import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FlowDetail,
  ProjectPermission,
  ProjectPermissionsView,
  TicketRoutingView,
} from '@zeroops/contracts';
import { ProjectPermissionsPage } from '../src/features/projects/ProjectPermissionsPage';
import { TicketRoutingPanel } from '../src/features/flows/TicketRoutingPanel';
import { FlowsPage } from '../src/features/flows/FlowsPage';
import { FlowEditor } from '../src/features/flows/FlowEditor';
import { StepConfigPanel } from '../src/features/flows/StepConfigPanel';
import { IdentityLocaleProvider } from '../src/lib/identity';
import { ProjectAdminProvider } from '../src/lib/project-admin';
import { SessionProvider } from '../src/lib/session';
import type { ReactNode } from 'react';

vi.mock('../src/features/flows/FlowCanvas', () => ({
  FlowCanvas: () => <div />,
  autoLayout: () => ({}),
}));
const project = {
  id: 'project',
  name: 'Projeto de teste',
  archived: false,
  logoVersion: null,
  version: 4,
};
const detail: FlowDetail = {
  id: 'flow',
  name: 'Fluxo de teste',
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
  draftVersion: 1,
  draftChanged: true,
  published: null,
  active: null,
  pendingChanges: { definition: true, routing: true, alertKeys: false },
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
  draft: {
    start: 'end',
    nodes: [{ id: 'end', op: 'end', label: 'Fim', config: { outcome: 'resolved' } }],
    edges: [],
    layout: {},
  },
};
const view: ProjectPermissionsView = {
  projectId: project.id,
  version: 4,
  assignablePermissions: ['flows.view', 'flows.edit'],
  members: [
    {
      id: 'actor',
      displayName: 'Delegado',
      role: 'technical',
      isAdmin: false,
      canManage: false,
      permissions: ['project.permissions.manage', 'flows.edit'],
    },
    {
      id: 'admin',
      displayName: 'Admin',
      role: 'admin',
      isAdmin: true,
      canManage: false,
      permissions: [],
    },
    {
      id: 'target',
      displayName: 'Destinatário',
      role: 'client',
      isAdmin: false,
      canManage: true,
      permissions: ['project.permissions.manage'],
    },
  ],
};

function mockApi(permissions: ProjectPermission[] = []) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url);
    if (path === '/api/session')
      return Response.json({
        user: {
          id: 'actor',
          projectId: project.id,
          role: 'technical',
          displayName: 'Delegado',
          email: 'synthetic@example.test',
        },
        csrfToken: 'test-csrf',
      });
    if (options?.method === 'POST') return Response.json(detail);
    if (path.endsWith('/access')) return Response.json({ project, permissions, isAdmin: false });
    if (path.endsWith('/permissions')) return Response.json(view);
    if (path.endsWith('/flows/flow')) return Response.json(detail);
    if (path.endsWith('/repository-resources'))
      return Response.json({ available: false, resources: [] });
    if (path.endsWith('/flows') || path.endsWith('/assistant') || path.endsWith('/agent-profiles'))
      return Response.json([]);
    throw new Error(`Unexpected request: ${path}`);
  });
}

function tree(children: ReactNode, permissions?: ProjectPermission[]) {
  return (
    <IdentityLocaleProvider>
      <SessionProvider>
        {permissions ? (
          <ProjectAdminProvider project={project} permissions={permissions}>
            {children}
          </ProjectAdminProvider>
        ) : (
          children
        )}
      </SessionProvider>
    </IdentityLocaleProvider>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P01 project permission UI', () => {
  it('isolates delegated grant management and preserves unassignable grants in updates', async () => {
    const fetch = mockApi();
    render(tree(<ProjectPermissionsPage projectId={project.id} />));
    const target = await screen.findByRole('form', { name: 'Destinatário' });
    expect(
      within(target).getByLabelText('Gerir permissões do projeto').hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('form', { name: 'Delegado' }).querySelector('fieldset')?.disabled).toBe(
      true,
    );
    expect(screen.getByRole('form', { name: 'Admin' }).querySelector('fieldset')?.disabled).toBe(
      true,
    );
    fireEvent.click(within(target).getByLabelText('Editar fluxos'));
    fireEvent.click(within(target).getByRole('button', { name: 'Gravar permissões' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true),
    );
    const call = fetch.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(call[0]).toBe('/api/projects/project/permissions');
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      userId: 'target',
      expectedVersion: 4,
      permissions: ['project.permissions.manage', 'flows.edit'],
    });
    expect(
      fetch.mock.calls.some(
        ([url]) => String(url).endsWith('/users') || String(url).endsWith('/integration-settings'),
      ),
    ).toBe(false);
  });

  it('loads flows through minimal project access without offering creation to readers', async () => {
    const fetch = mockApi(['flows.view']);
    render(tree(<FlowsPage projectId={project.id} flowId={null} />));
    await screen.findByText('Sem fluxos.');
    expect(screen.queryByRole('heading', { name: 'Novo fluxo' })).toBeNull();
    expect(fetch.mock.calls.some(([url]) => url === '/api/project-admin/project')).toBe(false);
    expect(fetch.mock.calls.some(([url]) => url === '/api/project-admin/project/flows')).toBe(true);
  });

  it('separates draft edits, including routing rules, from activation and simulation', async () => {
    const fetch = mockApi(['flows.view', 'flows.edit']);
    render(tree(<FlowEditor flowId="flow" onBack={() => {}} />, ['flows.view', 'flows.edit']));
    await screen.findByRole('heading', { name: 'Fluxo de teste' });
    expect(
      (screen.getByRole('button', { name: 'Ativar esta versão' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('tab', { name: 'Experimentar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Regras' }));
    expect((screen.getByLabelText('Nome') as HTMLInputElement).disabled).toBe(false);
    expect(
      (screen.getByLabelText('Prioridade da regra (menor ganha)') as HTMLInputElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByLabelText('Fluxo por omissão do projeto') as HTMLInputElement).disabled,
    ).toBe(false);
    expect(screen.getByText(/só entram em serviço com «Ativar esta versão»/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Metadados novos' } });
    fireEvent.change(screen.getByLabelText('Quando usar este fluxo'), {
      target: { value: 'Consultas de estado.' },
    });
    fireEvent.change(screen.getByLabelText('Exemplos que pertencem (um por linha)'), {
      target: { value: 'Estado do pagamento X\n\n  Onde está a encomenda?  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gravar regras' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, options]) => String(url).endsWith('/settings') && options?.method === 'POST',
        ),
      ).toBe(true),
    );
    const settings = fetch.mock.calls.find(([url]) => String(url).endsWith('/settings'))!;
    expect(JSON.parse(String(settings[1]?.body)).routingPolicy).toEqual({
      instructions: 'Consultas de estado.',
      positiveExamples: ['Estado do pagamento X', 'Onde está a encomenda?'],
      negativeExamples: [],
      fallbackOnUnresolved: false,
    });
  });

  it('allows activation without granting editing or simulation', async () => {
    const fetch = mockApi(['flows.view', 'flows.activate']);
    render(tree(<FlowEditor flowId="flow" onBack={() => {}} />, ['flows.view', 'flows.activate']));
    await screen.findByRole('heading', { name: 'Fluxo de teste' });
    expect((screen.getByLabelText('Acrescentar etapa') as HTMLSelectElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Gravar rascunho' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Ativar esta versão' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, options]) => String(url).endsWith('/activate') && options?.method === 'POST',
        ),
      ).toBe(true),
    );
  });

  it('permits profile management without making the step or profile selection editable', async () => {
    mockApi(['flows.view', 'agents.manage']);
    const definition = {
      ...detail.draft,
      nodes: [
        { id: 'end', op: 'copilot_task' as const, label: 'Análise', config: { mode: 'analysis' } },
      ],
    };
    render(
      tree(
        <StepConfigPanel
          definition={definition}
          nodeId="end"
          members={[]}
          issues={[]}
          onChange={() => {}}
          onClose={() => {}}
        />,
        ['flows.view', 'agents.manage'],
      ),
    );
    await screen.findByRole('button', { name: 'Criar perfil' });
    expect(screen.getByLabelText('Nome da etapa').closest('fieldset')?.disabled).toBe(true);
    expect((screen.getByLabelText('Perfil de execução') as HTMLSelectElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Criar perfil' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('P05 ticket routing panel', () => {
  const candidate = (key: string, name: string, versionId: string, fallback = false) => ({
    key,
    flowId: `flow-${key}`,
    versionId,
    versionNumber: 1,
    name,
    priority: 10,
    instructions: fallback ? '' : `Pedidos de ${name.toLowerCase()}.`,
    fallback,
  });
  const routing: TicketRoutingView = {
    status: 'awaiting_reply',
    policyHash: 'a'.repeat(64),
    candidates: [
      candidate('C1', 'Consulta', '11111111-1111-4111-8111-111111111111'),
      candidate('C2', 'Desenvolvimento', '22222222-2222-4222-8222-222222222222'),
      candidate('F', 'Geral', '33333333-3333-4333-8333-333333333333', true),
    ],
    questionsAsked: 1,
    pendingQuestion: {
      text: 'Quer saber o estado de um pagamento ou adicionar um método?',
      askedAt: '2030-01-01T10:00:00Z',
      replyDueAt: '2030-01-04T10:00:00Z',
    },
    lastDecision: {
      decision: 'clarify',
      candidate: null,
      reason: 'Pedido ambíguo.',
      alternatives: ['C1', 'C2'],
      question: 'Quer saber o estado de um pagamento ou adicionar um método?',
    },
    resolution: null,
    reason: null,
    chosen: null,
    routedAt: null,
    routedBy: null,
    job: null,
    canRoute: true,
    events: [],
  };

  it('shows the pending question and pinned candidates and routes only among them', async () => {
    const fetch = mockApi();
    const changed = vi.fn();
    render(tree(<TicketRoutingPanel ticketId="ticket" routing={routing} onChanged={changed} />));
    await waitFor(() => expect(fetch.mock.results.length).toBeGreaterThan(0));
    await act(async () => {
      await fetch.mock.results[0]!.value;
    });
    expect(screen.getByText('À espera do autor')).toBeTruthy();
    expect(screen.getByText(routing.pendingQuestion!.text)).toBeTruthy();
    expect(screen.getByText('para o cliente')).toBeTruthy();
    expect(screen.getByText(/Alternativas: Consulta, Desenvolvimento/)).toBeTruthy();
    const select = screen.getByLabelText('Fluxo') as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual([
      '—',
      'Consulta v1',
      'Desenvolvimento v1',
      'Geral v1',
    ]);
    fireEvent.change(select, { target: { value: routing.candidates[1]!.versionId } });
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Pedido de evolução' } });
    fireEvent.click(screen.getByRole('button', { name: 'Encaminhar' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    const call = fetch.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(call[0]).toBe('/api/tickets/ticket/flow/routing/manual');
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      versionId: routing.candidates[1]!.versionId,
      reason: 'Pedido de evolução',
    });
  });

  it('hides manual routing when the actor cannot activate or routing is closed', () => {
    mockApi();
    const { rerender } = render(
      tree(
        <TicketRoutingPanel
          ticketId="ticket"
          routing={{ ...routing, canRoute: false }}
          onChanged={() => {}}
        />,
      ),
    );
    expect(screen.queryByRole('button', { name: 'Encaminhar' })).toBeNull();
    rerender(
      tree(
        <TicketRoutingPanel
          ticketId="ticket"
          routing={{
            ...routing,
            status: 'routed',
            pendingQuestion: null,
            resolution: 'classified',
            chosen: {
              flowId: 'flow-C1',
              versionId: routing.candidates[0]!.versionId,
              name: 'Consulta',
              versionNumber: 1,
            },
            routedAt: '2030-01-01T11:00:00Z',
          }}
          onChanged={() => {}}
        />,
      ),
    );
    expect(screen.getByText('Encaminhado')).toBeTruthy();
    expect(screen.getByText(/Consulta v\s*1 · classificado pelo Copilot/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Encaminhar' })).toBeNull();
  });
});
