import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { parseArgv, runStoryPhase } from '../story-phase.js';

// ---------------------------------------------------------------------------
// Story #4256 — `--epic` / `--branch` skip the GitHub reads.
//
// `story-phase.js` is invoked 3–5×/story by the `/deliver` worker. Each call
// re-fetched the (immutable) epicId via `readEpicIdFromStory` (a `getTicket`
// read) and the Story branch via `resolveStoryBranch` (a `getTicketComments`
// read) — even though both are known from `story-init.js`'s Step 0 envelope.
// Passing `--epic` / `--branch` short-circuits both reads. This suite is the
// regression guard for "zero GitHub reads when the flags are supplied".
// ---------------------------------------------------------------------------

const EPIC_ID = 9;
const STORY_ID = 104;

/**
 * In-memory provider that counts the two read surfaces `runStoryPhase`
 * consumes for hierarchy / branch resolution (`getTicket`,
 * `getTicketComments`). postComment / deleteComment / updateTicket back the
 * render-only snapshot upsert and are not part of the read-skip contract.
 */
function makeCountingProvider({ storyBody } = {}) {
  const comments = [];
  let nextId = 1;
  const reads = { getTicket: 0, getTicketComments: 0 };
  return {
    reads,
    comments,
    async getTicket(id) {
      reads.getTicket += 1;
      return { id, body: storyBody ?? '', assignees: [] };
    },
    async getTicketComments(_id) {
      reads.getTicketComments += 1;
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
  ledgerDir = mkdtempSync(path.join(tmpdir(), 'story-phase-flags-'));
});
afterEach(() => {
  ledgerDir = null;
});

describe('story-phase — --epic / --branch skip GitHub reads (Story #4256)', () => {
  it('performs ZERO getTicket / getTicketComments reads when both flags are supplied', async () => {
    const provider = makeCountingProvider();
    const ledgerPath = path.join(ledgerDir, 'lifecycle.ndjson');

    const envelope = await runStoryPhase({
      storyId: STORY_ID,
      phase: 'implementing',
      epicId: EPIC_ID,
      branch: `story-${STORY_ID}`,
      provider,
      config: { github: {} },
      ledgerPath,
    });

    assert.equal(provider.reads.getTicket, 0);
    assert.equal(provider.reads.getTicketComments, 0);
    // The supplied values are used verbatim, not re-derived.
    assert.equal(envelope.epicId, EPIC_ID);
    assert.equal(envelope.branch, `story-${STORY_ID}`);
    assert.equal(envelope.heartbeatEmitted, true);
  });

  it('still performs the GitHub reads when the flags are absent (interactive fallback)', async () => {
    const provider = makeCountingProvider({
      storyBody: `Story body.\n\nEpic: #${EPIC_ID}\n`,
    });
    const ledgerPath = path.join(ledgerDir, 'lifecycle.ndjson');

    const envelope = await runStoryPhase({
      storyId: STORY_ID,
      phase: 'implementing',
      // no epicId / branch overrides
      provider,
      config: { github: {} },
      ledgerPath,
    });

    // readEpicIdFromStory ran (getTicket) and resolveStoryBranch ran
    // (getTicketComments).
    assert.equal(provider.reads.getTicket, 1);
    assert.ok(provider.reads.getTicketComments >= 1);
    // Resolution still produces the right values from the body / fallback.
    assert.equal(envelope.epicId, EPIC_ID);
    assert.equal(envelope.branch, `story-${STORY_ID}`);
  });

  it('skips only the branch read when --branch alone is supplied', async () => {
    const provider = makeCountingProvider({
      storyBody: `Story body.\n\nEpic: #${EPIC_ID}\n`,
    });
    const ledgerPath = path.join(ledgerDir, 'lifecycle.ndjson');

    await runStoryPhase({
      storyId: STORY_ID,
      phase: 'implementing',
      branch: `story-${STORY_ID}`,
      provider,
      config: { github: {} },
      ledgerPath,
    });

    // Branch supplied → no getTicketComments read; epicId still resolved off
    // the body → one getTicket read.
    assert.equal(provider.reads.getTicketComments, 0);
    assert.equal(provider.reads.getTicket, 1);
  });

  it('skips only the epic read when --epic alone is supplied', async () => {
    const provider = makeCountingProvider();
    const ledgerPath = path.join(ledgerDir, 'lifecycle.ndjson');

    await runStoryPhase({
      storyId: STORY_ID,
      phase: 'implementing',
      epicId: EPIC_ID,
      provider,
      config: { github: {} },
      ledgerPath,
    });

    // Epic supplied → no getTicket read; branch still resolved via snapshot
    // lookup → at least one getTicketComments read.
    assert.equal(provider.reads.getTicket, 0);
    assert.ok(provider.reads.getTicketComments >= 1);
  });
});

describe('story-phase — parseArgv flag wiring (Story #4256)', () => {
  it('parses --epic into a numeric epicId and --branch into branch', () => {
    const parsed = parseArgv([
      '--story',
      '104',
      '--phase',
      'closing',
      '--epic',
      '9',
      '--branch',
      'story-104',
    ]);
    assert.equal(parsed.epicId, 9);
    assert.equal(parsed.branch, 'story-104');
  });

  it('leaves epicId / branch undefined when the flags are absent', () => {
    const parsed = parseArgv(['--story', '104', '--phase', 'closing']);
    assert.equal(parsed.epicId, undefined);
    assert.equal(parsed.branch, undefined);
  });
});
