import { useState } from 'react';
import {
  projectPermissionKeys,
  type ProjectPermission,
  type ProjectPermissionsView,
} from '@zeroops/contracts';
import { Loading, Notice, PageHeader, ResourceError } from '../../components/ui';
import { useMutation, useResource } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';

const labels: Record<ProjectPermission, { pt: string; en: string }> = {
  'flows.view': { pt: 'Consultar fluxos', en: 'View flows' },
  'flows.edit': { pt: 'Editar fluxos', en: 'Edit flows' },
  'flows.simulate': { pt: 'Simular fluxos', en: 'Simulate flows' },
  'flows.activate': {
    pt: 'Ativar versões e encaminhar fluxos',
    en: 'Activate versions and route flows',
  },
  'agents.manage': { pt: 'Gerir perfis de agentes', en: 'Manage agent profiles' },
  'skills.manage': {
    pt: 'Gerir skills, bindings e partilhas',
    en: 'Manage skills, bindings and sharing',
  },
  'repositories.manage': {
    pt: 'Gerir repositórios Git de desenvolvimento',
    en: 'Manage development Git repositories',
  },
  'capabilities.develop': {
    pt: 'Pedir desenvolvimento de capacidades',
    en: 'Request capability development',
  },
  'capabilities.publish': {
    pt: 'Autorizar publicação de capacidades',
    en: 'Authorize capability publishing',
  },
  'project.permissions.manage': {
    pt: 'Gerir permissões do projeto',
    en: 'Manage project permissions',
  },
};

/** Gestão delegada isolada da administração de contas, credenciais e integrações. */
export function ProjectPermissionsPage({ projectId }: { projectId: string }) {
  const { t } = useIdentityLocale();
  const resource = useResource<ProjectPermissionsView>(
    `/projects/${encodeURIComponent(projectId)}/permissions`,
  );
  return (
    <div className="stack">
      <PageHeader
        title={t('Permissões do projeto', 'Project permissions')}
        description={t(
          'A delegação exige gestão e a capacidade delegável. Revogar não remove grants já atribuídos a terceiros.',
          'Delegation requires management and the delegable capability. Revocation does not remove grants already assigned to others.',
        )}
        action={
          <button className="button button-secondary" onClick={resource.reload}>
            {t('Recarregar', 'Reload')}
          </button>
        }
      />
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ResourceError error={resource.error} retry={resource.reload} />
      ) : resource.data && resource.data.projectId === projectId ? (
        resource.data.members.map((member) => (
          <MemberPermissions
            key={`${member.id}:${resource.data!.version}`}
            member={member}
            view={resource.data!}
            onSaved={resource.reload}
          />
        ))
      ) : (
        <Notice>{t('Projeto indisponível.', 'Project unavailable.')}</Notice>
      )}
    </div>
  );
}

function MemberPermissions({
  member,
  view,
  onSaved,
}: {
  member: ProjectPermissionsView['members'][number];
  view: ProjectPermissionsView;
  onSaved: () => void;
}) {
  const { t } = useIdentityLocale();
  const { request } = useSession();
  const mutation = useMutation();
  const [permissions, setPermissions] = useState(member.permissions);
  const dirty =
    permissions.length !== member.permissions.length ||
    permissions.some((permission) => !member.permissions.includes(permission));
  return (
    <form
      className="panel stack"
      aria-label={member.displayName}
      onSubmit={(event) => {
        event.preventDefault();
        void mutation.run(async () => {
          await request(`/projects/${encodeURIComponent(view.projectId)}/permissions`, {
            method: 'POST',
            body: { userId: member.id, expectedVersion: view.version, permissions },
          });
          onSaved();
        });
      }}
    >
      <h2>{member.displayName}</h2>
      {member.isAdmin && (
        <p className="muted">
          {t(
            'A administração mantém todas as capacidades, independentemente dos grants.',
            'Administrators retain all capabilities independently of grants.',
          )}
        </p>
      )}
      <fieldset className="flow-fieldset" disabled={!member.canManage || mutation.busy}>
        <legend>{t('Grants explícitos', 'Explicit grants')}</legend>
        {projectPermissionKeys.map((permission) => (
          <label key={permission} className="checkbox-row">
            <input
              type="checkbox"
              checked={permissions.includes(permission)}
              disabled={!view.assignablePermissions.includes(permission)}
              onChange={(event) =>
                setPermissions((current) =>
                  event.target.checked
                    ? [...current, permission]
                    : current.filter((key) => key !== permission),
                )
              }
            />
            {t(labels[permission].pt, labels[permission].en)}
          </label>
        ))}
      </fieldset>
      {mutation.error && <Notice>{mutation.error}</Notice>}
      <button
        className="button button-primary align-start"
        disabled={!member.canManage || !dirty || mutation.busy}
      >
        {t('Gravar permissões', 'Save permissions')}
      </button>
    </form>
  );
}
