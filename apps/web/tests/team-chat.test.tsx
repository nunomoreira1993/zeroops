import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyUsage,
  type AgentModelCatalog,
  type AgentRun,
  type Comment,
  type User,
} from '@zeroops/contracts';
import { Avatar } from '../src/components/Avatar';
import { buildTeamThread } from '../src/features/tickets/team-chat';
import { TeamChat, TEAM_CHAT_PAGE } from '../src/features/tickets/TeamChat';
import { TeamComposer } from '../src/features/tickets/TeamComposer';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/lib/session', () => ({
  useSession: () => ({ request }),
}));

const user: User = {
  id: 'tech-1',
  projectId: 'project-1',
  email: 'tech@example.test',
  displayName: 'Técnica',
  role: 'technical',
};

const note = (id: string, minute: number, extra: Partial<Comment> = {}): Comment => ({
  id,
  authorId: 'tech-2',
  authorName: 'Colega',
  visibility: 'internal',
  body: `Nota ${id}`,
  automated: false,
  authorKind: 'human',
  authorRole: 'technical',
  authorOrganization: 'deloitte',
  version: 0,
  createdAt: new Date(Date.UTC(2026, 10, 9, 10, minute)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 10, 9, 10, minute)).toISOString(),
  ...extra,
});

const run = (extra: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run-1',
  ticketId: 'ticket-1',
  status: 'succeeded',
  trigger: 'manual',
  instructions: 'Confirme o pagamento.',
  progress: null,
  summary: 'Resumo do run.',
  replyDraft: null,
  clientQuestions: [],
  clientMessageId: null,
  evidence: [{ source: 'sql', detail: 'pagamento capturado' }],
  toolCalls: [],
  errorCode: null,
  cancelRequested: false,
  pendingQuestion: null,
  usage: null,
  quota: null,
  model: 'auto',
  reasoningEffort: null,
  requestedBy: { id: 'tech-1', displayName: 'Técnica' },
  createdAt: new Date(Date.UTC(2026, 10, 9, 10, 5)).toISOString(),
  startedAt: null,
  finishedAt: new Date(Date.UTC(2026, 10, 9, 10, 8)).toISOString(),
  ...extra,
});

const catalog: AgentModelCatalog = {
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
    {
      id: 'gpt-mini',
      name: 'GPT mini',
      multiplier: 0,
      efforts: [],
      defaultEffort: null,
      fusion: false,
    },
    {
      id: 'gpt-pro',
      name: 'GPT pro',
      multiplier: 1,
      efforts: ['high', 'max'],
      defaultEffort: null,
      fusion: false,
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
    {
      id: 'hydrafusion-max',
      name: 'Max',
      description: 'Maximum routing',
      fusionTier: 'max',
      enabled: true,
      visible: true,
      reason: null,
    },
    {
      id: 'fast',
      name: 'Fast',
      description: 'Hidden tier',
      fusionTier: null,
      enabled: true,
      visible: false,
      reason: null,
    },
  ],
  defaultModel: null,
  refreshedAt: null,
  refreshing: false,
  errorCode: null,
};

function composer(props: Partial<Parameters<typeof TeamComposer>[0]> = {}) {
  return (
    <TeamComposer
      ticketId="ticket-1"
      closed={false}
      active={null}
      catalog={catalog}
      draft=""
      onDraftChange={vi.fn()}
      onChanged={vi.fn()}
      onRunsChanged={vi.fn()}
      {...props}
    />
  );
}

function selectPicker(title: string, option: RegExp) {
  fireEvent.click(screen.getByTitle(title));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  request.mockReset();
  window.localStorage.clear();
});

