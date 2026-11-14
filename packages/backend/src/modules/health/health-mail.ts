import {
  renderMailHtml,
  type MailBrand,
  type MailSection,
  type MailTone,
} from '../smtp/mail-layout.js';

const tagPattern = /^\s*((?:\[[^\]]+\])+)\s*/;

function classify(subject: string): { title: string; badge?: string; tone: MailTone } {
  const tags = (subject.match(tagPattern)?.[1]?.match(/\[([^\]]+)\]/g) ?? []).map((tag) =>
    tag.slice(1, -1),
  );
  const title = subject.replace(tagPattern, '').trim() || subject;
  const badge =
    tags.find((tag) => !/^ZeroOps/i.test(tag)) ?? (/relat/i.test(title) ? 'Relatório' : undefined);
  const key = (badge ?? '').toLowerCase();
  const tone: MailTone = key.startsWith('resolvido')
    ? 'success'
    : /urgente|cr[ií]tic/.test(key)
      ? 'danger'
      : key === 'relatório' || !badge
        ? 'primary'
        : 'warning';
  return { title, badge, tone };
}

/** Converte o corpo em texto estruturado das notificações de Saúde num email HTML. */
export function renderHealthMailHtml(subject: string, body: string, brand?: MailBrand) {
  const { title, badge, tone } = classify(subject);
  const paragraphs: string[] = [];
  const facts: [string, string][] = [];
  const sections: MailSection[] = [];
  let action: { label: string; url: string } | undefined;
  let current: MailSection | null = null;

  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const item = line.match(/^\s*-\s+(.*)$/) ?? (current ? line.match(/^\s{2,}(\S.*)$/) : null);
    if (item && current) {
      current.items.push(item[1] ?? '');
      continue;
    }
    current = null;
    if (!line.trim()) continue;
    const panel = line.match(/^Painel:\s*(https?:\/\/\S+)$/);
    if (panel) {
      action = { label: 'Abrir painel de Saúde', url: panel[1] ?? '' };
      continue;
    }
    if (/:$/.test(line)) {
      current = { title: line.slice(0, -1), items: [] };
      sections.push(current);
      continue;
    }
    const fact = line.match(/^([^:]{1,40}):\s+(.+)$/);
    if (fact?.[1] && fact[2]) facts.push([fact[1], fact[2]]);
    else paragraphs.push(line);
  }

  return renderMailHtml({
    title,
    badge,
    tone,
    eyebrow: 'Saúde',
    preheader: paragraphs[0] ?? title,
    paragraphs,
    facts,
    sections: sections.filter((section) => section.items.length),
    action,
    brand,
  });
}
