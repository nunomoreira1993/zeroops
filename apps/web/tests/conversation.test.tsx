import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedUser, TicketAssignments, TicketDetail, User } from '@zeroops/contracts';
import { MarkdownContent } from '../src/components/MarkdownContent';
import { MarkdownEditor } from '../src/components/MarkdownEditor';
import { ConversationThread } from '../src/features/tickets/ConversationThread';
import { NewTicketPage } from '../src/features/tickets/NewTicketPage';
import { TicketAssignmentsPanel } from '../src/features/tickets/TicketAssignmentsPanel';
import { TicketDetailPage } from '../src/features/tickets/TicketDetailPage';
import { ResolutionPanel } from '../src/features/tickets/ResolutionPanel';
import { TicketParticipantsPanel } from '../src/features/tickets/TicketParticipantsPanel';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
const user: User = {
  id: 'client-1',
  projectId: 'project-1',
  email: 'client@example.test',
  displayName: 'Cliente de teste',
  role: 'client',
};
vi.mock('../src/lib/session', () => ({
  useSession: () => ({ session: { user }, request }),
}));

const detail: TicketDetail = {
  creatorName: 'Cliente de teste',
  ticket: {
    id: 'ticket-1',
    key: 'ZO-1',
    projectId: user.projectId,
    createdBy: user.id,
    title: 'Incidente de teste',
    description: '## Pedido inicial\n\nO botão **não funciona**.',
    category: 'incident',
    environment: 'quality',
    priority: 'medium',
    status: 'new',
    version: 0,
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: '2026-01-01T10:00:00Z',
  },
  comments: [
    {
      id: 'c1',
      authorId: 'staff-1',
      authorName: 'Técnico do projeto',
      automated: false,
      authorKind: 'human',
      authorRole: 'technical',
      authorOrganization: 'deloitte',
      visibility: 'public',
      body: 'Estamos a analisar.',
      version: 0,
      createdAt: '2026-01-01T10:01:00Z',
      updatedAt: '2026-01-01T10:01:00Z',
    },
    {
      id: 'c2',
      authorId: 'staff-2',
      authorName: 'Equipa',
      automated: false,
      authorKind: 'human',
      authorRole: 'technical',
      authorOrganization: 'deloitte',
      visibility: 'internal',
      body: 'Nota reservada.',
      version: 0,
      createdAt: '2026-01-01T10:02:00Z',
      updatedAt: '2026-01-01T10:02:00Z',
    },
  ],
  commentRevisions: [],
  events: [],
  revisions: [],
  assignments: { client: null, technical: null, qa: null, release: null },
  participants: [],
  resolution: null,
  invalidations: [],
  proposal: null,
  approvalHash: null,
  blockers: [],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  user.role = 'client';
  request.mockReset();
});

