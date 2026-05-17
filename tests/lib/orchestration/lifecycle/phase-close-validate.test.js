// tests/lib/orchestration/lifecycle/phase-close-validate.test.js
/**
 * Contract test for `runPreMergeGates` emitting `close-validate.start` /
 * `close-validate.end` (with the umbrella `epic.close.start` from
 * `runEpicDeliverCloseTail`) on the lifecycle bus. Story #2249 / Task
 * #2250.
 *
 * Invariants pinned here:
 *   1. A passing gate chain emits `close-validate.start` then
 *      `close-validate.end` to the NDJSON ledger in seqId order, with
 *      `ok: true` and `durationMs: 0`-or-positive on the end record.
 *   2. A failed gate emits `close-validate.end` with `ok: false` AND a
 *      `story.blocked` (with `reason: 'close-validate-failed:<gate>'`)
 *      BEFORE the throw — the BlockerHandler listener cascades that to
 *      `epic.blocked` so the failure routes through the lifecycle
 *      cascade rather than being silently swallowed.
 *   3. `runEpicDeliverCloseTail` emits `epic.close.start` exactly once
 *      at Phase C entry when close-validation is NOT being skipped on
 *      resume.
 *   4. Resume that skips past close-validation does NOT re-emit
 *      `epic.close.start` (the original run's ledger already carries it).
 *   5. The helper is a no-op when `bus: null` is supplied (backward
 *      compatibility for legacy callers and unit fixtures).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runEpicDeliverCloseTail } from '../../../../.agents/scripts/lib/orchestration/epic-deliver-close-tail.js';
import {
  CHECKPOINT_SCHEMA_VERSION,
  Checkpointer,
} from '../../../../.agents/scripts/lib/orchestration/epic-runner/checkpointer.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { BlockerHandler } from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/blocker-handler.js';
import { runPreMergeGates } from '../../../../.agents/scripts/lib/orchestration/story-close/pre-merge-validation.js';

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function quietLogger() {
  return { warn() {}, info() {}, debug() {}, error() {} };
}

/**
 * In-memory provider that satisfies the checkpointer + the (no-op) ticket
 * surface the close-tail consumes when emitting `epic.close.*`.
 */
