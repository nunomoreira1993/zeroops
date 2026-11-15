import { z } from 'zod';

const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').some((part) => part === '..' || part === '.' || part === '') &&
      !path.includes(':'),
  );
const fileSchema = z.strictObject({
  path: relativePath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const testSchema = z.strictObject({
  command: z.string().min(1),
  exitCode: z.literal(0),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const sqlFilesSchema = z.array(z.string().regex(/^sql\/[a-z0-9_]+\.sql$/));
const sha1 = z.string().regex(/^[a-f0-9]{40}$/);

/**
 * Contrato legado (SVN) do candidato verificado: paths relativos, hashes SHA-256 e evidência de
 * testes aprovados. Um manifesto sem `vcs` continua a significar uma revisão SVN.
 */
export const svnCandidateManifestSchema = z.strictObject({
  svnRevision: z.string().regex(/^[1-9]\d*$/),
  files: z.array(fileSchema).min(1),
  tests: z.array(testSchema).min(1),
  sqlFiles: sqlFilesSchema,
});

/**
 * P08: candidato Git. Identifica de forma inequívoca o artefacto revisto e testado (repositório,
 * base e head), com os ficheiros adicionados/alterados medidos no head e os removidos à parte.
 */
export const gitCandidateManifestSchema = z.strictObject({
  vcs: z.strictObject({
    kind: z.literal('git'),
    repositoryId: z.uuid(),
    url: z.string().min(1).max(500),
    branch: z.string().min(1).max(200),
    baseSha: sha1,
    headSha: sha1,
    diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  files: z.array(fileSchema),
  removed: z.array(relativePath).default([]),
  tests: z.array(testSchema.extend({ testedSha: sha1 })).min(1),
  sqlFiles: sqlFilesSchema,
});

/** Aceita os dois formatos; o legado (`svnRevision`) mantém o significado e o hash anteriores. */
export const candidateManifestSchema = z.union([
  svnCandidateManifestSchema,
  gitCandidateManifestSchema,
]);
export type CandidateManifest = z.infer<typeof candidateManifestSchema>;
export type GitCandidateManifest = z.infer<typeof gitCandidateManifestSchema>;

/** Origem normalizada do candidato (manifestos legados sem `vcs` são SVN). */
export function candidateProvenance(manifest: CandidateManifest) {
  return 'vcs' in manifest
    ? {
        kind: 'git' as const,
        repositoryId: manifest.vcs.repositoryId,
        revision: manifest.vcs.headSha,
        base: manifest.vcs.baseSha,
      }
    : { kind: 'svn' as const, repositoryId: null, revision: manifest.svnRevision, base: null };
}
