/**
 * merge-envelopes.test.js — pure 3-way baseline merge (Story #5215).
 *
 * The bug this closes: git's line-based merge conflicts on disjoint row
 * moves that sit adjacent in sort order and can splice both sides' rows into
 * a set neither side scored. These tests pin the row-identity semantics that
 * replace it. Since Story #5400 the envelope carries no `generatedAt` and no
 * `rollup`, so the merge output carries neither.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getKindModule } from '../../.agents/scripts/lib/baselines/kernel.js';
import {
  kindFromEnvelope,
  mergeEnvelopes,
} from '../../.agents/scripts/lib/baselines/merge-envelopes.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/merge',
);

const readFixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

const MI_SCHEMA = '.agents/schemas/baselines/maintainability.schema.json';

function miEnvelope(rowsMap) {
  const mod = getKindModule('maintainability');
  const rows = mod.sortRows(
    Object.entries(rowsMap).map(([p, mi]) => ({ path: p, mi })),
  );
  return { $schema: MI_SCHEMA, kernelVersion: '0.1.0', rows };
}

const byPath = (envelope) =>
  Object.fromEntries(envelope.rows.map((r) => [r.path, r.mi]));

describe('kindFromEnvelope', () => {
  it('resolves a known per-kind envelope', () => {
    assert.equal(kindFromEnvelope({ $schema: MI_SCHEMA }), 'maintainability');
  });

  it('answers null for a baseline that is not a known kind', () => {
    // `baselines/*.json` also matches arch-cycles, cyclomatic, dead-exports…
    // The driver reads this null as "hand it back to git's text merge".
    assert.equal(
      kindFromEnvelope({
        $schema: 'https://mandrel.dev/baselines/cyclomatic.schema.json',
      }),
      null,
    );
    assert.equal(kindFromEnvelope({}), null);
    assert.equal(kindFromEnvelope(null), null);
  });
});

describe('mergeEnvelopes — disjoint row moves (AC-1)', () => {
  const base = miEnvelope({ 'a.js': 60, 'b.js': 70, 'c.js': 80 });
  const ours = miEnvelope({ 'a.js': 61, 'b.js': 70, 'c.js': 80 });
  const theirs = miEnvelope({ 'a.js': 60, 'b.js': 70, 'c.js': 83 });

  it('keeps both sides moved values', () => {
    const { envelope, conflicts } = mergeEnvelopes({ base, ours, theirs });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(byPath(envelope), { 'a.js': 61, 'b.js': 70, 'c.js': 83 });
  });

  it('emits neither a rollup nor a generatedAt stamp (Story #5400)', () => {
    const { envelope } = mergeEnvelopes({ base, ours, theirs });
    assert.deepEqual(Object.keys(envelope), [
      '$schema',
      'kernelVersion',
      'rows',
    ]);
  });

  it('emits rows in the kind canonical order', () => {
    const shuffled = { ...ours, rows: [...ours.rows].reverse() };
    const { envelope } = mergeEnvelopes({ base, ours: shuffled, theirs });
    assert.deepEqual(
      envelope.rows.map((r) => r.path),
      ['a.js', 'b.js', 'c.js'],
    );
  });
});

describe('mergeEnvelopes — additions and deletions', () => {
  const base = miEnvelope({ 'a.js': 60 });

  it('keeps a row added on either side', () => {
    const ours = miEnvelope({ 'a.js': 60, 'new-ours.js': 90 });
    const theirs = miEnvelope({ 'a.js': 60, 'new-theirs.js': 91 });
    const { envelope, conflicts } = mergeEnvelopes({ base, ours, theirs });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(byPath(envelope), {
      'a.js': 60,
      'new-ours.js': 90,
      'new-theirs.js': 91,
    });
  });

  it('honours a deletion when the other side left the row alone', () => {
    const ours = miEnvelope({});
    const theirs = miEnvelope({ 'a.js': 60 });
    const { envelope, conflicts } = mergeEnvelopes({ base, ours, theirs });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(envelope.rows, []);
  });

  it('treats a null base (added on both sides) as an empty row set', () => {
    const ours = miEnvelope({ 'a.js': 60 });
    const { envelope, conflicts } = mergeEnvelopes({
      base: null,
      ours,
      theirs: ours,
    });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(byPath(envelope), { 'a.js': 60 });
  });
});

describe('mergeEnvelopes — genuine double moves conflict (AC-2)', () => {
  const base = miEnvelope({ 'a.js': 60, 'b.js': 70 });
  const ours = miEnvelope({ 'a.js': 61, 'b.js': 71 });
  const theirs = miEnvelope({ 'a.js': 62, 'b.js': 71 });

  it('reports only the row both sides moved differently', () => {
    const { conflicts } = mergeEnvelopes({ base, ours, theirs });
    assert.equal(conflicts.length, 1);
    assert.deepEqual(
      { scope: conflicts[0].scope, identity: conflicts[0].identity },
      { scope: 'row', identity: 'a.js' },
    );
    assert.deepEqual(conflicts[0].ours, { path: 'a.js', mi: 61 });
    assert.deepEqual(conflicts[0].theirs, { path: 'a.js', mi: 62 });
  });

  it('still merges every other row', () => {
    const { envelope } = mergeEnvelopes({ base, ours, theirs });
    assert.equal(byPath(envelope)['b.js'], 71);
  });

  it('does not conflict when both sides moved a row to the SAME value', () => {
    const same = miEnvelope({ 'a.js': 65, 'b.js': 70 });
    const { conflicts } = mergeEnvelopes({
      base,
      ours: miEnvelope({ 'a.js': 65, 'b.js': 70 }),
      theirs: same,
    });
    assert.deepEqual(conflicts, []);
  });
});

describe('mergeEnvelopes — envelope stamps', () => {
  const rows = { 'a.js': 60 };
  it('merges a one-sided kernelVersion bump', () => {
    const base = miEnvelope(rows);
    const ours = {
      ...miEnvelope(rows),
      kernelVersion: '0.2.0',
    };
    const theirs = miEnvelope(rows);
    const { envelope, conflicts } = mergeEnvelopes({ base, ours, theirs });
    assert.deepEqual(conflicts, []);
    assert.equal(envelope.kernelVersion, '0.2.0');
  });

  it('conflicts when both sides bump a stamp differently', () => {
    const base = miEnvelope(rows);
    const ours = {
      ...miEnvelope(rows),
      kernelVersion: '0.2.0',
    };
    const theirs = {
      ...miEnvelope(rows),
      kernelVersion: '0.3.0',
    };
    const { conflicts } = mergeEnvelopes({ base, ours, theirs });
    assert.deepEqual(
      conflicts.map((c) => [c.scope, c.identity]),
      [['envelope', 'kernelVersion']],
    );
  });
});

describe('mergeEnvelopes — CRAP sibling rows (AC-3)', () => {
  const mod = getKindModule('crap');
  const CRAP_SCHEMA = '.agents/schemas/baselines/crap.schema.json';
  const crapEnvelope = (rows) => ({
    $schema: CRAP_SCHEMA,
    kernelVersion: '0.1.0',
    rows: mod.sortRows(rows),
  });

  // Two methods in ONE file: same `path` (the keyField), different identity.
  const sibling = {
    path: 'a/b.js',
    method: 'sibling',
    startLine: 40,
    crap: 12,
  };
  const target = { path: 'a/b.js', method: 'target', startLine: 7, crap: 3 };

  const base = crapEnvelope([target, sibling]);
  const ours = crapEnvelope([{ ...target, crap: 9 }, sibling]);
  const theirs = crapEnvelope([target, sibling]);

  it('moves only the identified row and preserves its sibling verbatim', () => {
    const { envelope, conflicts } = mergeEnvelopes({ base, ours, theirs });
    assert.deepEqual(conflicts, []);
    const byIdentity = Object.fromEntries(
      envelope.rows.map((r) => [mod.rowIdentity(r), r]),
    );
    assert.equal(byIdentity['a/b.js::target@7'].crap, 9);
    assert.deepEqual(byIdentity['a/b.js::sibling@40'], sibling);
  });

  it('rejects a side whose rows collide on identity', () => {
    const dup = crapEnvelope([target, { ...target }]);
    assert.throws(
      () => mergeEnvelopes({ base, ours: dup, theirs }),
      /identity contract/,
    );
  });
});

describe('mergeEnvelopes — the swarm-os reproduction (AC-4)', () => {
  const base = readFixture('maintainability.base.json');
  const main = readFixture('maintainability.main.json');
  const branch = readFixture('maintainability.branch.json');

  it('the fixture reproduces the bug: the three blobs differ only in disjoint rows', () => {
    // main refreshed site-analytics/ + site-metrics/; the branch refreshed
    // news/. Zero row overlap — before Story #5400 the text merge still
    // conflicted, purely because of the `generatedAt` stamp.
    const movedBy = (side) =>
      Object.entries(byPath(side))
        .filter(([p, mi]) => byPath(base)[p] !== mi)
        .map(([p]) => p)
        .sort();
    assert.deepEqual(movedBy(main), [
      'site-analytics/chart.ts',
      'site-analytics/report.ts',
      'site-metrics/collect.ts',
    ]);
    assert.deepEqual(movedBy(branch), [
      'news/blocks/canvas-model.ts',
      'news/news-view.ts',
    ]);
  });

  it('merges to main plus exactly the branch two moved rows', () => {
    const { envelope, conflicts } = mergeEnvelopes({
      base,
      ours: branch,
      theirs: main,
    });
    assert.deepEqual(conflicts, []);

    const expected = { ...byPath(main) };
    expected['news/blocks/canvas-model.ts'] =
      byPath(branch)['news/blocks/canvas-model.ts'];
    expected['news/news-view.ts'] = byPath(branch)['news/news-view.ts'];

    // Keyed by identity, not compared by row count — a count would pass on a
    // set that swapped one row for another.
    assert.deepEqual(byPath(envelope), expected);
    assert.deepEqual(
      envelope.rows.map((r) => r.path).sort(),
      Object.keys(expected).sort(),
    );
  });

  it('is order-independent', () => {
    const a = mergeEnvelopes({ base, ours: branch, theirs: main });
    const b = mergeEnvelopes({ base, ours: main, theirs: branch });
    assert.deepEqual(a.envelope, b.envelope);
  });
});
