import { describe, expect, it } from 'vitest';
import { logoForMail } from './mail-branding.js';
import { renderMailHtml } from './mail-layout.js';

describe('marca do projeto nos emails', () => {
  it('converte o logo em PNG com 96 px de altura e ignora formatos que o Outlook não mostra', () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#c00"/></svg>',
    );
    const logo = logoForMail('image/svg+xml', svg)!;
    expect(logo.png.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
    expect(logo.png.readUInt32BE(20)).toBe(96);
    expect(logo.width).toBe(192);
    const wide = logoForMail('image/png', logo.png)!;
    expect(wide.width).toBe(192);
    expect(wide.png.readUInt32BE(20)).toBe(96);
    expect(logoForMail('image/webp', Buffer.from('RIFF0000WEBP'))).toBeNull();
  });

  it('mostra o projeto no cabeçalho com o logo inline ou as iniciais', () => {
    const withLogo = renderMailHtml({
      title: 'Alerta',
      brand: { projectName: 'Pizza Hut', logoCid: 'project-logo@zeroops' },
    });
    expect(withLogo).toContain('src="cid:project-logo@zeroops"');
    expect(withLogo).toContain('Pizza Hut</p>');
    const initials = renderMailHtml({ title: 'Alerta', brand: { projectName: 'Pizza Hut' } });
    expect(initials).toContain('>PH</td>');
    expect(renderMailHtml({ title: 'Alerta' })).toContain('>ZeroOps</td>');
  });
});
