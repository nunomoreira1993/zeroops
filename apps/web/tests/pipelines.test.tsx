import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitRepositoryView } from '@zeroops/contracts';
import { PipelinesPage } from '../src/features/projects/PipelinesPage';
import { IdentityLocaleProvider } from '../src/lib/identity';
import { ProjectAdminProvider } from '../src/lib/project-admin';
import { SessionProvider } from '../src/lib/session';

vi.mock('../src/features/flows/CapabilityDevelopmentPanel', () => ({
  CapabilitySettingsCard: () => null,
}));

const project = { id: 'project', name: 'Projeto', archived: false, logoVersion: null };
const repository: GitRepositoryView = {
  id: 'repo',
  projectId: project.id,
  name: 'Site',
  url: 'https://github.com/example/site.git',
  baseBranch: 'main',
  allowedRefs: ['main'],
  setupCommands: [],
  testCommands: [],
  prProvider: 'zeroops',
  hasCredential: false,
  credentialProvider: 'token',
  credentialIdentity: null,
  version: 1,
  archived: false,
  verifiedAt: null,
  verifiedBaseSha: null,
  verificationError: null,
  updatedAt: '2026-01-01T00:00:00Z',
};

function mount() {
  return render(
    <IdentityLocaleProvider>
      <SessionProvider>
        <ProjectAdminProvider project={project}>
          <PipelinesPage projectId={project.id} />
        </ProjectAdminProvider>
      </SessionProvider>
    </IdentityLocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PipelinesPage resource target', () => {
  it('sends a trimmed targetKey when creating a pipeline', async () => {
    let submitted: Record<string, unknown> | null = null;
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input);
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/session')
        return Response.json({
          user: {
            id: 'admin',
            projectId: project.id,
            role: 'admin',
            displayName: 'Admin',
          },
          csrfToken: 'csrf',
        });
      if (path.endsWith('/git-repositories')) return Response.json([repository]);
      if (path.endsWith('/pipelines') && init?.method === 'POST') {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({});
      }
      if (path.endsWith('/pipelines')) return Response.json([]);
      return Response.json({}, { status: 404 });
    });

    mount();
    await screen.findByText('Ainda não há pipelines.');
    await waitFor(() => expect(calls).toContain('GET /api/session'));
    fireEvent.click(await screen.findByRole('button', { name: 'Nova pipeline' }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'QA' } });
    fireEvent.change(screen.getByLabelText('Endpoint do fornecedor'), {
      target: { value: 'https://ci.example.test/deploy' },
    });
    fireEvent.change(screen.getByLabelText(/Identificador do recurso real/), {
      target: { value: '  qa.pizzahut.pt  ' },
    });
    fireEvent.change(screen.getByLabelText('Segredo HMAC partilhado (mín. 32 caracteres)'), {
      target: { value: 'segredo-de-testes-com-pelo-menos-32-caracteres' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Pipeline de entrega' }));

    await waitFor(() => expect(submitted).not.toBeNull(), {
      onTimeout: (error) => {
        error.message += `\nFetch calls: ${calls.join(', ')}`;
        return error;
      },
    });
    expect(submitted).toMatchObject({
      name: 'QA',
      targetKey: 'qa.pizzahut.pt',
      environment: 'quality',
    });
  });
});
