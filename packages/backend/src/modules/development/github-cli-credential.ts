export interface GitHubRepositoryPermissions {
  admin: boolean;
  maintain: boolean;
  pull: boolean;
  push: boolean;
  triage: boolean;
}

export interface GitHubCliCredentialInfo {
  login: string;
  accountId: number;
  accountType: string;
  scopes: string[];
  permissions: GitHubRepositoryPermissions;
}

export class GitHubCliCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubCliCredentialError';
  }
}

const credentialError = (message: string) => new GitHubCliCredentialError(message);

function repositorySlug(repositoryUrl: string) {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw credentialError('GitHub CLI credentials require a valid HTTPS repository URL.');
  }
  const parts = url.pathname
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 2
  )
    throw credentialError('GitHub CLI credentials are supported only for github.com repositories.');
  return parts.map(encodeURIComponent).join('/');
}

function httpFailure(status: number, resource: string) {
  if (status === 401)
    return credentialError(
      'GitHub rejected the credential (HTTP 401); it may be revoked or expired. Authenticate again with GitHub CLI.',
    );
  if (status === 403)
    return credentialError(
      `GitHub denied access to ${resource} (HTTP 403); check organization authorization and repository permissions.`,
    );
  if (status === 404)
    return credentialError(
      `GitHub could not find ${resource} for the authenticated account (HTTP 404).`,
    );
  return credentialError(`GitHub request for ${resource} failed (HTTP ${status}).`);
}

async function githubGet(path: string, token: string, resource: string) {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ZeroOps',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw credentialError(`Could not contact GitHub while checking ${resource}.`);
  }
  if (!response.ok) throw httpFailure(response.status, resource);
  return response;
}

/** Validates the GitHub CLI credential without performing any write operation. */
export async function inspectGitHubCliCredential(
  repositoryUrl: string,
  token: string,
): Promise<GitHubCliCredentialInfo> {
  if (token.length < 20 || token.length > 500 || !/^[\x21-\x7e]+$/.test(token))
    throw credentialError('GitHub CLI returned an invalid credential value.');
  const slug = repositorySlug(repositoryUrl);
  const userResponse = await githubGet('/user', token, 'the authenticated account');
  const user = (await userResponse.json()) as {
    login?: unknown;
    id?: unknown;
    type?: unknown;
  };
  if (
    typeof user.login !== 'string' ||
    typeof user.id !== 'number' ||
    typeof user.type !== 'string'
  )
    throw credentialError('GitHub returned an incomplete authenticated account identity.');

  const repositoryResponse = await githubGet(`/repos/${slug}`, token, 'the repository');
  const repository = (await repositoryResponse.json()) as {
    permissions?: Partial<GitHubRepositoryPermissions>;
  };
  const permissions: GitHubRepositoryPermissions = {
    admin: repository.permissions?.admin === true,
    maintain: repository.permissions?.maintain === true,
    pull: repository.permissions?.pull === true,
    push: repository.permissions?.push === true,
    triage: repository.permissions?.triage === true,
  };
  const scopes = (userResponse.headers.get('x-oauth-scopes') ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
    .sort();
  if (!permissions.pull || !permissions.push)
    throw credentialError(
      'The authenticated account needs read and write access to the repository.',
    );
  if (!scopes.includes('repo'))
    throw credentialError(
      'The GitHub CLI credential lacks the repo scope required for pull requests.',
    );

  return {
    login: user.login,
    accountId: user.id,
    accountType: user.type,
    scopes,
    permissions,
  };
}
