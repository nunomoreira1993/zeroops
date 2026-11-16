import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundCredential } from '../deploy/qa/site-qa-credential.mjs';

const binding = {
  projectId: 'project',
  repositoryId: 'repository',
  url: 'https://github.com/example/site.git',
  targetBranch: 'qa',
  allowedRefs: ['qa'],
};
const row = {
  project_id: binding.projectId,
  id: binding.repositoryId,
  url: binding.url,
  base_branch: 'qa',
  credential_ciphertext: 'encrypted-test-value',
  archived: false,
};

test('only decrypts the current credential for the exact project, resource and URL', () => {
  let decrypted = 0;
  const decrypt = (value) => {
    assert.equal(value, row);
    decrypted++;
    return 'test-credential';
  };
  assert.equal(boundCredential(row, binding, decrypt), 'test-credential');
  assert.equal(decrypted, 1);
  for (const change of [
    { project_id: 'other' },
    { id: 'other' },
    { url: 'https://github.com/example/other.git' },
    { base_branch: 'main' },
    { archived: true },
    { credential_ciphertext: null },
  ])
    assert.throws(() => boundCredential({ ...row, ...change }, binding, decrypt), /Binding/);
  assert.throws(() => boundCredential(null, binding, decrypt), /Binding/);
  assert.throws(() => boundCredential(row, { ...binding, allowedRefs: [] }, decrypt), /Binding/);
  assert.equal(decrypted, 1);
});

test('does not turn a decryption failure or an invalid credential into success', () => {
  assert.throws(
    () =>
      boundCredential(row, binding, () => {
        throw new Error('decryption failed');
      }),
    /decryption failed/,
  );
  for (const token of ['', 'token\ninjected', 'x'.repeat(501)])
    assert.throws(() => boundCredential(row, binding, () => token), /invalida/);
});

test('uses the configured branch for a different project without changing the provider', () => {
  const other = {
    projectId: 'other-project',
    repositoryId: 'other-repository',
    url: 'https://github.com/another-owner/application.git',
    targetBranch: 'staging',
    allowedRefs: ['staging'],
  };
  const repository = {
    ...row,
    project_id: other.projectId,
    id: other.repositoryId,
    url: other.url,
    base_branch: other.targetBranch,
  };
  assert.equal(boundCredential(repository, other, () => 'fixture-token'), 'fixture-token');
  assert.throws(
    () => boundCredential(repository, { ...other, targetBranch: 'qa' }, () => 'fixture-token'),
    /Binding/,
  );
});
