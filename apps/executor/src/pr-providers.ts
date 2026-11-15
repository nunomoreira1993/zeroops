/** Pedido de criação/atualização idempotente de um PR para a branch de trabalho. */
export interface PullRequestRequest {
  repositoryUrl: string;
  credential: string | null;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export class PullRequestError extends Error {
  constructor(
    message: string,
    /** Falha de rede ou resposta 5xx: o PR pode ter sido criado (reconciliar antes de repetir). */
    readonly uncertain: boolean,
  ) {
    super(message);
    this.name = 'PullRequestError';
  }
}

export interface PullRequestProvider {
  /** Devolve o PR aberto da branch ou cria-o; repetir nunca cria um segundo PR. */
  ensure(request: PullRequestRequest): Promise<PullRequestResult>;
}

/** `https://github.com/<owner>/<repo>(.git)` → owner/repo (outros hosts não são suportados). */
export function githubRepository(url: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
    url,
  );
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/**
 * PR no GitHub via REST: procura primeiro um PR aberto da mesma branch (idempotência e
 * reconciliação após resultado incerto) e só depois cria. Nunca faz merge.
 */
export class GithubPullRequestProvider implements PullRequestProvider {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiUrl = 'https://api.github.com',
  ) {}

  async ensure(request: PullRequestRequest): Promise<PullRequestResult> {
    const target = githubRepository(request.repositoryUrl);
    if (!target) throw new PullRequestError('Repositório GitHub não reconhecido.', false);
    if (!request.credential) throw new PullRequestError('Sem credencial para criar o PR.', false);
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${request.credential}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'zeroops',
    };
    const base = `${this.apiUrl}/repos/${target.owner}/${target.repo}/pulls`;
    const call = async (url: string, init: RequestInit = {}) => {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new PullRequestError('Falha de rede ao contactar o GitHub.', true);
      }
      if (!response.ok)
        throw new PullRequestError(
          `GitHub respondeu ${response.status}.`,
          response.status >= 500 || response.status === 429,
        );
      return response.json() as Promise<unknown>;
    };
    const existing = (await call(
      `${base}?state=open&head=${encodeURIComponent(`${target.owner}:${request.head}`)}`,
    )) as { number: number; html_url: string }[];
    const open = Array.isArray(existing) ? existing[0] : undefined;
    if (open) return { number: open.number, url: open.html_url };
    const created = (await call(base, {
      method: 'POST',
      body: JSON.stringify({
        title: request.title,
        head: request.head,
        base: request.base,
        body: request.body,
      }),
    })) as { number: number; html_url: string };
    return { number: created.number, url: created.html_url };
  }
}
