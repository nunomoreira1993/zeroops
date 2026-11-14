import { useState } from 'react';
import { avatarUrl } from '@zeroops/contracts';
import { initials } from '../lib/format';
import { Icon } from './Icon';

export type AvatarKind = 'person' | 'copilot' | 'system';

/**
 * Avatar de quem escreve: fotografia de perfil, iniciais quando não há fotografia (ou falha a
 * carregar) e um robot para o Copilot.
 */
export function Avatar({
  name,
  userId,
  avatarVersion,
  kind = 'person',
  size = 'md',
}: {
  name: string;
  userId?: string | null;
  avatarVersion?: number | null;
  kind?: AvatarKind;
  size?: 'sm' | 'md' | 'lg';
}) {
  const src = kind === 'person' && userId ? avatarUrl({ id: userId, avatarVersion }) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const className = `avatar avatar-${size}${kind !== 'person' ? ` avatar-${kind}` : ''}`;
  if (kind === 'copilot')
    return (
      <span className={className} aria-hidden="true" title="Copilot">
        <Icon name="bot" size={size === 'sm' ? 14 : 18} />
      </span>
    );
  if (kind === 'system')
    return (
      <span className={className} aria-hidden="true">
        <Icon name="pulse" size={size === 'sm' ? 14 : 16} />
      </span>
    );
  return (
    <span
      className={`${className}${src && failed !== src ? ' avatar-photo' : ''}`}
      aria-hidden="true"
    >
      {src && failed !== src ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(src)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}
