import type { ReactElement } from 'react';
import type { Locale } from '../lib/identity';

/** Bandeiras em SVG: o Windows não desenha os emojis de bandeira (mostra «PT»/«GB»). */
function FlagPortugal() {
  return (
    <svg viewBox="0 0 30 20" aria-hidden="true" focusable="false">
      <rect width="12" height="20" fill="#046a38" />
      <rect x="12" width="18" height="20" fill="#da291c" />
      <circle cx="12" cy="10" r="4.2" fill="#ffe900" />
      <path d="M10 7.6h4v3.2a2 2 0 0 1-4 0z" fill="#fff" stroke="#da291c" strokeWidth="0.8" />
    </svg>
  );
}

function FlagUnitedKingdom() {
  return (
    <svg viewBox="0 0 60 30" aria-hidden="true" focusable="false">
      <rect width="60" height="30" fill="#012169" />
      <path d="M0 0 60 30M60 0 0 30" stroke="#fff" strokeWidth="6" />
      <path d="M0 0 60 30M60 0 0 30" stroke="#c8102e" strokeWidth="2" />
      <path d="M30 0v30M0 15h60" stroke="#fff" strokeWidth="10" />
      <path d="M30 0v30M0 15h60" stroke="#c8102e" strokeWidth="6" />
    </svg>
  );
}

const OPTIONS: { value: Locale; code: string; name: string; Flag: () => ReactElement }[] = [
  { value: 'pt-PT', code: 'PT', name: 'Português (Portugal)', Flag: FlagPortugal },
  { value: 'en', code: 'EN', name: 'English', Flag: FlagUnitedKingdom },
];

/** Seletor de idioma da barra do topo (bandeira + código). */
export function LocaleSwitcher({
  locale,
  disabled,
  label,
  onChange,
}: {
  locale: Locale;
  disabled?: boolean;
  label: string;
  onChange: (locale: Locale) => void;
}) {
  return (
    <div className="locale-switcher" role="group" aria-label={label}>
      {OPTIONS.map(({ value, code, name, Flag }) => (
        <button
          key={value}
          type="button"
          lang={value}
          title={name}
          aria-label={name}
          aria-pressed={locale === value}
          disabled={disabled}
          onClick={() => locale !== value && onChange(value)}
        >
          <span className="locale-flag">
            <Flag />
          </span>
          <span className="locale-code">{code}</span>
        </button>
      ))}
    </div>
  );
}
