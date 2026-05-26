// tests/scripts/wave-tick-recurring-failures.test.js
/**
 * Integration test for Story #3062 Task #3075.
 *
 * Drives `tick()` against a stub provider and an on-disk ledger fixture
 * that simulates two distinct Stories sharing the same `failedGate`.
 * Asserts that:
 *
 *   - The first tick upserts exactly one `recurring-failure-class`
 *     structured comment on the Epic ticket.
 *   - A second tick back-to-back (with the same ledger contents) leaves
 *     a single `recurring-failure-class` comment on the ticket — the
 *     upsert is idempotent across re-ticks (delete + repost collapses
 *     to one marker).
 *
 * The `_resetStructuredCommentCache` invocation between ticks emulates a
 * fresh process boundary so the WeakMap-backed per-provider cache does
 * not short-circuit `findStructuredComment` and mask a real duplicate.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  _resetStructuredCommentCache,
  structuredCommentMarker,
} from '../../.agents/scripts/lib/orchestration/ticketing.js';
import { tick } from '../../.agents/scripts/lib/wave-runner/tick.js';

/**
 * Build a synthetic `close-validate.end` `emitted` record. The shape
 * matches what `LedgerWriter.buildEmitted` writes to disk.
 */
function emitted({ seqId, ts, storyId, failedGate }) {
  return {
    kind: 'emitted',
    seqId,
    ts,
    event: 'close-validate.end',
    payload: { epicId: 9051, storyId, ok: false, failedGate },
  };
}

/**
 * Minimal in-memory ticketing provider supporting the surface the
 * default `recurringFailureReporter` and `upsertStructuredComment`
 * pipeline calls: `getTicket`, `getTicketComments`, `postComment`,
 * `deleteComment`.
 */
function createFakeProvider() {
  const commentsByTicket = new Map();
  let nextId = 1;
  return {
    _commentsByTicket: commentsByTicket,
    postCommentCalls: 0,
    async getTicket(id) {
      return { id, labels: [], title: `Story #${id}` };
    },
    async getTicketComments(ticketId) {
      return [...(commentsByTicket.get(ticketId) ?? [])];
    },
    async postComment(ticketId, { body }) {
      this.postCommentCalls += 1;
      const id = nextId++;
      const list = commentsByTicket.get(ticketId) ?? [];
      list.push({ id, body });
      commentsByTicket.set(ticketId, list);
      return { commentId: id, id };
    },
    async deleteComment(commentId) {
      for (const [ticketId, list] of commentsByTicket) {
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx >= 0) {
          list.splice(idx, 1);
          commentsByTicket.set(ticketId, list);
          return;
        }
      }
    },
  };
}

function fakeCheckpointer(state) {
  return { read: async () => state };
}

function countCommentsWithMarker(provider, ticketId, marker) {
  const list = provider._commentsByTicket.get(ticketId) ?? [];
  return list.filter((c) => c.body?.includes(marker)).length;
}

