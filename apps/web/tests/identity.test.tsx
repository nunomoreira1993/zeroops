import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthPage } from '../src/features/auth/AuthPage';
import { ReauthDialog, RecoveryCodes } from '../src/features/auth/IdentityForms';
import { TeamPage } from '../src/features/team/TeamPage';
import { AccountPage } from '../src/features/account/AccountPage';
import { InstanceProjectsPage } from '../src/features/projects/InstanceProjectsPage';
import { IdentityLocaleProvider, LocalePicker, consumeSecretLink } from '../src/lib/identity';
import { SessionProvider, useSession } from '../src/lib/session';

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});
const user = {
  id: 'actor',
  projectId: 'project',
  role: 'admin',
  email: 'admin@example.test',
  displayName: 'Admin',
  locale: 'pt-PT',
  instanceAdmin: true,
};
function mountAuth() {
  return render(
    <IdentityLocaleProvider>
      <SessionProvider>
        <AuthPage link={null} onConsumed={() => {}} />
      </SessionProvider>
    </IdentityLocaleProvider>,
  );
}
function fail(code: string, status = 401) {
  return Response.json(
    {
      error: { code, message: 'Texto de erro privado em português', requestId: 'test-reference' },
    },
    { status },
  );
}

describe('Identity authentication', () => {
  it('preserves recovery codes verbatim and lets the user confirm the redesigned panel', () => {
    const codes = ['SYNTHETIC-CODE-00001', 'SYNTHETIC-CODE-00002'];
    const onDone = vi.fn();
    render(
      <IdentityLocaleProvider>
        <RecoveryCodes codes={codes} onDone={onDone} />
      </IdentityLocaleProvider>,
    );
    const panel = screen.getByRole('region', { name: 'Guarde os códigos de recuperação' });
    expect(
      within(panel)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('code')?.textContent),
    ).toEqual(codes);
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Guardei os códigos. Continuar' }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('keeps mandatory enrollment restricted, sends challenge CSRF and shows manual key', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (url === '/api/session' || (url === '/api/auth/challenge' && options?.method !== 'POST'))
        return Response.json({}, { status: 401 });
      if (url === '/api/auth/login')
        return Response.json({ status: 'enrollment_required', csrfToken: 'restricted-csrf' });
      if (url === '/api/auth/enrollment')
        return Response.json({ uri: 'otpauth://totp/Test?secret=TESTONLY', secret: 'TESTONLY' });
      return Response.json({});
    });
    function Probe() {
      const { session, challenge } = useSession();
      return <output>{session ? 'FULL' : (challenge?.status ?? 'NONE')}</output>;
    }
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <AuthPage link={null} onConsumed={() => {}} />
          <Probe />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    await waitFor(() => expect(screen.getByText('NONE')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.test' } });
    fireEvent.change(screen.getByLabelText('Palavra-passe'), {
      target: { value: 'test-password-only' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByText('enrollment_required');
    expect(screen.queryByText('FULL')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Obter QR e chave de configuração' }));
    await screen.findByLabelText('Chave para configuração manual');
    expect(
      (screen.getByLabelText('Chave para configuração manual') as HTMLInputElement).value,
    ).toBe('TESTONLY');
    const call = fetch.mock.calls.find(([url]) => url === '/api/auth/enrollment');
    expect((call?.[1]?.headers as Record<string, string>)['X-CSRF-Token']).toBe('restricted-csrf');
  });

  it('restores MFA challenge after reload and accepts an unused recovery code before portal access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (url === '/api/session') return Response.json({}, { status: 401 });
      if (url === '/api/auth/challenge' && options?.method !== 'POST')
        return Response.json({ status: 'mfa_required', csrfToken: 'challenge-csrf' });
      return Response.json({
        status: 'authenticated',
        user,
        csrfToken: 'session-csrf',
        recoveryCodes: ['TEST-CODE-ONLY'],
      });
    });
    function Probe() {
      const { session, recoveryCodes } = useSession();
      return (
        <output>{session ? `${session.csrfToken}:${recoveryCodes?.join()}` : 'restricted'}</output>
      );
    }
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <AuthPage link={null} onConsumed={() => {}} />
          <Probe />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Código TOTP ou de recuperação'), {
      target: { value: 'TEST-RECOVERY-ONLY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await screen.findByText('session-csrf:TEST-CODE-ONLY');
    const challenge = fetch.mock.calls.find(
      ([url, options]) => url === '/api/auth/challenge' && options?.method === 'POST',
    );
    expect(JSON.parse(String(challenge?.[1]?.body))).toEqual({ code: 'TEST-RECOVERY-ONLY' });
  });

  it('localizes recovery and gives generic acceptance without disclosing account existence', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) =>
        url === '/api/auth/reset/request'
          ? Response.json({ ok: true })
          : Response.json({}, { status: 401 }),
      );
    mountAuth();
    fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'unknown@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText(/If the address is eligible/);
    const call = fetch.mock.calls.find(([url]) => url === '/api/auth/reset/request');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      email: 'unknown@example.test',
      locale: 'en',
    });
    expect((call?.[1]?.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
  });

  it.each(['pt-PT', 'en'])(
    'maps login errors by code in %s without showing backend text',
    async (locale) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
        url === '/api/auth/login'
          ? fail('invalid_credentials')
          : Response.json({}, { status: 401 }),
      );
      mountAuth();
      fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: locale } });
      fireEvent.change(screen.getByLabelText('Email'), {
        target: { value: 'unknown@example.test' },
      });
      fireEvent.change(screen.getByLabelText(locale === 'en' ? 'Password' : 'Palavra-passe'), {
        target: { value: 'test-password-only' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: locale === 'en' ? 'Continue' : 'Continuar' }),
      );
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(
        locale === 'en' ? 'Unable to sign in.' : 'Não foi possível iniciar sessão.',
      );
      expect(alert.textContent).toContain('test-reference');
      expect(alert.textContent).not.toContain('Texto de erro privado');
    },
  );

  it('translates rejected MFA/recovery codes while keeping access restricted', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (url === '/api/auth/challenge' && options?.method === 'POST') return fail('mfa_invalid');
      if (url === '/api/auth/challenge')
        return Response.json({ status: 'mfa_required', csrfToken: 'challenge-csrf' });
      return Response.json({}, { status: 401 });
    });
    mountAuth();
    fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    fireEvent.change(await screen.findByLabelText('TOTP or recovery code'), {
      target: { value: 'TEST-USED-CODE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The code is not valid.');
    expect(alert.textContent).not.toContain('Texto de erro privado');
    expect(screen.getByLabelText('TOTP or recovery code')).toBeTruthy();
  });

  it('does not claim recovery email acceptance when SMTP is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      url === '/api/auth/reset/request'
        ? fail('smtp_unavailable', 503)
        : Response.json({}, { status: 401 }),
    );
    mountAuth();
    fireEvent.change(screen.getByLabelText('Idioma'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'unknown@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Service unavailable. The request was not confirmed.',
    );
    expect(screen.queryByText(/If the address is eligible/)).toBeNull();
  });

  it('scrubs query and fragment secrets immediately without persistent storage', () => {
    for (const [path, kind] of [
      ['activate', 'invite'],
      ['reset-password', 'reset'],
      ['verify-email', 'email'],
      ['mfa-reset', 'mfa-reset'],
    ]) {
      window.history.replaceState(null, '', `/${path}#token=TEST-LINK-ONLY`);
      expect(consumeSecretLink()).toEqual({ kind, token: 'TEST-LINK-ONLY' });
      expect(window.location.hash).toBe('');
    }
    window.history.replaceState(null, '', '/?invite=TEST-INVITE-ONLY&view=public');
    expect(consumeSecretLink()).toEqual({ kind: 'invite', token: 'TEST-INVITE-ONLY' });
    expect(window.location.search).toBe('?view=public');
    expect(window.localStorage.length).toBe(0);
  });
});