function makeCheckpointProvider(initialPhase, epicId = 42) {
  const comments = new Map();
  let nextId = 1;
  if (initialPhase) {
    const marker = `<!-- ap:structured-comment type="epic-run-state" -->`;
    const payload = {
      version: CHECKPOINT_SCHEMA_VERSION,
      epicId,
      phase: initialPhase,
    };
    const body = `${marker}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    comments.set(epicId, [{ id: nextId++, body }]);
  }
  return {
    posted: [],
    updates: [],
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const id = nextId++;
      this.posted.push({ id, ticketId, ...payload });
      const list = comments.get(ticketId) ?? [];
      list.push({ id, body: payload.body });
      comments.set(ticketId, list);
      return { commentId: id };
    },
    async deleteComment(id) {
      for (const [ticketId, list] of comments) {
        const next = list.filter((c) => c.id !== id);
        if (next.length !== list.length) comments.set(ticketId, next);
      }
    },
    async updateTicket(ticketId, patch) {
      this.updates.push({ ticketId, patch });
      return { ok: true };
    },
    async getTicket(id) {
      return { id, title: `Epic ${id}` };
    },
  };
}

describe('lifecycle/phase-close-validate — runPreMergeGates emits', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-close-validate-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emits close-validate.start then close-validate.end with ok:true on a passing gate chain', async () => {
    const epicId = 7777;
    const storyId = 1234;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    const fakeGates = [{ name: 'lint' }, { name: 'test' }];
    await runPreMergeGates({
      cwd: '/repo',
      worktreePath: '/repo',
      epicBranch: 'epic/7777',
      agentSettings: {},
      storyId,
      epicId,
      useEvidence: false,
      bus,
      logger: quietLogger(),
      buildDefaultGates: () => fakeGates,
      runCloseValidation: async () => ({ ok: true, failed: [], skipped: [] }),
    });

    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter((r) => r.kind === 'emitted');
    assert.equal(emitted.length, 2, 'two emitted records');
    assert.equal(emitted[0].event, 'close-validate.start');
    assert.equal(emitted[1].event, 'close-validate.end');
    assert.ok(emitted[0].seqId < emitted[1].seqId, 'start.seqId < end.seqId');
    assert.equal(emitted[0].payload.epicId, epicId);
    assert.equal(emitted[0].payload.storyId, storyId);
    assert.equal(emitted[1].payload.ok, true);
    assert.equal(emitted[1].payload.gateCount, 2);
    assert.equal(typeof emitted[1].payload.durationMs, 'number');
    assert.ok(emitted[1].payload.durationMs >= 0);
    // Matching `completed` records from the privileged hook.
    const completed = records.filter((r) => r.kind === 'completed');
    assert.equal(completed.length, 2);
  });

  it('emits close-validate.end with ok:false and a story.blocked routed to epic.blocked when a gate fails', async () => {
    const epicId = 7778;
    const storyId = 5678;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);
    // Register the BlockerHandler so the cascade target (epic.blocked)
    // is observable on the ledger — this is the failure-routing assertion.
    const blockerHandler = new BlockerHandler({
      bus,
      epicId,
      logger: quietLogger(),
    });
    blockerHandler.register();

    const fakeGates = [{ name: 'typecheck' }, { name: 'lint' }];
    await assert.rejects(
      () =>
        runPreMergeGates({
          cwd: '/repo',
          worktreePath: '/repo',
          epicBranch: 'epic/7778',
          agentSettings: {},
          storyId,
          epicId,
          useEvidence: false,
          bus,
          logger: quietLogger(),
          buildDefaultGates: () => fakeGates,
          runCloseValidation: async () => ({
            ok: false,
            failed: [
              {
                gate: { name: 'lint', hint: 'fix the lint errors' },
                status: 1,
                cwd: '/repo',
              },
            ],
            skipped: [],
          }),
        }),
      /Pre-merge validation failed at "lint"/,
    );

    const records = readNdjson(writer.ledgerPath);
    const emittedEvents = records
      .filter((r) => r.kind === 'emitted')
      .map((r) => r.event);
    // Expected sequence: close-validate.start, close-validate.end (ok:false),
    // story.blocked, epic.blocked (cascade by BlockerHandler).
    assert.deepEqual(emittedEvents, [
      'close-validate.start',
      'close-validate.end',
      'story.blocked',
      'epic.blocked',
    ]);

    const closeEnd = records.find(
      (r) => r.event === 'close-validate.end' && r.kind === 'emitted',
    );
    assert.equal(closeEnd.payload.ok, false);
    assert.equal(closeEnd.payload.failedGate, 'lint');
    assert.equal(closeEnd.payload.exitCode, 1);
    assert.equal(typeof closeEnd.payload.durationMs, 'number');

    const storyBlocked = records.find(
      (r) => r.event === 'story.blocked' && r.kind === 'emitted',
    );
    assert.equal(storyBlocked.payload.storyId, storyId);
    assert.equal(storyBlocked.payload.reason, 'close-validate-failed:lint');

    const epicBlocked = records.find(
      (r) => r.event === 'epic.blocked' && r.kind === 'emitted',
    );
    assert.equal(epicBlocked.payload.sourceStoryId, storyId);
    assert.equal(epicBlocked.payload.reason, 'close-validate-failed:lint');
  });

  it('is a no-op observer when bus is null (backward compatibility)', async () => {
    // The legacy path (no bus) MUST continue to operate. The gate chain
    // runs to completion and the helper returns the validation envelope
    // without touching any ledger.
    const out = await runPreMergeGates({
      cwd: '/repo',
      worktreePath: '/repo',
      epicBranch: 'epic/0',
      agentSettings: {},
      storyId: 1,
      epicId: 1,
      useEvidence: false,
      bus: null,
      logger: quietLogger(),
      buildDefaultGates: () => [],
      runCloseValidation: async () => ({ ok: true, failed: [], skipped: [] }),
    });
    assert.equal(out.ok, true);
  });

  it('skips emits when storyId is missing even with a bus (schema-required field)', async () => {
    // The close-validate.* schemas require BOTH `epicId` and `storyId`.
    // If a caller wires a bus without a storyId (e.g. an Epic-level
    // validation outside a story-close), emits silently no-op so the
    // schema validation cannot reject a malformed payload.
    const epicId = 9999;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);
    await runPreMergeGates({
      cwd: '/repo',
      worktreePath: '/repo',
      epicBranch: 'epic/9999',
      agentSettings: {},
      storyId: null,
      epicId,
      useEvidence: false,
      bus,
      logger: quietLogger(),
      buildDefaultGates: () => [],
      runCloseValidation: async () => ({ ok: true, failed: [], skipped: [] }),
    });
    // Ledger should be empty (no file).
    let records = [];
    try {
      records = readNdjson(writer.ledgerPath);
    } catch {
      // file not created — expected
    }
    assert.equal(records.length, 0);
  });
});

describe('lifecycle/phase-close-validate — runEpicDeliverCloseTail epic.close.start', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-epic-close-start-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emits epic.close.start once before Phase C runs on a fresh entry', async () => {
    const epicId = 42;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);
    const provider = makeCheckpointProvider('close-validation', epicId);

    await runEpicDeliverCloseTail({
      epicId,
      provider,
      bus,
      logger: quietLogger(),
      runWaveGateFn: async () => ({ exitCode: 0 }),
      runHierarchyGateFn: async () => ({ exitCode: 0 }),
      runCodeReviewFn: async () => ({
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        halted: false,
        blockerReason: null,
        posted: true,
      }),
      runRetroFn: async () => ({
        posted: true,
        compact: true,
        scorecard: {},
        body: '',
      }),
      runFinalizeFn: async () => ({
        epicId,
        ffOk: true,
        pushed: true,
        prUrl: 'https://x/pull/1',
        postedHandoff: true,
      }),
    });

    const records = readNdjson(writer.ledgerPath);
    const epicCloseStarts = records.filter(
      (r) => r.event === 'epic.close.start' && r.kind === 'emitted',
    );
    assert.equal(epicCloseStarts.length, 1, 'one epic.close.start emit');
    assert.equal(epicCloseStarts[0].payload.epicId, epicId);
    const epicCloseEnds = records.filter(
      (r) => r.event === 'epic.close.end' && r.kind === 'emitted',
    );
    assert.equal(epicCloseEnds.length, 1, 'one epic.close.end emit');
  });

  it('does NOT emit epic.close.start when the checkpoint resumes past close-validation', async () => {
    const epicId = 43;
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);
    // Resume point is `retro` — close-validation and code-review skipped.
    const provider = makeCheckpointProvider('retro', epicId);

    await runEpicDeliverCloseTail({
      epicId,
      provider,
      bus,
      logger: quietLogger(),
      // These should never be called — they correspond to skipped phases.
      runWaveGateFn: async () => {
        throw new Error(
          'runWaveGateFn must not be called on resume past phase C',
        );
      },
      runHierarchyGateFn: async () => {
        throw new Error(
          'runHierarchyGateFn must not be called on resume past phase C',
        );
      },
      runCodeReviewFn: async () => {
        throw new Error(
          'runCodeReviewFn must not be called on resume past phase D',
        );
      },
      runRetroFn: async () => ({
        posted: true,
        compact: true,
        scorecard: {},
        body: '',
      }),
      runFinalizeFn: async () => ({
        epicId,
        ffOk: true,
        pushed: true,
        prUrl: 'https://x/pull/1',
        postedHandoff: true,
      }),
    });

    const records = readNdjson(writer.ledgerPath);
    const epicCloseStarts = records.filter(
      (r) => r.event === 'epic.close.start' && r.kind === 'emitted',
    );
    assert.equal(
      epicCloseStarts.length,
      0,
      'no epic.close.start on resume past phase C',
    );
    // But epic.close.end MUST still fire — retro ran.
    const epicCloseEnds = records.filter(
      (r) => r.event === 'epic.close.end' && r.kind === 'emitted',
    );
    assert.equal(epicCloseEnds.length, 1, 'epic.close.end on retro completion');
  });
});

// Pin a reference to `Checkpointer` so unused-import does not trip — the
// import is informational (tests in the close-tail family share the
// pinned schema version for fixture parity).
void Checkpointer;
