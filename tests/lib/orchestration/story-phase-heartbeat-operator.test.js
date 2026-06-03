import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  latestHeartbeatForOwner,
  normalizeOperatorHandle,
} from '../../../.agents/scripts/lib/orchestration/ticket-lease.js';
import { runStoryPhase } from '../../../.agents/scripts/story-phase.js';

// ---------------------------------------------------------------------------
// Contract-style regression guard for audit #3513 (Critical).
//
// The Epic-lease liveness check (`/epic-deliver`) resolves a foreign owner's
// last `story.heartbeat` via `latestHeartbeatForOwner({ epicId, owner })`,
// which matches records on `payload.operator === owner`. The only production
// heartbeat emitter is `story-phase.js` (`runStoryPhase`). If that producer
// never stamps `operator` onto the record, `latestHeartbeatForOwner` always
// returns null → `isClaimLive(null)` is false → a live foreign /epic-deliver
// claim is silently reclaimed.
//
// This test drives the REAL `runStoryPhase` emit path (no hand-seeded
// `operator` in the ledger) with a config carrying `github.operatorHandle`,
// then asserts `latestHeartbeatForOwner` resolves the just-emitted record for
// the same normalized owner the Epic lease assigns. It is the regression guard
// that the producer now emits `operator`.
// ---------------------------------------------------------------------------

const EPIC_ID = 9;
const STORY_ID = 104;
const OPERATOR_RAW = '@alice';
const OPERATOR = normalizeOperatorHandle(OPERATOR_RAW); // 'alice'

/**
 * In-memory provider exposing the surface `runStoryPhase` exercises:
 * getTicket (Story body carries the `Epic: #N` reference), getTicketComments
 * (for the prior-branch / snapshot lookups), postComment / deleteComment
 * (structured-comment upsert), and updateTicket. No network.
 */
function makeProvider({ storyBody }) {
  const comments = [];
  let nextId = 1;
  return {
    comments,
    async getTicket(id) {
      return { id, body: storyBody, assignees: [] };
    },
    async getTicketComments(_id) {
      return comments;
    },
    async postComment(_id, { body }) {
      const comment = { id: nextId++, body };
      comments.push(comment);
      return { commentId: comment.id, id: comment.id };
    },
    async deleteComment(commentId) {
      const idx = comments.findIndex((c) => c.id === commentId);
      if (idx >= 0) comments.splice(idx, 1);
    },
    async updateTicket() {},
  };
}

let ledgerDir;
beforeEach(() => {
  ledgerDir = mkdtempSync(path.join(tmpdir(), 'story-phase-hb-'));
});
afterEach(() => {
  ledgerDir = null;
});

describe('story-phase heartbeat producer — operator stamping (audit #3513)', () => {
  it('emits a story.heartbeat carrying the normalized operator so latestHeartbeatForOwner resolves it', async () => {
    const provider = makeProvider({
      storyBody: `Some Story body.\n\nEpic: #${EPIC_ID}\n`,
    });
    const ledgerPath = path.join(ledgerDir, 'lifecycle.ndjson');
    const config = { github: { operatorHandle: OPERATOR_RAW } };
    const now = new Date('2026-06-02T12:00:00.000Z');

    const envelope = await runStoryPhase({
      storyId: STORY_ID,
      phase: 'implementing',
      provider,
      config,
      ledgerPath,
      now,
    });

    assert.equal(envelope.heartbeatEmitted, true);
    assert.equal(envelope.epicId, EPIC_ID);

    // The Epic lease assigns the SAME normalized handle. Reading the ledger
    // through the real reader proves the producer stamped `operator` — we did
    // NOT hand-seed the record.
    const resolved = latestHeartbeatForOwner({
      epicId: EPIC_ID,
      owner: OPERATOR,
      ledgerPath,
    });
    assert.equal(resolved, now.getTime());
  });

  it('omits operator (no resolved owner) when github.operatorHandle is unset', async () => {
    const provider = makeProvider({
      storyBody: `Some Story body.\n\nEpic: #${EPIC_ID}\n`,
    });
    const ledgerPath = path.join(ledgerDir, 'lifecycle.ndjson');
    const config = { github: {} };
    const now = new Date('2026-06-02T12:00:00.000Z');

    const envelope = await runStoryPhase({
      storyId: STORY_ID,
      phase: 'implementing',
      provider,
      config,
      ledgerPath,
      now,
    });

    assert.equal(envelope.heartbeatEmitted, true);
    // No owner key → the record carries no `operator`, so a lookup for any
    // handle resolves null (the pre-lease unchanged shape is preserved).
    assert.equal(
      latestHeartbeatForOwner({ epicId: EPIC_ID, owner: OPERATOR, ledgerPath }),
      null,
    );
  });
});
