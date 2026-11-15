import { describe, expect, it } from 'vitest';
import { repositoryView, type GitRepositoryRow } from './git-repositories.service.js';

const row: GitRepositoryRow = {
  id: 'repository-id',
  project_id: 'project-id',
  name: 'Pizza Hut website',
  url: 'https://github.com/Deloitte-Portugal/pizzahut.git',
  base_branch: 'qa',
  allowed_refs: '["qa"]',
  setup_commands: '[]',
  test_commands: '[{"name":"smoke","command":"test -s zeroops-check.txt"}]',
  pr_provider: 'github',
  credential_ciphertext: 'encrypted-value',
  credential_provider: 'github_cli',
  credential_identity: 'numoreira_deloitte',
  version: 2,
  archived: false,
  verified_at: new Date('2026-11-15T09:00:00.000Z'),
  verified_base_sha: '2c38b0f581dfa7e9dc6b31b39219377b93b54b3f',
  verification_error: null,
  updated_at: new Date('2026-11-15T09:00:00.000Z'),
};

describe('repositoryView', () => {
  it('exposes GitHub CLI provenance but never the encrypted credential', () => {
    const view = repositoryView(row);

    expect(view).toMatchObject({
      hasCredential: true,
      credentialProvider: 'github_cli',
      credentialIdentity: 'numoreira_deloitte',
    });
    expect(view).not.toHaveProperty('credential_ciphertext');
    expect(JSON.stringify(view)).not.toContain('encrypted-value');
  });

  it('does not expose a credential identity after its credential is removed', () => {
    const view = repositoryView({
      ...row,
      credential_ciphertext: null,
      credential_identity: 'numoreira_deloitte',
    });

    expect(view.hasCredential).toBe(false);
    expect(view.credentialIdentity).toBeNull();
  });
});
