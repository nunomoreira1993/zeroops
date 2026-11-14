import { useEffect, useId, useRef, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/ui';
import { useIdentityLocale, useIdentityMutation } from '../../lib/identity';
import { useProjectSession } from '../../lib/project-admin';

export function PasswordFields({
  confirm = false,
  current = false,
}: {
  confirm?: boolean;
  current?: boolean;
}) {
  const { t } = useIdentityLocale();
  return (
    <>
      <label>
        {t('Palavra-passe', 'Password')}
        <input
          name="password"
          type="password"
          autoComplete={current ? 'current-password' : 'new-password'}
          required
          minLength={current ? 1 : 12}
          maxLength={128}
        />
      </label>
      {!current && (
        <p className="field-hint">
          {t(
            'Utilize pelo menos 12 caracteres e uma palavra-passe exclusiva.',
            'Use at least 12 characters and a unique password.',
          )}
        </p>
      )}
      {confirm && (
        <label>
          {t('Confirmar palavra-passe', 'Confirm password')}
          <input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </label>
      )}
    </>
  );
}

export function CodeField({ recovery = false }: { recovery?: boolean }) {
  const { t } = useIdentityLocale();
  return (
    <label>
      {recovery
        ? t('Código TOTP ou de recuperação', 'TOTP or recovery code')
        : t('Código da aplicação', 'Authenticator code')}
      <input
        name="code"
        autoComplete="one-time-code"
        inputMode={recovery ? 'text' : 'numeric'}
        required
        maxLength={64}
        pattern={recovery ? undefined : '[0-9]{6}'}
      />
    </label>
  );
}

export function Enrollment({ uri, secret }: { uri: string; secret: string }) {
  const { t } = useIdentityLocale();
  return (
    <div className="stack enrollment">
      <p>
        {t(
          'Leia este QR na sua aplicação autenticadora e confirme o código. Não partilhe a chave.',
          'Scan this QR in your authenticator app and confirm the code. Do not share the key.',
        )}
      </p>
      <QRCodeSVG value={uri} size={192} level="M" title={t('Inscrição MFA', 'MFA enrollment')} />
      <label>
        {t('Chave para configuração manual', 'Manual setup key')}
        <input readOnly value={secret} autoComplete="off" />
      </label>
    </div>
  );
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useIdentityLocale();
  const titleId = useId();
  return (
    <section className="panel recovery-card" aria-labelledby={titleId}>
      <header className="recovery-heading">
        <span className="recovery-symbol">
          <Icon name="shield" size={24} />
        </span>
        <div>
          <h2 id={titleId}>{t('Guarde os códigos de recuperação', 'Save your recovery codes')}</h2>
          <p className="recovery-description">
            {t(
              'Use um destes códigos se perder acesso à aplicação autenticadora.',
              'Use one of these codes if you lose access to your authenticator app.',
            )}
          </p>
        </div>
      </header>
      <Notice tone="warning">
        {t(
          'Apresentados apenas uma vez. Guarde-os num local seguro. Cada código só pode ser utilizado uma vez.',
          'Shown only once. Store them somewhere safe. Each code can only be used once.',
        )}
      </Notice>
      <ol className="recovery-codes">
        {codes.map((code, index) => (
          <li key={code}>
            <span className="recovery-code-number" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <code dir="ltr" translate="no">
              {code}
            </code>
          </li>
        ))}
      </ol>
      <footer className="recovery-footer">
        <p>
          {t(
            'Guarde-os num gestor de palavras-passe. Não partilhe estes códigos.',
            'Save them in a password manager. Do not share these codes.',
          )}
        </p>
        <button type="button" className="button button-primary" onClick={onDone}>
          <Icon name="check" size={17} />
          {t('Guardei os códigos. Continuar', 'I saved the codes. Continue')}
        </button>
      </footer>
    </section>
  );
}

export function IdentityDialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useIdentityLocale();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="identity-dialog"
      aria-labelledby="identity-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="stack">
        <h2 id="identity-dialog-title">{title}</h2>
        {children}
        <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>
          {t('Cancelar', 'Cancel')}
        </button>
      </div>
    </dialog>
  );
}

export function ReauthDialog({
  action,
  target,
  title,
  onConfirm,
  onClose,
}: {
  action: string;
  target: string;
  title: string;
  onConfirm: (token: string) => Promise<void>;
  onClose: () => void;
}) {
  const { request, session } = useProjectSession();
  const { t } = useIdentityLocale();
  const mutation = useIdentityMutation();
  return (
    <IdentityDialog title={title} onClose={onClose} busy={mutation.busy}>
      <p>
        {t(
          'Confirme a sua identidade para executar esta ação.',
          'Confirm your identity to perform this action.',
        )}
      </p>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          void mutation.run(async () => {
            const result = await request<{ confirmationToken: string }>('/account/reauth', {
              method: 'POST',
              body: {
                password: data.get('password'),
                code: data.get('code') || undefined,
                action,
                target,
              },
            });
            form.reset();
            await onConfirm(result.confirmationToken);
            onClose();
          });
        }}
      >
        <PasswordFields current />
        <label>
          {t('Código MFA / recuperação (se ativo)', 'MFA / recovery code (if enabled)')}
          <input
            name="code"
            autoComplete="one-time-code"
            maxLength={64}
            required={session?.user.role !== 'client' || session?.user.instanceAdmin}
          />
        </label>
        <button className="button button-primary" disabled={mutation.busy}>
          {mutation.busy ? t('A confirmar…', 'Confirming…') : t('Confirmar ação', 'Confirm action')}
        </button>
      </form>
    </IdentityDialog>
  );
}
