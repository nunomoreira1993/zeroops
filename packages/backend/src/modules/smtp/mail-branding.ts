import { Resvg } from '@resvg/resvg-js';
import type { Database } from '../../database/database.js';
import type { MailBrand } from './mail-layout.js';

/** Anexo inline (CID) no formato aceite pelo nodemailer; só Buffer, sem acesso a ficheiros/URLs. */
export interface MailInlineAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  cid: string;
}

/** Marca do projeto para o cabeçalho do email e respetivo anexo do logo, se existir. */
export interface ProjectMailBrand {
  brand: MailBrand;
  attachments: MailInlineAttachment[];
}

/** Ponto de extensão usado pelos remetentes; permite testes sem base de dados. */
export type MailBrandResolver = (
  projectId: string | null | undefined,
) => Promise<ProjectMailBrand | null>;

const LOGO_CID = 'project-logo@zeroops';
// Renderizado com o dobro do tamanho mostrado (40 px) para ecrãs de alta densidade.
const LOGO_RENDER_PX = 96;
const LOGO_HEIGHT = 40;
const LOGO_MAX_WIDTH = 160;

/**
 * Converte o logo guardado num PNG com altura fixa, apto para email. O Outlook desktop não mostra
 * SVG nem WebP, por isso tudo é rasterizado; PNG/JPEG são embebidos num SVG para ficarem à mesma escala.
 */
export function logoForMail(mime: string, data: Buffer): { png: Buffer; width: number } | null {
  let svg: Buffer;
  if (mime === 'image/svg+xml') svg = data;
  else if (mime === 'image/png' || mime === 'image/jpeg') {
    // PNG traz as dimensões no cabeçalho IHDR; no JPEG usa-se uma caixa quadrada (proporção mantida).
    const png = mime === 'image/png' && data.length > 24;
    const width = png ? data.readUInt32BE(16) : 1;
    const height = png ? data.readUInt32BE(20) : 1;
    svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><image width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" xlink:href="data:${mime};base64,${data.toString('base64')}"/></svg>`,
    );
  } else return null;
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'height', value: LOGO_RENDER_PX },
    font: { loadSystemFonts: false },
  }).render();
  return { png: rendered.asPng(), width: rendered.width };
}

/** Lê nome e logo do projeto e prepara a marca do email, com cache por versão do logo. */
export class MailBranding {
  private readonly cache = new Map<string, ProjectMailBrand>();

  constructor(private readonly db: Database) {}

  /** Devolve a marca do projeto, ou `null` sem projeto; falhas no logo caem para as iniciais. */
  async forProject(projectId: string | null | undefined): Promise<ProjectMailBrand | null> {
    if (!projectId) return null;
    const head = await this.db.query<{ name: string; logo_version: number | null }>(
      'SELECT name,logo_version FROM projects WHERE id=$1',
      [projectId],
    );
    const project = head.rows[0];
    if (!project) return null;
    const key = `${projectId}:${project.logo_version ?? 0}:${project.name}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const brand: ProjectMailBrand = {
      brand: { projectName: project.name },
      attachments: [],
    };
    const logo = await this.logo(projectId);
    if (logo) {
      brand.brand.logoCid = LOGO_CID;
      brand.brand.logoWidth = Math.min(
        LOGO_MAX_WIDTH,
        Math.max(LOGO_HEIGHT, Math.round((logo.width * LOGO_HEIGHT) / LOGO_RENDER_PX)),
      );
      brand.attachments.push({
        filename: 'logo.png',
        content: logo.png,
        contentType: 'image/png',
        cid: LOGO_CID,
      });
    }
    for (const stale of [...this.cache.keys()].filter((k) => k.startsWith(`${projectId}:`)))
      this.cache.delete(stale);
    this.cache.set(key, brand);
    return brand;
  }

  private async logo(projectId: string) {
    const result = await this.db.query<{ logo_mime: string; logo_data: Buffer }>(
      'SELECT logo_mime,logo_data FROM projects WHERE id=$1 AND logo_mime IS NOT NULL',
      [projectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    try {
      return logoForMail(row.logo_mime, Buffer.from(row.logo_data));
    } catch {
      return null;
    }
  }
}
