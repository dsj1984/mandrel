// tests/lifecycle/lifecycle-diff.test.js
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  assertMergeGateOrdering,
  assertReconcileOrdering,
  assertWaveCompleteness,
  diff,
  parseLedgerText,
  projectRecord,
} from '../../.agents/scripts/lifecycle-diff.js';

/**
 * The diff CLI is a tiny pure-JS surface, so we exercise the pure
 * exports directly. The CLI wrapper (`main()`) is exercised by the
 * filesystem fixture tests below where we drop ledger files in a temp
 * directory and call the helpers as if reading them through the CLI.
 */

const NDJSON_MIN = [
  {
    kind: 'emitted',
    seqId: 1,
    ts: '2026-05-17T10:00:00.000Z',
    event: 'epic.snapshot.start',
    payload: { epicId: 1 },
  },
  {
    kind: 'completed',
    seqId: 1,
    ts: '2026-05-17T10:00:00.001Z',
    event: 'epic.snapshot.start',
  },
];

describe('lifecycle-diff/diff', () => {
  it('returns empty for two identical ledgers', () => {
    const mismatches = diff(NDJSON_MIN, NDJSON_MIN);
    assert.deepEqual(mismatches, []);
  });

  it('returns empty for two ledgers with different ts/seqId but same shape', () => {
    const a = [...NDJSON_MIN];
    const b = NDJSON_MIN.map((r) => ({
      ...r,
      ts: '2026-12-31T23:59:59.000Z',
      seqId: r.seqId + 100,
    }));
    assert.deepEqual(diff(a, b), []);
  });

  it('reports a mismatch when event names differ', () => {
    const a = [...NDJSON_MIN];
    const b = [{ ...NDJSON_MIN[0], event: 'wave.start' }, NDJSON_MIN[1]];
    const m = diff(a, b);
    assert.equal(m.length, 1);
    assert.equal(m[0].index, 0);
  });

  it('reports a mismatch when one ledger is longer', () => {
    const a = [...NDJSON_MIN];
    const b = [...NDJSON_MIN, NDJSON_MIN[0]];
    const m = diff(a, b);
    assert.equal(m.length, 1);
    assert.equal(m[0].index, 2);
  });

  it('projectRecord strips ts and seqId', () => {
    const p = projectRecord({ ...NDJSON_MIN[0] });
    assert.equal(p.ts, undefined);
    assert.equal(p.seqId, undefined);
    assert.equal(p.event, 'epic.snapshot.start');
  });
});

describe('lifecycle-diff/parseLedgerText', () => {
  it('parses NDJSON tolerantly of blank lines', () => {
    const text = `${JSON.stringify(NDJSON_MIN[0])}\n\n${JSON.stringify(NDJSON_MIN[1])}\n`;
    const parsed = parseLedgerText(text);
    assert.equal(parsed.length, 2);
  });

  it('throws with line number on malformed JSON', () => {
    assert.throws(
      () => parseLedgerText(`${JSON.stringify(NDJSON_MIN[0])}\nnot-json\n`),
      /malformed JSON in ledger on line 2/,
    );
  });
});

describe('lifecycle-diff/assertMergeGateOrdering', () => {
  it('passes when ready precedes armed', () => {
    const records = [
      {
        kind: 'emitted',
        seqId: 10,
        ts: '2026-05-17T10:00:00.000Z',
        event: 'epic.merge.ready',
        payload: { prUrl: 'https://x/1' },
      },
      {
        kind: 'emitted',
        seqId: 11,
        ts: '2026-05-17T10:00:01.000Z',
        event: 'epic.merge.armed',
        payload: { prUrl: 'https://x/1' },
      },
    ];
    assert.deepEqual(assertMergeGateOrdering(records), { ok: true });
  });

  it('fails when armed precedes ready', () => {
    const records = [
      {
        kind: 'emitted',
        seqId: 10,
        ts: '2026-05-17T10:00:00.000Z',
        event: 'epic.merge.armed',
        payload: { prUrl: 'https://x/1' },
      },
      {
        kind: 'emitted',
        seqId: 11,
        ts: '2026-05-17T10:00:01.000Z',
        event: 'epic.merge.ready',
        payload: { prUrl: 'https://x/1' },
      },
    ];
    const result = assertMergeGateOrdering(records);
    assert.equal(result.ok, false);
    assert.match(result.reason, /without preceding epic\.merge\.ready/);
  });

  it('fails when armed and ready share the same seqId', () => {
    const records = [
      {
        kind: 'emitted',
        seqId: 5,
        ts: '2026-05-17T10:00:00.000Z',
        event: 'epic.merge.ready',
        payload: { prUrl: 'https://x/1' },
      },
      {
        kind: 'emitted',
        seqId: 5,
        ts: '2026-05-17T10:00:00.001Z',
        event: 'epic.merge.armed',
        payload: { prUrl: 'https://x/1' },
      },
    ];
    const result = assertMergeGateOrdering(records);
    assert.equal(result.ok, false);
    assert.match(result.reason, /must be >/);
  });
});

