// tests/lib/orchestration/lifecycle/resume-suite.test.js
/**
 * Consolidated crash/resume contract suite for every lifecycle event
 * in the taxonomy (Story #2266 / Task #2270, Epic #2172). Locks AC-3
 * (resume determinism) and the AC-9 corollary that the NDJSON ledger
 * is the only canonical run history — there is no second source of
 * truth the resume coordinator consults.
 *
 * The earlier per-phase resume tests (resume-snapshot-plan.test.js,
 * resume-iterate-waves.test.js, resume-close-tail.test.js,
 * resume-cleanup.test.js, resume-reconcile-finalize.test.js,
 * resume-story-close.test.js) each exercise one specific phase entry
 * point. They remain in tree because each one carries phase-specific
 * provider fixtures that this consolidated suite does not duplicate.
 *
 * This file is the per-event roll-up: for EVERY event in the
 * lifecycle taxonomy, we drive a minimal bus + LedgerWriter pair
 * through a "crash mid-emit / resume from the same ledger path"
 * scenario and assert the final ledger is byte-identical (modulo
 * `ts` and `seqId`) to an uninterrupted reference run.
 *
 * The suite is intentionally schema-driven: the event list is
 * derived from the on-disk schema directory via `readdirSync`, so
 * adding a new lifecycle event to the taxonomy automatically forces
 * a new test case here. Two events are excluded by name:
 *   - `ledger-record` — not a bus event, the record schema itself.
 *   - `checkpoint.written` — emitted by the pointer-writer listener
 *     in response to *.end events; this suite emits events directly
 *     against the bus, so a manual `checkpoint.written` emit would
 *     double-fire if the writer were also registered.
 *
 * Crash semantics: we simulate a kernel kill between two emits by
 * registering a throwing listener on the event under test. The
 * LedgerWriter has already appended the `emitted` line before any
 * listener runs (privileged onEmitted hook), so the partial ledger
 * always carries an `emitted` + `failed` pair. The resume run then
 * re-emits the same event on a fresh bus pointed at the SAME ledger
 * path; the resumed suffix is asserted to match the structural shape
 * of the uninterrupted reference run.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '.agents',
  'schemas',
  'lifecycle',
);

const EXCLUDED_FROM_SUITE = new Set([
  // Not a bus event — the record-shape schema for the ledger itself.
  'ledger-record',
  // Self-emitted by the pointer-writer listener in response to
  // observed `*.end` events. Driving it directly would model a
  // synthetic flow the runtime never produces.
  'checkpoint.written',
]);

/**
 * Discover every event schema on disk. Yields bare event names
 * (without the `.schema.json` suffix).
 */
function discoverTaxonomyEvents() {
  return readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .map((f) => f.replace(/\.schema\.json$/, ''))
    .filter((event) => !EXCLUDED_FROM_SUITE.has(event))
    .sort();
}

/**
 * Schema-valid minimum payload per event. Each entry is the smallest
 * object that satisfies the event's schema; the suite uses it to
 * drive `bus.emit` without dragging the live runner state in.
 */
