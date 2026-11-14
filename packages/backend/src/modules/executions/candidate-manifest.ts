import { z } from 'zod';

/** Contrato do candidato verificado: paths relativos, hashes SHA-256 e evidência de testes aprovados. */
export const candidateManifestSchema = z.strictObject({
  svnRevision: z.string().regex(/^[1-9]\d*$/),
  files: z
    .array(
      z.strictObject({
        path: z
          .string()
          .min(1)
          .max(500)
          .refine(
            (path) =>
              !path.startsWith('/') &&
              !path.includes('\\') &&
              !path.split('/').some((part) => part === '..' || part === '.' || part === '') &&
              !path.includes(':'),
          ),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1),
  tests: z
    .array(
      z.strictObject({
        command: z.string().min(1),
        exitCode: z.literal(0),
        evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1),
  sqlFiles: z.array(z.string().regex(/^sql\/[a-z0-9_]+\.sql$/)),
});
