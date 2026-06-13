/**
 * GitHubProvider facade — merge-methods surface.
 *
 * Tests GitHubProvider's getMergeMethods / setMergeMethods methods with a
 * mocked gh-exec facade — no live API calls. Split from the former root
 * monolith `tests/providers-github.test.js` (Story #4084).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestProvider, makeGh } from './_helpers.js';

// ---------------------------------------------------------------------------
// getMergeMethods / setMergeMethods — Task #1373
// ---------------------------------------------------------------------------
describe('GitHubProvider — getMergeMethods()', () => {
  it('returns the merge-method allowlist + auto-merge / delete-branch flags', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo': {
        status: 200,
        json: {
          allow_squash_merge: true,
          allow_rebase_merge: false,
          allow_merge_commit: false,
          allow_auto_merge: true,
          delete_branch_on_merge: true,
          // Other repo knobs the bootstrap doesn't care about — must be
          // filtered out.
          name: 'test-repo',
          private: false,
        },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getMergeMethods();
    assert.deepEqual(result, {
      allow_squash_merge: true,
      allow_rebase_merge: false,
      allow_merge_commit: false,
      allow_auto_merge: true,
      delete_branch_on_merge: true,
    });
  });

  it('returns only fields the API surfaces (sparse response)', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo': {
        status: 200,
        json: { allow_squash_merge: true },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getMergeMethods();
    assert.deepEqual(result, { allow_squash_merge: true });
  });
});

describe('GitHubProvider — setMergeMethods()', () => {
  it('PATCHes only the supplied merge-method fields', async () => {
    const gh = makeGh({
      'PATCH /repos/test-owner/test-repo': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.setMergeMethods({
      allow_squash_merge: true,
      allow_merge_commit: false,
      // Field the API understands but bootstrap doesn't care about — should
      // be dropped so we don't accidentally write it.
      private: true,
    });

    assert.deepEqual(result.patched, [
      'allow_squash_merge',
      'allow_merge_commit',
    ]);
    const patchCall = gh.__exec.calls.find((c) => c.args[2] === 'PATCH');
    assert.ok(patchCall, 'expected PATCH call to fire');
    const body = JSON.parse(patchCall.input);
    assert.deepEqual(body, {
      allow_squash_merge: true,
      allow_merge_commit: false,
    });
  });
});
