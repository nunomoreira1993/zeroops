import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  PROJECT_LOGO_MAX_BYTES,
  projectLogoMimeTypes,
  type ProjectLogoInput,
} from '@zeroops/contracts';
import { Notice } from '../../components/ui';
import { useIdentityLocale } from '../../lib/identity';
import { initials } from '../../lib/format';

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read the image.'));
    reader.onabort = () => reject(new Error('Image reading was cancelled.'));
    reader.readAsDataURL(file);
  });
}

/** Seleciona uma imagem sem a publicar; a operacao de gravacao pertence ao formulario. */
export function ProjectLogoPicker({
  logo,
  name,
  existingPreview,
  hasLogo = Boolean(logo),
  disabled = false,
  onChange,
  onValidityChange,
}: {
  logo: ProjectLogoInput | null;
  name: string;
  existingPreview?: ReactNode;
  hasLogo?: boolean;
  disabled?: boolean;
  onChange: (logo: ProjectLogoInput | null) => void | Promise<void>;
  onValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useIdentityLocale();
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const select = async (file: File | undefined) => {
    if (!file) return;
    const current = ++generation.current;
    setError(null);
    onValidityChange?.(false);
    const mime = projectLogoMimeTypes.find((value) => value === file.type);
    if (!mime || file.size > PROJECT_LOGO_MAX_BYTES || file.size === 0) {
      setError(
        t(
          'Use uma imagem PNG, JPEG, WebP ou SVG entre 1 byte e 256 KB.',
          'Use a PNG, JPEG, WebP or SVG image between 1 byte and 256 KB.',
        ),
      );
      if (input.current) input.current.value = '';
      return;
    }
    setBusy(true);
    try {
      const data = await readFile(file);
      if (current !== generation.current) return;
      await onChange({ mime, data });
      if (current === generation.current) onValidityChange?.(true);
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : t('Não foi possível carregar o logotipo.', 'Unable to load the logo.'),
        );
    } finally {
      if (current === generation.current) {
        setBusy(false);
        if (input.current) input.current.value = '';
      }
    }
  };

  const remove = async () => {
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      await onChange(null);
      if (current === generation.current) onValidityChange?.(true);
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : t('Não foi possível remover o logotipo.', 'Unable to remove the logo.'),
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  return (
    <div className="project-logo-field">
      {logo ? (
        <span className="project-mark project-mark-logo project-mark-lg">
          <img
            src={`data:${logo.mime};base64,${logo.data}`}
            alt={t('Pré-visualização do logotipo', 'Logo preview')}
          />
        </span>
      ) : (
        (existingPreview ?? (
          <span className="project-mark project-mark-lg" aria-hidden="true">
            {initials(name || 'Projeto')}
          </span>
        ))
      )}
      <div className="project-logo-body">
        <strong>{t('Logotipo do projeto', 'Project logo')}</strong>
        <span className="project-logo-hint">
          {t(
            'PNG, JPEG, WebP ou SVG até 256 KB; de preferência quadrado.',
            'PNG, JPEG, WebP or SVG up to 256 KB; square works best.',
          )}
        </span>
        <div className="project-logo-actions">
          <label
            className={`kt-btn kt-btn-outline kt-btn-sm${disabled || busy ? ' disabled' : ''}`}
          >
            <input
              ref={input}
              type="file"
              className="sr-only"
              aria-label={t('Selecionar logotipo', 'Select logo')}
              accept={projectLogoMimeTypes.join(',')}
              disabled={disabled || busy}
              onChange={(event) => void select(event.target.files?.[0])}
            />
            {hasLogo
              ? t('Substituir logotipo', 'Replace logo')
              : t('Selecionar logotipo', 'Select logo')}
          </label>
          {(hasLogo || error) && (
            <button
              type="button"
              className="kt-btn kt-btn-ghost kt-btn-sm"
              disabled={disabled || busy}
              onClick={() => void remove()}
            >
              {t('Remover', 'Remove')}
            </button>
          )}
        </div>
        {busy && <span role="status">{t('A carregar imagem…', 'Loading image…')}</span>}
        {error && <Notice>{error}</Notice>}
      </div>
    </div>
  );
}
