export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(message: string, status: number, code: string, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(
  path: string,
  options: RequestOptions = {},
  csrfToken?: string,
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    if (
      !csrfToken &&
      ![
        '/auth/login',
        '/auth/activate',
        '/auth/reset/request',
        '/auth/reset/confirm',
        '/auth/email/confirm',
        '/auth/mfa-reset/confirm',
      ].includes(path)
    ) {
      throw new ApiError('Inicie sessão novamente para confirmar esta ação.', 401, 'CSRF_MISSING');
    }
    headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError(
      'Não foi possível contactar o serviço. Verifique a ligação e tente novamente.',
      0,
      'NETWORK_ERROR',
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
    const details = error && typeof error === 'object' ? error : {};
    throw new ApiError(
      'message' in details && typeof details.message === 'string'
        ? details.message
        : response.status === 401
          ? 'A sessão terminou. Inicie sessão novamente.'
          : 'Não foi possível concluir o pedido. Tente novamente.',
      response.status,
      'code' in details && typeof details.code === 'string' ? details.code : 'REQUEST_FAILED',
      'requestId' in details && typeof details.requestId === 'string'
        ? details.requestId
        : undefined,
    );
  }
  return payload as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}${error.requestId ? ` · Referência: ${error.requestId}` : ''}`;
  }
  return error instanceof Error ? error.message : 'Ocorreu um erro inesperado.';
}