describe('Markdown no portal', () => {
  it('binds confirmation without code to the exact public response and current ticket version', async () => {
    request.mockResolvedValue({});
    const changed = vi.fn();
    render(
      <ResolutionPanel
        detail={{
          ...detail,
          ticket: { ...detail.ticket, status: 'awaiting_confirmation', version: 5 },
          resolution: {
            id: 'resolution-1',
            body: 'Resposta humana verificada.',
            hash: 'a'.repeat(64),
            authorName: 'Técnico',
            clientId: user.id,
            status: 'pending',
            createdAt: detail.ticket.createdAt,
            decidedAt: null,
            notes: null,
          },
        }}
        onChanged={changed}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Registar decisão' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith('/tickets/ticket-1/resolutions/decision', {
      method: 'POST',
      body: { expectedVersion: 5, artifactHash: 'a'.repeat(64), decision: 'approve', notes: '' },
    });
    expect(screen.queryByRole('button', { name: 'Propor resolução sem código' })).toBeNull();
  });

  it('adds project participants and never offers removal of the author or gate holders', async () => {
    user.role = 'technical';
    const person = {
      userId: 'other-person',
      displayName: 'Colega',
      role: 'qa' as const,
      organization: 'deloitte' as const,
      required: false,
    };
    request.mockResolvedValue([person]);
    const changed = vi.fn();
    render(
      <TicketParticipantsPanel
        ticket={detail.ticket}
        participants={[
          {
            userId: user.id,
            displayName: 'Cliente responsável',
            role: 'client',
            organization: 'client',
            required: true,
          },
        ]}
        onChanged={changed}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Adicionar participante'), {
      target: { value: person.userId },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith('/tickets/ticket-1/participants', {
      method: 'POST',
      body: { expectedVersion: 0, userId: person.userId, action: 'add' },
    });
    expect(screen.queryByRole('button', { name: 'Remover participante' })).toBeNull();
  });

  it('renders formatting, tables and code but never active HTML, unsafe links or remote images', () => {
    const { container } = render(
      <MarkdownContent>{`## Contexto\n\n**Impacto**\n\n- Passo um\n\n\`\`\`js\nalert("exemplo")\n\`\`\`\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[ataque](javascript:alert%281%29)\n\n![tracking](https://example.test/pixel)\n\n[Referência](https://example.test)`}</MarkdownContent>,
    );
    expect(screen.getByRole('heading', { name: 'Contexto' })).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('Impacto');
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.querySelector('pre code')?.textContent).toContain('alert("exemplo")');
    expect(container.querySelectorAll('script, iframe, img, link')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'ataque' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Referência' }).getAttribute('rel')).toContain(
      'noreferrer',
    );
  });

  it('edits a selected word and previews the same Markdown submitted by the form', async () => {
    function Editor() {
      const [value, setValue] = useState('Falha no botão');
      return (
        <form>
          <MarkdownEditor name="description" label="Descrição" value={value} onChange={setValue} />
        </form>
      );
    }
    const { container } = render(<Editor />);
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Descrição' });
    input.focus();
    input.setSelectionRange(9, 14);
    fireEvent.click(screen.getByRole('button', { name: 'Negrito' }));
    expect(input.value).toBe('Falha no **botão**');
    fireEvent.click(screen.getByRole('button', { name: 'Pré-visualizar' }));
    const preview = screen.getByRole('region', { name: 'Pré-visualização de Descrição' });
    expect(preview.querySelector('strong')?.textContent).toBe('botão');
    expect(new FormData(container.querySelector('form')!).get('description')).toBe(input.value);
    fireEvent.change(input, { target: { value: 'Novo **contexto**' } });
    expect(preview.querySelector('strong')?.textContent).toBe('contexto');
  });

  it('offers only quality and production on new requests', () => {
    render(<NewTicketPage />);
    const environment = screen.getByRole('combobox', { name: 'Ambiente' });
    expect(
      within(environment)
        .getAllByRole<HTMLOptionElement>('option')
        .map((o) => o.value),
    ).toEqual(['quality', 'production']);
    expect(screen.getByRole('button', { name: 'Pré-visualizar' })).toBeTruthy();
  });
});

