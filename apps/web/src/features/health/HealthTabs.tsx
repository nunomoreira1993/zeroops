import type { KeyboardEvent } from 'react';

export interface HealthTab<T extends string> {
  id: T;
  label: string;
  badge?: number;
}

/** Barra de tabs acessível (setas esquerda/direita) usada na página Saúde e nas suas secções. */
export function HealthTabBar<T extends string>({
  tabs,
  active,
  onSelect,
  idPrefix,
  label,
  variant = 'main',
}: {
  tabs: HealthTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  idPrefix: string;
  label: string;
  variant?: 'main' | 'sub';
}) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === active);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (!next) return;
    onSelect(next.id);
    document.getElementById(`${idPrefix}-tab-${next.id}`)?.focus();
  };
  return (
    <div
      className={`health-tabs health-tabs-${variant}`}
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          id={`${idPrefix}-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          className={`health-tab${tab.id === active ? ' is-active' : ''}`}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
          {tab.badge ? <span className="health-tab-badge">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export type HealthSection =
  'resumo' | 'alarmistica' | 'graficos' | 'historico' | 'notificacoes' | 'configuracao';

/** Interpreta `#health/<secção>/<verificação>`; secções desconhecidas voltam ao resumo. */
export function parseHealthRoute(route: string): { section: HealthSection; check: string | null } {
  const [, section, check] = route.split('/');
  const known: HealthSection[] = [
    'alarmistica',
    'graficos',
    'historico',
    'notificacoes',
    'configuracao',
  ];
  return {
    section: known.includes(section as HealthSection) ? (section as HealthSection) : 'resumo',
    check: section === 'historico' && check && /^[a-z0-9-]{1,60}$/.test(check) ? check : null,
  };
}

export const healthHref = (section: HealthSection, check?: string | null) =>
  section === 'resumo' ? '#health' : `#health/${section}${check ? `/${check}` : ''}`;
