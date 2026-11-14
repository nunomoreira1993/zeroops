import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unifiedDiff } from './unified-diff.js';

function applies(path: string, before: string | null, after: string) {
  const dir = mkdtempSync(join(tmpdir(), 'zeroops-diff-'));
  try {
    if (before !== null) writeFileSync(join(dir, path), before);
    writeFileSync(join(dir, 'change.patch'), unifiedDiff(path, before, after));
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--unsafe-paths', 'change.patch'], {
      cwd: dir,
      stdio: 'pipe',
    });
    return readFileSync(join(dir, path), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('unifiedDiff', () => {
  it('sem diferenças devolve vazio', () => {
    expect(unifiedDiff('a.js', 'x\n', 'x\n')).toBe('');
  });

  it('produz um patch que o git aplica (alterações separadas, ficheiro novo)', () => {
    const before = Array.from({ length: 30 }, (_, i) => `linha ${i}`).join('\n') + '\n';
    const after = before.replace('linha 2\n', 'linha dois\n').replace('linha 25\n', '');
    expect(unifiedDiff('pay.js', before, after).match(/^@@/gm)).toHaveLength(2);
    expect(applies('pay.js', before, after)).toBe(after);
    expect(applies('novo.js', null, 'a\nb\n')).toBe('a\nb\n');
  });
});