describe('Conversa do incidente', () => {
  it('starts with the original request once, followed by real authors and protects internal notes', () => {
    const onChanged = vi.fn();
    const { rerender } = render(
      <ConversationThread detail={detail} user={user} onChanged={onChanged} />,
    );
    const messages = within(screen.getByRole('list', { name: 'Mensagens do pedido' })).getAllByRole(
      'listitem',
    );
    expect(messages).toHaveLength(2);
    expect(within(messages[0]!).getByRole('heading', { name: 'Pedido inicial' })).toBeTruthy();
    expect(within(messages[0]!).getByText('Cliente de teste')).toBeTruthy();
    expect(within(messages[1]!).getByText('Técnico do projeto')).toBeTruthy();
    expect(screen.queryByText('Nota reservada.')).toBeNull();
    rerender(
      <ConversationThread
        detail={detail}
        user={{ ...user, id: 'staff-1', role: 'admin' }}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText('Nota reservada.')).toBeTruthy();
    expect(screen.getByText('Cliente de teste')).toBeTruthy();
  });

  it('opens in chat, receives replies by polling without losing drafts and stops polling on exit', async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ ...detail, comments: [detail.comments[0]] });
    const { unmount } = render(<TicketDetailPage id={detail.ticket.id} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: /^Conversa / }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByText('Investigação Copilot')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Adicionar mensagem' }), {
      target: { value: 'Rascunho por enviar' },
    });
    request.mockResolvedValue({
      ...detail,
      comments: [
        detail.comments[0],
        { ...detail.comments[0], id: 'c3', body: 'Nova resposta da equipa.' },
      ],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText('Nova resposta da equipa.')).toBeTruthy();
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Adicionar mensagem' }).value,
    ).toBe('Rascunho por enviar');
    const calls = request.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(20000);
    expect(request).toHaveBeenCalledTimes(calls);
  });

  it('keeps Copilot work in the team channel and only sends a reviewed answer to the client', async () => {
    user.role = 'technical';
    const run = {
      id: 'run-1',
      ticketId: 'ticket-1',
      status: 'succeeded' as const,
      instructions: null,
      progress: null,
      summary: 'Encomenda paga e integrada.',
      replyDraft: 'Bom dia, confirmámos a encomenda.',
      evidence: [{ source: 'sql', detail: 'encomenda encontrada' }],
      toolCalls: [],
      errorCode: null,
      cancelRequested: false,
      pendingQuestion: null,
      usage: null,
      quota: null,
      model: 'hydrafusion',
      reasoningEffort: 'high',
      requestedBy: { id: 'tech-1', displayName: 'Técnico' },
      trigger: 'client_reply' as const,
      clientQuestions: ['Qual o número da encomenda?'],
      clientMessageId: 'c9',
      createdAt: '2026-11-09T10:00:00.000Z',
      startedAt: null,
      finishedAt: '2026-11-09T10:05:00.000Z',
    };
    const catalog = {
      models: [
        {
          id: 'auto',
          name: 'Auto',
          multiplier: null,
          efforts: ['high'],
          defaultEffort: null,
          fusion: false,
        },
        {
          id: 'hydrafusion',
          name: 'Copilot Fusion',
          multiplier: 1,
          efforts: ['high'],
          defaultEffort: null,
          fusion: true,
        },
      ],
      routingTiers: [
        {
          id: 'balance',
          name: 'Standard',
          description: 'Balanced routing',
          fusionTier: 'standard',
          enabled: true,
          visible: true,
          reason: null,
        },
        {
          id: 'hydrafusion',
          name: 'High',
          description: 'High routing',
          fusionTier: 'high',
          enabled: true,
          visible: true,
          reason: null,
        },
      ],
      defaultModel: null,
      refreshedAt: '2026-11-09T10:00:00.000Z',
      refreshing: false,
      errorCode: null,
    };
    window.localStorage.clear();
    request.mockImplementation(async (path: string) =>
      path.endsWith('/agent-runs')
        ? [run]
        : path.endsWith('/agent-models')
          ? catalog
          : path === '/tickets/ticket-1'
            ? detail
            : [],
    );
    render(<TicketDetailPage id={detail.ticket.id} />);
    const clientTab = await screen.findByRole('button', { name: /^Cliente/ });
    expect(clientTab.getAttribute('aria-pressed')).toBe('true');
    const proposal = await screen.findByRole('complementary', {
      name: 'Resposta proposta pelo Copilot',
    });
    expect(within(proposal).getByText('Bom dia, confirmámos a encomenda.')).toBeTruthy();
    expect(screen.getByText('Nota reservada.').closest('[hidden]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Equipa · Copilot/ }));
    expect(screen.getByText('Nota reservada.').closest('[hidden]')).toBeNull();
    expect(screen.getByText('Resposta do cliente')).toBeTruthy();
    expect(screen.getByText('Encomenda paga e integrada.')).toBeTruthy();
    expect(screen.getAllByText('Copilot Fusion · High').length).toBeGreaterThan(0);
    expect(screen.queryByText('Qual o número da encomenda?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver interações (0)' }));
    expect(screen.getByText('Qual o número da encomenda?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rever e enviar ao cliente' }));
    expect(clientTab.getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Resposta ao cliente' }).value,
    ).toBe('Bom dia, confirmámos a encomenda.');
    expect(request.mock.calls.some(([path]) => String(path).endsWith('/comments'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Enviar ao cliente' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/tickets/ticket-1/comments', {
        method: 'POST',
        body: { body: 'Bom dia, confirmámos a encomenda.', visibility: 'public' },
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Equipa · Copilot/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Nota' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Nota interna' }), {
      target: { value: 'Só para a equipa' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar nota' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/tickets/ticket-1/comments', {
        method: 'POST',
        body: { body: 'Só para a equipa', visibility: 'internal' },
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Perguntar ao Copilot' }));
    fireEvent.change(await screen.findByLabelText('Mensagem para o Copilot'), {
      target: { value: 'Ver a captura' },
    });
    fireEvent.click(screen.getByTitle('Nível Fusion'));
    fireEvent.click(screen.getByRole('option', { name: /^High/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Investigar' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/tickets/ticket-1/agent-runs', {
        method: 'POST',
        body: {
          instructions: 'Ver a captura',
          executionMode: 'copilot',
          model: 'fusion',
          fusionTier: 'high',
          reasoningEffort: null,
        },
      }),
    );
  });

  it('shows agent messages to the client as the support team, without Copilot labels', () => {
    render(
      <ConversationThread
        detail={{
          ...detail,
          comments: [
            {
              ...detail.comments[0]!,
              id: 'c9',
              authorName: 'Técnico',
              automated: true,
              authorKind: 'agent',
              body: 'Olá, precisamos de mais informação.',
            },
          ],
        }}
        user={user}
        onChanged={vi.fn()}
        channel="public"
      />,
    );
    expect(screen.getByText('Equipa de suporte')).toBeTruthy();
    expect(screen.queryByText('Técnico')).toBeNull();
    expect(screen.queryByText(/Copilot/)).toBeNull();
  });

  it('lets the author submit an edit before analysis with the current ticket version', async () => {
    request.mockResolvedValue(detail);
    render(<TicketDetailPage id={detail.ticket.id} />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Contexto e proposta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar pedido' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Assunto' }), {
      target: { value: 'Incidente de checkout revisto' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar revisão' }));
    await screen.findByText('Pedido atualizado. A revisão ficou registada no histórico.');
    const update = request.mock.calls.find(
      ([path, options]) => path === '/tickets/ticket-1/revisions' && options?.method === 'POST',
    );
    expect(update?.[1]?.body).toMatchObject({
      expectedVersion: 0,
      title: 'Incidente de checkout revisto',
    });
  });

  it('lets a message author correct a comment through a preserved revision', async () => {
    request.mockResolvedValue({});
    const onChanged = vi.fn();
    render(
      <ConversationThread
        detail={detail}
        user={{ ...user, id: 'staff-1', role: 'technical' }}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Corrigir mensagem' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Corrigir mensagem' }), {
      target: { value: 'Resposta corrigida com mais contexto.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar correção' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const correction = request.mock.calls.find(
      ([path, options]) =>
        path === '/tickets/ticket-1/comments/c1/revisions' && options?.method === 'POST',
    );
    expect(correction?.[1]?.body).toMatchObject({
      expectedVersion: 0,
      body: 'Resposta corrigida com mais contexto.',
    });
  });

  it('lets project admins assign distinct role-matched people to each stage', async () => {
    user.role = 'admin';
    const member = (id: string, role: User['role']): ManagedUser => ({
      ...user,
      id,
      role,
      disabled: false,
      lockedUntil: null,
      mfaEnabled: true,
    });
    const members = [
      member('10000000-0000-4000-8000-000000000001', 'client'),
      member('10000000-0000-4000-8000-000000000002', 'technical'),
      member('10000000-0000-4000-8000-000000000003', 'qa'),
      member('10000000-0000-4000-8000-000000000004', 'release'),
    ];
    request.mockImplementation(async (path) => (path === '/users' ? members : {}));
    const assignments: TicketAssignments = {
      client: null,
      technical: null,
      qa: null,
      release: null,
    };
    const onChanged = vi.fn();
    render(
      <TicketAssignmentsPanel
        ticket={detail.ticket}
        assignments={assignments}
        onChanged={onChanged}
      />,
    );
    for (const [label, id] of [
      ['Cliente responsável', '10000000-0000-4000-8000-000000000001'],
      ['Responsável técnico', '10000000-0000-4000-8000-000000000002'],
      ['Qualidade / QA', '10000000-0000-4000-8000-000000000003'],
      ['Responsável de release', '10000000-0000-4000-8000-000000000004'],
    ] as const) {
      fireEvent.change(await screen.findByLabelText(label), { target: { value: id } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Guardar responsáveis' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const assignmentRequest = request.mock.calls.find(
      ([path, options]) => path === '/tickets/ticket-1/assignments' && options?.method === 'POST',
    );
    expect(assignmentRequest?.[1]?.body).toMatchObject({
      expectedVersion: detail.ticket.version,
      clientUserId: '10000000-0000-4000-8000-000000000001',
      technicalUserId: '10000000-0000-4000-8000-000000000002',
      qaUserId: '10000000-0000-4000-8000-000000000003',
      releaseUserId: '10000000-0000-4000-8000-000000000004',
    });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('em tickets geridos por fluxo só mostra os papéis usados pelas etapas e preserva os ocultos', async () => {
    user.role = 'admin';
    const qa: ManagedUser = {
      ...user,
      id: '10000000-0000-4000-8000-000000000003',
      role: 'qa',
      disabled: false,
      lockedUntil: null,
      mfaEnabled: true,
    };
    request.mockImplementation(async (path) => (path === '/users' ? [qa] : {}));
    const assignments: TicketAssignments = {
      client: null,
      technical: { userId: '10000000-0000-4000-8000-000000000002', displayName: 'Tiago' },
      qa: null,
      release: null,
    } as TicketAssignments;
    const onChanged = vi.fn();
    render(
      <TicketAssignmentsPanel
        ticket={detail.ticket}
        assignments={assignments}
        flowRoles={['qa']}
        onChanged={onChanged}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Qualidade / QA'), {
      target: { value: qa.id },
    });
    expect(screen.queryByLabelText('Responsável de release')).toBeNull();
    expect(screen.queryByLabelText('Cliente responsável')).toBeNull();
    expect(screen.getByLabelText('Responsável técnico')).toBeTruthy();
    expect(screen.queryByText(/Cada etapa exige/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar responsáveis' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    const body = request.mock.calls.find(
      ([path, options]) => path === '/tickets/ticket-1/assignments' && options?.method === 'POST',
    )?.[1]?.body;
    expect(body).toMatchObject({
      clientUserId: null,
      technicalUserId: '10000000-0000-4000-8000-000000000002',
      qaUserId: qa.id,
      releaseUserId: null,
    });
  });

  it('em tickets geridos por fluxo sem papéis nem atribuições não mostra o painel', () => {
    const { container } = render(
      <TicketAssignmentsPanel
        ticket={detail.ticket}
        assignments={{ client: null, technical: null, qa: null, release: null }}
        flowRoles={[]}
        onChanged={vi.fn()}
      />,
    );
    expect(container.querySelector('section')).toBeNull();
  });
});
