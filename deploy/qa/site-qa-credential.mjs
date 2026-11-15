import { randomUUID } from 'node:crypto';

/** Validates the fixed binding before giving a credential to the trusted Git process. */
export function boundCredential(row, binding, decrypt) {
  if (
    !row ||
    row.archived ||
    row.project_id !== binding.projectId ||
    row.id !== binding.repositoryId ||
    row.url !== binding.url ||
    row.base_branch !== 'qa' ||
    !binding.allowedRefs.includes('qa') ||
    !row.credential_ciphertext
  )
    throw new Error('Binding Git QA indisponivel, alterado ou sem credencial.');
  const token = decrypt(row);
  if (!/^[\x21-\x7e]{1,500}$/.test(token)) throw new Error('Credencial Git QA invalida.');
  return token;
}

async function main() {
  if (process.stdout.isTTY)
    throw new Error('Este fornecedor so pode escrever no pipe privado do operador.');
  const { Database } = await import('/app/dist/packages/backend/src/database/database.js');
  const { IdentityCipher } =
    await import('/app/dist/packages/backend/src/modules/identity/identity-security.js');
  const { activeRepository, repositoryCredentialContext, jsonValue } =
    await import('/app/dist/packages/backend/src/modules/development/git-repositories.service.js');
  const { allowedRepositoryRoots, repositoryUrlAllowed } =
    await import('/app/dist/packages/backend/src/modules/development/git.js');
  const env = process.env;
  const binding = {
    projectId: env.ZEROOPS_SITE_PROJECT_ID,
    repositoryId: env.ZEROOPS_SITE_REPOSITORY_ID,
    url: env.ZEROOPS_SITE_SOURCE_REPO,
    allowedRefs: [],
  };
  if (
    !binding.projectId ||
    !binding.repositoryId ||
    !binding.url ||
    !repositoryUrlAllowed(binding.url, allowedRepositoryRoots(env))
  )
    throw new Error('Binding do operador fora das origens autorizadas.');
  const db = new Database(env.ZEROOPS_DATABASE_URL);
  try {
    const project = await db.query('SELECT id FROM projects WHERE id=$1 AND NOT archived', [
      binding.projectId,
    ]);
    if (!project.rowCount) throw new Error('Projeto do operador indisponivel.');
    const row = await activeRepository(db, binding.projectId, binding.repositoryId);
    binding.allowedRefs = jsonValue(row?.allowed_refs, []);
    const cipher = new IdentityCipher(env.ZEROOPS_IDENTITY_KEY);
    const token = boundCredential(row, binding, (repository) =>
      cipher.decrypt(
        repository.credential_ciphertext,
        repositoryCredentialContext(binding.projectId, binding.repositoryId),
      ),
    );
    await db.query(
      `INSERT INTO audit_events(id,action,details)
       VALUES($1,'git_repository.qa_publication_credential',$2)`,
      [
        randomUUID(),
        JSON.stringify({ projectId: binding.projectId, repositoryId: binding.repositoryId }),
      ],
    );
    process.stdout.write(token);
  } finally {
    await db.close();
  }
}

// The operator sends this file over stdin to Node inside the API container.
if (!process.argv[1])
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Fornecedor Git QA indisponivel.');
    process.exitCode = 1;
  });
