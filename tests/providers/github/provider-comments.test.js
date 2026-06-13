/**
 * GitHubProvider facade — comments surface.
 *
 * Tests GitHubProvider.postComment() with a mocked gh-exec facade — no live
 * API calls. Split from the former root monolith
 * `tests/providers-github.test.js` (Story #4084).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestProvider, makeGh } from './_helpers.js';

// ---------------------------------------------------------------------------
// postComment
// ---------------------------------------------------------------------------
describe('GitHubProvider — postComment()', () => {
  it('prepends type badge to comment body', async () => {
    const gh = makeGh({
      'POST /issues/42/comments': { status: 201, json: { id: 100 } },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.postComment(42, {
      body: 'Unit tests pass',
      type: 'progress',
    });

    assert.equal(result.commentId, 100);
    const sentBody = JSON.parse(gh.__exec.calls[0].input);
    assert.ok(sentBody.body.includes('🔄 **Progress**'));
    assert.ok(sentBody.body.includes('Unit tests pass'));
  });
});
