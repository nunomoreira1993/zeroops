export type MailTone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

export interface MailSection {
  title: string;
  items: string[];
}

export interface MailLayoutInput {
  locale?: 'pt-PT' | 'en';
  /** Texto curto mostrado pelos clientes de email antes de abrir a mensagem. */
  preheader?: string;
  eyebrow?: string;
  title: string;
  tone?: MailTone;
  badge?: string;
  paragraphs?: string[];
  facts?: [string, string][];
  sections?: MailSection[];
  action?: { label: string; url: string };
  note?: string;
  footer?: string;
  /** Projeto em destaque no cabeçalho; o logo é referenciado por CID (anexo inline). */
  brand?: MailBrand;
}

export interface MailBrand {
  projectName: string;
  logoCid?: string;
  /** Largura do logo em px para 40 px de altura (logos não quadrados). */
  logoWidth?: number;
}

const palette = {
  page: '#f5f6fa',
  card: '#ffffff',
  border: '#e9ebf0',
  text: '#071437',
  body: '#4b5675',
  muted: '#78829d',
  primary: '#c74c32',
};

const tones: Record<MailTone, { color: string; soft: string }> = {
  primary: { color: '#c74c32', soft: '#fdf1ee' },
  success: { color: '#17c653', soft: '#eafff1' },
  warning: { color: '#c48a00', soft: '#fff8dd' },
  danger: { color: '#f8285a', soft: '#ffeef3' },
  neutral: { color: '#4b5675', soft: '#f1f1f4' },
};

// O Outlook (motor do Word) usa Times New Roman se a primeira fonte da lista não existir no Windows.
const font =
  "font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;";

