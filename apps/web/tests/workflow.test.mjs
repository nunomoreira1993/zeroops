import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableTransitions, canPublishProposal } from '../src/features/tickets/workflow.ts';

test('clients can answer information requests but cannot author technical proposals or cancel', () => {
  assert.deepEqual(
    availableTransitions('client', 'awaiting_information').map((option) => option.action),
    ['resume'],
  );
  assert.deepEqual(availableTransitions('client', 'new'), []);
  assert.equal(canPublishProposal('client', 'awaiting_client'), false);
});

test('active or validated work cannot be cancelled or have its proposal replaced, including by admin', () => {
  for (const role of ['technical', 'admin']) {
    for (const status of [
      'implementing',
      'awaiting_qa',
      'awaiting_release',
      'deploying',
      'resolved',
    ]) {
      assert.equal(canPublishProposal(role, status), false, `${role}/${status}`);
      assert.equal(
        availableTransitions(role, status).some((option) => option.action === 'cancel'),
        false,
      );
    }
  }
});

test('revising a pending proposal is available only to authoring profiles and terminal tickets can reopen', () => {
  for (const role of ['technical', 'admin']) {
    assert.equal(canPublishProposal(role, 'awaiting_client'), true);
    assert.equal(canPublishProposal(role, 'awaiting_technical'), true);
  }
  for (const role of ['client', 'technical', 'qa', 'release', 'admin']) {
    assert.deepEqual(
      availableTransitions(role, 'resolved').map((option) => option.action),
      ['reopen'],
    );
    assert.equal(canPublishProposal(role, 'cancelled'), false);
  }
});
