import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectGitHubCliCredential } from './github-cli-credential.js';

const token = `gho_${'a'.repeat(36)}`;
const repositoryUrl = 'https://github.com/Deloitte-Portugal/pizzahut.git';

afterEach(() => vi.unstubAllGlobals());

describe('inspectGitHubCliCredential', () => {
  it('checks identity, repository permissions and OAuth scopes without writing', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ login: 'numoreira_deloitte', id: 123, type: 'User' }), {
          status: 200,
          headers: { 'x-oauth-scopes': 'repo, read:org' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            permissions: {
              admin: true,
              maintain: true,
              pull: true,
              push: true,
              triage: true,
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetch);

    await expect(inspectGitHubCliCredential(repositoryUrl, token)).resolves.toEqual({
      login: 'numoreira_deloitte',
      accountId: 123,
      accountType: 'User',
      scopes: ['read:org', 'repo'],
      permissions: { admin: true, maintain: true, pull: true, push: true, triage: true },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/user',
      'https://api.github.com/repos/Deloitte-Portugal/pizzahut',
    ]);
    expect(fetch.mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);
  });

  it('reports revoked or expired credentials without including the credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));

    await expect(inspectGitHubCliCredential(repositoryUrl, token)).rejects.toThrow(
      'GitHub rejected the credential (HTTP 401); it may be revoked or expired.',
    );
  });

  it('surfaces organization authorization failures without exposing response bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private response body', { status: 403 })),
    );

    await expect(inspectGitHubCliCredential(repositoryUrl, token)).rejects.toThrow(
      'GitHub denied access to the authenticated account (HTTP 403); check organization authorization and repository permissions.',
    );
  });

  it('rejects credentials without repository read/write access', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ login: 'user', id: 123, type: 'User' }), {
          status: 200,
          headers: { 'x-oauth-scopes': 'repo' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ permissions: { pull: true } }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetch);

    await expect(inspectGitHubCliCredential(repositoryUrl, token)).rejects.toThrow(
      'The authenticated account needs read and write access to the repository.',
    );
  });

  it('does not send credentials to non-GitHub hosts', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      inspectGitHubCliCredential('https://example.com/org/repo.git', token),
    ).rejects.toThrow('GitHub CLI credentials are supported only for github.com repositories.');
    expect(fetch).not.toHaveBeenCalled();
  });
});
