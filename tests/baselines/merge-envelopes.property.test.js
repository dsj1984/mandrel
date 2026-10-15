/**
 * merge-envelopes.property.test.js — fast-check invariants for the 3-way
 * baseline merge driver (Story #5683).
 *
 * `merge-envelopes.test.js` pins hand-picked examples; these properties pin
 * the contract every merge must keep, over generated base/ours/theirs triples
 * drawn from a small identity pool and value domain so equal values,
 * deletions and additions collide often:
 *
 *   1. changed-side-wins — a side identical to base yields the other side;
 *   2. idempotence — identical sides yield that side;
 *   3. conflict iff both differ — a row conflict is reported exactly when both
 *      sides changed the same identity to different values;
 *   4. ours/theirs symmetry — swapping the sides yields the same row set and
 *      the same conflict set (a conflicted row's kept value is side-specific
 *      by design, so it is compared by identity only).
 *
 * Runs under the pinned seed from tests/helpers/fast-check-config.js.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';

import { getKindModule } from '../../.agents/scripts/lib/baselines/kernel.js';
import { mergeEnvelopes } from '../../.agents/scripts/lib/baselines/merge-envelopes.js';
import { fcParams } from '../helpers/fast-check-config.js';

const KIND = 'maintainability';
const SCHEMA = `.agents/schemas/baselines/${KIND}.schema.json`;
const POOL = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];

/** A cell is absent (`undefined`) or one of a few MI values. */
const cell = fc.option(fc.integer({ min: 60, max: 63 }), { nil: undefined });

/** `{ path: mi | undefined }` over the identity pool. */
const side = fc
  .tuple(...POOL.map(() => cell))
  .map((values) => Object.fromEntries(POOL.map((p, i) => [p, values[i]])));

const triple = fc.record({ base: side, ours: side, theirs: side });

function envelope(cells) {
  const rows = Object.entries(cells)
    .filter(([, mi]) => mi !== undefined)
    .map(([path, mi]) => ({ path, mi }));
  return {
    $schema: SCHEMA,
    kernelVersion: '0.1.0',
    rows: getKindModule(KIND).sortRows(rows),
  };
}

function merge(base, ours, theirs) {
  return mergeEnvelopes({
    base: envelope(base),
    ours: envelope(ours),
    theirs: envelope(theirs),
  });
}

const rowConflictIds = (result) =>
  result.conflicts
    .filter((c) => c.scope === 'row')
    .map((c) => c.identity)
    .sort();

describe('mergeEnvelopes — properties (Story #5683)', () => {
  it('changed-side-wins: a side identical to base yields the other side', () => {
    fc.assert(
      fc.property(side, side, (base, changed) => {
        const theirsChanged = merge(base, base, changed);
        assert.deepEqual(theirsChanged.envelope.rows, envelope(changed).rows);
        assert.deepEqual(theirsChanged.conflicts, []);

        const oursChanged = merge(base, changed, base);
        assert.deepEqual(oursChanged.envelope.rows, envelope(changed).rows);
        assert.deepEqual(oursChanged.conflicts, []);
      }),
      fcParams(),
    );
  });

  it('idempotence: identical sides yield that side whatever the base', () => {
    fc.assert(
      fc.property(side, side, (base, both) => {
        const result = merge(base, both, both);
        assert.deepEqual(result.envelope.rows, envelope(both).rows);
        assert.deepEqual(result.conflicts, []);
      }),
      fcParams(),
    );
  });

  it('conflict iff both sides changed the same identity to different values', () => {
    fc.assert(
      fc.property(triple, ({ base, ours, theirs }) => {
        const expected = POOL.filter(
          (p) =>
            ours[p] !== base[p] &&
            theirs[p] !== base[p] &&
            ours[p] !== theirs[p],
        ).sort();
        assert.deepEqual(rowConflictIds(merge(base, ours, theirs)), expected);
      }),
      fcParams(),
    );
  });

  it('ours/theirs symmetry: swapping the sides yields the same row set and conflicts', () => {
    fc.assert(
      fc.property(triple, ({ base, ours, theirs }) => {
        const forward = merge(base, ours, theirs);
        const swapped = merge(base, theirs, ours);
        const conflicted = new Set(rowConflictIds(forward));
        assert.deepEqual(rowConflictIds(swapped), [...conflicted].sort());

        const ids = (r) => r.envelope.rows.map((row) => row.path);
        assert.deepEqual(ids(swapped), ids(forward));

        const settled = (r) =>
          r.envelope.rows.filter((row) => !conflicted.has(row.path));
        assert.deepEqual(settled(swapped), settled(forward));
      }),
      fcParams(),
    );
  });
});
