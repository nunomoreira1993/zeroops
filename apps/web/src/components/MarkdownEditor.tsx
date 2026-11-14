import { useId, useRef, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { formatMarkdown, type MarkdownAction } from './markdown-format';

const actions: { action: MarkdownAction; label: string; text: string }[] = [
  { action: 'bold', label: 'Negrito', text: 'B' },
  { action: 'italic', label: 'Itálico', text: 'I' },
  { action: 'heading', label: 'Título', text: 'H2' },
  { action: 'list', label: 'Lista', text: '☷' },
  { action: 'link', label: 'Ligação', text: 'Link' },
  { action: 'code', label: 'Bloco de código', text: '</>' },
];

export function MarkdownEditor({
  name,
  label,
  value,
  onChange,
  rows = 6,
  minLength,
  maxLength = 20000,
  placeholder,
  describedBy,
  required = true,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  describedBy?: string;
  required?: boolean;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const format = (action: MarkdownAction) => {
    const input = textarea.current;
    if (!input) return;
    const result = formatMarkdown(value, input.selectionStart, input.selectionEnd, action);
    if (result.value.length > maxLength) {
      setError(`A formatação ultrapassa o limite de ${maxLength} caracteres.`);
      return;
    }
    setError(null);
    onChange(result.value);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(result.start, result.end);
    });
  };
  return (
    <div className="markdown-field">
      <label htmlFor={id}>{label}</label>
      <div className="markdown-editor">
        <div className="markdown-toolbar">
          <div role="group" aria-label={`Formatação de ${label}`}>
            {actions.map(({ action, label: title, text }) => (
              <button
                key={action}
                type="button"
                aria-label={title}
                title={title}
                onClick={() => format(action)}
              >
                {text}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-expanded={preview}
            aria-controls={`${id}-preview`}
            onClick={() => setPreview(!preview)}
          >
            {preview ? 'Ocultar pré-visualização' : 'Pré-visualizar'}
          </button>
        </div>
        <textarea
          ref={textarea}
          id={id}
          name={name}
          value={value}
          onChange={(event) => {
            setError(null);
            onChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && ['b', 'i'].includes(event.key.toLowerCase())) {
              event.preventDefault();
              format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
            }
          }}
          required={required}
          rows={rows}
          minLength={minLength}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-describedby={[`${id}-hint`, describedBy].filter(Boolean).join(' ')}
        />
        {preview && (
          <div
            id={`${id}-preview`}
            className="markdown-preview"
            role="region"
            aria-label={`Pré-visualização de ${label}`}
          >
            {value.trim() ? (
              <MarkdownContent>{value}</MarkdownContent>
            ) : (
              <p className="field-hint">Escreva para pré-visualizar.</p>
            )}
          </div>
        )}
      </div>
      <p className="field-hint" id={`${id}-hint`}>
        Markdown: títulos, listas, ligações e código. HTML e imagens externas não são carregados.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
