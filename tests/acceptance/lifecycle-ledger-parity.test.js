// tests/acceptance/lifecycle-ledger-parity.test.js
/**
 * AC-8 acceptance test — Epic #2307 ("Retire the Legacy Orchestration
 * Scripts and Migrate Checkpointer Consumers").
 *
 * AC-8 (PRD #2399) reads:
 *
 *   A /epic-deliver run on a fixture Epic produces a lifecycle ledger
 *   byte-identical (modulo `ts` and `seqId` fields) to a D-1-era
 *   ledger of the same Epic.
 *
 * Baseline-capture strategy
 * -------------------------
 * A *true* D-1-era ledger (captured from a real /epic-deliver run
 * against #2172's runtime before D-2 landed) was never persisted as
 * a test fixture — the D-1 Epic's `lifecycle.ndjson` lives in the
 * Epic's temp directory, which is reaped on close. Capturing one
 * after the fact would have required restoring D-1's source tree,
 * which is prohibitively complex and brittle for a CI test.
 *
 * Pragmatic substitute (per the dispatch contract for Task #2444):
 * we capture a *fresh* ledger from a deterministic in-test fixture
 * Epic emitted through the production `Bus` + `LedgerWriter` pair,
 * then diff that capture against a checked-in copy of the same
 * capture stored at `tests/fixtures/ledger-baselines/d1-era-baseline.jsonl`.
 *
 * The parity guarantee this delivers:
 *   - Any drift in the structured-comment / NDJSON record shape
 *     produced by `LedgerWriter.buildEmitted` / `buildCompleted` —
 *     for example a new top-level key, a reordered field, a payload
 *     contamination from the schema layer — fails the diff with
 *     a clear unified-diff style message.
 *   - Any drift in the lifecycle event payload schemas (e.g. an
 *     event gaining or losing a required field) fails the AJV
 *     validation inside `Bus.emit` before any ledger record lands;
 *     the test's "capture" step throws and surfaces the failure.
 *   - Any reordering of the canonical `emitted` → `completed`
 *     pairing fails the diff at the affected index.
 *
 * What this CANNOT guarantee:
 *   - Byte-identity against the *historic* D-1-era ledger format.
 *     If the D-2 work had silently changed record shape vs. D-1,
 *     this test would NOT catch it — both halves of the diff would
 *     reflect the post-D-2 shape. That class of regression has to
 *     be caught by the bus / ledger-writer / schema-registry unit
 *     suites (`tests/lifecycle/*.test.js`), which lock down the
 *     individual record-shape contracts against fixtures captured
 *     during the D-1 era.
 *
 * Net effect: this test pins the *future* invariant ("the lifecycle
 * ledger format does not drift") even though it cannot replay the
 * past.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Bus } from '../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';
import { diff, parseLedgerText } from '../../.agents/scripts/lifecycle-diff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'ledger-baselines',
  'd1-era-baseline.jsonl',
);

/**
 * Deterministic fixture Epic event sequence.
 *
 * The sequence is intentionally a *minimal* representative slice of a
 * /epic-deliver run — enough events to exercise the major lifecycle
 * boundaries (snapshot, wave dispatch, close-tail, finalize, automerge,
 * complete) but small enough to keep the baseline file reviewable.
 *
 * Each event payload is validated against
 * `.agents/schemas/lifecycle/<event>.schema.json` by the bus during
 * emit — if a future contributor mutates a schema, this fixture must
 * be updated alongside.
 *
 * Story IDs and PR URL are deliberately synthetic / non-routable to
 * make the fixture self-contained.
 */
