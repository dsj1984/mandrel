/**
 * bootstrap/merge-methods — Epic #1235 Story 5
 *
 * Covers:
 *   - In-target-state: applyMergeMethods is a no-op (status=unchanged).
 *   - Drift + HITL decline: returns skipped, no PATCH.
 *   - Drift + HITL approve: PATCH with target payload lands.
 *   - Per-consumer override: settings.github.mergeMethods overrides
 *     framework defaults before diffing.
 *   - Read failure: surfaces failed without throwing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyMergeMethods,
  diffMergeMethods,
  TARGET_MERGE_METHODS,
} from '../../.agents/scripts/lib/bootstrap/merge-methods.js';

function makeProvider({
  current = {},
  throwsOnGet = null,
  throwsOnSet = null,
} = {}) {
  const calls = { getMergeMethods: 0, setMergeMethods: [] };
  return {
    calls,
    async getMergeMethods() {
      calls.getMergeMethods++;
      if (throwsOnGet) throw throwsOnGet;
      return current;
    },
    async setMergeMethods(settings) {
      calls.setMergeMethods.push(settings);
      if (throwsOnSet) throw throwsOnSet;
      return { patched: Object.keys(settings) };
    },
  };
}

describe('bootstrap/merge-methods diffMergeMethods', () => {
  it('returns null when current matches target exactly', () => {
    const diff = diffMergeMethods(
      { ...TARGET_MERGE_METHODS },
      TARGET_MERGE_METHODS,
    );
    assert.equal(diff, null);
  });

  it('returns a structured diff when any field differs', () => {
    const diff = diffMergeMethods(
      { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
      TARGET_MERGE_METHODS,
    );
    assert.deepEqual(diff, {
      allow_merge_commit: { current: true, proposed: false },
    });
  });
});

describe('bootstrap/applyMergeMethods', () => {
  it('in-target-state: no-op, returns status=unchanged', async () => {
    const provider = makeProvider({ current: { ...TARGET_MERGE_METHODS } });
    let hitl = 0;
    const result = await applyMergeMethods({
      provider,
      settings: {},
      hitlConfirm: async () => {
        hitl++;
        return true;
      },
    });
    assert.equal(result.status, 'unchanged');
    assert.equal(provider.calls.setMergeMethods.length, 0);
    assert.equal(hitl, 0);
  });

  it('drift + HITL decline → skipped, no PATCH', async () => {
    const provider = makeProvider({
      current: { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
    });
    let seen = null;
    const result = await applyMergeMethods({
      provider,
      settings: {},
      hitlConfirm: async ({ current, proposed }) => {
        seen = { current, proposed };
        return false;
      },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'hitl-declined');
    assert.equal(provider.calls.setMergeMethods.length, 0);
    assert.equal(seen.proposed.allow_merge_commit, false);
    assert.equal(seen.current.allow_merge_commit, true);
  });

  it('drift + HITL approve → PATCH lands with target payload', async () => {
    const provider = makeProvider({
      current: { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
    });
    const result = await applyMergeMethods({
      provider,
      settings: {},
      hitlConfirm: async () => true,
    });
    assert.equal(result.status, 'patched');
    assert.equal(provider.calls.setMergeMethods.length, 1);
    assert.deepEqual(provider.calls.setMergeMethods[0], TARGET_MERGE_METHODS);
  });

  it('per-consumer override: settings.github.mergeMethods is applied before diffing', async () => {
    // Consumer opts back into merge commits — drift is now relative to
    // *that* target, not the framework default.
    const consumerTarget = {
      ...TARGET_MERGE_METHODS,
      allow_merge_commit: true,
    };
    const provider = makeProvider({ current: { ...consumerTarget } });
    const result = await applyMergeMethods({
      provider,
      settings: { github: { mergeMethods: { allow_merge_commit: true } } },
      hitlConfirm: async () => true,
    });
    assert.equal(result.status, 'unchanged');
  });

  it('non-TTY default (no hitlConfirm) aborts on drift', async () => {
    const provider = makeProvider({
      current: { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
    });
    const result = await applyMergeMethods({ provider, settings: {} });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'hitl-declined');
  });

  it('read failure: returns failed without throwing', async () => {
    const provider = makeProvider({
      throwsOnGet: new Error('401 Unauthorized'),
    });
    const result = await applyMergeMethods({ provider, settings: {} });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /401 Unauthorized/);
  });

  it('PATCH failure: returns failed without throwing', async () => {
    const provider = makeProvider({
      current: { ...TARGET_MERGE_METHODS, allow_merge_commit: true },
      throwsOnSet: new Error('422 Unprocessable Entity'),
    });
    const result = await applyMergeMethods({
      provider,
      settings: {},
      hitlConfirm: async () => true,
    });
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /422 Unprocessable/);
  });
});
