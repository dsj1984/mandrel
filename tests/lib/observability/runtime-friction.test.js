/**
 * Tests for runtime-derived friction emission (Story #4578).
 *
 * The interesting behaviour splits in two:
 *   - **Terminal policy** — which terminals are worth a retro record and
 *     which are noise. Driven through `emitTerminalFriction` (the real
 *     contract) rather than an exported pure helper: the policy is an
 *     internal, and exporting it solely to test it would be
 *     production-dead code the `--production` ratchet rightly rejects.
 *   - **The write path** — exercised against a real temp tree, so the
 *     record's on-disk shape is proven both readable by the roll-up's own
 *     reader (`forEachLine(null, sid, ...)`) and valid against
 *     `signal-event.schema.json`. That second half matters: the writer
 *     DROPS a schema-invalid record, so a shape mistake here would
 *     silently reproduce the very zero-signal bug this Story fixes.
 *
 * Every test uses an absolute per-test tempRoot — writing to the shared
 * main-checkout `temp/` would poison real state for concurrent work.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  emitRuntimeFriction,
  emitTerminalFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import { forEachLine } from '../../../.agents/scripts/lib/observability/signals-writer.js';

/** An absolute, per-test tempRoot — never the shared main-checkout temp. */
let tempRoot;
let config;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-friction-'));
  config = { project: { paths: { tempRoot } } };
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/**
 * Read back every signal the roll-up would see for a standalone Story.
 * Deliberately uses the SAME reader the epilogue uses (`epicId: null`) —
 * a record written where the roll-up does not look is not a fix.
 */
async function readStorySignals(storyId) {
  const rows = [];
  await forEachLine(null, storyId, (parsed) => rows.push(parsed), config);
  return rows;
}

/**
 * Terminal-envelope policy, exercised through the real emit contract
 * (`emitTerminalFriction` + the stream) rather than an exported pure
 * helper: the policy is internal, and an export solely for testability
 * would be production-dead code.
 */
describe('terminal-envelope friction policy', () => {
  /** @returns {Promise<object|null>} the single emitted record, or null. */
  async function emitAndRead(envelope) {
    const ok = await emitTerminalFriction({ envelope, config });
    const rows = await readStorySignals(envelope.storyId);
    assert.equal(ok, rows.length === 1, 'return value must match what landed');
    return rows[0] ?? null;
  }

  it('flags a failed terminal, naming the phase and reason', async () => {
    const row = await emitAndRead({
      storyId: 7,
      status: 'failed',
      phase: 'close-validation',
      failure: { reason: 'lint gate exploded' },
    });
    assert.equal(row.category, RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED);
    assert.equal(row.details.phase, 'close-validation');
    assert.match(row.details.reason, /lint gate exploded/);
  });

  it('flags a pending terminal whose wait budget was exhausted (the parked worker)', async () => {
    const row = await emitAndRead({
      storyId: 8,
      status: 'pending',
      phase: 'confirm-merge',
      pr: { number: 21, checksStatus: 'PENDING' },
      waitBudget: {
        maxWaitSeconds: 600,
        waitedSeconds: 600,
        cumulativeSeconds: 1800,
        maxBudgetSeconds: 3600,
      },
    });
    assert.equal(
      row.category,
      RUNTIME_FRICTION_CATEGORIES.MERGE_WAIT_EXHAUSTED,
    );
    assert.equal(row.details.prNumber, 21);
    assert.equal(row.details.cumulativeSeconds, 1800);
  });

  it('does NOT flag a --no-wait-merge pending (operator owns the land; nothing is broken)', async () => {
    // The runner's `--no-wait-merge` terminal: status pending, no waitBudget.
    // Flagging this would train operators to ignore the channel.
    assert.equal(
      await emitAndRead({
        storyId: 9,
        status: 'pending',
        phase: 'auto-merge',
        pr: { number: 21, state: 'OPEN' },
        waitBudget: null,
      }),
      null,
    );
  });

  it('does NOT flag a blocked terminal — the agent::blocked transition owns that observable', async () => {
    // Every blocked terminal flips agent::blocked, which is instrumented at
    // the canonical mutator. Emitting here too would double-count one
    // incident into occurrences: 2 and fabricate a filed proposal.
    assert.equal(
      await emitAndRead({
        storyId: 10,
        status: 'blocked',
        phase: 'confirm-merge',
        blocked: { blockClass: 'checks-failed', reason: 'red CI' },
      }),
      null,
    );
  });

  it('does NOT flag a landed terminal', async () => {
    assert.equal(
      await emitAndRead({ storyId: 11, status: 'landed', phase: 'post-land' }),
      null,
    );
  });

  it('tolerates a malformed envelope rather than throwing', async () => {
    assert.equal(await emitTerminalFriction({ envelope: null, config }), false);
    assert.equal(
      await emitTerminalFriction({ envelope: 'nonsense', config }),
      false,
    );
    assert.equal(await emitTerminalFriction({ envelope: {}, config }), false);
    assert.equal(await emitTerminalFriction(), false);
  });
});

