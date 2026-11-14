import { useState } from 'react';
import type { InstanceProject } from '@zeroops/contracts';
import { ProjectLogo, PROJECTS_CHANGED_EVENT } from '../../components/ProjectLogo';
import { useProjectAdmin, useProjectSession } from '../../lib/project-admin';
import { ProjectLogoPicker } from './ProjectLogoPicker';

/** Grava o logotipo no projeto indicado, sem alterar o projeto ativo da sessao. */
export function ProjectLogoField({
  project,
  onChanged,
}: {
  project: InstanceProject;
  onChanged: () => void;
}) {
  const { request } = useProjectSession();
  const context = useProjectAdmin();
  const [logoVersion, setLogoVersion] = useState(project.logoVersion);
  const prefix = context
    ? `/project-admin/${encodeURIComponent(project.id)}`
    : `/instance/projects/${encodeURIComponent(project.id)}`;
  return (
    <ProjectLogoPicker
      logo={null}
      name={project.name}
      hasLogo={logoVersion !== null}
      existingPreview={
        <ProjectLogo
          project={{ id: project.id, logoVersion }}
          name={project.name}
          className="project-mark-lg"
        />
      }
      onChange={async (logo) => {
        const result = await request<{ logoVersion: number | null }>(
          `${prefix}/logo${logo ? '' : '/remove'}`,
          { method: 'POST', body: logo ?? {} },
        );
        setLogoVersion(result.logoVersion);
        window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT));
        onChanged();
      }}
    />
  );
}
