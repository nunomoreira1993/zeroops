import { useState } from 'react';
import {
  siteKeys,
  siteProfiles,
  type InstanceUser,
  type ProjectLogoInput,
} from '@zeroops/contracts';
import { IdentityDialog, ReauthDialog } from '../auth/IdentityForms';
import { Loading, Notice, ResourceError } from '../../components/ui';
import { useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';
import { ProjectLogoPicker } from './ProjectLogoPicker';

export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { request } = useSession();
  const { t } = useIdentityLocale();
  const users = useResource<InstanceUser[]>('/instance/users');
  const [name, setName] = useState('');
  const [siteKey, setSiteKey] = useState('');
  const [adminId, setAdminId] = useState('');
  const [logo, setLogo] = useState<ProjectLogoInput | null>(null);
  const [logoValid, setLogoValid] = useState(true);
  const [confirming, setConfirming] = useState(false);

  if (confirming)
    return (
      <ReauthDialog
        action="project-create"
        target={`${adminId}:${name.trim()}`}
        title={t('Confirmar criação do projeto', 'Confirm project creation')}
        onClose={() => setConfirming(false)}
        onConfirm={async (confirmationToken) => {
          const result = await request<{ id: string }>('/instance/projects', {
            method: 'POST',
            body: {
              name: name.trim(),
              siteKey: siteKeys.find((key) => key === siteKey) ?? null,
              initialAdminUserId: adminId,
              ...(logo ? { logo } : {}),
              confirmationToken,
            },
          });
          onCreated(result.id);
        }}
      />
    );

  return (
    <IdentityDialog title={t('Criar projeto', 'Create project')} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            name.trim().length >= 2 &&
            logoValid &&
            users.data?.some((user) => user.id === adminId)
          )
            setConfirming(true);
        }}
      >
        <label>
          {t('Nome do projeto', 'Project name')}
          <input
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={2}
            maxLength={50}
          />
        </label>
        <label>
          {t('Site', 'Site')}
          <select
            name="siteKey"
            value={siteKey}
            onChange={(event) => setSiteKey(event.target.value)}
          >
            <option value="">{t('Sem site', 'No site')}</option>
            {siteKeys.map((key) => (
              <option key={key} value={key}>
                {siteProfiles[key].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Administrador inicial do projeto', 'Initial project administrator')}
          <select
            name="initialAdminUserId"
            value={adminId}
            onChange={(event) => setAdminId(event.target.value)}
            required
          >
            <option value="" disabled>
              {t('Selecionar utilizador', 'Select a user')}
            </option>
            {(users.data ?? []).map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName} · {user.email}
              </option>
            ))}
          </select>
        </label>
        <p className="field-hint">
          {t(
            'Será enviado um convite. Depois pode adicionar outros administradores e configurar o cliente, acessos, integrações e Saúde.',
            'An invitation will be sent. You can then add more administrators and configure the client, access, integrations and Health.',
          )}
        </p>
        <ProjectLogoPicker
          logo={logo}
          name={name}
          onChange={setLogo}
          onValidityChange={setLogoValid}
        />
        {users.loading ? (
          <Loading label={t('A carregar utilizadores…', 'Loading users…')} />
        ) : users.error ? (
          <ResourceError error={users.error} retry={users.reload} />
        ) : !users.data?.length ? (
          <Notice tone="warning">
            {t(
              'Não existem contas ativas para o administrador inicial.',
              'There are no active accounts for the initial administrator.',
            )}
          </Notice>
        ) : null}
        <button
          className="button button-primary"
          disabled={
            name.trim().length < 2 ||
            users.loading ||
            Boolean(users.error) ||
            !users.data?.length ||
            !adminId ||
            !logoValid
          }
        >
          {t('Continuar para confirmação', 'Continue to confirmation')}
        </button>
      </form>
    </IdentityDialog>
  );
}
