import { useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/ui';
import { useIdentityLocale, useIdentityMutation } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { PasswordFields } from './IdentityForms';

/** Primeiro acesso com a palavra-passe temporária do convite: define a definitiva. */
export function InitialPasswordPage() {
  const { session, request, refresh, logout } = useSession();
  const { t } = useIdentityLocale();
  const mutation = useIdentityMutation();
  const [mismatch, setMismatch] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');
    if (password !== data.get('confirmPassword')) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    void mutation.run(async () => {
      await request('/account/initial-password', { method: 'POST', body: { password } });
      await refresh();
    });
  };
  return (
    <main className="auth-layout">
      <section className="auth-form-side">
        <div className="kt-card auth-card">
          <div className="kt-card-content stack">
            <div className="auth-card-head">
              <span className="brand-symbol">
                <Icon name="shield" size={20} />
              </span>
              <h1>{t('Definir a sua palavra-passe', 'Choose your password')}</h1>
              <p>{session?.user.email}</p>
            </div>
            <Notice tone="warning">
              {t(
                'Entrou com a palavra-passe temporária do convite. Escolha agora a sua palavra-passe para continuar; a temporária deixa de funcionar.',
                'You signed in with the temporary password from the invitation. Choose your own password to continue; the temporary one stops working.',
              )}
            </Notice>
            {mutation.error && <Notice>{mutation.error}</Notice>}
            {mismatch && (
              <Notice>{t('As palavras-passe não coincidem.', 'Passwords do not match.')}</Notice>
            )}
            <form className="stack" onSubmit={submit}>
              <PasswordFields confirm />
              <button className="button button-primary" disabled={mutation.busy}>
                {t('Guardar e continuar', 'Save and continue')}
              </button>
            </form>
            <button className="text-button" onClick={() => void logout()}>
              {t('Terminar sessão', 'Sign out')}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