const FIXTURE_EPIC_ID = 9001;
const FIXTURE_PR_URL = 'https://github.com/dsj1984/mandrel/pull/9001';
const FIXTURE_EVENTS = [
  // Snapshot: enumerate the Epic's stories.
  ['epic.snapshot.start', { epicId: FIXTURE_EPIC_ID }],
  ['epic.snapshot.end', { epicId: FIXTURE_EPIC_ID, storyIds: [9101, 9102] }],
  // Single wave with both fixture stories.
  ['wave.start', { waveIndex: 0, storyIds: [9101, 9102] }],
  ['story.dispatch.start', { storyId: 9101, waveIndex: 0 }],
  ['story.dispatch.end', { storyId: 9101, outcome: 'done', durationMs: 12345 }],
  ['story.merged', { storyId: 9101, sha: 'abcdef1234567' }],
  ['story.dispatch.start', { storyId: 9102, waveIndex: 0 }],
  ['story.dispatch.end', { storyId: 9102, outcome: 'done', durationMs: 23456 }],
  ['story.merged', { storyId: 9102, sha: '1234567abcdef' }],
  ['wave.end', { waveIndex: 0, outcomes: { 9101: 'done', 9102: 'done' } }],
  // Close-tail: validate + code-review + retro.
  ['epic.close.start', { epicId: FIXTURE_EPIC_ID }],
  ['close-validate.start', { epicId: FIXTURE_EPIC_ID, storyId: 9102 }],
  [
    'close-validate.end',
    {
      epicId: FIXTURE_EPIC_ID,
      storyId: 9102,
      ok: true,
      gateCount: 6,
      durationMs: 34567,
    },
  ],
  ['code-review.start', { epicId: FIXTURE_EPIC_ID }],
  ['epic.close.end', { epicId: FIXTURE_EPIC_ID }],
  // Acceptance reconcile gates Finalizer.
  ['acceptance.reconcile.start', { epicId: FIXTURE_EPIC_ID }],
  ['acceptance.reconcile.ok', { baseRead: true }],
  // Finalize → PR created.
  ['epic.finalize.start', { epicId: FIXTURE_EPIC_ID }],
  [
    'pr.created',
    {
      prUrl: FIXTURE_PR_URL,
      head: `epic/${FIXTURE_EPIC_ID}`,
      base: 'main',
    },
  ],
  ['epic.finalize.end', { epicId: FIXTURE_EPIC_ID, prUrl: FIXTURE_PR_URL }],
  // Automerge: ready → start → armed.
  [
    'epic.merge.ready',
    { prUrl: FIXTURE_PR_URL, reason: 'fixture: predicate clean' },
  ],
  ['epic.automerge.start', { prUrl: FIXTURE_PR_URL }],
  ['epic.merge.armed', { prUrl: FIXTURE_PR_URL }],
  // Terminal.
  ['epic.complete', { epicId: FIXTURE_EPIC_ID, prUrl: FIXTURE_PR_URL }],
];

/**
 * Emit the fixture sequence through a real Bus + LedgerWriter pair
 * into a fresh temp directory and return the parsed NDJSON records.
 *
 * Each event has at least one no-op listener registered to exercise
 * the full emitted → listener → completed path. Without a listener,
 * the Bus would still write `emitted` + `completed` via the privileged
 * hooks (LedgerWriter installs these directly), but registering a
 * listener keeps the test honest about the production path.
 */
async function captureFreshLedger(tempRoot) {
  const bus = new Bus();
  const writer = new LedgerWriter({
    epicId: FIXTURE_EPIC_ID,
    tempRoot,
  });
  writer.register(bus);
  // Subscribe a single no-op listener to every event in the fixture
  // so the listener phase runs (and the completed hook fires) rather
  // than degenerating into hook-only writes.
  for (const [event] of FIXTURE_EVENTS) {
    bus.on(event, () => {});
  }
  for (const [event, payload] of FIXTURE_EVENTS) {
    await bus.emit(event, payload);
  }
  const text = readFileSync(writer.ledgerPath, 'utf8');
  return { text, records: parseLedgerText(text) };
}

