// tests/lib/orchestration/lifecycle/listener-comment.test.js
/**
 * Unit test for StructuredCommentPoster — verifies marker-keyed upsert
 * idempotency and the (event, seqId) cache (Story #2239 Task #2242,
 * Acceptance Spec AC-10).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  markerTypeFor,
  renderBody,
  StructuredCommentPoster,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/structured-comment-poster.js';

describe('markerTypeFor', () => {
  it('returns wave-<n>-start for wave.start with a valid waveIndex', () => {
    assert.equal(markerTypeFor('wave.start', { waveIndex: 0 }), 'wave-0-start');
    assert.equal(markerTypeFor('wave.start', { waveIndex: 7 }), 'wave-7-start');
  });
  it('returns wave-<n>-end for wave.end with a valid waveIndex', () => {
    assert.equal(markerTypeFor('wave.end', { waveIndex: 3 }), 'wave-3-end');
  });
  it('returns epic-blocked for epic.blocked', () => {
    assert.equal(markerTypeFor('epic.blocked', { reason: 'r' }), 'epic-blocked');
  });
  it('returns null for unknown / malformed events', () => {
    assert.equal(markerTypeFor('wave.start', {}), null);
    assert.equal(markerTypeFor('wave.end', { waveIndex: -1 }), null);
    assert.equal(markerTypeFor('story.merged', { storyId: 1 }), null);
  });
});

describe('renderBody', () => {
  it('embeds the event kind + payload as a fenced JSON block', () => {
    const body = renderBody('wave.start', { waveIndex: 0, storyIds: [1, 2] });
    assert.match(body, /Wave 1 starting/);
    assert.match(body, /Stories: 2/);
    assert.match(body, /```json[\s\S]+wave\.start[\s\S]+```/);
  });
  it('counts done/skipped/bad outcomes correctly for wave.end', () => {
    const body = renderBody('wave.end', {
      waveIndex: 1,
      outcomes: { 1: 'done', 2: 'done', 3: 'skipped', 4: 'failed' },
    });
    assert.match(body, /2 done · 1 skipped · 1 failed\/blocked/);
    assert.match(body, /Wave 2 halted/);
  });
});

describe('StructuredCommentPoster (bus integration)', () => {
  function buildPoster({ upserts }) {
    return new StructuredCommentPoster({
      provider: { tag: 'p' },
      epicId: 555,
      upsertStructuredComment: async (provider, ticketId, type, body) => {
        upserts.push({ ticketId, type, body });
      },
      logger: { warn() {}, debug() {} },
    });
  }

  it('upserts exactly one comment per (event, seqId)', async () => {
    const bus = new Bus();
    const upserts = [];
    const poster = buildPoster({ upserts });
    poster.register(bus);

    await bus.emit('wave.start', { waveIndex: 0, storyIds: [101, 102] });
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].type, 'wave-0-start');
    assert.equal(upserts[0].ticketId, 555);

    // Second invocation with the same seqId — short-circuits.
    await poster.handle({
      event: 'wave.start',
      seqId: 1,
      payload: { waveIndex: 0, storyIds: [101, 102] },
    });
    assert.equal(
      upserts.length,
      1,
      'duplicate (event, seqId) must NOT post a second comment',
    );
  });

  it('uses distinct marker types for distinct wave indexes', async () => {
    const bus = new Bus();
    const upserts = [];
    const poster = buildPoster({ upserts });
    poster.register(bus);

    await bus.emit('wave.start', { waveIndex: 0, storyIds: [1] });
    await bus.emit('wave.end', { waveIndex: 0, outcomes: { 1: 'done' } });
    await bus.emit('wave.start', { waveIndex: 1, storyIds: [2] });
    await bus.emit('wave.end', { waveIndex: 1, outcomes: { 2: 'done' } });

    const types = upserts.map((u) => u.type);
    assert.deepEqual(types, [
      'wave-0-start',
      'wave-0-end',
      'wave-1-start',
      'wave-1-end',
    ]);
  });

  it('marker collision short-circuits to an upsert (does not write a new comment)', async () => {
    // The injected upsert fn is a pure stub here — its job is to model
    // the canonical upsertStructuredComment behaviour, which is
    // "find-by-marker; edit-or-create". We verify that the poster does
    // not bypass the upsert path by direct create, by asserting the
    // single API call surface remains `upsertStructuredComment`.
    const bus = new Bus();
    let createCount = 0;
    let upsertCount = 0;
    const fakeUpsert = async () => {
      upsertCount += 1;
      // No create path even in the stub — match canonical behaviour.
    };
    const poster = new StructuredCommentPoster({
      provider: {
        async createComment() {
          createCount += 1;
        },
      },
      epicId: 555,
      upsertStructuredComment: fakeUpsert,
      logger: { warn() {}, debug() {} },
    });
    poster.register(bus);

    await bus.emit('wave.start', { waveIndex: 0, storyIds: [1] });
    poster.resetSeen();
    // After resetting the seqId cache, a re-emit with a fresh seqId
    // hits the upsert path again — but still NEVER createComment.
    await bus.emit('wave.start', { waveIndex: 0, storyIds: [1] });
    assert.equal(upsertCount, 2, 'each fresh seqId routes through upsert');
    assert.equal(createCount, 0, 'never bypasses the upsert path');
  });

  it('logs and swallows upsert errors rather than crashing the bus', async () => {
    const bus = new Bus();
    const warnings = [];
    const poster = new StructuredCommentPoster({
      provider: {},
      epicId: 555,
      upsertStructuredComment: async () => {
        throw new Error('network down');
      },
      logger: {
        warn(msg) {
          warnings.push(msg);
        },
        debug() {},
      },
    });
    poster.register(bus);
    await bus.emit('wave.start', { waveIndex: 0, storyIds: [1] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /upsert wave-0-start failed/);
  });
});
