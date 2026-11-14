import { describe, expect, it } from 'vitest';
import { renderHealthMailHtml } from './health-mail.js';

describe('renderHealthMailHtml', () => {
  it('turns the structured text body into facts, lists and a panel button', () => {
    const html = renderHealthMailHtml(
      '[ZeroOps Saúde][URGENTE] Disponibilidade do site',
      [
        'Estado: Falha',
        '',
        'Detalhe: HTTP 503 <script>alert(1)</script>',
        'Alertas abertos:',
        '- [alto] Erros PHP',
        'Painel: https://tickets.example.test/#health',
      ].join('\n'),
    );
    expect(html).toContain('>URGENTE</span>');
    expect(html).toContain('#f8285a');
    expect(html).toContain('>Disponibilidade do site</h1>');
    expect(html).toContain('>Estado</td>');
    expect(html).toContain('[alto] Erros PHP');
    expect(html).toContain('href="https://tickets.example.test/#health"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('marks resolved notifications as success', () => {
    const html = renderHealthMailHtml(
      '[ZeroOps Saúde][RESOLVIDO] CPU',
      'A verificação voltou ao normal.',
    );
    expect(html).toContain('#17c653');
    expect(html).toContain('A verificação voltou ao normal.');
  });
});