describe('Epic #2307 — Acceptance Criterion 8 (lifecycle ledger parity)', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-ledger-parity-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fresh capture of the fixture Epic matches the checked-in baseline (modulo ts and seqId)', async () => {
    const { records: freshRecords } = await captureFreshLedger(tempRoot);

    // Optional baseline rewrite seam: when the fixture sequence is
    // intentionally extended, run with REWRITE_BASELINE=1 and the
    // test overwrites the checked-in baseline from this run's
    // capture, then hard-fails so the rewrite ships as a reviewed
    // PR diff rather than as a silent CI green. The rewrite happens
    // BEFORE the length / diff assertions so an empty or stale
    // baseline doesn't trip the early guard during the very
    // re-record we're trying to perform.
    if (process.env.REWRITE_BASELINE === '1') {
      writeFileSync(
        BASELINE_PATH,
        readFileSync(
          path.join(tempRoot, `epic-${FIXTURE_EPIC_ID}`, 'lifecycle.ndjson'),
          'utf8',
        ),
        'utf8',
      );
      assert.fail(
        `Baseline rewritten at ${BASELINE_PATH}. Re-run the test without REWRITE_BASELINE to confirm parity, then commit the updated baseline.`,
      );
    }

    const baselineText = readFileSync(BASELINE_PATH, 'utf8');
    const baselineRecords = parseLedgerText(baselineText);

    // Sanity check: both ledgers must have the same length (one
    // emitted + one completed per fixture event). A length drift is
    // surfaced by `diff()` too, but asserting it up-front makes
    // failures easier to read.
    const expectedLen = FIXTURE_EVENTS.length * 2;
    assert.equal(
      freshRecords.length,
      expectedLen,
      `fresh ledger length ${freshRecords.length} != expected ${expectedLen} (one emitted + one completed per fixture event)`,
    );
    assert.equal(
      baselineRecords.length,
      expectedLen,
      `baseline ledger length ${baselineRecords.length} != expected ${expectedLen} — the baseline fixture has drifted from the FIXTURE_EVENTS sequence. Re-record by running the test with REWRITE_BASELINE=1.`,
    );

    const mismatches = diff(freshRecords, baselineRecords);

    assert.deepEqual(
      mismatches,
      [],
      [
        'AC-8 regression: the lifecycle ledger produced by the',
        'production Bus + LedgerWriter no longer matches the',
        'checked-in baseline (modulo ts and seqId).',
        '',
        'Either:',
        '  - a record-shape change leaked into LedgerWriter /',
        '    Bus / a lifecycle event schema, in which case fix the',
        '    underlying drift, OR',
        '  - the fixture sequence in this test was intentionally',
        '    extended, in which case re-record the baseline by',
        '    running:  REWRITE_BASELINE=1 node --test',
        `              tests/acceptance/lifecycle-ledger-parity.test.js`,
        '    and commit the updated d1-era-baseline.jsonl as part',
        '    of the same change.',
        '',
        'Mismatch indices (zero-based):',
        ...mismatches.map(
          (m) =>
            `  [${m.index}] left=${JSON.stringify(m.left)} right=${JSON.stringify(m.right)}`,
        ),
      ].join('\n'),
    );
  });

  it('the diff helper ignores ts and seqId fields (regression guard for the Tech Spec contract)', async () => {
    // This is the inner half of AC-8: the diff comparator must not
    // care about the two volatile fields. Pin it directly so a future
    // refactor of `lifecycle-diff.js` that loses the projection is
    // caught here rather than only on the slower full-ledger path.
    const { records } = await captureFreshLedger(tempRoot);
    const drifted = records.map((rec, idx) => ({
      ...rec,
      ts: '1999-12-31T23:59:59.000Z',
      seqId: rec.seqId + 10_000 + idx,
    }));
    const mismatches = diff(records, drifted);
    assert.deepEqual(
      mismatches,
      [],
      'lifecycle-diff.diff() regressed: ts/seqId drift is no longer ignored. Restore the projection in lifecycle-diff.js or pin the new contract here.',
    );
  });
});