describe('emitRuntimeFriction (write path)', () => {
  it('appends a schema-valid friction record the roll-up reader can see', async () => {
    const ok = await emitRuntimeFriction({
      storyId: 4578,
      category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
      tool: 'transitionTicketState',
      details: { reason: 'operator resume required' },
      config,
    });
    assert.equal(ok, true);

    const rows = await readStorySignals(4578);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.kind, 'friction');
    assert.equal(row.category, RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED);
    assert.equal(row.storyId, 4578);
    // Standalone Story: epicId is present-but-null, which is what the
    // envelope guard and the JSON schema both require.
    assert.equal(row.epicId, null);
    assert.equal(row.taskId, null);
    assert.equal(row.emitter.tool, 'transitionTicketState');
    // `source` is the framework/consumer classifier tag injected by the
    // writer — its presence proves the record went through the real path.
    assert.ok(row.source === 'framework' || row.source === 'consumer');
    assert.ok(typeof row.ts === 'string' && row.ts.length > 0);
  });

  it('writes to the standalone stream the epilogue roll-up actually reads', async () => {
    await emitRuntimeFriction({
      storyId: 99,
      category: RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED,
      tool: 'single-story-close',
      config,
    });
    const target = path.join(
      tempRoot,
      'standalone',
      'stories',
      'story-99',
      'signals.ndjson',
    );
    const raw = await fs.readFile(target, 'utf8');
    assert.match(raw, /"kind":"friction"/);
  });

  it('aggregates repeat categories so a run-wide wall routes as one proposal', async () => {
    // Two Stories hitting the same wall must share a category string —
    // retro-proposals aggregates by exact match.
    await emitRuntimeFriction({
      storyId: 1,
      category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
      tool: 't',
      config,
    });
    await emitRuntimeFriction({
      storyId: 2,
      category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
      tool: 't',
      config,
    });
    const a = await readStorySignals(1);
    const b = await readStorySignals(2);
    assert.equal(a[0].category, b[0].category);
  });

  it('returns false without a Story context rather than throwing', async () => {
    assert.equal(
      await emitRuntimeFriction({
        storyId: null,
        category: 'x',
        tool: 't',
        config,
      }),
      false,
    );
    assert.equal(await emitRuntimeFriction(), false);
  });

  it('refuses a category-less signal rather than writing an invalid record', async () => {
    assert.equal(
      await emitRuntimeFriction({ storyId: 5, tool: 't', config }),
      false,
    );
    assert.equal((await readStorySignals(5)).length, 0);
  });

  it('never throws when the write path is broken — observability must not halt the runner', async () => {
    // A tempRoot pointing at a FILE makes mkdir/append fail for real.
    const filePath = path.join(tempRoot, 'not-a-dir');
    await fs.writeFile(filePath, 'x', 'utf8');
    const ok = await emitRuntimeFriction({
      storyId: 5,
      category: RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED,
      tool: 't',
      config: { project: { paths: { tempRoot: filePath } } },
    });
    assert.equal(ok, false);
  });
});
