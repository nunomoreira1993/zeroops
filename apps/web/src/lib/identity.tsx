import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export type Locale = 'pt-PT' | 'en';
const LocaleContext = createContext({
  locale: 'pt-PT' as Locale,
  setLocale: (_locale: Locale) => {},
});

export function IdentityLocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('pt-PT');
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

export function useIdentityLocale() {
  const context = useContext(LocaleContext);
  return { ...context, t: (pt: string, en: string) => (context.locale === 'en' ? en : pt) };
}

export function LocalePicker() {
  const { locale, setLocale, t } = useIdentityLocale();
  return (
    <label>
      {t('Idioma', 'Language')}
      <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
        <option value="pt-PT">Português (Portugal)</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}

export function useIdentityMutation() {
  const { t } = useIdentityLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      const messages: Record<string, [string, string]> = {
        invalid_credentials: [
          'Não foi possível iniciar sessão. Verifique os dados ou tente novamente mais tarde.',
          'Unable to sign in. Check your details or try again later.',
        ],
        invalid_mfa_code: [
          'O código não é válido. Utilize um código atual ou um código de recuperação não utilizado.',
          'The code is not valid. Use a current code or an unused recovery code.',
        ],
        mfa_invalid: [
          'O código não é válido. Utilize um código atual ou um código de recuperação não utilizado.',
          'The code is not valid. Use a current code or an unused recovery code.',
        ],
        challenge_expired: [
          'O desafio expirou. Inicie sessão novamente.',
          'The challenge expired. Sign in again.',
        ],
        invalid_token: [
          'A ligação não é válida ou expirou. Solicite uma nova ligação.',
          'The link is invalid or expired. Request a new link.',
        ],
        token_expired: [
          'A ligação não é válida ou expirou. Solicite uma nova ligação.',
          'The link is invalid or expired. Request a new link.',
        ],
        last_admin: [
          'Tem de permanecer pelo menos um administrador ativo.',
          'At least one active administrator must remain.',
        ],
        last_active_admin: [
          'Tem de permanecer pelo menos um administrador ativo.',
          'At least one active administrator must remain.',
        ],
        mfa_required: [
          'É necessária autenticação multifator para esta ação.',
          'Multi-factor authentication is required for this action.',
        ],
        reauthentication_required: [
          'Confirme novamente a sua identidade para esta ação.',
          'Confirm your identity again for this action.',
        ],
        forbidden: [
          'Não tem permissão para executar esta ação.',
          'You do not have permission to perform this action.',
        ],
        validation_error: [
          'Verifique os campos do formulário e tente novamente.',
          'Check the form fields and try again.',
        ],
        email_in_use: [
          'Não foi possível utilizar este endereço de email.',
          'This email address cannot be used.',
        ],
        network_error: [
          'Não foi possível contactar o serviço. Verifique a ligação.',
          'Unable to contact the service. Check your connection.',
        ],
      };
      const translated = cause instanceof ApiError ? messages[cause.code.toLowerCase()] : undefined;
      const message =
        cause instanceof ApiError && cause.status === 503
          ? t(
              'Serviço indisponível. O pedido não foi confirmado. Tente mais tarde.',
              'Service unavailable. The request was not confirmed. Try again later.',
            )
          : cause instanceof ApiError && cause.status === 429
            ? t(
                'Demasiadas tentativas. Aguarde antes de tentar novamente.',
                'Too many attempts. Wait before trying again.',
              )
            : translated
              ? t(...translated)
              : t(
                  'Não foi possível concluir o pedido. Verifique os dados e tente novamente.',
                  'Unable to complete the request. Check the details and try again.',
                );
      setError(
        message + (cause instanceof ApiError && cause.requestId ? ` (${cause.requestId})` : ''),
      );
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export interface SecretLink {
  kind: 'invite' | 'reset' | 'email' | 'mfa-reset';
  token: string;
}
export function consumeSecretLink(): SecretLink | null {
  const url = new URL(window.location.href);
  let link: SecretLink | null = null;
  for (const kind of ['invite', 'reset', 'email', 'mfa-reset'] as const) {
    const token = url.searchParams.get(kind);
    if (token && !link) link = { kind, token };
    url.searchParams.delete(kind);
  }
  // Support token links using the hash route, without keeping a secret in history.
  const token = url.searchParams.get('token');
  const route = url.hash.replace(/^#\/?/, '').replace(/^auth\//, '');
  if (!link && token && ['activate', 'reset', 'email', 'mfa-reset'].includes(route)) {
    link = { kind: route === 'activate' ? 'invite' : (route as SecretLink['kind']), token };
  }
  url.searchParams.delete('token');
  const fragment = new URLSearchParams(url.hash.slice(1));
  const fragmentToken = fragment.get('token');
  const paths: Record<string, SecretLink['kind']> = {
    '/activate': 'invite',
    '/reset-password': 'reset',
    '/verify-email': 'email',
    '/mfa-reset': 'mfa-reset',
  };
  const pathKind = paths[url.pathname];
  if (!link && token && pathKind) link = { kind: pathKind, token };
  if (fragmentToken) {
    if (pathKind) link = { kind: pathKind, token: fragmentToken };
    url.hash = '';
  }
  window.history.replaceState(null, '', url);
  return link;
}
