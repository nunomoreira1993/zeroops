import { useState } from 'react';
import type { ManagedUser } from '@zeroops/contracts';
import { Loading, Notice, PageHeader } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale, useIdentityMutation, type Locale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { AvatarField } from './AvatarField';
import {
  CodeField,
  Enrollment,
  PasswordFields,
  ReauthDialog,
  RecoveryCodes,
} from '../auth/IdentityForms';

export type ManagedAccount = ManagedUser;

export function AccountPage() {
  const account = useResource<ManagedAccount>('/account');
  const { request, session, refresh } = useSession();
  const { t, locale, setLocale } = useIdentityLocale();
  const mutation = useIdentityMutation();
  const [pending, setPending] = useState<{
    action: string;
    operation: (token: string) => Promise<void>;
  } | null>(null);
  const [enrollment, setEnrollment] = useState<{ uri: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mustSignIn, setMustSignIn] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  if (account.loading) return <Loading label={t('A carregar conta…', 'Loading account…')} />;
  if (account.error || !account.data)
    return (
      <Notice>
        {t('Não foi possível carregar a conta.', 'Unable to load the account.')}{' '}
        <button className="text-button" onClick={account.reload}>
          {t('Tentar novamente', 'Retry')}
        </button>
      </Notice>
    );
  const user = account.data;
  if (codes)
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setCodes(null);
          if (mustSignIn) void refresh();
        }}
      />
    );
  const sensitive = (action: string, operation: (token: string) => Promise<void>) => {
    setMessage(null);
    setPending({ action, operation });
  };
  const simpleOperation = (action: string, path: string) =>
    sensitive(action, async (confirmationToken) => {
      await request(path, { method: 'POST', body: { confirmationToken } });
      if (action === 'sessions' || action === 'mfa-disable') await refresh();
      else {
        account.reload();
        setMessage(t('Ação concluída.', 'Action completed.'));
      }
    });
  return (
    <>
      <PageHeader
        title={t('A minha conta', 'My account')}
        description={t(
          'Gira os seus dados e a segurança do acesso.',
          'Manage your details and access security.',
        )}
      />
      {message && <Notice tone="success">{message}</Notice>}
      {passwordMismatch && (
        <Notice>{t('As palavras-passe não coincidem.', 'Passwords do not match.')}</Notice>
      )}
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <div className="identity-grid">
        <section className="panel stack">
          <h2>{t('Perfil', 'Profile')}</h2>
          <p>{user.email}</p>
          {session && <AvatarField user={session.user} />}
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void mutation.run(async () => {
                await request('/account/profile', {
                  method: 'POST',
                  body: { displayName: data.get('displayName'), locale: data.get('locale') },
                });
                setLocale(data.get('locale') as Locale);
                account.reload();
                await refresh();
                setMessage(t('Perfil atualizado.', 'Profile updated.'));
              });
            }}
          >
            <label>
              {t('Nome', 'Name')}
              <input name="displayName" defaultValue={user.displayName} required maxLength={160} />
            </label>
            <label>
              {t('Idioma', 'Language')}
              <select name="locale" defaultValue={user.locale ?? locale}>
                <option value="pt-PT">Português (Portugal)</option>
                <option value="en">English</option>
              </select>
            </label>
            <button className="button button-primary" disabled={mutation.busy}>
              {t('Guardar perfil', 'Save profile')}
            </button>
          </form>
        </section>
        <section className="panel stack">
          <h2>{t('Alterar palavra-passe', 'Change password')}</h2>
          <p>
            {t(
              'A alteração termina as sessões existentes.',
              'Changing your password ends existing sessions.',
            )}
          </p>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              const password = String(data.get('password'));
              if (password !== data.get('confirmPassword')) {
                setPasswordMismatch(true);
                return;
              }
              setPasswordMismatch(false);
              form.reset();
              sensitive('password', async (confirmationToken) => {
                await request('/account/password', {
                  method: 'POST',
                  body: { password, confirmationToken },
                });
                await refresh();
              });
            }}
          >
            <PasswordFields confirm />
            <button className="button button-primary" disabled={mutation.busy}>
              {t('Alterar palavra-passe', 'Change password')}
            </button>
          </form>
        </section>
        <section className="panel stack">
          <h2>{t('Autenticação multifator', 'Multi-factor authentication')}</h2>
          <p>
            {user.mfaEnabled
              ? t('MFA ativo.', 'MFA enabled.')
              : t('MFA não configurado.', 'MFA not configured.')}
          </p>
          <p className="field-hint">
            {t(
              'Recomendado para todos e obrigatório por defeito para a equipa. Pode desativá-lo na sua conta; volta a ser pedido se o configurar de novo ou se um administrador o repuser.',
              'Recommended for everyone and required by default for staff. You can disable it on your account; it is required again if you set it up again or an administrator resets it.',
            )}
          </p>
          {!user.mfaEnabled && !enrollment && (
            <button
              className="button button-primary"
              onClick={() =>
                sensitive('mfa-start', async (confirmationToken) => {
                  setEnrollment(
                    await request('/account/mfa/start', {
                      method: 'POST',
                      body: { confirmationToken },
                    }),
                  );
                })
              }
            >
              {t('Configurar MFA', 'Set up MFA')}
            </button>
          )}
          {enrollment && (
            <>
              <Enrollment {...enrollment} />
              <form
                className="stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void mutation.run(async () => {
                    const result = await request<{ recoveryCodes: string[] }>(
                      '/account/mfa/confirm',
                      { method: 'POST', body: { code: data.get('code') } },
                    );
                    setEnrollment(null);
                    setMustSignIn(true);
                    setCodes(result.recoveryCodes);
                  });
                }}
              >
                <CodeField />
                <button className="button button-primary" disabled={mutation.busy}>
                  {t('Confirmar inscrição', 'Confirm enrollment')}
                </button>
              </form>
            </>
          )}
          {user.mfaEnabled && (
            <>
              <button
                className="button button-secondary"
                onClick={() =>
                  sensitive('mfa-codes', async (confirmationToken) => {
                    const result = await request<{ recoveryCodes: string[] }>(
                      '/account/mfa/codes',
                      { method: 'POST', body: { confirmationToken } },
                    );
                    setCodes(result.recoveryCodes);
                  })
                }
              >
                {t(
                  'Regenerar códigos (invalida os anteriores)',
                  'Regenerate codes (invalidates previous codes)',
                )}
              </button>
              <button
                className="button button-secondary"
                onClick={() => {
                  if (
                    window.confirm(
                      t(
                        'Desativar o MFA desta conta? O acesso passa a depender só da password e todas as sessões serão terminadas.',
                        'Disable MFA for this account? Access will rely on the password only and all sessions will be ended.',
                      ),
                    )
                  )
                    simpleOperation('mfa-disable', '/account/mfa/disable');
                }}
              >
                {t('Desativar MFA', 'Disable MFA')}
              </button>
            </>
          )}
        </section>
        <section className="panel stack">
          <h2>{t('Sessões', 'Sessions')}</h2>
          <p>
            {t(
              'Termine todos os acessos, incluindo esta sessão.',
              'End all access, including this session.',
            )}
          </p>
          <button
            className="button button-secondary"
            onClick={() => simpleOperation('sessions', '/account/sessions/revoke')}
          >
            {t('Revogar todas as sessões', 'Revoke all sessions')}
          </button>
        </section>
      </div>
      {pending && (
        <ReauthDialog
          action={pending.action}
          target={session!.user.id}
          title={t('Confirmar ação sensível', 'Confirm sensitive action')}
          onConfirm={pending.operation}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}