describe('wave-tick-recurring-failures', () => {
  it('upserts a single recurring-failure-class comment across two ticks', async () => {
    const sandbox = mkdtempSync(
      path.join(tmpdir(), 'wave-tick-recurring-failures-'),
    );
    const prevCwd = process.cwd();
    try {
      process.chdir(sandbox);
      const epicId = 9051;
      const epicDir = path.join(sandbox, 'temp', `epic-${epicId}`);
      mkdirSync(epicDir, { recursive: true });
      const ledgerPath = path.join(epicDir, 'lifecycle.ndjson');
      const lines = [
        emitted({
          seqId: 1,
          ts: '2026-05-26T10:00:00.000Z',
          storyId: 9101,
          failedGate: 'lint',
        }),
        emitted({
          seqId: 2,
          ts: '2026-05-26T10:05:00.000Z',
          storyId: 9102,
          failedGate: 'lint',
        }),
      ];
      writeFileSync(
        ledgerPath,
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
        'utf8',
      );

      const provider = createFakeProvider();
      const checkpointer = fakeCheckpointer({
        epicId,
        currentWave: 0,
        totalWaves: 1,
        plan: [[{ id: 9101 }, { id: 9102 }]],
        waves: [],
      });

      // Reset the WeakMap cache so a previous suite's entries don't
      // bleed in (defense-in-depth — each provider instance is also
      // distinct, so this is belt+suspenders).
      _resetStructuredCommentCache();

      // First tick — should detect the recurring lint failure and
      // upsert exactly one recurring-failure-class comment.
      await tick({
        epic: epicId,
        collaborators: {
          provider,
          epicRunStateStore: checkpointer,
          signalEmit: async () => {},
        },
      });

      const marker = structuredCommentMarker('recurring-failure-class');
      assert.equal(
        countCommentsWithMarker(provider, epicId, marker),
        1,
        'first tick must upsert exactly one recurring-failure-class comment',
      );
      const firstTickPostCalls = provider.postCommentCalls;
      assert.ok(
        firstTickPostCalls >= 1,
        'first tick must call postComment at least once',
      );

      // Second tick — same ledger contents, same findings. The upsert
      // path deletes the prior comment and reposts; the on-ticket
      // marker count must remain 1.
      await tick({
        epic: epicId,
        collaborators: {
          provider,
          epicRunStateStore: checkpointer,
          signalEmit: async () => {},
        },
      });

      assert.equal(
        countCommentsWithMarker(provider, epicId, marker),
        1,
        'second tick must leave exactly one recurring-failure-class comment (idempotent upsert)',
      );
    } finally {
      process.chdir(prevCwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('does not post a recurring-failure-class comment when no gate recurs', async () => {
    const sandbox = mkdtempSync(
      path.join(tmpdir(), 'wave-tick-recurring-failures-empty-'),
    );
    const prevCwd = process.cwd();
    try {
      process.chdir(sandbox);
      const epicId = 9052;
      const epicDir = path.join(sandbox, 'temp', `epic-${epicId}`);
      mkdirSync(epicDir, { recursive: true });
      const ledgerPath = path.join(epicDir, 'lifecycle.ndjson');
      const lines = [
        emitted({
          seqId: 1,
          ts: '2026-05-26T10:00:00.000Z',
          storyId: 9201,
          failedGate: 'lint',
        }),
        emitted({
          seqId: 2,
          ts: '2026-05-26T10:05:00.000Z',
          storyId: 9202,
          failedGate: 'test',
        }),
      ];
      writeFileSync(
        ledgerPath,
        `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
        'utf8',
      );

      const provider = createFakeProvider();
      const checkpointer = fakeCheckpointer({
        epicId,
        currentWave: 0,
        totalWaves: 1,
        plan: [[{ id: 9201 }, { id: 9202 }]],
        waves: [],
      });

      _resetStructuredCommentCache();

      await tick({
        epic: epicId,
        collaborators: {
          provider,
          epicRunStateStore: checkpointer,
          signalEmit: async () => {},
        },
      });

      const marker = structuredCommentMarker('recurring-failure-class');
      assert.equal(
        countCommentsWithMarker(provider, epicId, marker),
        0,
        'no recurring-failure-class comment when gates are distinct',
      );
    } finally {
      process.chdir(prevCwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('invokes an injected recurringFailureReporter collaborator once per tick', async () => {
    let calls = 0;
    const provider = {
      async getTicket(id) {
        return { id, labels: [], title: `Story #${id}` };
      },
    };
    const checkpointer = fakeCheckpointer({
      epicId: 9053,
      currentWave: 0,
      totalWaves: 1,
      plan: [[{ id: 9301 }]],
      waves: [],
    });

    await tick({
      epic: 9053,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
        signalEmit: async () => {},
        recurringFailureReporter: async () => {
          calls += 1;
        },
      },
    });
    await tick({
      epic: 9053,
      collaborators: {
        provider,
        epicRunStateStore: checkpointer,
        signalEmit: async () => {},
        recurringFailureReporter: async () => {
          calls += 1;
        },
      },
    });

    assert.equal(calls, 2, 'reporter must fire exactly once per tick');
  });
});