describe('chat da equipa', () => {
  it('apresenta relatórios do sistema como mensagens identificadas com conteúdo Markdown', () => {
    const body = [
      'A correção ainda não foi aplicada.',
      'A recuperação está por confirmar.',
      '',
      '### Próximo passo',
      '- Confirmar a causa do erro antes de alterar o serviço.',
      '',
      '```php',
      '$proposta = true;',
      '```',
    ].join('\n');
    const { container } = render(
      <TeamChat
        ticketId="ticket-1"
        comments={[note('report', 8, { authorKind: 'system', automated: true, body })]}
        runs={[]}
        models={catalog.models}
        user={user}
        visible
        onUseDraft={vi.fn()}
      />,
    );
    const message = container.querySelector('.team-chat-message.is-system article');
    expect(message?.querySelector('header strong')?.textContent).toBe('Sistema');
    expect(message?.querySelector('time')?.getAttribute('dateTime')).toBe(
      note('report', 8).createdAt,
    );
    expect(message?.querySelector('.markdown-content p')?.textContent).toBe(
      'A correção ainda não foi aplicada.\nA recuperação está por confirmar.',
    );
    expect(screen.getByRole('heading', { name: 'Próximo passo' })).toBeTruthy();
    expect(message?.querySelector('ul li')?.textContent).toBe(
      'Confirmar a causa do erro antes de alterar o serviço.',
    );
    expect(message?.querySelector('pre code')?.textContent).toBe('$proposta = true;\n');
  });

  it('mostra a nota final do run como resposta do Copilot, sem a repetir como mensagem solta', () => {
    const reply = note('reply', 8, { authorKind: 'agent', automated: true, agentRunId: 'run-1' });
    const items = buildTeamThread(
      [note('a', 1), reply, note('public', 2, { visibility: 'public' })],
      [run()],
    );
    expect(items.map((item) => item.kind)).toEqual(['note', 'run']);
    expect(items[1]).toMatchObject({ kind: 'run', reply: { id: 'reply' } });
  });

  it('abre nas últimas mensagens, carrega as anteriores e esconde o trabalho técnico', () => {
    const comments = Array.from({ length: TEAM_CHAT_PAGE + 5 }, (_, index) =>
      note(`n${index}`, index),
    );
    render(
      <TeamChat
        ticketId="ticket-1"
        comments={comments}
        runs={[run({ createdAt: new Date(Date.UTC(2026, 10, 9, 11)).toISOString() })]}
        models={catalog.models}
        user={user}
        visible
        onUseDraft={vi.fn()}
      />,
    );
    expect(screen.queryByText('Nota n0')).toBeNull();
    expect(screen.getByText('Resumo do run.')).toBeTruthy();
    expect(screen.getByText('Confirme o pagamento.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mensagens anteriores (6)' }));
    expect(screen.getByText('Nota n0')).toBeTruthy();

    expect(screen.queryByText(/pagamento capturado/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver interações (0)' }));
    expect(screen.getByText(/pagamento capturado/)).toBeTruthy();
  });

  it('mostra encaminhamento uma vez no rodapé e modelos usados só no detalhe do consumo', () => {
    const { container } = render(
      <TeamChat
        ticketId="ticket-1"
        comments={[]}
        runs={[
          run({
            executionMode: 'copilot',
            model: 'fusion',
            fusionTier: 'standard',
            usage: { ...emptyUsage(), models: ['gpt-mini'], inputTokens: 100 },
          }),
        ]}
        models={catalog.models}
        user={user}
        visible
        onUseDraft={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Copilot · Fusion Standard')).toHaveLength(1);
    expect(screen.getByText('Custo indisponível')).toBeTruthy();
    expect(container.querySelector('.agent-usage-details summary')?.textContent).not.toContain(
      'gpt-mini',
    );
    expect(screen.getByText('GPT mini')).toBeTruthy();
  });

  it('explica recusa Fusion com escolha explícita de outro modelo', () => {
    render(
      <TeamChat
        ticketId="ticket-1"
        comments={[]}
        runs={[
          run({
            status: 'failed',
            model: 'fusion',
            fusionTier: 'high',
            errorCode: 'fusion_unavailable',
          }),
        ]}
        models={catalog.models}
        user={user}
        visible
        onUseDraft={vi.fn()}
      />,
    );
    expect(screen.getByText('Fusion indisponível ou recusado; escolha outro modelo.')).toBeTruthy();
  });

  it('começa em Fusion Standard e envia o tier canónico, nunca o id opaco do runtime', async () => {
    request.mockResolvedValue({});
    render(composer());
    expect(screen.getByRole('button', { name: 'Modelo do Copilot: Fusion' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nível Fusion: Standard' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Investigar' }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith('/tickets/ticket-1/agent-runs', {
      method: 'POST',
      body: {
        executionMode: 'copilot',
        model: 'fusion',
        fusionTier: 'standard',
        reasoningEffort: null,
      },
    });
  });

  it('guarda Fusion Max para o próximo run sem confundir tier com esforço', async () => {
    request.mockResolvedValue({});
    const { unmount } = render(composer());
    selectPicker('Nível Fusion', /^Max/);
    fireEvent.click(screen.getByRole('button', { name: 'Investigar' }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]?.[1].body).toEqual({
      executionMode: 'copilot',
      model: 'fusion',
      fusionTier: 'max',
      reasoningEffort: null,
    });
    unmount();
    render(composer());
    expect(screen.getByRole('button', { name: 'Nível Fusion: Max' })).toBeTruthy();
  });

  it('Local usa Auto/modelos individuais no servidor e envia o esforço original', async () => {
    request.mockResolvedValue({});
    render(composer());
    selectPicker('Modo de execução', /^Local/);
    expect(screen.getByRole('button', { name: 'Modelo do Copilot: Auto' })).toBeTruthy();
    fireEvent.click(screen.getByTitle('Modelo do Copilot'));
    expect(screen.queryByRole('option', { name: /^Fusion/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /^Copilot Fusion/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /^GPT pro/ }));
    selectPicker('Esforço de raciocínio', /^High$/);
    fireEvent.click(screen.getByRole('button', { name: 'Investigar' }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]?.[1].body).toEqual({
      executionMode: 'local',
      model: 'gpt-pro',
      fusionTier: null,
      reasoningEffort: 'high',
    });
  });

  it('preserva preferência antiga explícita e exige escolha quando fica indisponível', () => {
    window.localStorage.setItem(
      'zeroops.copilot-model',
      JSON.stringify({ model: 'gpt-pro', high: true }),
    );
    const { rerender } = render(composer());
    expect(screen.getByRole('button', { name: /Modelo do Copilot: GPT pro/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Esforço de raciocínio: High' })).toBeTruthy();
    rerender(
      composer({
        catalog: { ...catalog, models: catalog.models.filter((model) => model.id !== 'gpt-pro') },
      }),
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Investigar' }).disabled).toBe(
      true,
    );
    expect(screen.getByText(/A preferência guardada está indisponível/)).toBeTruthy();
    fireEvent.submit(screen.getByRole('button', { name: 'Investigar' }).closest('form')!);
    expect(request).not.toHaveBeenCalled();
  });

  it('recusa Fusion indisponível sem fallback silencioso', () => {
    window.localStorage.setItem(
      'zeroops.copilot-model',
      JSON.stringify({
        executionMode: 'copilot',
        model: 'fusion',
        fusionTier: 'high',
        reasoningEffort: null,
      }),
    );
    render(
      composer({
        catalog: {
          ...catalog,
          routingTiers: catalog.routingTiers?.map((tier) => ({
            ...tier,
            enabled: false,
            reason: 'Policy denies Fusion',
          })),
        },
      }),
    );
    expect(screen.getByText('Policy denies Fusion')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Investigar' }).disabled).toBe(
      true,
    );
  });

  it('menus pesquisam, operam com teclado, fecham por Escape e restauram foco', () => {
    render(composer());
    const trigger = screen.getByTitle('Modelo do Copilot');
    fireEvent.click(trigger);
    const search = screen.getByRole('searchbox');
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'mini' } });
    expect(screen.queryByRole('option', { name: /^Fusion/ })).toBeNull();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /^GPT mini/ }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /^GPT mini/ }));
    expect(document.activeElement).toBe(trigger);
  });

  it('ticket fechado bloqueia submit e o atalho; alternar Nota retém o texto Copilot', () => {
    const { rerender } = render(composer());
    fireEvent.change(screen.getByLabelText('Mensagem para o Copilot'), {
      target: { value: 'Contexto guardado' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Nota' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Perguntar ao Copilot' }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Mensagem para o Copilot').value).toBe(
      'Contexto guardado',
    );
    rerender(composer({ closed: true }));
    fireEvent.keyDown(screen.getByLabelText('Mensagem para o Copilot'), {
      key: 'Enter',
      ctrlKey: true,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('só mostra promoção ativa reportada pelo runtime, nunca inventa desconto', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T13:00:00Z'));
    const tiers = catalog.routingTiers?.map((tier) => ({
      ...tier,
      promo: {
        discountPercent: 17,
        startsAt: '2026-11-01T00:00:00Z',
        endsAt: '2026-12-01T00:00:00Z',
        message: 'Promoção verificada: 17%',
      },
    }));
    const { rerender } = render(composer({ catalog: { ...catalog, routingTiers: tiers } }));
    expect(screen.getByText('Promoção verificada: 17%')).toBeTruthy();
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));
    rerender(composer({ catalog: { ...catalog, routingTiers: tiers } }));
    expect(screen.queryByText('Promoção verificada: 17%')).toBeNull();
    vi.useRealTimers();
  });

  it('envia seguimentos ao run em curso com o modelo do run bloqueado', async () => {
    request.mockResolvedValue({});
    window.localStorage.setItem(
      'zeroops.copilot-model',
      JSON.stringify({
        executionMode: 'local',
        model: 'gpt-pro',
        fusionTier: null,
        reasoningEffort: 'high',
      }),
    );
    const { rerender } = render(
      composer({
        active: run({
          status: 'running',
          model: 'fusion',
          executionMode: 'copilot',
          fusionTier: 'max',
        }),
      }),
    );
    const model = screen.getByTitle<HTMLButtonElement>('Modelo do Copilot');
    expect(model.disabled).toBe(true);
    expect(model.textContent).toBe('Fusion');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Nível Fusion: Max' }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Modo de execução: Copilot' }).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Mensagem para o Copilot'), {
      target: { value: 'Veja também o Shift4.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/tickets/ticket-1/agent-runs/run-1/inputs', {
        method: 'POST',
        body: { kind: 'message', text: 'Veja também o Shift4.' },
      }),
    );
    rerender(composer());
    expect(screen.getByRole('button', { name: 'Modo de execução: Local' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Modelo do Copilot: GPT pro/ })).toBeTruthy();
  });

  it('mostra as iniciais quando a fotografia não carrega e o robot para o Copilot', () => {
    const { container } = render(
      <>
        <Avatar name="Ana Silva" userId="user-1" avatarVersion={3} />
        <Avatar name="Copilot" kind="copilot" />
      </>,
    );
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('/api/users/user-1/avatar?v=3');
    fireEvent.error(image);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('AS')).toBeTruthy();
    expect(container.querySelector('.avatar-copilot svg')).toBeTruthy();
  });
});
