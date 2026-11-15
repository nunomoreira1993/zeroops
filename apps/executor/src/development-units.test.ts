import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { gitEnvironment } from '../../../packages/backend/src/modules/development/git.js';
import { GithubPullRequestProvider, PullRequestError } from './pr-providers.js';
import { parseNameStatus } from './workspace-manager.js';

describe('gitEnvironment', () => {
  it('declara safe.directory na config global isolada (o upload-pack local ignora -c)', () => {
    const env = gitEnvironment();
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8')).toMatch(/\[safe\]\s+directory = \*/);
  });
});

describe('parseNameStatus', () => {
  it('interpreta adições, alterações, remoções, renomeações e cópias', () => {
    const raw = [
      'A',
      'novo.js',
      'M',
      'app.js',
      'D',
      'old.txt',
      'R087',
      'a.js',
      'b.js',
      'C100',
      'x.js',
      'y.js',
      '',
    ].join('\0');
    expect(parseNameStatus(raw)).toEqual([
      { status: 'A', path: 'novo.js' },
      { status: 'M', path: 'app.js' },
      { status: 'D', path: 'old.txt' },
      { status: 'R', path: 'b.js', previousPath: 'a.js' },
      { status: 'A', path: 'y.js' },
    ]);
  });
});

describe('GithubPullRequestProvider', () => {
  const request = {
    repositoryUrl: 'https://github.com/acme/sandbox.git',
    credential: 'token-de-teste',
    head: 'zeroops/t-1',
    base: 'main',
    title: 'T-1',
    body: 'corpo',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('reutiliza o PR aberto da branch sem criar outro', async () => {
    const fetchImpl = vi.fn(async () => json([{ number: 7, html_url: 'https://x/7' }]));
    const result = await new GithubPullRequestProvider(fetchImpl as typeof fetch).ensure(request);
    expect(result).toEqual({ number: 7, url: 'https://x/7' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain(
      'head=acme%3Azeroops%2Ft-1',
    );
  });

  it('cria quando não existe PR aberto', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ number: 8, html_url: 'https://x/8' }, 201));
    const result = await new GithubPullRequestProvider(fetchImpl as typeof fetch).ensure(request);
    expect(result.number).toBe(8);
    expect(fetchImpl.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
  });

  it('distingue resultado incerto (rede/5xx) de recusa definitiva (4xx)', async () => {
    const network = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      new GithubPullRequestProvider(network as typeof fetch).ensure(request),
    ).rejects.toMatchObject({ uncertain: true });
    const server = vi.fn(async () => json({}, 502));
    await expect(
      new GithubPullRequestProvider(server as typeof fetch).ensure(request),
    ).rejects.toMatchObject({ uncertain: true });
    const denied = vi.fn(async () => json({}, 403));
    await expect(
      new GithubPullRequestProvider(denied as typeof fetch).ensure(request),
    ).rejects.toMatchObject({ uncertain: false });
  });

  it('recusa hosts não suportados e ausência de credencial sem chamar a API', async () => {
    const fetchImpl = vi.fn();
    const provider = new GithubPullRequestProvider(fetchImpl as typeof fetch);
    await expect(
      provider.ensure({ ...request, repositoryUrl: 'https://gitlab.com/a/b.git' }),
    ).rejects.toBeInstanceOf(PullRequestError);
    await expect(provider.ensure({ ...request, credential: null })).rejects.toBeInstanceOf(
      PullRequestError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
