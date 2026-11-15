import { describe, expect, it } from 'vitest';
import { candidateManifestSchema, candidateProvenance } from './candidate-manifest.js';

const hash = 'a'.repeat(64);
const sha = 'b'.repeat(40);

describe('manifesto de candidato Git/SVN', () => {
  it('mantém os manifestos legados SVN válidos e com o mesmo significado', () => {
    const legacy = {
      svnRevision: '1234',
      files: [{ path: 'www/index.php', sha256: hash }],
      tests: [{ command: 'php -l www/index.php', exitCode: 0, evidenceHash: hash }],
      sqlFiles: [],
    };
    const parsed = candidateManifestSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(candidateProvenance(parsed)).toEqual({
      kind: 'svn',
      repositoryId: null,
      revision: '1234',
      base: null,
    });
  });

  it('aceita Git com base/head e testes associados ao SHA testado', () => {
    const parsed = candidateManifestSchema.parse({
      vcs: {
        kind: 'git',
        repositoryId: '00000000-0000-4000-8000-000000000001',
        url: 'file:///repos/sandbox.git',
        branch: 'zeroops/t-1',
        baseSha: 'c'.repeat(40),
        headSha: sha,
        diffSha256: hash,
      },
      files: [],
      removed: ['old.txt'],
      tests: [{ command: 'node test.js', exitCode: 0, evidenceHash: hash, testedSha: sha }],
      sqlFiles: [],
    });
    expect(candidateProvenance(parsed)).toMatchObject({ kind: 'git', revision: sha });
  });

  it('rejeita testes falhados, testes sem SHA e mistura de formatos', () => {
    const git = {
      vcs: {
        kind: 'git',
        repositoryId: '00000000-0000-4000-8000-000000000001',
        url: 'file:///repos/sandbox.git',
        branch: 'zeroops/t-1',
        baseSha: sha,
        headSha: sha,
        diffSha256: hash,
      },
      files: [],
      tests: [{ command: 'node test.js', exitCode: 0, evidenceHash: hash, testedSha: sha }],
      sqlFiles: [],
    };
    expect(candidateManifestSchema.safeParse(git).success).toBe(true);
    expect(
      candidateManifestSchema.safeParse({
        ...git,
        tests: [{ ...git.tests[0], exitCode: 1 }],
      }).success,
    ).toBe(false);
    expect(
      candidateManifestSchema.safeParse({
        ...git,
        tests: [{ command: 'x', exitCode: 0, evidenceHash: hash }],
      }).success,
    ).toBe(false);
    expect(candidateManifestSchema.safeParse({ ...git, svnRevision: '1' }).success).toBe(false);
  });
});
