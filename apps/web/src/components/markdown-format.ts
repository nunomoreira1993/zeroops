export type MarkdownAction = 'bold' | 'italic' | 'heading' | 'list' | 'link' | 'code';

export function formatMarkdown(value: string, start: number, end: number, action: MarkdownAction) {
  let selection = value.slice(start, end);
  let prefix: string;
  let suffix: string;
  switch (action) {
    case 'heading':
    case 'list': {
      const lastSelected = end > start && value[end - 1] === '\n' ? end - 1 : end;
      start = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = value.indexOf('\n', lastSelected);
      end = lineEnd < 0 ? value.length : lineEnd;
      const marker = action === 'heading' ? '## ' : '- ';
      selection = value.slice(start, end) || (action === 'heading' ? 'Título' : 'Item');
      const inserted = selection
        .split('\n')
        .map((line) => marker + line)
        .join('\n');
      return {
        value: value.slice(0, start) + inserted + value.slice(end),
        start: start + marker.length,
        end: start + inserted.length,
      };
    }
    case 'bold':
      prefix = suffix = '**';
      selection ||= 'texto';
      break;
    case 'italic':
      prefix = suffix = '*';
      selection ||= 'texto';
      break;
    case 'link':
      prefix = '[';
      suffix = '](https://exemplo.pt)';
      selection ||= 'descrição';
      break;
    case 'code':
      prefix = `${start > 0 && value[start - 1] !== '\n' ? '\n' : ''}\`\`\`\n`;
      suffix = `\n\`\`\`${end < value.length && value[end] !== '\n' ? '\n' : ''}`;
      selection ||= 'código';
      break;
  }
  return {
    value: value.slice(0, start) + prefix + selection + suffix + value.slice(end),
    start: start + prefix.length,
    end: start + prefix.length + selection.length,
  };
}
