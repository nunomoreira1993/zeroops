import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { SessionResponse } from '@zeroops/contracts';
import { api, ApiError, errorMessage, type RequestOptions } from './api';

export type AuthenticationResponse =
  | (SessionResponse & { status: 'authenticated'; recoveryCodes?: string[] })
  | { status: 'mfa_required' | 'enrollment_required'; csrfToken: string };
type Challenge = Extract<
  AuthenticationResponse,
  { status: 'mfa_required' | 'enrollment_required' }
>;

interface SessionContextValue {
  session: SessionResponse | null;
  challenge: Challenge | null;
  recoveryCodes: string[] | null;
  dismissRecoveryCodes: () => void;
  completeAuthentication: (response: AuthenticationResponse) => void;
  challengeRequest: <T>(path: string, body: unknown) => Promise<T>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  authenticate: (mode: 'login' | 'activate', values: Record<string, string>) => Promise<void>;
  logout: () => Promise<void>;
  request: <T>(path: string, options?: RequestOptions) => Promise<T>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSession(await api<SessionResponse>('/session'));
      setChallenge(null);
    } catch (cause) {
      setSession(null);
      if (cause instanceof ApiError && cause.status === 401) {
        try {
          setChallenge(await api<Challenge>('/auth/challenge'));
        } catch {
          setChallenge(null);
        }
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setLoading(false);
    }
  }, []);
  const completeAuthentication = useCallback((response: AuthenticationResponse) => {
    setError(null);
    if (response.status === 'authenticated') {
      setSession({ user: response.user, csrfToken: response.csrfToken });
      setChallenge(null);
      setRecoveryCodes(response.recoveryCodes ?? null);
    } else {
      setSession(null);
      setChallenge(response);
    }
  }, []);
  const challengeRequest = useCallback(
    <T,>(path: string, body: unknown) =>
      api<T>(path, { method: 'POST', body }, challenge?.csrfToken),
    [challenge?.csrfToken],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const request = useCallback(
    async <T,>(path: string, options?: RequestOptions): Promise<T> => {
      try {
        return await api<T>(path, options, session?.csrfToken);
      } catch (cause) {
        const rejectedReauthentication =
          (path === '/account/reauth' || /^\/project-admin\/[^/]+\/account\/reauth$/.test(path)) &&
          cause instanceof ApiError &&
          [
            'invalid_credentials',
            'invalid_mfa_code',
            'mfa_invalid',
            'reauthentication_failed',
          ].includes(cause.code.toLowerCase());
        if (cause instanceof ApiError && cause.status === 401 && !rejectedReauthentication) {
          setSession(null);
          setError('A sessão terminou. Inicie sessão novamente para continuar.');
        }
        throw cause;
      }
    },
    [session?.csrfToken],
  );
  const authenticate = useCallback(
    async (mode: 'login' | 'activate', values: Record<string, string>) => {
      completeAuthentication(
        await api<AuthenticationResponse>(`/auth/${mode}`, { method: 'POST', body: values }),
      );
    },
    [completeAuthentication],
  );
  const logout = useCallback(async () => {
    await request('/auth/logout', { method: 'POST', body: {} });
    setSession(null);
    setChallenge(null);
    setRecoveryCodes(null);
    setError(null);
  }, [request]);
  const value = useMemo(
    () => ({
      session,
      challenge,
      recoveryCodes,
      dismissRecoveryCodes: () => setRecoveryCodes(null),
      completeAuthentication,
      challengeRequest,
      loading,
      error,
      refresh,
      authenticate,
      logout,
      request,
    }),
    [
      session,
      challenge,
      recoveryCodes,
      completeAuthentication,
      challengeRequest,
      loading,
      error,
      refresh,
      authenticate,
      logout,
      request,
    ],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('Contexto de sessão indisponível.');
  return context;
}
