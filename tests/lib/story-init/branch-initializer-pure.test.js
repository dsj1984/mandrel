/**
 * Pure-helper tests for `branch-initializer`. The impure orchestration
 * (`bootstrapWorktree`) is exercised end-to-end by `story-init.js`
 * smoke runs; here we lock down the small predicates it composes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { planStoryBranchSeed } from '../../../.agents/scripts/lib/story-init/branch-initializer.js';

test('planStoryBranchSeed: local branch present → no-op', () => {
  assert.equal(
    planStoryBranchSeed({ localHas: true, remoteHas: false }),
    'none',
  );
  assert.equal(
    planStoryBranchSeed({ localHas: true, remoteHas: true }),
    'none',
  );
});

test('planStoryBranchSeed: only remote → fetch into local', () => {
  assert.equal(
    planStoryBranchSeed({ localHas: false, remoteHas: true }),
    'fetch',
  );
});

test('planStoryBranchSeed: neither side has it → create from epic', () => {
  assert.equal(
    planStoryBranchSeed({ localHas: false, remoteHas: false }),
    'create',
  );
});
