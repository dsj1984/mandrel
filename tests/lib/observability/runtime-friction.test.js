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
  emitBlockRecoveredFriction,
  emitCloseRecoveredFriction,
  emitRecoveredFrictionMarker,
  emitRuntimeFriction,
  emitTerminalFriction,
  isRecoveredSignal,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import { forEachLine } from '../../../.agents/scripts/lib/observability/signals-writer.js';
import { composeRoutedProposals } from '../../../.agents/scripts/lib/orchestration/retro-proposals.js';
import { gatherStoryFrictionSignals } from '../../../.agents/scripts/lib/orchestration/story-follow-ups.js';

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

  it('flags a pending terminal whose CUMULATIVE budget is exhausted (the parked worker)', async () => {
    // AC-4 — genuine exhaustion (cumulativeSeconds >= maxBudgetSeconds) still
    // routes, so the residual case the source-side guard cannot suppress (a
    // merge that spends its whole budget and lands on a later resume) stays
    // observable.
    const row = await emitAndRead({
      storyId: 8,
      status: 'pending',
      phase: 'confirm-merge',
      pr: { number: 21, checksStatus: 'PENDING' },
      waitBudget: {
        maxWaitSeconds: 600,
        waitedSeconds: 600,
        cumulativeSeconds: 3600,
        maxBudgetSeconds: 3600,
      },
    });
    assert.equal(
      row.category,
      RUNTIME_FRICTION_CATEGORIES.MERGE_WAIT_EXHAUSTED,
    );
    assert.equal(row.details.prNumber, 21);
    assert.equal(row.details.cumulativeSeconds, 3600);
  });

  it('does NOT flag a pending window rollover still under cumulative budget', async () => {
    // AC-3 — the routine long-CI rollover the category name wrongly claimed.
    // The `pending` return is reached at the per-invocation `maxWaitSeconds`
    // bound with `cumulativeSeconds` still under `maxBudgetSeconds`, so it is
    // NOT exhaustion and must emit nothing.
    assert.equal(
      await emitAndRead({
        storyId: 12,
        status: 'pending',
        phase: 'confirm-merge',
        pr: { number: 21, checksStatus: 'PENDING' },
        waitBudget: {
          maxWaitSeconds: 600,
          waitedSeconds: 600,
          cumulativeSeconds: 1800,
          maxBudgetSeconds: 3600,
        },
      }),
      null,
    );
  });

  it('does NOT flag a pending whose budget fields cannot prove exhaustion', async () => {
    // A missing/non-numeric cumulativeSeconds or maxBudgetSeconds means
    // exhaustion is unproven → emit nothing (never a speculative record).
    assert.equal(
      await emitAndRead({
        storyId: 13,
        status: 'pending',
        phase: 'confirm-merge',
        pr: { number: 21, checksStatus: 'PENDING' },
        waitBudget: { maxWaitSeconds: 600, waitedSeconds: 600 },
      }),
      null,
    );
    assert.equal(
      await emitAndRead({
        storyId: 14,
        status: 'pending',
        phase: 'confirm-merge',
        pr: { number: 21, checksStatus: 'PENDING' },
        waitBudget: {
          cumulativeSeconds: 'nonsense',
          maxBudgetSeconds: 3600,
        },
      }),
      null,
    );
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

describe('block-recovery friction (Story #4622)', () => {
  it('emits a story-blocked record carrying the recovered discriminator', async () => {
    const ok = await emitBlockRecoveredFriction({
      storyId: 4622,
      fromState: 'agent::blocked',
      toState: 'agent::executing',
      config,
    });
    assert.equal(ok, true);

    const rows = await readStorySignals(4622);
    assert.equal(rows.length, 1);
    const rec = rows[0];
    assert.equal(rec.kind, 'friction');
    assert.equal(rec.category, RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED);
    assert.equal(rec.details.recovered, true);
    assert.equal(rec.details.fromState, 'agent::blocked');
    assert.equal(rec.details.toState, 'agent::executing');
  });

  it('keeps the category as story-blocked so it does not open a new routable bucket', async () => {
    await emitBlockRecoveredFriction({ storyId: 4623, config });
    const rows = await readStorySignals(4623);
    assert.equal(rows[0].category, 'story-blocked');
    assert.equal(rows[0].details.fromState, null);
    assert.equal(rows[0].details.toState, null);
  });
});

describe('close-recovery friction (Story #4649)', () => {
  /** Put an un-recovered `close-failed` on the Story's stream. */
  const seedCloseFailure = (storyId) =>
    emitRuntimeFriction({
      storyId,
      category: RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED,
      tool: 'test',
      details: { phase: 'push', reason: 'boom' },
      config,
    });

  it('emits a close-failed record carrying the recovered discriminator', async () => {
    await seedCloseFailure(4649);
    const ok = await emitCloseRecoveredFriction({ storyId: 4649, config });
    assert.equal(ok, true);

    const rows = await readStorySignals(4649);
    assert.equal(rows.length, 2);
    const rec = rows[1];
    assert.equal(rec.kind, 'friction');
    assert.equal(rec.category, RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED);
    assert.equal(rec.details.recovered, true);
    assert.equal(rec.storyId, 4649);
  });

  it('writes nothing when the close never failed', async () => {
    // The common case — a clean first-try land. An unconditional marker
    // would file a category-mislabelled row AND pre-net any future close
    // failure for this Story out of the aggregate.
    const ok = await emitCloseRecoveredFriction({ storyId: 4651, config });
    assert.equal(ok, false);
    assert.deepEqual(await readStorySignals(4651), []);
  });

  it('does not write a second marker when one is already present', async () => {
    await seedCloseFailure(4652);
    assert.equal(
      await emitCloseRecoveredFriction({ storyId: 4652, config }),
      true,
    );
    assert.equal(
      await emitCloseRecoveredFriction({ storyId: 4652, config }),
      false,
      'idempotent across a re-run of the land tail',
    );
    assert.equal((await readStorySignals(4652)).length, 2);
  });

  it('ignores an unusable story id', async () => {
    assert.equal(
      await emitCloseRecoveredFriction({ storyId: 0, config }),
      false,
    );
    assert.equal(await emitCloseRecoveredFriction({ config }), false);
  });

  it('keeps the category as close-failed so it does not open a new routable bucket', async () => {
    await seedCloseFailure(4650);
    await emitCloseRecoveredFriction({ storyId: 4650, config });
    const rows = await readStorySignals(4650);
    assert.equal(rows[1].category, 'close-failed');
  });

  it('nets a fail-then-land close out to zero filed proposals', async () => {
    // The AC-6 contract, end to end: writer → marker → composer.
    await seedCloseFailure(4653);
    await emitCloseRecoveredFriction({ storyId: 4653, config });

    const signals = await gatherStoryFrictionSignals(4653, config);
    assert.equal(signals.length, 2);
    const proposals = composeRoutedProposals({
      anchorId: 4653,
      anchorKind: 'story',
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
      signals,
    });
    assert.deepEqual(proposals, {
      framework: [],
      consumer: [],
      discarded: [],
    });
  });

  it('leaves a close failure that never landed fully counted', async () => {
    await seedCloseFailure(4654);
    await seedCloseFailure(4654);
    const signals = await gatherStoryFrictionSignals(4654, config);
    const proposals = composeRoutedProposals({
      anchorId: 4654,
      anchorKind: 'story',
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
      signals,
    });
    const filed = [...proposals.framework, ...proposals.consumer];
    assert.equal(filed.length, 1, 'no land, no netting — it still routes');
    assert.equal(filed[0].category, 'close-failed');
    assert.equal(filed[0].occurrences, 2);
  });
});

describe('emitRecoveredFrictionMarker (generalized, Story #4654)', () => {
  const MWE = RUNTIME_FRICTION_CATEGORIES.MERGE_WAIT_EXHAUSTED;
  const BLOCKED = RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED;

  /** Put one un-recovered record in `category` on the Story's stream. */
  const seed = (storyId, category) =>
    emitRuntimeFriction({
      storyId,
      category,
      tool: 'test',
      details: { reason: 'boom' },
      config,
    });

  it('marks any category conditionally — a seeded merge-wait-exhausted nets out', async () => {
    await seed(5401, MWE);
    const ok = await emitRecoveredFrictionMarker({
      storyId: 5401,
      category: MWE,
      config,
    });
    assert.equal(ok, true);
    const rows = await readStorySignals(5401);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].category, MWE);
    assert.equal(rows[1].details.recovered, true);
  });

  it('writes nothing when the category never fired (keeps the bucket routable)', async () => {
    // The conditional probe is what prevents a spurious marker from
    // suppressing a category for a Story that never hit the incident.
    const ok = await emitRecoveredFrictionMarker({
      storyId: 5402,
      category: BLOCKED,
      config,
    });
    assert.equal(ok, false);
    assert.deepEqual(await readStorySignals(5402), []);
  });

  it('does not write a second marker when one is already present (idempotent)', async () => {
    await seed(5403, BLOCKED);
    assert.equal(
      await emitRecoveredFrictionMarker({
        storyId: 5403,
        category: BLOCKED,
        config,
      }),
      true,
    );
    assert.equal(
      await emitRecoveredFrictionMarker({
        storyId: 5403,
        category: BLOCKED,
        config,
      }),
      false,
    );
    assert.equal((await readStorySignals(5403)).length, 2);
  });

  it('refuses an unusable story id or category rather than throwing', async () => {
    assert.equal(
      await emitRecoveredFrictionMarker({ storyId: 0, category: MWE, config }),
      false,
    );
    assert.equal(
      await emitRecoveredFrictionMarker({
        storyId: 5404,
        category: '  ',
        config,
      }),
      false,
    );
    assert.equal(await emitRecoveredFrictionMarker(), false);
  });
});

