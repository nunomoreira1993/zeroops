import { useRef, useState, type ChangeEvent } from 'react';
import { USER_AVATAR_MAX_BYTES, userAvatarMimeTypes, type User } from '@zeroops/contracts';
import { Avatar } from '../../components/Avatar';
import { Notice } from '../../components/ui';
import { useMutation } from '../../lib/hooks';
import { useIdentityLocale } from '../../lib/identity';
import { useSession } from '../../lib/session';

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Leitura falhou.'));
    reader.readAsDataURL(file);
  });

/** Fotografia de perfil usada no chat e no menu; sem fotografia mostram-se as iniciais. */
export function AvatarField({ user }: { user: User }) {
  const { request, refresh } = useSession();
  const { t } = useIdentityLocale();
  const mutation = useMutation();
  const input = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState(user.avatarVersion ?? null);

  const save = (body: object | null) =>
    void mutation.run(async () => {
      const result = await request<{ avatarVersion: number | null }>(
        `/account/avatar${body ? '' : '/remove'}`,
        { method: 'POST', body: body ?? {} },
      );
      setVersion(result.avatarVersion);
      await refresh();
    });

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!(userAvatarMimeTypes as readonly string[]).includes(file.type))
      return void mutation.run(async () => {
        throw new Error(t('Use uma imagem PNG, JPEG ou WebP.', 'Use a PNG, JPEG or WebP image.'));
      });
    if (file.size > USER_AVATAR_MAX_BYTES)
      return void mutation.run(async () => {
        throw new Error(
          t('A fotografia não pode exceder 512 KB.', 'The photo cannot exceed 512 KB.'),
        );
      });
    void readBase64(file).then((data) => save({ mime: file.type, data }));
  };

  return (
    <div className="avatar-field">
      <Avatar name={user.displayName} userId={user.id} avatarVersion={version} size="lg" />
      <div className="stack">
        <strong>{t('Fotografia', 'Photo')}</strong>
        <span className="field-hint">
          {t(
            'Aparece no chat dos pedidos. PNG, JPEG ou WebP até 512 KB; sem fotografia mostram-se as iniciais.',
            'Shown in ticket chats. PNG, JPEG or WebP up to 512 KB; without a photo your initials are shown.',
          )}
        </span>
        {mutation.error && <Notice>{mutation.error}</Notice>}
        <div className="avatar-field-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={mutation.busy}
            onClick={() => input.current?.click()}
          >
            {version === null
              ? t('Carregar fotografia', 'Upload photo')
              : t('Alterar fotografia', 'Change photo')}
          </button>
          {version !== null && (
            <button
              type="button"
              className="text-button"
              disabled={mutation.busy}
              onClick={() => save(null)}
            >
              {t('Remover', 'Remove')}
            </button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          hidden
          accept={userAvatarMimeTypes.join(',')}
          aria-label={t('Fotografia de perfil', 'Profile photo')}
          onChange={choose}
        />
      </div>
    </div>
  );
}
