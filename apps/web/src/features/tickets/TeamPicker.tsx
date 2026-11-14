import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../../components/Icon';
import { useIdentityLocale } from '../../lib/identity';

export type PickerOption = {
  id: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
};

/** Searchable, keyboard-operated picker kept within the viewport, outside scrolling chat panels. */
export function TeamPicker({
  label,
  value,
  display,
  options,
  disabled = false,
  icon,
  onChange,
}: {
  label: string;
  value: string;
  display: string;
  options: PickerOption[];
  disabled?: boolean;
  icon?: IconName;
  onChange: (value: string) => void;
}) {
  const { t } = useIdentityLocale();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320, maxHeight: 320 });
  const filtered = options.filter((option) =>
    `${option.label} ${option.description ?? ''}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || disabled) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const upwards = below < 240 && above > below;
      const maxHeight = Math.max(80, Math.min(360, upwards ? above : below));
      const height = Math.min(panel.current?.scrollHeight ?? maxHeight, maxHeight);
      setPosition({
        width,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: upwards ? Math.max(8, rect.top - height - 8) : Math.max(8, rect.bottom + 8),
        maxHeight,
      });
    };
    place();
    search.current?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, disabled, filtered.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="team-picker-trigger"
        disabled={disabled}
        aria-label={`${label}: ${display}`}
        aria-haspopup="dialog"
        aria-expanded={open && !disabled}
        aria-controls={open ? id : undefined}
        title={label}
        onClick={() => {
          setQuery('');
          setOpen((current) => !current);
        }}
      >
        {icon && <Icon name={icon} size={14} />}
        <span>{display}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={panel}
            id={id}
            className="team-picker-popover"
            role="dialog"
            aria-label={label}
            style={position}
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                !event.currentTarget.contains(event.relatedTarget)
              )
                setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                if (event.target === search.current && ['Home', 'End'].includes(event.key)) return;
                const nodes = Array.from(
                  panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
                );
                if (!nodes.length) return;
                const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? nodes.length - 1
                      : event.key === 'ArrowDown'
                        ? (index + 1) % nodes.length
                        : index < 0
                          ? nodes.length - 1
                          : (index - 1 + nodes.length) % nodes.length;
                event.preventDefault();
                nodes[next]?.focus();
              }
            }}
          >
            <div className="team-picker-search">
              <Icon name="search" size={15} />
              <input
                ref={search}
                type="search"
                value={query}
                aria-label={t('Pesquisar opções', 'Search options')}
                placeholder={t('Pesquisar…', 'Search…')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div role="listbox" aria-label={label} className="team-picker-options">
              {filtered.map((option, index) => (
                <div key={option.id}>
                  {option.group && filtered[index - 1]?.group !== option.group && (
                    <div className="team-picker-group">{option.group}</div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === option.id}
                    disabled={option.disabled}
                    onClick={() => {
                      onChange(option.id);
                      close();
                    }}
                  >
                    <span>
                      <strong>{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {value === option.id && <Icon name="check" size={15} />}
                  </button>
                </div>
              ))}
              {!filtered.length && (
                <p className="field-hint">{t('Sem resultados.', 'No results.')}</p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
