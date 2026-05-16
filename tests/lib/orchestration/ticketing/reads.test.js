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
  _resetStructuredCommentCache,
  ALL_STATES,
  assertValidStructuredCommentType,
  findStructuredComment,
  isValidStructuredCommentType,
  STATE_LABELS,
  STRUCTURED_COMMENT_TYPES,
  structuredCommentMarker,
  WAVE_TYPE_PATTERN,
} from '../../../../.agents/scripts/lib/orchestration/ticketing/reads.js';

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
    assert.deepEqual(ALL_STATES.slice().sort(), [
      'agent::blocked',
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