/** Data/hora legível em hora de Lisboa, por exemplo `10/11/2026, 15:40 (hora de Lisboa)`. */
export function formatLisbonTime(date: Date, locale: 'pt-PT' | 'en' = 'pt-PT') {
  const en = locale === 'en';
  const value = new Intl.DateTimeFormat(en ? 'en-GB' : 'pt-PT', {
    timeZone: 'Europe/Lisbon',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  return `${value} (${en ? 'Lisbon time' : 'hora de Lisboa'})`;
}

/** Escapa texto para inserção segura em HTML de email. */
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Converte URLs http(s) de texto já escapado em ligações. */
function linkify(escaped: string) {
  return escaped.replace(
    /https?:\/\/[^\s<>"']+/g,
    (match) =>
      `<a href="${match}" style="color:${palette.primary};text-decoration:none;word-break:break-all;">${match}</a>`,
  );
}

const text = (value: string) => linkify(escapeHtml(value));

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('') || 'Z';

/** Cabeçalho: logo/iniciais e nome do projeto em destaque, ou a marca ZeroOps quando não há projeto. */
function renderHeader(brand: MailBrand | undefined, lang: 'pt-PT' | 'en') {
  if (!brand)
    return `<tr><td style="padding:0 4px 18px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="30" height="30" align="center" style="background:${palette.primary};border-radius:7px;${font}font-size:15px;font-weight:700;color:#ffffff;">Z</td><td style="padding-left:10px;${font}font-size:17px;font-weight:700;color:${palette.text};">ZeroOps</td></tr></table></td></tr>`;
  const name = escapeHtml(brand.projectName);
  const width = Math.min(160, Math.max(40, Math.round(brand.logoWidth ?? 40)));
  const mark = brand.logoCid
    ? `<td height="48" align="center" valign="middle" bgcolor="${palette.card}" style="background:${palette.card};border:1px solid ${palette.border};border-radius:10px;padding:4px 6px;"><img src="cid:${escapeHtml(brand.logoCid)}" width="${width}" height="40" alt="${name}" style="display:block;width:${width}px;height:40px;border:0;outline:none;"></td>`
    : `<td width="48" height="48" align="center" valign="middle" bgcolor="${palette.primary}" style="background:${palette.primary};border-radius:10px;${font}font-size:18px;font-weight:700;color:#ffffff;">${escapeHtml(initials(brand.projectName))}</td>`;
  const via = lang === 'en' ? 'Notification via ZeroOps' : 'Notificação via ZeroOps';
  return `<tr><td style="padding:0 4px 18px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${mark}<td style="padding-left:14px;"><p style="margin:0;${font}font-size:20px;line-height:26px;font-weight:700;color:${palette.text};">${name}</p><p style="margin:2px 0 0;${font}font-size:12px;line-height:16px;color:${palette.muted};">${via}</p></td></tr></table></td></tr>`;
}

/** Renderiza um email HTML com tabelas e estilos inline, compatível com Outlook e webmail. */
export function renderMailHtml(input: MailLayoutInput) {
  const tone = tones[input.tone ?? 'primary'];
  const lang = input.locale === 'en' ? 'en' : 'pt-PT';
  const action = input.action ? safeUrl(input.action.url) : null;
  const blocks: string[] = [];

  for (const paragraph of input.paragraphs ?? [])
    blocks.push(
      `<p style="margin:0 0 14px;${font}font-size:14px;line-height:22px;color:${palette.body};">${text(paragraph)}</p>`,
    );

  if (input.facts?.length)
    blocks.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border:1px solid ${palette.border};border-radius:8px;border-collapse:separate;">${input.facts
        .map(
          ([label, value], index) =>
            `<tr><td style="${font}padding:10px 14px;font-size:13px;color:${palette.muted};width:38%;vertical-align:top;${index ? `border-top:1px solid ${palette.border};` : ''}">${escapeHtml(label)}</td><td style="${font}padding:10px 14px;font-size:13px;font-weight:600;color:${palette.text};vertical-align:top;${index ? `border-top:1px solid ${palette.border};` : ''}">${text(value)}</td></tr>`,
        )
        .join('')}</table>`,
    );

  for (const section of input.sections ?? [])
    blocks.push(
      `<p style="margin:8px 0 8px;${font}font-size:13px;font-weight:600;color:${palette.text};">${escapeHtml(section.title)}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${section.items
        .map(
          (item) =>
            `<tr><td width="14" style="${font}font-size:13px;line-height:20px;color:${tone.color};vertical-align:top;padding:3px 0;">&#8226;</td><td style="${font}font-size:13px;line-height:20px;color:${palette.body};padding:3px 0;">${text(item)}</td></tr>`,
        )
        .join('')}</table>`,
    );

  if (input.action && action)
    blocks.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 14px;"><tr><td bgcolor="${palette.primary}" style="border-radius:6px;background:${palette.primary};padding:11px 22px;mso-padding-alt:11px 22px;"><a href="${escapeHtml(action)}" style="display:inline-block;${font}font-size:14px;line-height:18px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(input.action.label)}</a></td></tr></table><p style="margin:0 0 14px;${font}font-size:12px;line-height:18px;color:${palette.muted};">${lang === 'en' ? 'If the button does not work, copy this link:' : 'Se o botão não funcionar, copie esta ligação:'}<br><a href="${escapeHtml(action)}" style="color:${palette.primary};text-decoration:none;word-break:break-all;">${escapeHtml(action)}</a></p>`,
    );

  if (input.note)
    blocks.push(
      `<p style="margin:0 0 4px;${font}font-size:12px;line-height:18px;color:${palette.muted};">${text(input.note)}</p>`,
    );

  const badge = input.badge
    ? `<span style="display:inline-block;margin:0 0 12px;padding:3px 10px;border-radius:999px;background:${tone.soft};color:${tone.color};${font}font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;">${escapeHtml(input.badge)}</span><br>`
    : '';
  const eyebrow = input.eyebrow
    ? `<p style="margin:0 0 6px;${font}font-size:12px;font-weight:500;color:${palette.muted};">${escapeHtml(input.eyebrow)}</p>`
    : '';
  const footer =
    input.footer ??
    (lang === 'en'
      ? 'Automatic message from ZeroOps. Please do not reply to this email.'
      : 'Mensagem automática do ZeroOps. Não responda a este email.');

  return `<!doctype html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(input.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>table,td,p,a,h1,span{font-family:'Segoe UI',Arial,sans-serif!important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${palette.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(input.preheader ?? input.title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${palette.page}" style="background:${palette.page};"><tr><td align="center" style="padding:32px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">
${renderHeader(input.brand, lang)}
<tr><td bgcolor="${palette.card}" style="background:${palette.card};border:1px solid ${palette.border};border-radius:12px;overflow:hidden;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="4" bgcolor="${tone.color}" style="background:${tone.color};font-size:4px;line-height:4px;mso-line-height-rule:exactly;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 26px;">${badge}${eyebrow}<h1 style="margin:0 0 16px;${font}font-size:20px;line-height:28px;font-weight:600;color:${palette.text};">${escapeHtml(input.title)}</h1>${blocks.join('\n')}</td></tr></table>
</td></tr>
<tr><td align="center" style="padding:18px 16px 0;${font}font-size:12px;line-height:18px;color:${palette.muted};">${escapeHtml(footer)}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}
