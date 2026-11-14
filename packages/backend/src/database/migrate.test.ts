import { describe, expect, it } from 'vitest';
import { migrationChecksums } from './migrate.js';

describe('migrationChecksums', () => {
  it('produz o mesmo checksum para LF e CRLF e aceita o checksum antigo em CRLF', () => {
    const lf = migrationChecksums('CREATE TABLE a (id INT);\nSELECT 1;\n');
    const crlf = migrationChecksums('CREATE TABLE a (id INT);\r\nSELECT 1;\r\n');
    expect(crlf.checksum).toBe(lf.checksum);
    expect(lf.legacyChecksums).toContain(crlf.legacyChecksums[0]);
  });

  it('distingue alteracoes reais de conteudo', () => {
    const original = migrationChecksums('SELECT 1;\n');
    const changed = migrationChecksums('SELECT 2;\n');
    expect(changed.checksum).not.toBe(original.checksum);
    expect(original.legacyChecksums).not.toContain(changed.legacyChecksums[0]);
  });
});