describe('Team access and reauthentication', () => {
  it('creates a project with an action-bound confirmation and queues only an administrator invite', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (url === '/api/session') return Response.json({ user, csrfToken: 'session-csrf' });
      if (url === '/api/instance/projects' && options?.method !== 'POST') return Response.json([]);
      if (url === '/api/instance/users')
        return Response.json([
          {
            id: 'existing-user',
            email: 'admin@example.test',
            displayName: 'Admin',
            locale: 'pt-PT',
          },
        ]);
      if (url === '/api/account/reauth')
        return Response.json({ confirmationToken: 'TEST-CONFIRM-ONLY' });
      if (url === '/api/instance/projects' && options?.method === 'POST')
        return Response.json({ id: 'new-project', name: 'Quality Sandbox' });
      return Response.json({});
    });
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <InstanceProjectsPage />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    expect(screen.queryByLabelText('Nome do projeto')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Criar projeto' }));
    fireEvent.change(await screen.findByLabelText('Nome do projeto'), {
      target: { value: 'Quality Sandbox' },
    });
    await screen.findByRole('option', { name: 'Admin · admin@example.test' });
    fireEvent.change(screen.getByLabelText('Administrador inicial do projeto'), {
      target: { value: 'existing-user' },
    });
    const image =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    fireEvent.change(screen.getByLabelText('Selecionar logotipo'), {
      target: { files: [new File([image], 'logo.svg', { type: 'image/svg+xml' })] },
    });
    await screen.findByAltText('Pré-visualização do logotipo');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Continuar para confirmação' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continuar para confirmação' }));
    await screen.findByLabelText('Palavra-passe');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Palavra-passe'), {
      target: { value: 'test-password-only' },
    });
    fireEvent.change(screen.getByLabelText('Código MFA / recuperação (se ativo)'), {
      target: { value: '000000' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirmar ação' })));
    const reauth = fetch.mock.calls.find(([url]) => url === '/api/account/reauth');
    expect(JSON.parse(String(reauth?.[1]?.body))).toMatchObject({
      action: 'project-create',
      target: 'existing-user:Quality Sandbox',
    });
    const create = fetch.mock.calls.find(
      ([url, options]) => url === '/api/instance/projects' && options?.method === 'POST',
    );
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      name: 'Quality Sandbox',
      initialAdminUserId: 'existing-user',
      confirmationToken: 'TEST-CONFIRM-ONLY',
      logo: { mime: 'image/svg+xml', data: btoa(image) },
    });
    await screen.findByText(/convite do administrador foi colocado na fila/);
  });

  it('keeps the project draft when confirmation is cancelled and blocks an invalid logo', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/api/session') return Response.json({ user, csrfToken: 'session-csrf' });
      if (url === '/api/instance/users')
        return Response.json([
          { id: 'existing-user', displayName: 'Admin', email: 'admin@example.test' },
        ]);
      return Response.json([]);
    });
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <InstanceProjectsPage />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Criar projeto' }));
    await screen.findByRole('option', { name: 'Admin · admin@example.test' });
    fireEvent.change(screen.getByLabelText('Nome do projeto'), { target: { value: 'Sandbox' } });
    fireEvent.change(screen.getByLabelText('Administrador inicial do projeto'), {
      target: { value: 'existing-user' },
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Continuar para confirmação' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continuar para confirmação' }));
    await screen.findByLabelText('Palavra-passe');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(((await screen.findByLabelText('Nome do projeto')) as HTMLInputElement).value).toBe(
      'Sandbox',
    );
    fireEvent.change(screen.getByLabelText('Selecionar logotipo'), {
      target: { files: [new File(['text'], 'logo.txt', { type: 'text/plain' })] },
    });
    await screen.findByRole('alert');
    expect(
      screen.getByRole('button', { name: 'Continuar para confirmação' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      fetch.mock.calls.some(
        ([url, options]) => url === '/api/instance/projects' && options?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('does not terminate the session when scoped project reauthentication rejects credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      url === '/api/session'
        ? Response.json({ user, csrfToken: 'session-csrf' })
        : fail('invalid_credentials'),
    );
    function Probe() {
      const { session, request } = useSession();
      const [rejected, setRejected] = useState(false);
      return (
        <>
          <output>{session ? session.user.projectId : 'no-session'}</output>
          <button
            onClick={() => {
              void request('/project-admin/other-project/account/reauth', {
                method: 'POST',
                body: {},
              }).catch(() => setRejected(true));
            }}
          >
            Reauthenticate
          </button>
          {rejected && <span>Rejected</span>}
        </>
      );
    }
    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );
    await screen.findByText('project');
    fireEvent.click(screen.getByRole('button', { name: 'Reauthenticate' }));
    await screen.findByText('Rejected');
    expect(screen.getByText('project')).toBeTruthy();
    expect(screen.queryByText('no-session')).toBeNull();
  });

  it('does not expose global identity controls to a project administrator', async () => {
    const projectAdmin = { ...user, instanceAdmin: false };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/api/session')
        return Response.json({ user: projectAdmin, csrfToken: 'session-csrf' });
      if (url === '/api/users')
        return Response.json([
          { ...projectAdmin, disabled: false, mfaEnabled: true, organization: null },
        ]);
      if (url === '/api/invitations') return Response.json([]);
      return Response.json({}, { status: 404 });
    });
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <TeamPage />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    await screen.findByText('Admin');
    expect(screen.queryByRole('button', { name: 'Alterar email' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ver entregas' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Iniciar reposição MFA' })).toBeNull();
  });

  it('sends invitations without reauthentication and never displays activation links', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (url === '/api/session') return Response.json({ user, csrfToken: 'session-csrf' });
      if (url === '/api/users')
        return Response.json([{ ...user, disabled: false, mfaEnabled: true, organization: null }]);
      if (url === '/api/invitations' && options?.method !== 'POST') return Response.json([]);
      if (url === '/api/account/reauth')
        return Response.json({ confirmationToken: 'TEST-CONFIRM-ONLY' });
      return Response.json({ ok: true });
    });
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <TeamPage />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    await screen.findByText('Admin');
    expect(
      screen.getByRole('button', { name: 'Iniciar reposição MFA' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Convidar pessoa' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'New person' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.test' } });
    fireEvent.change(screen.getByLabelText('Organização', { selector: 'dialog select' }), {
      target: { value: 'deloitte' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Enviar convite' })));
    expect(screen.queryByLabelText('Palavra-passe')).toBeNull();
    expect(fetch.mock.calls.some(([url]) => url === '/api/account/reauth')).toBe(false);
    const invitation = fetch.mock.calls.find(
      ([url, options]) => url === '/api/invitations' && options?.method === 'POST',
    );
    const body = JSON.parse(String(invitation?.[1]?.body));
    expect(body).toMatchObject({ email: 'new@example.test', organization: 'deloitte' });
    expect(body).not.toHaveProperty('confirmationToken');
    expect(screen.queryByLabelText('Ligação de ativação')).toBeNull();
  });

  it('only retries eligible failed delivery, without reauthentication', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (url === '/api/session') return Response.json({ user, csrfToken: 'session-csrf' });
      if (url === '/api/users')
        return Response.json([{ ...user, disabled: false, mfaEnabled: true, organization: null }]);
      if (url === '/api/invitations') return Response.json([]);
      if (url === '/api/users/actor/deliveries')
        return Response.json(
          [
            { id: 'failed-mail', state: 'failed', attempts: 1 },
            { id: 'uncertain-mail', state: 'uncertain', attempts: 1 },
            { id: 'exhausted-mail', state: 'blocked', attempts: 5 },
            { id: 'delivered-mail', state: 'delivered', attempts: 1 },
          ].map((delivery) => ({
            ...delivery,
            kind: 'invite',
            error_code: null,
            created_at: '2026-01-01T00:00:00Z',
            delivered_at: null,
          })),
        );
      if (url === '/api/account/reauth')
        return Response.json({ confirmationToken: 'TEST-RETRY-ONLY' });
      if (url === '/api/users/actor/deliveries/failed-mail/retry' && options?.method === 'POST')
        return Response.json({ ok: true });
      return Response.json({}, { status: 404 });
    });
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <TeamPage />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ver entregas' }));
    await screen.findByText('Entrega incerta');
    expect(screen.getAllByRole('button', { name: 'Tentar envio novamente' })).toHaveLength(1);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Tentar envio novamente' })),
    );
    expect(fetch.mock.calls.some(([url]) => url === '/api/account/reauth')).toBe(false);
    const retry = fetch.mock.calls.find(
      ([url]) => url === '/api/users/actor/deliveries/failed-mail/retry',
    );
    expect(JSON.parse(String(retry?.[1]?.body))).toEqual({});
  });

  it.each(['pt-PT', 'en'])(
    'translates reauthentication rejection in %s and does not execute the action',
    async (locale) => {
      const onConfirm = vi.fn();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
        url === '/api/session'
          ? Response.json({ user, csrfToken: 'session-csrf' })
          : fail('invalid_credentials'),
      );
      function Form() {
        const { session } = useSession();
        return session ? (
          <>
            <LocalePicker />
            <ReauthDialog
              title="Sensitive action"
              action="invite"
              target="actor"
              onConfirm={onConfirm}
              onClose={() => {}}
            />
          </>
        ) : null;
      }
      render(
        <IdentityLocaleProvider>
          <SessionProvider>
            <Form />
          </SessionProvider>
        </IdentityLocaleProvider>,
      );
      const picker = await screen.findByLabelText('Idioma');
      fireEvent.change(picker, { target: { value: locale } });
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(
        within(dialog).getByLabelText(locale === 'en' ? 'Password' : 'Palavra-passe'),
        { target: { value: 'test-password-only' } },
      );
      fireEvent.change(
        within(dialog).getByLabelText(
          locale === 'en'
            ? 'MFA / recovery code (if enabled)'
            : 'Código MFA / recuperação (se ativo)',
        ),
        { target: { value: '000000' } },
      );
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: locale === 'en' ? 'Confirm action' : 'Confirmar ação',
        }),
      );
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toContain(
        locale === 'en' ? 'Unable to sign in.' : 'Não foi possível iniciar sessão.',
      );
      expect(alert.textContent).not.toContain('Texto de erro privado');
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );
});

