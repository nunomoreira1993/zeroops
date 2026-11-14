import { useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/ui';
import { api } from '../../lib/api';
import {
  LocalePicker,
  useIdentityLocale,
  useIdentityMutation,
  type SecretLink,
} from '../../lib/identity';
import { useSession, type AuthenticationResponse } from '../../lib/session';
import { CodeField, Enrollment, PasswordFields } from './IdentityForms';

export function AuthPage({
  link,
  onConsumed,
}: {
  link: SecretLink | null;
  onConsumed: () => void;
}) {
  const {
    authenticate,
    challenge,
    challengeRequest,
    completeAuthentication,
    error: sessionError,
    refresh,
  } = useSession();
  const { t, locale } = useIdentityLocale();
  const [mode, setMode] = useState<'login' | 'recover' | SecretLink['kind']>(link?.kind ?? 'login');
  const [enrollment, setEnrollment] = useState<{ uri: string; secret: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const mutation = useIdentityMutation();
  const stage = challenge?.status;
  const changeMode = (next: 'login' | 'recover') => {
    onConsumed();
    setMode(next);
    setMessage(null);
    setMismatch(false);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get('password') ?? '');
    if (['invite', 'reset'].includes(mode) && !stage && password !== data.get('confirmPassword')) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    void mutation.run(async () => {
      if (stage) {
        completeAuthentication(
          await challengeRequest<AuthenticationResponse>(
            stage === 'mfa_required' ? '/auth/challenge' : '/auth/enrollment/confirm',
            { code: data.get('code') },
          ),
        );
        setEnrollment(null);
        onConsumed();
      } else if (mode === 'login' || mode === 'invite') {
        await authenticate(
          mode === 'invite' ? 'activate' : 'login',
          mode === 'invite'
            ? {
                token: link?.token ?? '',
                password,
                displayName: String(data.get('displayName') ?? ''),
              }
            : { email: String(data.get('email') ?? ''), password },
        );
        onConsumed();
        setMode('login');
      } else if (mode === 'recover') {
        await api('/auth/reset/request', {
          method: 'POST',
          body: { email: data.get('email'), locale },
        });
        setMessage(
          t(
            'Se o endereço permitir recuperação, receberá instruções por email. Verifique também o spam.',
            'If the address is eligible, recovery instructions will be emailed. Check your spam folder too.',
          ),
        );
      } else if (mode === 'mfa-reset') {
        completeAuthentication(
          await api<AuthenticationResponse>('/auth/mfa-reset/confirm', {
            method: 'POST',
            body: { token: link?.token ?? '', email: data.get('email'), password },
          }),
        );
        onConsumed();
        setMode('login');
      } else {
        await api(mode === 'email' ? '/auth/email/confirm' : '/auth/reset/confirm', {
          method: 'POST',
          body: { token: link?.token ?? '', ...(mode === 'reset' ? { password } : {}) },
        });
        setMessage(
          mode === 'email'
            ? t('Email confirmado. Inicie sessão.', 'Email confirmed. Sign in.')
            : t(
                'Palavra-passe reposta. Inicie sessão; o MFA continua obrigatório quando aplicável.',
                'Password reset. Sign in; MFA is still required where applicable.',
              ),
        );
        onConsumed();
      }
      form.reset();
    });
  };
  const title =
    stage === 'mfa_required'
      ? t('Verificar a sua identidade', 'Verify your identity')
      : stage === 'enrollment_required'
        ? t('Configurar autenticação MFA', 'Set up MFA')
        : mode === 'invite'
          ? t('Ativar o seu acesso', 'Activate your access')
          : mode === 'recover'
            ? t('Recuperar palavra-passe', 'Recover password')
            : mode === 'reset'
              ? t('Repor palavra-passe', 'Reset password')
              : mode === 'email'
                ? t('Confirmar novo email', 'Confirm new email')
                : mode === 'mfa-reset'
                  ? t('Reposição de MFA', 'MFA reset')
                  : t('Iniciar sessão', 'Sign in');
  return (
    <main className="auth-layout">
      <section className="auth-form-side">
        <div className="kt-card auth-card">
          <div className="kt-card-content stack">
            <div className="auth-card-head">
              <span className="brand-symbol">
                <Icon name="pulse" size={20} />
              </span>
              <h1>{title}</h1>
              <p>{t('Pizza Hut · Portal de manutenção', 'Pizza Hut · Maintenance portal')}</p>
            </div>
            <LocalePicker />
            {sessionError && (
              <Notice tone="warning">
                {t('Não foi possível validar a sessão.', 'Unable to validate the session.')}{' '}
                <button className="text-button" onClick={() => void refresh()}>
                  {t('Tentar novamente', 'Retry')}
                </button>
              </Notice>
            )}
            {mutation.error && <Notice>{mutation.error}</Notice>}
            {mismatch && (
              <Notice>{t('As palavras-passe não coincidem.', 'Passwords do not match.')}</Notice>
            )}
            {message ? (
              <>
                <Notice tone="success">{message}</Notice>
                <button className="kt-btn kt-btn-outline" onClick={() => changeMode('login')}>
                  {t('Iniciar sessão', 'Sign in')}
                </button>
              </>
            ) : (
              <>
                {stage === 'enrollment_required' && !enrollment ? (
                  <button
                    className="kt-btn kt-btn-primary"
                    disabled={mutation.busy}
                    onClick={() =>
                      void mutation.run(async () => {
                        setEnrollment(await challengeRequest('/auth/enrollment', {}));
                      })
                    }
                  >
                    {t('Obter QR e chave de configuração', 'Get QR and setup key')}
                  </button>
                ) : (
                  <form className="stack auth-form" onSubmit={submit}>
                    {stage ? (
                      <>
                        {enrollment && <Enrollment {...enrollment} />}
                        <CodeField recovery={stage === 'mfa_required'} />
                      </>
                    ) : (
                      <>
                        {mode === 'invite' && (
                          <label>
                            {t('O seu nome', 'Your name')}
                            <input
                              name="displayName"
                              autoComplete="name"
                              required
                              maxLength={160}
                            />
                          </label>
                        )}
                        {['login', 'recover', 'mfa-reset'].includes(mode) && (
                          <label>
                            Email
                            <input
                              name="email"
                              type="email"
                              autoComplete="username"
                              required
                              maxLength={254}
                            />
                          </label>
                        )}
                        {!['recover', 'email'].includes(mode) && (
                          <PasswordFields
                            current={mode === 'login' || mode === 'mfa-reset'}
                            confirm={mode === 'invite' || mode === 'reset'}
                          />
                        )}
                        {mode === 'email' && (
                          <p>
                            {t(
                              'Confirme a alteração solicitada. O novo email será usado no próximo início de sessão.',
                              'Confirm the requested change. The new email will be used on your next sign-in.',
                            )}
                          </p>
                        )}
                      </>
                    )}
                    <button className="kt-btn kt-btn-primary w-full" disabled={mutation.busy}>
                      {mutation.busy ? t('A validar…', 'Validating…') : t('Continuar', 'Continue')}
                      <Icon name="arrow" size={16} />
                    </button>
                  </form>
                )}
                {!stage && (
                  <div className="auth-help">
                    <button
                      className="text-button"
                      disabled={mutation.busy}
                      onClick={() => changeMode(mode === 'login' ? 'recover' : 'login')}
                    >
                      {mode === 'login'
                        ? t('Esqueceu-se da palavra-passe?', 'Forgot your password?')
                        : t('Voltar ao início de sessão', 'Back to sign in')}
                    </button>
                  </div>
                )}
                {stage && (
                  <>
                    <p className="field-hint">
                      {t(
                        'Não consegue usar o MFA? Utilize um código de recuperação ou contacte o administrador para verificar a sua identidade.',
                        'Cannot use MFA? Use a recovery code or contact your administrator to verify your identity.',
                      )}
                    </p>
                    <button
                      className="text-button"
                      disabled={mutation.busy}
                      onClick={() => void refresh()}
                    >
                      {t('Verificar validade do desafio', 'Check challenge validity')}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </section>
      <section className="auth-story" aria-label="ZeroOps">
        <a className="brand brand-large" href="#dashboard">
          <span className="brand-symbol">
            <Icon name="pulse" size={22} />
          </span>
          <span>
            zero<span className="brand-light">ops</span>
          </span>
        </a>
        <div className="auth-story-content">
          <h2>{t('Portal de manutenção', 'Maintenance portal')}</h2>
          <p>
            {t(
              'Pedidos, propostas, aprovações e publicação das plataformas Pizza Hut e Pizza Movil num só sítio.',
              'Requests, proposals, approvals and releases for the Pizza Hut platform in one place.',
            )}
          </p>
        </div>
        <div className="auth-footer">
          <Icon name="shield" size={16} />
          {t('Acesso apenas por convite.', 'Invitation-only access.')}
        </div>
      </section>
    </main>
  );
}