const PAYLOAD_BY_EVENT = Object.freeze({
  'acceptance.reconcile.failed': { baseRead: false, reason: 'fixture' },
  'acceptance.reconcile.ok': { baseRead: true },
  'acceptance.reconcile.skipped': { baseRead: false, reason: 'fixture' },
  'acceptance.reconcile.start': { epicId: 9999 },
  'close-validate.end': { epicId: 9999, storyId: 9999, ok: true },
  'close-validate.start': { epicId: 9999, storyId: 9999 },
  'code-review.end': { epicId: 9999, status: 'no-changes' },
  'code-review.start': { epicId: 9999 },
  'epic.automerge.end': {
    prUrl: 'https://example.test/pr/1',
    merged: false,
  },
  'epic.automerge.start': { prUrl: 'https://example.test/pr/1' },
  'epic.blocked': { reason: 'fixture' },
  'epic.cleanup.end': { epicId: 9999 },
  'epic.cleanup.start': { epicId: 9999 },
  'epic.close.end': { epicId: 9999 },
  'epic.close.start': { epicId: 9999 },
  'epic.complete': { epicId: 9999, prUrl: 'https://example.test/pr/1' },
  'epic.finalize.end': {
    epicId: 9999,
    prUrl: 'https://example.test/pr/1',
  },
  'epic.finalize.start': { epicId: 9999 },
  'epic.merge.armed': { prUrl: 'https://example.test/pr/1' },
  'epic.merge.blocked': {
    prUrl: 'https://example.test/pr/1',
    reason: 'fixture',
  },
  'epic.merge.ready': { prUrl: 'https://example.test/pr/1' },
  'epic.plan.end': { waves: [[1]] },
  'epic.plan.start': { epicId: 9999 },
  'epic.snapshot.end': { epicId: 9999, storyIds: [] },
  'epic.snapshot.start': { epicId: 9999 },
  'epic.unblocked': { reason: 'fixture' },
  'epic.watch.end': {
    prUrl: 'https://example.test/pr/1',
    checkOutcomes: {},
  },
  'epic.watch.start': {
    prUrl: 'https://example.test/pr/1',
    requiredChecks: [],
  },
  'notification.emitted': {
    event: 'wave.end',
    channel: 'webhook',
    severity: 'info',
    ok: true,
  },
  'pr.created': {
    prUrl: 'https://example.test/pr/1',
    head: 'epic/9999',
    base: 'main',
  },
  'retro.end': { epicId: 9999, posted: false },
  'retro.start': { epicId: 9999 },
  'story.blocked': { storyId: 9999, reason: 'fixture' },
  'story.dispatch.end': {
    storyId: 9999,
    outcome: 'done',
    durationMs: 0,
  },
  'story.dispatch.start': { storyId: 9999, waveIndex: 0 },
  'story.merged': { storyId: 9999, sha: 'abcdef1' },
  'wave.end': { waveIndex: 0, outcomes: {} },
  'wave.start': { waveIndex: 0, storyIds: [] },
});

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function structuralRecord(record) {
  const { ts: _ts, seqId: _seqId, ...rest } = record;
  return rest;
}

/**
 * Drive a single emit through a fresh bus, asserting the writer
 * appended `emitted` + `completed`. Returns the LedgerWriter so the
 * caller can inspect / reuse the ledger path.
 */
async function emitUninterrupted({ event, payload, epicId, tempRoot }) {
  const bus = new Bus();
  const writer = new LedgerWriter({ epicId, tempRoot });
  writer.register(bus);
  await bus.emit(event, payload);
  return writer;
}

/**
 * Drive a single emit through a bus that crashes mid-handler (via a
 * thrown named listener). The LedgerWriter records `emitted` BEFORE
 * the listener runs and `failed` AFTER the listener throws, so the
 * partial ledger always carries one of each.
 */
async function emitWithCrash({ event, payload, epicId, tempRoot }) {
  const bus = new Bus();
  const writer = new LedgerWriter({ epicId, tempRoot });
  writer.register(bus);
  bus.on(event, () => {
    throw new Error('simulated-kill-during-listener');
  });
  await assert.rejects(
    () => bus.emit(event, payload),
    /simulated-kill-during-listener/,
  );
  return writer;
}

