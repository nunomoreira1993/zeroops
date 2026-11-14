import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IntegrationSetting } from '@zeroops/contracts';
import { IntegrationSettingsPanel } from '../src/features/integrations/IntegrationSettingsPanel';
import { IdentityLocaleProvider } from '../src/lib/identity';
import { SessionProvider } from '../src/lib/session';

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
});
const user = {
  id: 'root',
  projectId: 'project',
  displayName: 'Administrator',
  email: 'admin@example.test',
  role: 'admin',
  instanceAdmin: true,
  locale: 'pt-PT',
};
const saved: IntegrationSetting = {
  id: 'setting-1',
  scope: 'instance',
  environment: 'quality',
  kind: 'smtp',
  version: 1,
  status: 'draft',
  secretConfigured: true,
  testCode: null,
  testedAt: null,
  values: {
    host: 'smtp.example.test',
    port: 587,
    from: 'zeroops@example.test',
    username: 'service-user',
    secure: false,
    requireTLS: true,
    allowInsecureLoopback: false,
  },
};
function mount() {
  return render(
    <IdentityLocaleProvider>
      <SessionProvider>
        <IntegrationSettingsPanel />
      </SessionProvider>
    </IdentityLocaleProvider>,
  );
}

describe('Integration settings UI', () => {
  it('saves with the authenticated session without reauthentication, sends a new secret once and clears it after saving the redacted response', async () => {
    let stored = false;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (url === '/api/session') return Response.json({ user, csrfToken: 'test-csrf' });
      if (url === '/api/integration-settings' && options?.method === 'POST') {
        stored = true;
        return Response.json(saved);
      }
      if (url === '/api/integration-settings') return Response.json(stored ? [saved] : []);
      return Response.json({}, { status: 404 });
    });
    mount();
    fireEvent.change(await screen.findByLabelText('Servidor SMTP'), {
      target: { value: saved.values.host },
    });
    fireEvent.change(screen.getByLabelText('Remetente'), { target: { value: saved.values.from } });
    fireEvent.change(screen.getByLabelText('Utilizador SMTP (opcional)'), {
      target: { value: saved.values.username },
    });
    fireEvent.change(screen.getByLabelText('Nova palavra-passe SMTP'), {
      target: { value: 'TEST-NEW-SECRET-ONLY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar / rodar credencial' }));
    await screen.findByText('Configuração atualizada e operação auditada.');
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Nova palavra-passe SMTP').value).toBe(''),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetch.mock.calls.some(([url]) => url === '/api/account/reauth')).toBe(false);
    const write = fetch.mock.calls.find(
      ([url, options]) => url === '/api/integration-settings' && options?.method === 'POST',
    );
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      scope: 'instance',
      environment: 'quality',
      expectedVersion: 0,
      values: { kind: 'smtp', password: 'TEST-NEW-SECRET-ONLY' },
    });
    expect(JSON.parse(String(write?.[1]?.body))).not.toHaveProperty('confirmationToken');
    expect(document.body.textContent).not.toContain('TEST-NEW-SECRET-ONLY');
    expect(screen.queryByText('Ligação verificada. Isto não ativa GenOps.')).toBeNull();
  });

  it('shows the Quality/Production switch only for environment-scoped integrations', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      if (url === '/api/session') return Response.json({ user, csrfToken: 'test-csrf' });
      if (url === '/api/integration-settings' && options?.method === 'POST')
        return Response.json({ ...saved, kind: 'database', scope: 'project' });
      if (url === '/api/integration-settings') return Response.json([]);
      return Response.json({}, { status: 404 });
    });
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: /Copilot/ }));
    expect(screen.queryByRole('button', { name: 'Produção' })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Sandbox/ })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Base de dados/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Produção' }));
    fireEvent.change(screen.getByLabelText('Servidor de dados'), { target: { value: '10.0.0.5' } });
    fireEvent.change(screen.getByLabelText('Base de dados'), { target: { value: 'site' } });
    fireEvent.change(screen.getByLabelText('Utilizador (o conector só executa leituras)'), {
      target: { value: 'reader' },
    });
    fireEvent.change(screen.getByLabelText('Nova palavra-passe'), {
      target: { value: 'TEST-DB-SECRET-ONLY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar / rodar credencial' }));
    await screen.findByText('Configuração atualizada e operação auditada.');
    const write = fetch.mock.calls.find(
      ([url, options]) => url === '/api/integration-settings' && options?.method === 'POST',
    );
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      scope: 'project',
      environment: 'production',
      values: { kind: 'database', host: '10.0.0.5', database: 'site' },
    });
  });
});