describe('isRecoveredSignal (Story #4622, generalized by #4649)', () => {
  const STORY_BLOCKED = RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED;

  it('is true for a story-blocked record with details.recovered === true', () => {
    assert.equal(
      isRecoveredSignal({
        category: STORY_BLOCKED,
        details: { recovered: true },
      }),
      true,
    );
  });

  it('is false for a plain (terminal) story-blocked record', () => {
    assert.equal(
      isRecoveredSignal({
        category: STORY_BLOCKED,
        details: { toState: 'agent::blocked' },
      }),
      false,
    );
  });

  it('is category-agnostic — a recovered close-failed is a marker too', () => {
    // Pre-#4649 this returned false, which is why `close-failed` had no
    // recovery path at all. The composer nets per (category, storyId), so a
    // marker can still only cancel records in its own bucket.
    assert.equal(
      isRecoveredSignal({
        category: RUNTIME_FRICTION_CATEGORIES.CLOSE_FAILED,
        details: { recovered: true },
      }),
      true,
    );
  });

  it('is false for a category-less record', () => {
    assert.equal(isRecoveredSignal({ details: { recovered: true } }), false);
    assert.equal(
      isRecoveredSignal({ category: '  ', details: { recovered: true } }),
      false,
    );
  });

  it('is false for null / non-object / detail-less input', () => {
    assert.equal(isRecoveredSignal(null), false);
    assert.equal(isRecoveredSignal('nope'), false);
    assert.equal(isRecoveredSignal({ category: STORY_BLOCKED }), false);
  });
});
