import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  healthSettingsSchema,
  projectPermissionKeys,
  type InstanceProject,
} from '@zeroops/contracts';
import { App } from '../src/App';
import { parseFlowsRoute } from '../src/features/flows/FlowsPage';
import {
  ProjectAdminPage,
  parseProjectAdminRoute,
} from '../src/features/projects/ProjectAdminPage';
import { IdentityLocaleProvider, LocalePicker } from '../src/lib/identity';
import { useResource } from '../src/lib/hooks';
import {
  ProjectAdminProvider,
  projectAdminPath,
  useProjectSession,
} from '../src/lib/project-admin';
import { SessionProvider, useSession } from '../src/lib/session';

const actor = {
  id: 'actor',
  projectId: 'active-project',
  role: 'client',
  email: 'actor@example.test',
  displayName: 'Instance administrator',
  locale: 'pt-PT',
  instanceAdmin: true,
  passwordChangeRequired: false,
};
const project = (id: string): InstanceProject => ({
  id,
  name: `Project ${id}`,
  archived: false,
  logoVersion: null,
  siteKey: null,
  version: id === 'one' ? 3 : 9,
  memberCount: 1,
  adminCount: 2,
  pendingAdminCount: 1,
  clientName: `Client ${id}`,
});
const member = (id: string) => ({
  ...actor,
  id: `member-${id}`,
  projectId: id,
  displayName: `Member ${id}`,
  email: `${id}@example.test`,
  role: 'admin',
  organization: 'client',
  disabled: false,
  lockedUntil: null,
  mfaEnabled: true,
});
function mockApi(user = actor) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const path = String(url);
    if (path === '/api/session') return Response.json({ user, csrfToken: 'session-csrf' });
    if (options?.method === 'POST') {
      if (path.endsWith('/account/reauth'))
        return Response.json({ confirmationToken: 'test-confirmation-token' });
      if (path.endsWith('/monitoring/agent-token') || path.endsWith('/agent/relay/token'))
        return Response.json({ token: 'test-project-token' });
      return Response.json({});
    }
    const detail = path.match(/^\/api\/project-admin\/([^/]+)$/);
    if (detail?.[1]) return Response.json(project(detail[1]));
    const access = path.match(/^\/api\/projects\/([^/]+)\/access$/);
    if (access?.[1])
      return Response.json({
        project: project(access[1]),
        isAdmin: user.instanceAdmin || user.role === 'admin',
        permissions: user.instanceAdmin || user.role === 'admin' ? projectPermissionKeys : [],
      });
    if (path.endsWith('/flows')) return Response.json([]);
    if (/\/flows\/[^/]+$/.test(path))
      return Response.json({ error: 'not_found', message: 'Flow not found.' }, { status: 404 });
    if (path.endsWith('/users')) {
      const id = path.includes('/two/') ? 'two' : 'one';
      return Response.json([member(id)]);
    }
    if (
      path.endsWith('/invitations') ||
      path.endsWith('/integration-settings') ||
      path === '/api/projects'
    )
      return Response.json([]);
    if (path.endsWith('/agent/instructions'))
      return Response.json({
        body: 'Default instructions for this project.',
        version: 2,
        history: [],
        canManage: true,
        isDefault: false,
        autoInvestigate: false,
        autoClientQuestions: false,
      });
    if (path.endsWith('/agent/relay'))
      return Response.json({
        configured: false,
        canManage: true,
        lastDay: { done: 0, failed: 0, expired: 0 },
      });
    if (path.endsWith('/monitoring'))
      return Response.json({
        settings: healthSettingsSchema.parse({ enabled: true }),
        canManage: true,
        checks: [],
        alerts: [],
        members: [],
        agentTokenConfigured: false,
        alertRulesSync: { state: 'disabled', syncedAt: null, message: null },
      });
    return Response.json({
      investigation: true,
      implementation: true,
      deployment: true,
      blockers: [],
    });
  });
}
function tree(id: string, tab: 'geral' | 'utilizadores' | 'integracoes' | 'saude' = 'geral') {
  return (
    <IdentityLocaleProvider>
      <SessionProvider>
        <ProjectAdminPage id={id} tab={tab} />
      </SessionProvider>
    </IdentityLocaleProvider>
  );
}
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  window.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('Explicit project administration', () => {
  it('scopes only supported settings endpoints, leaving session and operational routes alone', async () => {
    const fetch = mockApi();
    function Probe() {
      const scoped = useProjectSession();
      const actual = useSession();
      return (
        <>
          <output>{`${scoped.session === actual.session}:${scoped.session?.user.projectId}:${scoped.session?.user.role}`}</output>
          <button onClick={() => void scoped.request('/users', { method: 'POST', body: {} })}>
            Mutate members
          </button>
          <button onClick={() => void scoped.request('/account/profile')}>Read account</button>
        </>
      );
    }
    render(
      <SessionProvider>
        <ProjectAdminProvider project={project('one')}>
          <Probe />
        </ProjectAdminProvider>
      </SessionProvider>,
    );
    await screen.findByText('true:active-project:client');
    fireEvent.click(screen.getByText('Mutate members'));
    fireEvent.click(screen.getByText('Read account'));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => url === '/api/project-admin/one/users')).toBe(true),
    );
    const mutation = fetch.mock.calls.find(([url]) => url === '/api/project-admin/one/users');
    expect((mutation?.[1]?.headers as Record<string, string>)['X-CSRF-Token']).toBe('session-csrf');
    expect(fetch.mock.calls.some(([url]) => url === '/api/account/profile')).toBe(true);
    for (const path of [
      '/users',
      '/users/id/action',
      '/invitations/id/action',
      '/auth/invite',
      '/integration-settings/id/test',
      '/integration-settings/id/revoke',
      '/agent/instructions',
      '/agent/settings',
      '/agent/relay',
      '/agent/relay/token',
      '/monitoring',
      '/monitoring/settings',
      '/monitoring/agent-token',
      '/account/reauth',
    ])
      expect(projectAdminPath('one', path)).toBe(`/project-admin/one${path}`);
    for (const path of [
      '/users/id/deliveries',
      '/users/id/email',
      '/monitoring/run',
      '/monitoring/report',
      '/monitoring/charts',
      '/tickets',
      '/session',
    ])
      expect(projectAdminPath('one', path)).toBe(path);
  });

  it('aborts an old scoped resource and never displays a late response from another project', async () => {
    const fetch = mockApi();
    let oldResolve!: (response: Response) => void;
    let oldSignal: AbortSignal | null | undefined;
    fetch.mockImplementation(async (url, options) => {
      if (url === '/api/session') return Response.json({ user: actor, csrfToken: 'session-csrf' });
      if (url === '/api/project-admin/one/users') {
        oldSignal = options?.signal;
        return new Promise<Response>((resolve) => {
          oldResolve = resolve;
        });
      }
      return Response.json([member('two')]);
    });
    function Users() {
      const resource = useResource<ReturnType<typeof member>[]>('/users');
      return <output>{resource.data?.[0]?.displayName ?? 'waiting'}</output>;
    }
    const scopedTree = (id: string) => (
      <SessionProvider>
        <ProjectAdminProvider project={project(id)}>
          <Users />
        </ProjectAdminProvider>
      </SessionProvider>
    );
    const view = render(scopedTree('one'));
    await waitFor(() => expect(oldResolve).toBeTypeOf('function'));
    view.rerender(scopedTree('two'));
    await screen.findByText('Member two');
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => oldResolve(Response.json([member('one')])));
    expect(screen.queryByText('Member one')).toBeNull();
  });

  it('shows persistent detail, localized tabs and isolated general drafts with scoped reauthentication', async () => {
    const fetch = mockApi();
    const view = render(tree('one'));
    const name = await screen.findByLabelText('Nome do projeto');
    expect(screen.getByText('Client one')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Geral',
      'Utilizadores e acessos',
      'Parâmetros e integrações',
      'Saúde e notificações',
      'Fluxos de resolução',
      'Permissões do projeto',
    ]);
    fireEvent.change(name, { target: { value: 'Draft one' } });
    view.rerender(tree('two'));
    expect(((await screen.findByLabelText('Nome do projeto')) as HTMLInputElement).value).toBe(
      'Project two',
    );
    expect(screen.queryByText('Project one')).toBeNull();
    fireEvent.change(screen.getByLabelText('Nome do projeto'), {
      target: { value: 'Updated two' },
    });
    fireEvent.change(screen.getByLabelText('Organização / cliente'), {
      target: { value: 'Updated client' },
    });
    fireEvent.change(screen.getByLabelText('Motivo'), {
      target: { value: 'Approved administrative change' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar alteração' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Palavra-passe'), {
      target: { value: 'test-password-only' },
    });
    fireEvent.change(within(dialog).getByLabelText('Código MFA / recuperação (se ativo)'), {
      target: { value: '123456' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar ação' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, options]) => url === '/api/project-admin/two' && options?.method === 'POST',
        ),
      ).toBe(true),
    );
    const reauth = fetch.mock.calls.find(
      ([url]) => url === '/api/project-admin/two/account/reauth',
    );
    expect(JSON.parse(String(reauth?.[1]?.body))).toMatchObject({
      action: 'project-update',
      target: 'two',
    });
    const update = fetch.mock.calls.find(
      ([url, options]) => url === '/api/project-admin/two' && options?.method === 'POST',
    );
    expect(JSON.parse(String(update?.[1]?.body))).toEqual({
      name: 'Updated two',
      clientName: 'Updated client',
      siteKey: null,
      expectedVersion: 9,
      reason: 'Approved administrative change',
      confirmationToken: 'test-confirmation-token',
    });
    expect(parseProjectAdminRoute('projects/one').tab).toBe('geral');
    expect(parseProjectAdminRoute('projects/one/unknown').tab).toBe('geral');
    expect(parseProjectAdminRoute('projects/one/fluxos/flow-1')).toMatchObject({
      id: 'one',
      tab: 'fluxos',
      sub: 'flow-1',
    });
    expect(parseFlowsRoute('flows')).toBeNull();
    expect(parseFlowsRoute('flows/flow%201')).toBe('flow 1');
  });

  it('limits member management to project membership fields even for instance administrators', async () => {
    const fetch = mockApi();
    const view = render(tree('one', 'utilizadores'));
    await screen.findByText('Member one');
    for (const name of [
      'Ver entregas',
      'Alterar email',
      'Desbloquear conta',
      'Revogar sessões',
      'Iniciar reposição MFA',
    ])
      expect(screen.queryByRole('button', { name })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Nome') as HTMLInputElement).readOnly).toBe(true);
    expect(within(dialog).queryByLabelText('Idioma')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Perfil'), { target: { value: 'qa' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar utilizador' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, options]) =>
            url === '/api/project-admin/one/users/member-one' && options?.method === 'POST',
        ),
      ).toBe(true),
    );
    const update = fetch.mock.calls.find(
      ([url]) => url === '/api/project-admin/one/users/member-one',
    );
    expect(JSON.parse(String(update?.[1]?.body))).toEqual({ role: 'qa', organization: 'client' });
    view.rerender(tree('two', 'utilizadores'));
    await screen.findByText('Member two');
    expect(screen.queryByText('Member one')).toBeNull();
  });

  it('reuses integration and health settings with scoped mutations and no operational endpoints', async () => {
    const fetch = mockApi();
    const view = render(tree('one', 'integracoes'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await screen.findByRole('heading', { name: 'Agente de investigação' });
    await screen.findByRole('button', { name: 'Gerar token' });
    expect(screen.queryByRole('tab', { name: /SMTP/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar token' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => url === '/api/project-admin/one/agent/relay/token'),
      ).toBe(true),
    );
    view.rerender(tree('two', 'saude'));
    await screen.findByRole('heading', { name: 'Configuração' });
    expect(screen.queryByText('test-project-token')).toBeNull();
    fireEvent.submit(screen.getByRole('heading', { name: 'Configuração' }).closest('form')!);
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, options]) =>
            url === '/api/project-admin/two/monitoring/settings' && options?.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(
      fetch.mock.calls.some(([url]) =>
        /\/capabilities|\/monitoring\/(?:run|report|charts|history)/.test(String(url)),
      ),
    ).toBe(false);
  });

  it('keeps archive controls instance-only and localizes the administration interface', async () => {
    mockApi({ ...actor, role: 'admin', instanceAdmin: false });
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <LocalePicker />
          <ProjectAdminPage id="one" />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    await screen.findByLabelText('Nome do projeto');
    expect(screen.queryByRole('button', { name: 'Confirmar arquivo' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    expect(await screen.findByRole('tab', { name: 'Users and access' })).toBeTruthy();
    expect(screen.getByLabelText('Organization / client')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to active project' })).toBeTruthy();
  });

  it('admits global administrators without membership and denies non-admin project routes', async () => {
    const fetch = mockApi();
    window.history.replaceState(null, '', '/#projects/one/geral');
    const view = render(<App />);
    await screen.findByLabelText('Nome do projeto');
    expect(fetch.mock.calls.some(([url]) => url === '/api/project-admin/one')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Utilizadores e acessos' }));
    await screen.findByText('Member one');
    expect(window.location.hash).toBe('#projects/one/utilizadores');
    expect(screen.getByText('Client one')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Geral' }));
    await screen.findByLabelText('Nome do projeto');
    view.unmount();
    fetch.mockRestore();
    const deniedFetch = mockApi({ ...actor, instanceAdmin: false });
    render(<App />);
    await screen.findByText('Página indisponível');
    expect(deniedFetch.mock.calls.some(([url]) => url === '/api/project-admin/one')).toBe(false);
  });

  it('opens a flow inside the project tab and the flows page from the side menu', async () => {
    const fetch = mockApi();
    window.history.replaceState(null, '', '/#projects/one/fluxos/flow-1');
    const view = render(<App />);
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => url === '/api/project-admin/one/flows/flow-1')).toBe(
        true,
      ),
    );
    expect(screen.queryByText('Página indisponível')).toBeNull();
    view.unmount();
    window.history.replaceState(null, '', '/#flows');
    render(<App />);
    await screen.findByRole('heading', { name: 'Fluxos de resolução', level: 1 });
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => url === '/api/project-admin/active-project/flows'),
      ).toBe(true),
    );
    expect(screen.getByRole('link', { name: 'Fluxos' }).getAttribute('aria-current')).toBe('page');
  });
});
