// tests/lib/orchestration/lifecycle/legacy-resume.test.js
/**
 * Contract test for the legacy-resume adapter
 * (Story #2266 / Task #2269, Epic #2172).
 *
 * Acceptance contract:
 *   - A fixture pre-cutover snapshot loads, generates a synthetic
 *     ledger prefix, and the prefix is internally consistent with an
 *     uninterrupted run (alternating emitted / completed pairs,
 *     monotonic seqIds, schema-valid event names + payloads).
 *   - The adapter is idempotent — second invocation against the same
 *     snapshot is a no-op (no extra records appended, the marker
 *     file remains, status reflects the existing ledger).
 *
 * Idempotency is the most important property: in-flight Epics will
 * call this adapter multiple times across resume cycles, and a single
 * duplicate prefix would invalidate every downstream resume.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  apply,
  buildSyntheticPayload,
  deriveWavesFromSnapshot,
  isLegacySnapshot,
  phaseToCompletedEndEvents,
  resolveLedgerPath,
  synthesizePrefix,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/legacy-resume.js';

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

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-resume-'));
}

function loadAjvForLedger() {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  return ajv;
}

function readLedgerRecords(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  return txt
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

const SAMPLE_LEGACY_SNAPSHOT = Object.freeze({
  version: 1,
  epicId: 2172,
  startedAt: '2026-05-10T09:00:00.000Z',
  currentWave: 2,
  totalWaves: 4,
  concurrencyCap: 2,
  phase: 'wave-loop',
  waves: [
    { index: 0, storyIds: [2231, 2232] },
    { index: 1, storyIds: [2233, 2234] },
  ],
  blockerHistory: [],
  manualInterventions: [],
});

describe('isLegacySnapshot', () => {
  it('accepts the canonical legacy shape', () => {
    assert.equal(isLegacySnapshot(SAMPLE_LEGACY_SNAPSHOT), true);
  });

  it('accepts a snapshot without an explicit version field (very old runs)', () => {
    const noVersion = { ...SAMPLE_LEGACY_SNAPSHOT };
    delete noVersion.version;
    assert.equal(isLegacySnapshot(noVersion), true);
  });

  it('rejects null / undefined / primitives', () => {
    for (const value of [null, undefined, 1, 'x', true, []]) {
      assert.equal(isLegacySnapshot(value), false);
    }
  });

  it('rejects an object missing the epicId field', () => {
    const broken = { ...SAMPLE_LEGACY_SNAPSHOT };
    delete broken.epicId;
    assert.equal(isLegacySnapshot(broken), false);
  });

  it('rejects an object with a non-array waves field', () => {
    assert.equal(
      isLegacySnapshot({ ...SAMPLE_LEGACY_SNAPSHOT, waves: 'oops' }),
      false,
    );
  });

  it('rejects a future-version snapshot (we only migrate v1)', () => {
    assert.equal(
      isLegacySnapshot({ ...SAMPLE_LEGACY_SNAPSHOT, version: 99 }),
      false,
    );
  });
});

describe('phaseToCompletedEndEvents', () => {
  it('returns [] for phase=prepare (nothing has completed yet)', () => {
    assert.deepEqual(phaseToCompletedEndEvents('prepare'), []);
  });

  it('returns [epic.snapshot.end, epic.plan.end] for phase=wave-loop', () => {
    assert.deepEqual(phaseToCompletedEndEvents('wave-loop'), [
      'epic.snapshot.end',
      'epic.plan.end',
    ]);
  });

  it('returns the full close-tail event list for phase=done', () => {
    assert.deepEqual(phaseToCompletedEndEvents('done'), [
      'epic.snapshot.end',
      'epic.plan.end',
      'close-validate.end',
      'code-review.end',
      'retro.end',
      'epic.finalize.end',
    ]);
  });

  it('returns [] for an unknown phase string', () => {
    assert.deepEqual(phaseToCompletedEndEvents('nonsense'), []);
  });
});

describe('deriveWavesFromSnapshot', () => {
  it('extracts integer story IDs from the legacy wave records', () => {
    assert.deepEqual(deriveWavesFromSnapshot(SAMPLE_LEGACY_SNAPSHOT), [
      [2231, 2232],
      [2233, 2234],
    ]);
  });

  it('falls back to epicId when waves are missing storyIds', () => {
    const snap = { ...SAMPLE_LEGACY_SNAPSHOT, waves: [{ index: 0 }] };
    assert.deepEqual(deriveWavesFromSnapshot(snap), [[snap.epicId]]);
  });

  it('returns a single-placeholder wave when waves is an empty array', () => {
    const snap = { ...SAMPLE_LEGACY_SNAPSHOT, waves: [] };
    assert.deepEqual(deriveWavesFromSnapshot(snap), [[snap.epicId]]);
  });
});

describe('buildSyntheticPayload schema conformance', () => {
  // We validate each synthetic payload against its matching lifecycle
  // schema so the records `synthesizePrefix` emits remain bus-valid.
  // The ledger writer never re-validates on append, so we have to
  // catch shape regressions in the test suite.
  const ajv = loadAjvForLedger();
  const eventNames = [
    'epic.snapshot.end',
    'epic.plan.end',
    'wave.end',
    'close-validate.end',
    'code-review.end',
    'retro.end',
    'epic.finalize.end',
  ];
  for (const event of eventNames) {
    it(`synthetic payload for ${event} matches its schema`, () => {
      const schema = JSON.parse(
        fs.readFileSync(path.join(SCHEMA_DIR, `${event}.schema.json`), 'utf8'),
      );
      const validate = ajv.compile(schema);
      const payload = buildSyntheticPayload({
        event,
        snapshot: SAMPLE_LEGACY_SNAPSHOT,
        waveIndex: 0,
      });
      const ok = validate(payload);
      assert.equal(
        ok,
        true,
        `synthetic payload for ${event} failed schema: ${JSON.stringify(validate.errors)}`,
      );
    });
  }
});

describe('synthesizePrefix', () => {
  it('throws on a non-legacy snapshot', () => {
    assert.throws(
      () => synthesizePrefix({ snapshot: { nope: true } }),
      /not a legacy shape/,
    );
  });

  it('produces an empty wave loop when phase=prepare and currentWave=0', () => {
    const snap = {
      ...SAMPLE_LEGACY_SNAPSHOT,
      phase: 'prepare',
      currentWave: 0,
      waves: [],
    };
    const records = synthesizePrefix({ snapshot: snap });
    // Prepare phase has not produced ANY phase-end events yet, so
    // the prefix is empty.
    assert.deepEqual(records, []);
  });

  it('produces alternating emitted/completed pairs with monotonic seqIds', () => {
    const records = synthesizePrefix({ snapshot: SAMPLE_LEGACY_SNAPSHOT });
    assert.equal(records.length % 2, 0);
    for (let i = 0; i < records.length; i += 2) {
      assert.equal(records[i].kind, 'emitted');
      assert.equal(records[i + 1].kind, 'completed');
      assert.equal(records[i].seqId, records[i + 1].seqId);
      assert.equal(records[i].event, records[i + 1].event);
      if (i > 0) {
        assert.equal(records[i].seqId > records[i - 2].seqId, true);
      }
    }
  });

  it('emits prepare-phase boundaries + wave.end x currentWave for phase=wave-loop', () => {
    const records = synthesizePrefix({ snapshot: SAMPLE_LEGACY_SNAPSHOT });
    const eventSequence = records
      .filter((r) => r.kind === 'emitted')
      .map((r) => r.event);
    assert.deepEqual(eventSequence, [
      'epic.snapshot.end',
      'epic.plan.end',
      'wave.end',
      'wave.end',
    ]);
  });

  it('includes the close-tail events when phase=done', () => {
    const snap = {
      ...SAMPLE_LEGACY_SNAPSHOT,
      phase: 'done',
      currentWave: 4,
      waves: [
        { index: 0, storyIds: [2231] },
        { index: 1, storyIds: [2232] },
        { index: 2, storyIds: [2233] },
        { index: 3, storyIds: [2234] },
      ],
    };
    const records = synthesizePrefix({ snapshot: snap });
    const eventSequence = records
      .filter((r) => r.kind === 'emitted')
      .map((r) => r.event);
    assert.deepEqual(eventSequence, [
      'epic.snapshot.end',
      'epic.plan.end',
      'wave.end',
      'wave.end',
      'wave.end',
      'wave.end',
      'close-validate.end',
      'code-review.end',
      'retro.end',
      'epic.finalize.end',
    ]);
  });

  it('produces deterministic timestamps for the same input (byte-identical prefix)', () => {
    const a = synthesizePrefix({ snapshot: SAMPLE_LEGACY_SNAPSHOT });
    const b = synthesizePrefix({ snapshot: SAMPLE_LEGACY_SNAPSHOT });
    assert.deepEqual(a, b);
  });

  it('every synthesized record validates against ledger-record.schema.json', () => {
    const ajv = loadAjvForLedger();
    const recordSchema = JSON.parse(
      fs.readFileSync(
        path.join(SCHEMA_DIR, 'ledger-record.schema.json'),
        'utf8',
      ),
    );
    const validate = ajv.compile(recordSchema);
    const records = synthesizePrefix({ snapshot: SAMPLE_LEGACY_SNAPSHOT });
    for (const record of records) {
      const ok = validate(record);
      assert.equal(
        ok,
        true,
        `record ${JSON.stringify(record)} failed: ${JSON.stringify(validate.errors)}`,
      );
    }
  });
});

describe('apply — adapter entry point', () => {
  let tempRoot;
  beforeEach(() => {
    tempRoot = mkTempRoot();
  });
  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns noop-not-legacy when snapshot is not a legacy shape', () => {
    const result = apply({ snapshot: null, tempRoot });
    assert.equal(result.status, 'noop-not-legacy');
    assert.equal(result.recordsAppended, 0);
  });

  it('synthesizes the prefix on first invocation', () => {
    const result = apply({ snapshot: SAMPLE_LEGACY_SNAPSHOT, tempRoot });
    assert.equal(result.status, 'synthesized');
    assert.equal(result.recordsAppended > 0, true);
    const records = readLedgerRecords(result.ledgerPath);
    assert.equal(records.length, result.recordsAppended);
    // First emitted record is the snapshot-end boundary.
    assert.equal(records[0].kind, 'emitted');
    assert.equal(records[0].event, 'epic.snapshot.end');
  });

  it('is idempotent — second invocation is a noop', () => {
    const first = apply({ snapshot: SAMPLE_LEGACY_SNAPSHOT, tempRoot });
    assert.equal(first.status, 'synthesized');
    const ledgerBefore = fs.readFileSync(first.ledgerPath, 'utf8');

    const second = apply({ snapshot: SAMPLE_LEGACY_SNAPSHOT, tempRoot });
    assert.equal(second.status, 'noop-existing-ledger');
    assert.equal(second.recordsAppended, 0);

    const ledgerAfter = fs.readFileSync(first.ledgerPath, 'utf8');
    assert.equal(
      ledgerAfter,
      ledgerBefore,
      'ledger must not be mutated on re-apply',
    );
  });

  it('skips synthesis when the marker file already exists (even if ledger absent)', () => {
    // Lay down the marker without writing a ledger.
    const epicDir = path.join(
      tempRoot,
      `epic-${SAMPLE_LEGACY_SNAPSHOT.epicId}`,
    );
    fs.mkdirSync(epicDir, { recursive: true });
    fs.writeFileSync(
      path.join(epicDir, 'legacy-resume.synthesized'),
      'manual-marker\n',
      'utf8',
    );

    const result = apply({ snapshot: SAMPLE_LEGACY_SNAPSHOT, tempRoot });
    assert.equal(result.status, 'noop-existing-ledger');
    // No ledger was written because the marker short-circuited.
    assert.equal(fs.existsSync(result.ledgerPath), false);
  });

  it('writes the resolved path matching resolveLedgerPath', () => {
    const result = apply({ snapshot: SAMPLE_LEGACY_SNAPSHOT, tempRoot });
    assert.equal(
      result.ledgerPath,
      resolveLedgerPath({ tempRoot, epicId: SAMPLE_LEGACY_SNAPSHOT.epicId }),
    );
    assert.equal(fs.existsSync(result.ledgerPath), true);
  });
});