describe('lifecycle/resume-suite (per-event consolidated)', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-resume-suite-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('the suite covers every event in the taxonomy (excluding ledger-record + checkpoint.written)', () => {
    const taxonomy = discoverTaxonomyEvents();
    // PAYLOAD_BY_EVENT must carry one payload entry per taxonomy
    // member. Adding a new event to the schema directory MUST force
    // an addition here or the table-driven loop below will fail
    // discovery.
    for (const event of taxonomy) {
      assert.ok(
        Object.hasOwn(PAYLOAD_BY_EVENT, event),
        `PAYLOAD_BY_EVENT is missing a fixture payload for "${event}"`,
      );
    }
  });

  // Table-driven per-event resume contract. Each iteration:
  //   1. Reference run — uninterrupted emit on a clean ledger.
  //   2. Crash run — emit on a fresh ledger with a throwing listener
  //      installed. Partial ledger has `emitted` + `failed`.
  //   3. Resume run — fresh bus + writer against the SAME ledger
  //      path; re-emit the same event without the throwing listener.
  //   4. Assert the resumed suffix (everything after the crash
  //      preamble) is structurally identical (modulo ts/seqId) to
  //      the reference final ledger.
  for (const event of discoverTaxonomyEvents()) {
    it(`event=${event} — crash mid-listener + resume yields a structurally identical ledger`, async () => {
      const payload = PAYLOAD_BY_EVENT[event];
      assert.ok(payload, `missing payload fixture for ${event}`);

      // Reference (uninterrupted) ledger — written into a sibling
      // tempRoot so the resume scenario writes into a clean
      // directory.
      const refRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-resume-ref-'));
      try {
        const refWriter = await emitUninterrupted({
          event,
          payload,
          epicId: 9999,
          tempRoot: refRoot,
        });
        const referenceFinal = readNdjson(refWriter.ledgerPath).map(
          structuralRecord,
        );
        assert.equal(
          referenceFinal.length,
          2,
          `reference run for ${event} must produce emitted+completed`,
        );

        // Crash run.
        const crashWriter = await emitWithCrash({
          event,
          payload,
          epicId: 9999,
          tempRoot,
        });
        const crashPartial = readNdjson(crashWriter.ledgerPath);
        assert.equal(
          crashPartial.length,
          2,
          `crash run for ${event} must produce emitted+failed`,
        );
        assert.equal(crashPartial[0].kind, 'emitted');
        assert.equal(crashPartial[1].kind, 'failed');

        // Resume — fresh bus + writer pointed at the SAME ledger
        // path. The append-only writer adds the post-resume suffix
        // at the tail of the existing partial ledger.
        const resumeBus = new Bus();
        const resumeWriter = new LedgerWriter({
          epicId: 9999,
          tempRoot,
        });
        resumeWriter.register(resumeBus);
        await resumeBus.emit(event, payload);

        const resumedAll = readNdjson(resumeWriter.ledgerPath);
        // First two records are the crash preamble (emitted +
        // failed). Drop them — the resumed suffix must match the
        // uninterrupted reference structurally.
        const suffix = resumedAll.slice(2).map(structuralRecord);
        assert.deepEqual(
          suffix,
          referenceFinal,
          `resume suffix for ${event} must match reference run (modulo ts/seqId)`,
        );
      } finally {
        rmSync(refRoot, { recursive: true, force: true });
      }
    });
  }

  it('the resume suffix preserves event ordering across two distinct emits', async () => {
    // Multi-event crash → resume sanity check. Emit `wave.start`
    // followed by `wave.end`. Crash on `wave.start`'s listener; the
    // resumed run re-emits both events on a fresh bus. The final
    // ledger must record both events in order, with the crash
    // preamble preserved verbatim at the head.
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId: 9999, tempRoot });
    writer.register(bus);
    bus.on('wave.start', () => {
      throw new Error('simulated-kill-during-listener');
    });
    await assert.rejects(() =>
      bus.emit('wave.start', PAYLOAD_BY_EVENT['wave.start']),
    );

    const resumeBus = new Bus();
    const resumeWriter = new LedgerWriter({ epicId: 9999, tempRoot });
    resumeWriter.register(resumeBus);
    await resumeBus.emit('wave.start', PAYLOAD_BY_EVENT['wave.start']);
    await resumeBus.emit('wave.end', PAYLOAD_BY_EVENT['wave.end']);

    const records = readNdjson(resumeWriter.ledgerPath);
    // Preamble: emitted(wave.start) + failed(wave.start).
    // Resumed:  emitted(wave.start) + completed(wave.start) +
    //           emitted(wave.end)  + completed(wave.end).
    assert.equal(records.length, 6);
    assert.equal(records[0].kind, 'emitted');
    assert.equal(records[0].event, 'wave.start');
    assert.equal(records[1].kind, 'failed');
    assert.equal(records[2].kind, 'emitted');
    assert.equal(records[2].event, 'wave.start');
    assert.equal(records[3].kind, 'completed');
    assert.equal(records[3].event, 'wave.start');
    assert.equal(records[4].kind, 'emitted');
    assert.equal(records[4].event, 'wave.end');
    assert.equal(records[5].kind, 'completed');
    assert.equal(records[5].event, 'wave.end');
  });
});
