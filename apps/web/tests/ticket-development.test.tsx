import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DevelopmentWorkspaceView,
  FlowDefinition,
  ProjectPermission,
  TicketDevelopmentView,
} from '@zeroops/contracts';
import { StepConfigPanel } from '../src/features/flows/StepConfigPanel';
import { TicketDevelopmentPanel } from '../src/features/flows/TicketDevelopmentPanel';
import { IdentityLocaleProvider } from '../src/lib/identity';
import { ProjectAdminProvider } from '../src/lib/project-admin';
import { SessionProvider } from '../src/lib/session';

const project = { id: 'project', name: 'Projeto', archived: false, logoVersion: null, version: 1 };
const session = () =>
  Response.json({
    user: { id: 'tech', projectId: project.id, role: 'technical', displayName: 'Tiago' },
    csrfToken: 'csrf',
  });

function wrap(children: React.ReactNode, permissions: ProjectPermission[] = ['flows.view']) {
  return (
    <IdentityLocaleProvider>
      <SessionProvider>
        <ProjectAdminProvider project={project} permissions={permissions}>
          {children}
        </ProjectAdminProvider>
      </SessionProvider>
    </IdentityLocaleProvider>
  );
}

const base = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const head = 'c'.repeat(40);

function workspace(overrides: Partial<DevelopmentWorkspaceView> = {}): DevelopmentWorkspaceView {
  return {
    id: 'ws-1',
    nodeId: 'dev',
    repository: {
      id: 'repo',
      name: 'Sandbox',
      url: 'file:///repos/sandbox.git',
      prProvider: 'zeroops',
    },
    branch: 'zeroops/t-1-ws',
    baseBranch: 'main',
    baseSha: base,
    headSha: head,
    state: 'idle',
    publish: 'pull_request',
    currentRunId: null,
    ownerEpoch: null,
    retentionUntil: null,
    diff: 'diff --git a/app.js b/app.js\n+module.exports = 2;\n',
    diffTruncated: false,
    revisions: [
      {
        id: 'rev-2',
        agentRunId: 'run-2',
        baseSha: base,
        headSha: head,
        diffSha256: 'd'.repeat(64),
        scopeHash: 'e'.repeat(64),
        files: [
          { status: 'A', path: 'novo.js' },
          { status: 'M', path: 'app.js' },
          { status: 'D', path: 'old.txt' },
        ],
        testsPassed: true,
        candidateHash: 'f'.repeat(64),
        createdAt: '2026-11-15T10:00:00.000Z',
      },
    ],
    tests: [
      {
        id: 'test-1',
        agentRunId: 'run-2',
        phase: 'final',
        name: 'unit',
        command: 'node test.js',
        exitCode: 0,
        timedOut: false,
        testedSha: head,
        workingTreeHash: null,
        logSha256: '0'.repeat(64),
        log: 'ok',
        durationMs: 120,
        createdAt: '2026-11-15T10:00:00.000Z',
      },
    ],
    publications: [
      {
        id: 'pub-1',
        kind: 'pull_request',
        provider: 'zeroops',
        state: 'published',
        headSha: head,
        remoteRef: 'zeroops/t-1-ws',
        number: 1,
        url: null,
        attempts: 2,
        lastError: null,
        updatedAt: '2026-11-15T10:00:00.000Z',
      },
    ],
    reviews: [
      {
        id: 'dec-1',
        stepId: 'step-1',
        actor: { id: 'qa', displayName: 'Rita QA' },
        port: 'failure',
        headSha: oldHead,
        scopeHash: '1'.repeat(64),
        comment: 'Falta validar o caso vazio',
        override: false,
        invalidatedAt: '2026-11-15T09:59:00.000Z',
        invalidationReason: 'head_changed',
        createdAt: '2026-11-15T09:50:00.000Z',
      },
    ],
    review: {
      stepId: 'step-2',
      nodeId: 'review',
      rule: 'any',
      required: 1,
      approvals: 0,
      reviewers: [{ id: 'qa', displayName: 'Rita QA' }],
      canDecide: false,
    },
    pipeline: { available: false, reason: 'Sem pipeline de entrega configurada.', deliveries: [] },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P08 painel de desenvolvimento do ticket', () => {
  it('mostra base/head, diff A/M/D, testes com SHA, PR, revisores, invalidação e entrega sem pipeline configurada', async () => {
    const view: TicketDevelopmentView = { ticketId: 'ticket', workspaces: [workspace()] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === '/api/session') return session();
      if (String(url).endsWith('/tickets/ticket/development')) return Response.json(view);
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(wrap(<TicketDevelopmentPanel ticketId="ticket" />));
    const panel = await screen.findByRole('region', { name: 'Desenvolvimento' });
    expect(panel.textContent).toContain(base.slice(0, 12));
    expect(panel.textContent).toContain(head.slice(0, 12));
    for (const path of ['novo.js', 'app.js', 'old.txt']) expect(panel.textContent).toContain(path);
    expect(panel.textContent).toContain(`commit ${head.slice(0, 12)}`);
    expect(panel.textContent).toContain('#1');
    expect(panel.textContent).toContain('Rita QA');
    expect(panel.textContent).toContain('não é revisor desta etapa');
    expect(panel.querySelector('.development-invalidated')?.textContent).toContain(
      oldHead.slice(0, 12),
    );
    expect(panel.textContent).toContain('Sem pipeline de entrega configurada.');
    // A sessão pode chegar depois e recarregar o painel (remonta e fecha o diff): repete o clique.
    await vi.waitFor(() => {
      const show = screen.queryByRole('button', { name: 'Ver diff completo' });
      if (show) fireEvent.click(show);
      expect(screen.getByRole('region', { name: 'Desenvolvimento' }).textContent).toContain(
        '+module.exports = 2;',
      );
    }, 4000);
  });

  it('P09 mostra entrega: estado, fila, integração revalidada, digest, checks, aprovações e eventos', async () => {
    const integrated = 'd'.repeat(40);
    const digest = `sha256:${'e'.repeat(64)}`;
    const view: TicketDevelopmentView = {
      ticketId: 'ticket',
      workspaces: [
        workspace({
          pipeline: {
            available: true,
            reason: null,
            deliveries: [
              {
                id: 'del-1',
                stepId: 'step',
                nodeId: 'deliver',
                workspaceId: 'ws-1',
                pipeline: {
                  id: 'pl',
                  name: 'QA sandbox',
                  environment: 'quality',
                  targetBranch: 'main',
                },
                state: 'publishing',
                reason: 'À espera do ambiente quality',
                candidate: { baseSha: base, headSha: head, scopeHash: 'x' },
                approvals: [{ actorId: 'qa', displayName: 'Rita QA' }],
                targetSha: base,
                integratedSha: integrated,
                revalidated: true,
                artifactDigest: digest,
                externalId: 'run-42',
                externalUrl: 'https://ci.example.pt/run/42',
                pipelineStatus: 'running',
                checks: [{ name: 'deploy-qa', status: 'running' }],
                queuePosition: 2,
                attempts: 1,
                events: [
                  {
                    id: 'ev-1',
                    eventId: 'e1',
                    source: 'callback',
                    sequence: 1,
                    status: 'running',
                    outcome: 'duplicate',
                    receivedAt: '2026-01-01T10:00:00.000Z',
                  },
                ],
                createdAt: '2026-01-01T09:00:00.000Z',
                updatedAt: '2026-01-01T10:00:00.000Z',
                finishedAt: null,
              },
            ],
          },
        }),
      ],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === '/api/session') return session();
      if (String(url).endsWith('/tickets/ticket/development')) return Response.json(view);
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    render(wrap(<TicketDevelopmentPanel ticketId="ticket" />));
    const panel = await screen.findByRole('region', { name: 'Desenvolvimento' });
    const text = panel.textContent ?? '';
    expect(text).toContain('Entrega por pipeline');
    expect(text).toContain('QA sandbox');
    expect(text).toContain('pipeline em curso');
    expect(text).toContain('À espera do ambiente quality');
    expect(text).toContain('posição 2');
    expect(text).toContain(integrated.slice(0, 12));
    expect(text).toContain('revalidado sobre a base atual');
    expect(text).toContain(digest.slice(0, 19));
    expect(text).toContain('run-42');
    expect(text).toContain('deploy-qa');
    expect(text).toContain('Rita QA');
    expect(text).toContain('duplicate');
    expect(text).not.toContain('Sem pipeline de entrega configurada.');
  });

  it('não mostra nada num ticket sem workspace (investigação simples)', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        String(url) === '/api/session'
          ? session()
          : Response.json({ ticketId: 'ticket', workspaces: [] }),
      );
    const { container } = render(wrap(<TicketDevelopmentPanel ticketId="ticket" />));
    await vi.waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/development'))).toBe(true),
    );
    expect(container.querySelector('section')).toBeNull();
  });

  it('P09 configura a entrega com a pipeline do projeto e o review exigido (sem UUIDs à mão)', async () => {
    const definition = {
      schemaVersion: 1,
      start: 'dev',
      nodes: [
        { id: 'dev', op: 'copilot_task', label: 'Desenvolver', config: { mode: 'develop' } },
        {
          id: 'review',
          op: 'human_decision',
          label: 'Rever commit',
          config: { review: { sourceNode: 'dev', reviewers: { roles: ['qa'] }, rule: 'any' } },
        },
        { id: 'deliver', op: 'action', label: 'Entregar', config: { action: 'deliver' } },
      ],
      edges: [],
      layout: {},
    } as unknown as FlowDefinition;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === '/api/session') return session();
      if (String(url).endsWith(`/projects/${project.id}/pipelines`))
        return Response.json([
          { id: 'pl-1', name: 'QA sandbox', environment: 'quality', targetBranch: 'main' },
          {
            id: 'pl-old',
            name: 'Antiga',
            environment: 'quality',
            targetBranch: 'x',
            archived: true,
          },
        ]);
      throw new Error(`Unexpected request: ${String(url)}`);
    });
    const onChange = vi.fn();
    render(
      wrap(
        <StepConfigPanel
          definition={definition}
          nodeId="deliver"
          members={[]}
          issues={[]}
          onChange={onChange}
          onClose={() => undefined}
        />,
        ['flows.view', 'flows.edit'],
      ),
    );
    const pipeline = await screen.findByRole('combobox', { name: /Pipeline do projeto/ });
    await screen.findByRole('option', { name: 'QA sandbox (quality, main)' });
    expect(screen.queryByRole('option', { name: /Antiga/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Pipeline do projeto/ })).toBeNull();
    fireEvent.change(pipeline, { target: { value: 'pl-1' } });
    expect(onChange.mock.calls.at(-1)?.[0].nodes[2].config).toMatchObject({ pipelineId: 'pl-1' });
    fireEvent.change(screen.getByRole('combobox', { name: /Review exigido/ }), {
      target: { value: 'review' },
    });
    expect(onChange.mock.calls.at(-1)?.[0].nodes[2].config).toMatchObject({ reviewNode: 'review' });
  });
});