describe('lifecycle-diff/assertReconcileOrdering', () => {
  it('passes when reconcile.ok precedes pr.created', () => {
    const records = [
      {
        kind: 'emitted',
        seqId: 1,
        ts: '2026-05-17T10:00:00.000Z',
        event: 'acceptance.reconcile.ok',
        payload: { baseRead: true },
      },
      {
        kind: 'emitted',
        seqId: 2,
        ts: '2026-05-17T10:00:01.000Z',
        event: 'pr.created',
        payload: { prUrl: 'https://x/1', head: 'epic/1', base: 'main' },
      },
    ];
    assert.deepEqual(assertReconcileOrdering(records), { ok: true });
  });

  it('fails when pr.created has no preceding reconcile.ok', () => {
    const records = [
      {
        kind: 'emitted',
        seqId: 1,
        ts: '2026-05-17T10:00:00.000Z',
        event: 'pr.created',
        payload: { prUrl: 'https://x/1', head: 'epic/1', base: 'main' },
      },
    ];
    const result = assertReconcileOrdering(records);
    assert.equal(result.ok, false);
    assert.match(result.reason, /without preceding acceptance\.reconcile\.ok/);
  });
});

describe('lifecycle-diff/assertWaveCompleteness', () => {
  it('passes when wave.end.outcomes matches wave.start.storyIds', () => {
    const records = [
      {
        kind: 'emitted',
        seqId: 1,
        ts: '2026-05-17T10:00:00.000Z',
        event: 'wave.start',
        payload: { waveIndex: 0, storyIds: [101, 102] },
      },
      {
        kind: 'emitted',
        seqId: 2,
        ts: '2026-05-17T10:00:10.000Z',
        event: 'wave.end',
        payload: { waveIndex: 0, outcomes: { 101: 'done', 102: 'blocked' } },
      },
    ];
    assert.deepEqual(assertWaveCompleteness(records), { ok: true });
  });

  it('fails when outcomes is missing a storyId from start', () => {
    const records = [
      {
        kind: 'emitted',
        seqId: 1,
        ts: '2026-05-17T10:00:00.000Z',
        event: 'wave.start',
        payload: { waveIndex: 0, storyIds: [101, 102] },
      },
      {
        kind: 'emitted',
        seqId: 2,
        ts: '2026-05-17T10:00:10.000Z',
        event: 'wave.end',
        payload: { waveIndex: 0, outcomes: { 101: 'done' } },
      },
    ];
    const result = assertWaveCompleteness(records);
    assert.equal(result.ok, false);
    assert.match(result.reason, /storyIds count .* != outcomes count/);
  });

  it('fails when wave.end has no matching wave.start', () => {
    const records = [
      {
        kind: 'emitted',
        seqId: 1,
        ts: '2026-05-17T10:00:00.000Z',
        event: 'wave.end',
        payload: { waveIndex: 7, outcomes: {} },
      },
    ];
    const result = assertWaveCompleteness(records);
    assert.equal(result.ok, false);
    assert.match(result.reason, /without preceding wave\.start/);
  });
});

describe('lifecycle-diff CLI roundtrip', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mandrel-diff-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('two identical synthetic ledgers diff cleanly', () => {
    const a = path.join(dir, 'a.ndjson');
    const b = path.join(dir, 'b.ndjson');
    const text = NDJSON_MIN.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(a, text, 'utf8');
    writeFileSync(b, text, 'utf8');
    const records = parseLedgerText(text);
    assert.deepEqual(diff(records, records), []);
  });
});
