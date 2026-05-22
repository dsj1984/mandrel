/**
 * tests/contract/finalize/post-handoff-comment.test.js
 *
 * Contract test for `postHandoffComment` — Story #2894 / Task #2909
 * (Epic #2880).
 *
 * Asserts:
 *   1. Upsert on first call — invokes `upsertStructuredComment` with
 *      the `epic-handoff` marker on the Epic ticket.
 *   2. Idempotency — a second invocation calls `upsertStructuredComment`
 *      with the same marker. (The real upsert path diffs by marker and
 *      edits in place; we assert that the marker is stable across
 *      invocations rather than re-implementing the diff here.)
 *   3. Body rendering — the rendered body carries the PR number, the PR
 *      URL when supplied, and a JSON fence with the canonical
 *      `epic-handoff` payload shape.
 *   4. Input validation — bad `epicId` / `prNumber` / missing provider
 *      throw TypeError.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  EPIC_HANDOFF_MARKER,
  postHandoffComment,
  renderHandoffBody,
} from '../../../.agents/scripts/lib/orchestration/finalize/post-handoff-comment.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

describe('renderHandoffBody', () => {
  it('renders the PR number, the URL, and a JSON fence', () => {
    const body = renderHandoffBody({
      epicId: 2880,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
    });
    assert.match(body, /Epic handoff/);
    assert.match(body, /Epic: #2880/);
    assert.match(body, /#99/);
    assert.match(body, /https:\/\/github\.com\/o\/r\/pull\/99/);
    assert.match(body, /```json/);
    assert.match(body, /"kind": "epic-handoff"/);
  });

  it('omits the URL link form when prUrl is absent', () => {
    const body = renderHandoffBody({ epicId: 1, prNumber: 7 });
    assert.match(body, /Pull request: #7$/m);
    assert.doesNotMatch(body, /\(http/);
  });
});

describe('postHandoffComment', () => {
  it('upserts the epic-handoff marker on the Epic on first call', async () => {
    const calls = [];
    const upsertFn = async (provider, ticketId, type, body) => {
      calls.push({ ticketId, type, body });
      return { commentId: 12345 };
    };
    const result = await postHandoffComment({
      epicId: 2880,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      provider: { sentinel: true },
      upsertStructuredCommentFn: upsertFn,
      logger: quietLogger(),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ticketId, 2880);
    assert.equal(calls[0].type, EPIC_HANDOFF_MARKER);
    assert.match(calls[0].body, /#99/);
    assert.deepEqual(result, {
      marker: EPIC_HANDOFF_MARKER,
      commentId: 12345,
    });
  });

  it('is idempotent: re-invocation upserts with the same marker (no duplicates)', async () => {
    const calls = [];
    const upsertFn = async (provider, ticketId, type, body) => {
      calls.push({ ticketId, type, body });
      return { commentId: 12345 };
    };
    const opts = {
      epicId: 2880,
      prNumber: 99,
      prUrl: 'https://github.com/o/r/pull/99',
      provider: { sentinel: true },
      upsertStructuredCommentFn: upsertFn,
      logger: quietLogger(),
    };
    await postHandoffComment(opts);
    await postHandoffComment(opts);
    assert.equal(calls.length, 2);
    // Same marker → real upsertStructuredComment would edit in place.
    assert.equal(calls[0].type, EPIC_HANDOFF_MARKER);
    assert.equal(calls[1].type, EPIC_HANDOFF_MARKER);
    // And the body is byte-stable so the marker dedup short-circuits.
    assert.equal(calls[0].body, calls[1].body);
  });

  it('propagates upsert failures', async () => {
    await assert.rejects(
      () =>
        postHandoffComment({
          epicId: 1,
          prNumber: 1,
          provider: { sentinel: true },
          upsertStructuredCommentFn: async () => {
            throw new Error('rate-limited');
          },
          logger: quietLogger(),
        }),
      /rate-limited/,
    );
  });

  it('throws on invalid epicId / prNumber / missing provider', async () => {
    await assert.rejects(
      () =>
        postHandoffComment({
          epicId: 0,
          prNumber: 1,
          provider: {},
        }),
      /epicId/,
    );
    await assert.rejects(
      () =>
        postHandoffComment({
          epicId: 1,
          prNumber: 0,
          provider: {},
        }),
      /prNumber/,
    );
    await assert.rejects(
      () =>
        postHandoffComment({
          epicId: 1,
          prNumber: 1,
          provider: null,
        }),
      /provider/,
    );
  });
});
