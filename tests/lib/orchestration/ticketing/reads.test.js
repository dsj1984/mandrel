/**
 * Story #1848 — Sibling test for the extracted `ticketing/reads`
 * sub-module. Exercises the read-side surface (validators, marker,
 * `findStructuredComment`) directly against the new path so the
 * verb-family split is contractually pinned independent of the
 * facade re-export.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  _peekStructuredCommentCache,
  _resetRawCommentsCache,
  _resetStructuredCommentCache,
  ALL_STATES,
  assertValidStructuredCommentType,
  buildStorylessTicketSnapshot,
  findStructuredComment,
  getProviderRawCommentsCache,
  invalidateRawCommentsCache,
  isValidStructuredCommentType,
  STATE_LABELS,
  STRUCTURED_COMMENT_TYPES,
  structuredCommentMarker,
  WAVE_TYPE_PATTERN,
} from '../../../../.agents/scripts/lib/orchestration/ticketing/reads.js';
import {
  postStructuredComment,
  upsertStructuredComment,
} from '../../../../.agents/scripts/lib/orchestration/ticketing/state.js';

function makeProvider({ existingComments = [] } = {}) {
  const getCommentsCalls = [];
  const comments = [...existingComments];
  return {
    getCommentsCalls,
    async getTicketComments(id) {
      getCommentsCalls.push(id);
      return comments.filter((c) => c.ticketId === id);
    },
  };
}

describe('ticketing/reads — constants and validators', () => {
  it('exports the canonical agent state label set including BLOCKED', () => {
    assert.equal(STATE_LABELS.READY, 'agent::ready');
    assert.equal(STATE_LABELS.EXECUTING, 'agent::executing');
    assert.equal(STATE_LABELS.DONE, 'agent::done');
    // Story #2004 — BLOCKED joined the canonical enum so the HITL pause
    // contract (.agents/instructions.md §1.J) is reachable via the state
    // mutator. ALL_STATES.sort() is asserted alphabetically so the
    // expected array order is insensitive to the source enum order.
    assert.equal(STATE_LABELS.BLOCKED, 'agent::blocked');
    // Story #2144 — CLOSING joined the enum so the intermediate
    // story-close state (between executing and done) is reachable via
    // the canonical state mutator.
    assert.equal(STATE_LABELS.CLOSING, 'agent::closing');
    assert.deepEqual(ALL_STATES.slice().sort(), [
      'agent::blocked',
      'agent::closing',
      'agent::done',
      'agent::executing',
      'agent::ready',
    ]);
  });

  it('STRUCTURED_COMMENT_TYPES includes the canonical types', () => {
    for (const t of [
      'progress',
      'friction',
      'notification',
      'story-init',
      'story-run-progress',
    ]) {
      assert.ok(STRUCTURED_COMMENT_TYPES.includes(t), `expected ${t} in enum`);
    }
  });

  it('isValidStructuredCommentType accepts enum + wave + claim patterns', () => {
    assert.equal(isValidStructuredCommentType('progress'), true);
    assert.equal(isValidStructuredCommentType('wave-3-start'), true);
    assert.equal(WAVE_TYPE_PATTERN.test('wave-3-end'), true);
    assert.equal(isValidStructuredCommentType('claim-42'), true);
    assert.equal(isValidStructuredCommentType('not-a-type'), false);
    assert.equal(isValidStructuredCommentType(''), false);
    assert.equal(isValidStructuredCommentType(123), false);
  });

  it('assertValidStructuredCommentType throws with discoverable message', () => {
    assert.throws(
      () => assertValidStructuredCommentType('nope'),
      /Invalid structured-comment type/,
    );
    assert.doesNotThrow(() => assertValidStructuredCommentType('friction'));
  });

  // Story #2681 — `audit-results` was prescribed by `helpers/epic-audit.md`
  // Step 4 before it was added to the registry; the missing entry made
  // every Phase 4 audit-results upsert fail with "Invalid structured-
  // comment type". Pin the entry so the helper's invocation stays
  // green and the marker can't be silently retired again.
  it('isValidStructuredCommentType accepts the audit-results marker', () => {
    assert.equal(isValidStructuredCommentType('audit-results'), true);
    assert.doesNotThrow(() =>
      assertValidStructuredCommentType('audit-results'),
    );
  });
});

describe('ticketing/reads — structuredCommentMarker', () => {
  it('emits the bare marker when no attrs supplied', () => {
    assert.equal(
      structuredCommentMarker('progress'),
      '<!-- ap:structured-comment type="progress" -->',
    );
  });

  it('appends sorted attrs onto the marker', () => {
    const marker = structuredCommentMarker('wave-run-progress', { wave: 4 });
    assert.equal(
      marker,
      '<!-- ap:structured-comment type="wave-run-progress" wave="4" -->',
    );
  });

  it('skips null/undefined attr values', () => {
    const marker = structuredCommentMarker('progress', {
      wave: null,
      foo: undefined,
    });
    assert.equal(marker, '<!-- ap:structured-comment type="progress" -->');
  });
});

describe('ticketing/reads — findStructuredComment', () => {
  let provider;

  beforeEach(() => {
    provider = makeProvider({
      existingComments: [
        {
          id: 100,
          ticketId: 7,
          body: `${structuredCommentMarker('friction')}\nbody`,
        },
      ],
    });
    _resetStructuredCommentCache(provider);
  });

  it('returns the matching comment on the happy path', async () => {
    const found = await findStructuredComment(provider, 7, 'friction');
    assert.ok(found);
    assert.equal(found.id, 100);
  });

  it('returns null when no comment carries the marker', async () => {
    const found = await findStructuredComment(provider, 7, 'progress');
    assert.equal(found, null);
  });

  it('memoises the resolved row in the per-provider cache', async () => {
    await findStructuredComment(provider, 7, 'friction');
    await findStructuredComment(provider, 7, 'friction');
    assert.equal(
      provider.getCommentsCalls.length,
      1,
      'second call should hit the cache and skip getTicketComments',
    );
    const peek = _peekStructuredCommentCache(provider);
    assert.ok(peek.size >= 1, 'cache should hold at least one entry');
  });
});

describe('ticketing/reads — per-ticketId raw-comments cache (Story #2465)', () => {
  function makeWriteProvider({ existingComments = [] } = {}) {
    const getCommentsCalls = [];
    const postCommentCalls = [];
    const deleteCommentCalls = [];
    let nextId = 1000;
    const comments = [...existingComments];
    return {
      getCommentsCalls,
      postCommentCalls,
      deleteCommentCalls,
      _comments: comments,
      async getTicketComments(id) {
        getCommentsCalls.push(id);
        return comments.filter((c) => c.ticketId === id);
      },
      async postComment(id, { body }) {
        postCommentCalls.push({ id, body });
        const newComment = { id: ++nextId, ticketId: id, body };
        comments.push(newComment);
        return { id: newComment.id };
      },
      async deleteComment(commentId) {
        deleteCommentCalls.push(commentId);
        const idx = comments.findIndex((c) => c.id === commentId);
        if (idx >= 0) comments.splice(idx, 1);
      },
    };
  }

  it('two consecutive findStructuredComment calls for different types share one getTicketComments fetch', async () => {
    const provider = makeWriteProvider({
      existingComments: [
        {
          id: 100,
          ticketId: 42,
          body: `${structuredCommentMarker('friction')}\nfriction-body`,
        },
        {
          id: 101,
          ticketId: 42,
          body: `${structuredCommentMarker('progress')}\nprogress-body`,
        },
      ],
    });
    _resetStructuredCommentCache(provider);
    _resetRawCommentsCache(provider);

    const a = await findStructuredComment(provider, 42, 'friction');
    const b = await findStructuredComment(provider, 42, 'progress');

    assert.equal(a?.id, 100);
    assert.equal(b?.id, 101);
    assert.equal(
      provider.getCommentsCalls.length,
      1,
      'expected exactly one getTicketComments fetch across two different-type lookups',
    );
  });

  it('postStructuredComment evicts the raw-comments cache entry for that ticketId', async () => {
    const provider = makeWriteProvider({
      existingComments: [
        {
          id: 200,
          ticketId: 7,
          body: `${structuredCommentMarker('friction')}\nbody`,
        },
      ],
    });
    _resetStructuredCommentCache(provider);
    _resetRawCommentsCache(provider);

    // Seed the raw cache.
    await findStructuredComment(provider, 7, 'friction');
    const cache = getProviderRawCommentsCache(provider);
    assert.ok(cache.has(7), 'raw cache should be seeded after first lookup');

    await postStructuredComment(provider, 7, 'notification', 'hello');
    assert.equal(
      cache.has(7),
      false,
      'postStructuredComment must evict the raw cache for the mutated ticket',
    );
  });

  it('upsertStructuredComment evicts the raw-comments cache entry for that ticketId', async () => {
    const provider = makeWriteProvider({ existingComments: [] });
    _resetStructuredCommentCache(provider);
    _resetRawCommentsCache(provider);

    // Seed the raw cache via a finder that returns null.
    await findStructuredComment(provider, 9, 'progress');
    const cache = getProviderRawCommentsCache(provider);
    assert.ok(cache.has(9), 'raw cache seeded with empty array');

    await upsertStructuredComment(provider, 9, 'progress', 'body-v1');
    assert.equal(
      cache.has(9),
      false,
      'upsertStructuredComment must evict the raw cache for the mutated ticket',
    );
  });

  it('invalidateRawCommentsCache is a no-op for unknown providers and missing entries', () => {
    // Should not throw or mutate when called with non-provider input.
    invalidateRawCommentsCache(null, 1);
    invalidateRawCommentsCache({}, 1);
    invalidateRawCommentsCache('not-an-object', 1);
  });
});

// Story #3097 (Wave-0 additive, Epic #3078 Strategy B) — Storyless
// snapshot helper. The 3-tier hierarchy collapses to Epic → Feature →
// Story (no Task children), so reading a Story snapshot must surface a
// well-formed object with `subTickets: []` instead of throwing.
describe('ticketing/reads — buildStorylessTicketSnapshot (Story #3097)', () => {
  it('returns null for null/undefined input', () => {
    assert.equal(buildStorylessTicketSnapshot(null), null);
    assert.equal(buildStorylessTicketSnapshot(undefined), null);
  });

  it('produces a well-formed snapshot with empty subTickets when none supplied', () => {
    const ticket = {
      id: 7,
      labels: ['type::story', 'agent::ready'],
      body: 'Story body',
      state: 'open',
    };
    const snapshot = buildStorylessTicketSnapshot(ticket);
    assert.equal(snapshot.id, 7);
    assert.deepEqual(snapshot.subTickets, []);
    // Source fields preserved.
    assert.equal(snapshot.body, 'Story body');
    assert.equal(snapshot.state, 'open');
    assert.deepEqual(snapshot.labels, ['type::story', 'agent::ready']);
  });

  it('threads through caller-supplied subTickets when provided', () => {
    const ticket = { id: 8, labels: ['type::story'] };
    const subs = [{ id: 9 }, { id: 10 }];
    const snapshot = buildStorylessTicketSnapshot(ticket, { subTickets: subs });
    assert.deepEqual(snapshot.subTickets, subs);
  });

  it('ignores non-array opts.subTickets and falls back to []', () => {
    const ticket = { id: 11, labels: ['type::story'] };
    const snapshot = buildStorylessTicketSnapshot(ticket, {
      subTickets: 'not-an-array',
    });
    assert.deepEqual(snapshot.subTickets, []);
  });

  it('does not mutate the input ticket object', () => {
    const ticket = { id: 12, labels: ['type::story'], body: 'x' };
    const before = JSON.stringify(ticket);
    buildStorylessTicketSnapshot(ticket);
    assert.equal(JSON.stringify(ticket), before);
  });
});
