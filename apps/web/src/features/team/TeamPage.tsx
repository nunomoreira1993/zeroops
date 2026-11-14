import { useState, type ReactNode } from 'react';
import { roles, type Role, type ManagedInvitation } from '@zeroops/contracts';
import { EmptyState, Loading, Notice, PageHeader } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useProjectAdmin, useProjectSession } from '../../lib/project-admin';
import { IdentityDialog, ReauthDialog } from '../auth/IdentityForms';
import type { ManagedAccount } from '../account/AccountPage';
import { UserDeliveries, useDeliveryLabels } from './UserDeliveries';

type Editor = { kind: 'invite' } | { kind: 'user' | 'email' | 'mfa-reset'; user: ManagedAccount };

export function TeamPage() {
  const { session, request, refresh } = useProjectSession();
  const projectAdmin = useProjectAdmin();
  const { t, locale } = useIdentityLocale();
  const users = useResource<ManagedAccount[]>('/users');
  const invitations = useResource<ManagedInvitation[]>('/invitations');
  const deliveryLabels = useDeliveryLabels();
  const instanceAdmin = Boolean(session?.user.instanceAdmin && !projectAdmin);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [organization, setOrganization] = useState('');
  const [state, setState] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deliveryUser, setDeliveryUser] = useState<ManagedAccount | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  type PendingAction = {
    action: string;
    target: string;
    title: string;
    path: string;
    body: Record<string, unknown>;
  };
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels: Record<Role, string> = {
    client: t('Cliente', 'Client'),
    technical: t('Equipa técnica', 'Technical'),
    qa: t('Qualidade', 'Quality assurance'),
    release: t('Gestor de release', 'Release manager'),
    admin: t('Administrador', 'Administrator'),
  };
  const actionLabels: Record<string, string> = {
    disable: t('Desativar acesso', 'Disable access'),
    enable: t('Reativar acesso', 'Enable access'),
    unlock: t('Desbloquear conta', 'Unlock account'),
    sessions: t('Revogar sessões', 'Revoke sessions'),
    'mfa-reset': t('Iniciar reposição MFA', 'Start MFA reset'),
    email: t('Alterar email', 'Change email'),
    resend: t('Reenviar convite', 'Resend invitation'),
    revoke: t('Revogar convite', 'Revoke invitation'),
    'user-update': t('Guardar utilizador', 'Save user'),
    invite: t('Enviar convite', 'Send invitation'),
  };
  /** Só estas ações pedem palavra-passe/MFA; as restantes usam a sessão já autenticada. */
  const reauthActions = ['sessions', 'mfa-reset', 'email'];
  const confirmActions: Record<string, string> = {
    disable: t(
      'Desativar o acesso desta pessoa? As sessões dela são terminadas.',
      'Disable this person’s access? Their sessions are ended.',
    ),
    revoke: t('Revogar este convite?', 'Revoke this invitation?'),
  };
  async function execute(item: PendingAction, confirmationToken?: string) {
    await request(item.path, {
      method: 'POST',
      body: confirmationToken ? { ...item.body, confirmationToken } : item.body,
    });
    users.reload();
    invitations.reload();
    setMessage(
      ['invite', 'resend', 'email', 'mfa-reset', 'mail-retry'].includes(item.action)
        ? t(
            'Pedido aceite para envio por email. Consulte o estado de entrega.',
            'Request accepted for email delivery. Check delivery status.',
          )
        : t('Ação concluída.', 'Action completed.'),
    );
    if (
      !projectAdmin &&
      item.target === session!.user.id &&
      ['user-update', 'disable', 'sessions'].includes(item.action)
    )
      await refresh();
  }
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : t('Ação não concluída.', 'Action not completed.');
  async function queue(
    action: string,
    target: string,
    title: string,
    path: string,
    body: Record<string, unknown>,
  ) {
    setMessage(null);
    const item = { action, target, title, path, body };
    if (reauthActions.includes(action)) return setPending(item);
    if (confirmActions[action] && !window.confirm(confirmActions[action])) return;
    try {
      await execute(item);
    } catch (error) {
      setMessage(errorText(error));
    }
  }
  function fields(user?: ManagedAccount): ReactNode {
    return (
      <>
        <label>
          {t('Nome', 'Name')}
          <input
            name="displayName"
            defaultValue={user?.displayName ?? ''}
            required
            readOnly={Boolean(projectAdmin && user)}
            maxLength={160}
          />
        </label>
        {!user && (
          <label>
            Email
            <input name="email" type="email" required maxLength={254} />
          </label>
        )}
        <label>
          {t('Perfil', 'Role')}
          <select name="role" defaultValue={user?.role ?? 'client'}>
            {roles.map((value) => (
              <option key={value} value={value}>
                {labels[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Organização', 'Organization')}
          <select name="organization" defaultValue={user?.organization ?? ''} required={!user}>
            <option value="">{t('Por confirmar', 'Unconfirmed')}</option>
            <option value="client">{t('Cliente', 'Client')}</option>
            <option value="deloitte">Deloitte</option>
          </select>
        </label>
        {(!projectAdmin || !user) && (
          <label>
            {t('Idioma', 'Language')}
            <select name="locale" defaultValue={user?.locale ?? locale}>
              <option value="pt-PT">Português (Portugal)</option>
              <option value="en">English</option>
            </select>
          </label>
        )}
      </>
    );
  }
  const filtered = (users.data ?? []).filter(
    (user) =>
      `${user.displayName} ${user.email}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()) &&
      (!role || user.role === role) &&
      (!organization || (user.organization ?? 'unconfirmed') === organization) &&
      (!state ||
        (state === 'active'
          ? !user.disabled
          : state === 'disabled'
            ? user.disabled
            : Boolean(user.lockedUntil && new Date(user.lockedUntil) > new Date()))),
  );
  return (
    <>
      {!projectAdmin && (
        <PageHeader
          title={t('Equipa e acessos', 'Team and access')}
          description={t(
            'Gira contas e convites. Organização e perfil são independentes.',
            'Manage accounts and invitations. Organization and role are independent.',
          )}
          action={
            <button className="button button-primary" onClick={() => setEditor({ kind: 'invite' })}>
              {t('Convidar pessoa', 'Invite someone')}
            </button>
          }
        />
      )}
      {projectAdmin && (
        <div className="form-actions">
          <button className="button button-primary" onClick={() => setEditor({ kind: 'invite' })}>
            {t('Convidar pessoa', 'Invite someone')}
          </button>
          <span className="muted">
            {t(
              'Apenas acessos deste projeto. A identidade global não é alterada.',
              'Only access to this project. Global identity is not changed.',
            )}
          </span>
        </div>
      )}
      {message && <Notice tone="success">{message}</Notice>}
      <section className="panel stack">
        <h2>{t('Utilizadores', 'Users')}</h2>
        <div className="identity-filters">
          <label>
            {t('Pesquisar nome ou email', 'Search name or email')}
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            {t('Perfil', 'Role')}
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="">{t('Todos', 'All')}</option>
              {roles.map((value) => (
                <option key={value} value={value}>
                  {labels[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Organização', 'Organization')}
            <select value={organization} onChange={(event) => setOrganization(event.target.value)}>
              <option value="">{t('Todas', 'All')}</option>
              <option value="client">{t('Cliente', 'Client')}</option>
              <option value="deloitte">Deloitte</option>
              <option value="unconfirmed">{t('Por confirmar', 'Unconfirmed')}</option>
            </select>
          </label>
          <label>
            {t('Estado', 'Status')}
            <select value={state} onChange={(event) => setState(event.target.value)}>
              <option value="">{t('Todos', 'All')}</option>
              <option value="active">{t('Ativo', 'Active')}</option>
              <option value="disabled">{t('Desativado', 'Disabled')}</option>
              <option value="locked">{t('Bloqueado', 'Locked')}</option>
            </select>
          </label>
        </div>
        {users.loading ? (
          <Loading label={t('A carregar…', 'Loading…')} />
        ) : users.error ? (
          <Notice>
            {t('Não foi possível carregar os utilizadores.', 'Unable to load users.')}
            <button className="text-button" onClick={users.reload}>
              {t('Tentar novamente', 'Retry')}
            </button>
          </Notice>
        ) : (
          <div className="table-scroll">
            <table className="identity-table">
              <thead>
                <tr>
                  <th>{t('Pessoa', 'Person')}</th>
                  <th>{t('Perfil / organização', 'Role / organization')}</th>
                  <th>{t('Estado / MFA', 'Status / MFA')}</th>
                  <th>{t('Ações', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.displayName}</strong>
                      <br />
                      {user.email}
                    </td>
                    <td>
                      {labels[user.role]}
                      <br />
                      {user.organization === 'deloitte'
                        ? 'Deloitte'
                        : user.organization === 'client'
                          ? t('Cliente', 'Client')
                          : t('Por confirmar', 'Unconfirmed')}
                    </td>
                    <td>
                      {user.disabled ? t('Desativado', 'Disabled') : t('Ativo', 'Active')}
                      <br />
                      {user.mfaEnabled
                        ? t('MFA ativo', 'MFA enabled')
                        : t('MFA pendente', 'MFA pending')}
                      {user.lockedUntil && new Date(user.lockedUntil) > new Date() && (
                        <>
                          <br />
                          {t('Bloqueio temporário', 'Temporarily locked')}
                        </>
                      )}
                    </td>
                    <td>
                      <div className="identity-actions">
                        <button
                          className="text-button"
                          onClick={() => setEditor({ kind: 'user', user })}
                        >
                          {t('Editar', 'Edit')}
                        </button>
                        {instanceAdmin && (
                          <>
                            <button
                              className="text-button"
                              onClick={() => setEditor({ kind: 'email', user })}
                            >
                              {actionLabels.email}
                            </button>
                            <button className="text-button" onClick={() => setDeliveryUser(user)}>
                              {t('Ver entregas', 'View deliveries')}
                            </button>
                          </>
                        )}
                        {['enable', 'disable', ...(instanceAdmin ? ['unlock', 'sessions'] : [])]
                          .filter((action) => action !== (user.disabled ? 'disable' : 'enable'))
                          .map((action) => (
                            <button
                              key={action}
                              className="text-button"
                              onClick={() =>
                                void queue(
                                  action,
                                  user.id,
                                  `${actionLabels[action]} · ${user.email}`,
                                  `/users/${encodeURIComponent(user.id)}/action`,
                                  { action },
                                )
                              }
                            >
                              {actionLabels[action]}
                            </button>
                          ))}
                        {instanceAdmin && (
                          <button
                            className="text-button"
                            disabled={user.id === session!.user.id}
                            onClick={() => setEditor({ kind: 'mfa-reset', user })}
                          >
                            {actionLabels['mfa-reset']}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && (
              <p>
                {t('Nenhum utilizador corresponde aos filtros.', 'No users match the filters.')}
              </p>
            )}
          </div>
        )}
      </section>
      <section className="panel stack">
        <h2>{t('Convites e entrega', 'Invitations and delivery')}</h2>
        <p>
          {t(
            'Os convites são enviados por email. Aceitação pelo relay não garante chegada à caixa de entrada.',
            'Invitations are emailed. Relay acceptance does not guarantee inbox delivery.',
          )}
        </p>
        {invitations.loading ? (
          <Loading label={t('A carregar…', 'Loading…')} />
        ) : invitations.error ? (
          <Notice>
            {t('Não foi possível carregar os convites.', 'Unable to load invitations.')}
            <button className="text-button" onClick={invitations.reload}>
              {t('Tentar novamente', 'Retry')}
            </button>
          </Notice>
        ) : !invitations.data?.length ? (
          <EmptyState
            icon="mail"
            title={t('Ainda não há convites', 'No invitations yet')}
            action={
              <button
                className="kt-btn kt-btn-outline"
                onClick={() => setEditor({ kind: 'invite' })}
              >
                {t('Enviar primeiro convite', 'Send first invitation')}
              </button>
            }
          >
            {t(
              'Convide colegas ou clientes por email. Aqui acompanha o estado de cada convite, a entrega e a validade da ligação.',
              'Invite colleagues or clients by email. Track each invitation status, delivery and link expiry here.',
            )}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="identity-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>{t('Estado / entrega', 'Status / delivery')}</th>
                  <th>{t('Validade', 'Expires')}</th>
                  <th>{t('Ações', 'Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {(invitations.data ?? []).map((invite) => {
                  const closed = Boolean(invite.usedAt || invite.revokedAt);
                  const status = closed
                    ? invite.usedAt
                      ? t('Aceite', 'Accepted')
                      : t('Revogado', 'Revoked')
                    : new Date(invite.expiresAt) < new Date()
                      ? t('Expirado', 'Expired')
                      : t('Pendente', 'Pending');
                  return (
                    <tr key={invite.id}>
                      <td>
                        {invite.email}
                        <br />
                        {invite.displayName}
                      </td>
                      <td>
                        {status}
                        <br />
                        {invite.deliveryState
                          ? deliveryLabels[invite.deliveryState]
                          : t('Por confirmar', 'Unconfirmed')}
                      </td>
                      <td>{new Date(invite.expiresAt).toLocaleString(locale)}</td>
                      <td>
                        <div className="identity-actions">
                          {['resend', 'revoke'].map((action) => (
                            <button
                              key={action}
                              className="text-button"
                              disabled={closed}
                              onClick={() =>
                                void queue(
                                  action,
                                  invite.id,
                                  `${actionLabels[action]} · ${invite.email}`,
                                  `/invitations/${encodeURIComponent(invite.id)}/action`,
                                  { action },
                                )
                              }
                            >
                              {actionLabels[action]}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {deliveryUser && (
        <UserDeliveries
          userId={deliveryUser.id}
          name={deliveryUser.displayName}
          onClose={() => setDeliveryUser(null)}
          onRetry={(delivery) => {
            void queue(
              'mail-retry',
              delivery.id,
              t('Confirmar nova tentativa de envio', 'Confirm delivery retry'),
              `/users/${encodeURIComponent(deliveryUser.id)}/deliveries/${encodeURIComponent(delivery.id)}/retry`,
              {},
            );
            setDeliveryUser(null);
          }}
        />
      )}
      {editor && (
        <IdentityDialog
          title={
            editor.kind === 'invite'
              ? actionLabels.invite!
              : `${editor.kind === 'user' ? t('Editar utilizador', 'Edit user') : actionLabels[editor.kind]} · ${editor.user.email}`
          }
          onClose={() => {
            setEditor(null);
            setEditorError(null);
          }}
        >
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const allValues = Object.fromEntries(data.entries());
              const values: Record<string, FormDataEntryValue> =
                projectAdmin && editor.kind === 'user'
                  ? { role: allValues.role ?? '', organization: allValues.organization ?? '' }
                  : allValues;
              const action = editor.kind === 'user' ? 'user-update' : editor.kind;
              const target = editor.kind === 'invite' ? session!.user.id : editor.user.id;
              const path =
                editor.kind === 'invite'
                  ? '/invitations'
                  : `/users/${encodeURIComponent(target)}${editor.kind === 'email' ? '/email' : editor.kind === 'mfa-reset' ? '/action' : ''}`;
              const body =
                editor.kind === 'mfa-reset'
                  ? { action, reason: values.reason }
                  : {
                      ...values,
                      ...(['invite', 'user'].includes(editor.kind)
                        ? { organization: values.organization || null }
                        : {}),
                    };
              const item = { action, target, title: actionLabels[action]!, path, body };
              setMessage(null);
              setEditorError(null);
              if (reauthActions.includes(action)) {
                setPending(item);
                setEditor(null);
                return;
              }
              setBusy(true);
              try {
                await execute(item);
                setEditor(null);
              } catch (error) {
                setEditorError(errorText(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {editor.kind === 'invite' || editor.kind === 'user' ? (
              fields(editor.kind === 'user' ? editor.user : undefined)
            ) : editor.kind === 'email' ? (
              <>
                <p>
                  {t(
                    'O email atual permanece ativo até o novo endereço ser confirmado.',
                    'The current email remains active until the new address is confirmed.',
                  )}
                </p>
                <label>
                  {t('Novo email', 'New email')}
                  <input name="email" type="email" required maxLength={254} />
                </label>
              </>
            ) : (
              <>
                <Notice tone="warning">
                  {t(
                    'Confirme a identidade da pessoa por um canal humano. Esta ação revoga sessões e exige nova inscrição MFA. Não é permitida na sua própria conta.',
                    'Verify the person’s identity through a human channel. This revokes sessions and requires new MFA enrollment. Not allowed on your own account.',
                  )}
                </Notice>
                <label>
                  {t('Motivo e verificação de identidade', 'Reason and identity verification')}
                  <textarea name="reason" required minLength={10} maxLength={2000} />
                </label>
              </>
            )}
            {editorError && <Notice>{editorError}</Notice>}
            <button className="button button-primary" disabled={busy}>
              {editor.kind === 'invite'
                ? actionLabels.invite
                : editor.kind === 'user'
                  ? actionLabels['user-update']
                  : t('Continuar para confirmação', 'Continue to confirmation')}
            </button>
          </form>
        </IdentityDialog>
      )}
      {pending && (
        <ReauthDialog
          {...pending}
          onClose={() => setPending(null)}
          onConfirm={(confirmationToken) => execute(pending, confirmationToken)}
        />
      )}
    </>
  );
}
