import { useState } from 'react';
import { projectLogoUrl, type Project } from '@zeroops/contracts';
import { initials } from '../lib/format';

/** Emitido depois de alterar projetos (ex.: logotipo) para a shell recarregar a lista. */
export const PROJECTS_CHANGED_EVENT = 'zeroops:projects-changed';

/** Logotipo real do cliente; mostra as iniciais enquanto não existir ou se falhar a carregar. */
export function ProjectLogo({
  project,
  name,
  className = '',
}: {
  project?: Pick<Project, 'id' | 'logoVersion'> | null;
  name: string;
  className?: string;
}) {
  const src = project ? projectLogoUrl(project) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = src && failed !== src;
  return (
    <span className={`project-mark${showImage ? ' project-mark-logo' : ''} ${className}`.trim()}>
      {showImage ? (
        <img src={src} alt="" onError={() => setFailed(src)} />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
}
