/**
 * Unit tests for the v2 split-policy validator (one-owner-AC split rejector).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertAcceptancePartition,
  normalizeAcceptance,
  validateAcceptancePartition,
} from '../../../.agents/scripts/lib/orchestration/split-policy-validator.js';

describe('normalizeAcceptance', () => {
  it('trims, collapses whitespace, and lower-cases', () => {
    assert.equal(
      normalizeAcceptance('  The  Widget   Renders '),
      'the widget renders',
    );
  });
  it('returns null for non-strings and empty text', () => {
    assert.equal(normalizeAcceptance(''), null);
    assert.equal(normalizeAcceptance('   '), null);
    assert.equal(normalizeAcceptance(42), null);
    assert.equal(normalizeAcceptance(null), null);
  });
});

describe('validateAcceptancePartition — cross-Story duplication', () => {
  it('passes the default single-Story plan (nothing can collide)', () => {
    const { ok, violations } = validateAcceptancePartition([
      { id: 's1', acceptance: ['a renders', 'b saves', 'c deletes'] },
    ]);
    assert.equal(ok, true);
    assert.deepEqual(violations, []);
  });

  it('passes a clean N>1 split with disjoint acceptance', () => {
    const { ok } = validateAcceptancePartition([
      { id: 's1', acceptance: ['migration adds column'] },
      { id: 's2', acceptance: ['api reads the column'] },
    ]);
    assert.equal(ok, true);
  });

  it('rejects an identical AC shared across two Stories', () => {
    const { ok, violations } = validateAcceptancePartition([
      { id: 's1', acceptance: ['user can log in'] },
      { id: 's2', acceptance: ['User can log in'] }, // case/space-insensitive
    ]);
    assert.equal(ok, false);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, 'cross-story-duplicate');
    assert.deepEqual(violations[0].stories.sort(), ['s1', 's2']);
    assert.equal(violations[0].acceptance, 'user can log in'); // first-seen original
  });

  it('does not flag a duplicate AC within a single Story', () => {
    const { ok } = validateAcceptancePartition([
      { id: 's1', acceptance: ['x works', 'x works'] },
    ]);
    assert.equal(ok, true); // same-Story repetition is not a coupling signal
  });

  it('falls back to a positional id when a Story has no id/slug', () => {
    const { violations } = validateAcceptancePartition([
      { acceptance: ['shared'] },
      { acceptance: ['shared'] },
    ]);
    assert.deepEqual(violations[0].stories.sort(), ['story[0]', 'story[1]']);
  });
});

describe('validateAcceptancePartition — coverage against a manifest', () => {
  it('passes when Stories exactly partition the manifest', () => {
    const { ok } = validateAcceptancePartition(
      [
        { id: 's1', acceptance: ['a'] },
        { id: 's2', acceptance: ['b'] },
      ],
      { planAcceptance: ['a', 'b'] },
    );
    assert.equal(ok, true);
  });

  it('flags a manifest AC claimed by no Story', () => {
    const { ok, violations } = validateAcceptancePartition(
      [{ id: 's1', acceptance: ['a'] }],
      { planAcceptance: ['a', 'b'] },
    );
    assert.equal(ok, false);
    assert.ok(
      violations.some(
        (v) => v.kind === 'unclaimed-manifest-ac' && v.acceptance === 'b',
      ),
    );
  });

  it('flags a Story AC absent from the manifest', () => {
    const { ok, violations } = validateAcceptancePartition(
      [{ id: 's1', acceptance: ['a', 'rogue'] }],
      { planAcceptance: ['a'] },
    );
    assert.equal(ok, false);
    const orphan = violations.find((v) => v.kind === 'orphan-ac');
    assert.equal(orphan.acceptance, 'rogue');
    assert.equal(orphan.story, 's1');
  });
});

describe('assertAcceptancePartition', () => {
  it('returns the stories unchanged when clean', () => {
    const stories = [{ id: 's1', acceptance: ['a'] }];
    assert.equal(assertAcceptancePartition(stories), stories);
  });

  it('throws a batched error listing every violation', () => {
    assert.throws(
      () =>
        assertAcceptancePartition([
          { id: 's1', acceptance: ['shared'] },
          { id: 's2', acceptance: ['shared'] },
        ]),
      /split-policy.*acceptance-partition violation/s,
    );
  });
});