describe('Account MFA', () => {
  it('shows one-time recovery codes before refreshing the session revoked by enrollment', async () => {
    let revoked = false;
    const client = {
      ...user,
      role: 'client',
      instanceAdmin: false,
      disabled: false,
      mfaEnabled: false,
      lockedUntil: null,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url === '/api/session')
        return revoked
          ? Response.json({}, { status: 401 })
          : Response.json({ user: client, csrfToken: 'session-csrf' });
      if (url === '/api/account') return Response.json(client);
      if (url === '/api/account/reauth')
        return Response.json({ confirmationToken: 'TEST-CONFIRM-ONLY' });
      if (url === '/api/account/mfa/start')
        return Response.json({ uri: 'otpauth://totp/Test?secret=TESTONLY', secret: 'TESTONLY' });
      if (url === '/api/account/mfa/confirm') {
        revoked = true;
        return Response.json({ recoveryCodes: ['TEST-RECOVERY-ONLY'] });
      }
      return Response.json({}, { status: 401 });
    });
    function Probe() {
      const { session } = useSession();
      return <output>{session ? 'local-session' : 'signed-out'}</output>;
    }
    render(
      <IdentityLocaleProvider>
        <SessionProvider>
          <AccountPage />
          <Probe />
        </SessionProvider>
      </IdentityLocaleProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Configurar MFA' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Palavra-passe'), {
      target: { value: 'test-password-only' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirmar ação' }));
    fireEvent.change(await screen.findByLabelText('Código da aplicação'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar inscrição' }));
    await screen.findByText('TEST-RECOVERY-ONLY');
    expect(screen.getByText('local-session')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardei os códigos. Continuar' }));
    await screen.findByText('signed-out');
    expect(screen.queryByText('TEST-RECOVERY-ONLY')).toBeNull();
  });
});
