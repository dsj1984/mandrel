// tests/lib/story-plan/trigger.test.js
/**
 * Unit tests for the story-plan triggering predicate (Epic #3212, Story #3261).
 *
 * Covers:
 *   - isNonTrivial returns true when changes.length >= floor.changes (default 3)
 *   - isNonTrivial returns true when acceptance.length >= floor.acceptance (default 3)
 *   - isNonTrivial returns true when sizingProfile === 'atomic-rewrite'
 *   - isNonTrivial returns false when all axes are below floor
 *   - alwaysEmitFloor thresholds are overridable via the floor parameter
 *   - Custom floor override for changes axis
 *   - Custom floor override for acceptance axis
 *   - Boundary: exactly at floor triggers (>=)
 *   - Boundary: one below floor does not trigger
 *   - Empty/null inputs are safe (treated as length 0)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_ALWAYS_EMIT_FLOOR,
  isNonTrivial,
} from '../../../.agents/scripts/lib/story-plan/trigger.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Three PathEntry objects — meets the default changes floor. */
const THREE_CHANGES = [
  { path: 'src/a.js', assumption: 'creates' },
  { path: 'src/b.js', assumption: 'refactors-existing' },
  { path: 'src/c.js', assumption: 'creates' },
];

/** Two PathEntry objects — below the default changes floor. */
const TWO_CHANGES = [
  { path: 'src/a.js', assumption: 'creates' },
  { path: 'src/b.js', assumption: 'refactors-existing' },
];

/** Three acceptance strings — meets the default acceptance floor. */
const THREE_ACCEPTANCE = [
  'The feature works for happy path',
  'Error messages are user-friendly',
  'Audit log records the event',
];

/** Two acceptance strings — below the default acceptance floor. */
const TWO_ACCEPTANCE = [
  'The feature works for happy path',
  'Error messages are user-friendly',
];

// ---------------------------------------------------------------------------
// Default floor constants
// ---------------------------------------------------------------------------

describe('DEFAULT_ALWAYS_EMIT_FLOOR', () => {
  it('has changes floor of 3', () => {
    assert.equal(DEFAULT_ALWAYS_EMIT_FLOOR.changes, 3);
  });

  it('has acceptance floor of 3', () => {
    assert.equal(DEFAULT_ALWAYS_EMIT_FLOOR.acceptance, 3);
  });
});

// ---------------------------------------------------------------------------
// isNonTrivial — triggering conditions
// ---------------------------------------------------------------------------

describe('isNonTrivial — changes axis', () => {
  it('returns true when changes.length equals the default floor (3)', () => {
    assert.equal(
      isNonTrivial({
        changes: THREE_CHANGES,
        acceptance: [],
        sizingProfile: null,
      }),
      true,
    );
  });

  it('returns true when changes.length exceeds the default floor', () => {
    const fourChanges = [
      ...THREE_CHANGES,
      { path: 'src/d.js', assumption: 'creates' },
    ];
    assert.equal(
      isNonTrivial({
        changes: fourChanges,
        acceptance: [],
        sizingProfile: null,
      }),
      true,
    );
  });

  it('returns false when changes.length is below the default floor', () => {
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: [],
        sizingProfile: null,
      }),
      false,
    );
  });
});

describe('isNonTrivial — acceptance axis', () => {
  it('returns true when acceptance.length equals the default floor (3)', () => {
    assert.equal(
      isNonTrivial({
        changes: [],
        acceptance: THREE_ACCEPTANCE,
        sizingProfile: null,
      }),
      true,
    );
  });

  it('returns true when acceptance.length exceeds the default floor', () => {
    const fourAC = [...THREE_ACCEPTANCE, 'Performance meets SLA'];
    assert.equal(
      isNonTrivial({ changes: [], acceptance: fourAC, sizingProfile: null }),
      true,
    );
  });

  it('returns false when acceptance.length is below the default floor', () => {
    assert.equal(
      isNonTrivial({
        changes: [],
        acceptance: TWO_ACCEPTANCE,
        sizingProfile: null,
      }),
      false,
    );
  });
});

describe('isNonTrivial — sizingProfile axis', () => {
  it('returns true when sizingProfile is atomic-rewrite regardless of counts', () => {
    assert.equal(
      isNonTrivial({
        changes: [],
        acceptance: [],
        sizingProfile: 'atomic-rewrite',
      }),
      true,
    );
  });

  it('returns true when sizingProfile is atomic-rewrite even with counts below floor', () => {
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: TWO_ACCEPTANCE,
        sizingProfile: 'atomic-rewrite',
      }),
      true,
    );
  });

  it('returns false when sizingProfile is a non-triggering profile', () => {
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: TWO_ACCEPTANCE,
        sizingProfile: 'scaffolding',
      }),
      false,
    );
  });

  it('returns false when sizingProfile is mechanical-sweep', () => {
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: TWO_ACCEPTANCE,
        sizingProfile: 'mechanical-sweep',
      }),
      false,
    );
  });

  it('returns false when sizingProfile is null', () => {
    assert.equal(
      isNonTrivial({ changes: [], acceptance: [], sizingProfile: null }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// isNonTrivial — below all thresholds
// ---------------------------------------------------------------------------

describe('isNonTrivial — below all thresholds', () => {
  it('returns false when changes, acceptance are below floor and no triggering profile', () => {
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: TWO_ACCEPTANCE,
        sizingProfile: null,
      }),
      false,
    );
  });

  it('returns false for a completely empty Story body', () => {
    assert.equal(
      isNonTrivial({ changes: [], acceptance: [], sizingProfile: null }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// isNonTrivial — floor overrides
// ---------------------------------------------------------------------------

describe('isNonTrivial — alwaysEmitFloor overrides', () => {
  it('respects a custom changes floor of 2', () => {
    // TWO_CHANGES.length (2) >= floor.changes (2) → true
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: [],
        sizingProfile: null,
        floor: { changes: 2 },
      }),
      true,
    );
  });

  it('respects a custom acceptance floor of 2', () => {
    // TWO_ACCEPTANCE.length (2) >= floor.acceptance (2) → true
    assert.equal(
      isNonTrivial({
        changes: [],
        acceptance: TWO_ACCEPTANCE,
        sizingProfile: null,
        floor: { acceptance: 2 },
      }),
      true,
    );
  });

  it('falls back to default floor when only one axis is overridden', () => {
    // Override changes to 2, acceptance stays at default 3.
    // TWO_ACCEPTANCE.length (2) < 3 → acceptance does not trigger.
    // TWO_CHANGES.length (2) >= 2 → changes does trigger.
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: TWO_ACCEPTANCE,
        sizingProfile: null,
        floor: { changes: 2 },
      }),
      true,
    );
  });

  it('raises floor to suppress triggering — changes floor 4 with 3 changes', () => {
    // THREE_CHANGES.length (3) < floor.changes (4) → false
    assert.equal(
      isNonTrivial({
        changes: THREE_CHANGES,
        acceptance: [],
        sizingProfile: null,
        floor: { changes: 4 },
      }),
      false,
    );
  });

  it('ignores invalid floor values and falls back to defaults', () => {
    // floor.changes = 0 is invalid (< 1) → default 3 applies
    // TWO_CHANGES.length (2) < 3 → false
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: [],
        sizingProfile: null,
        floor: { changes: 0 },
      }),
      false,
    );
  });

  it('ignores non-numeric floor values and falls back to defaults', () => {
    // floor.changes = 'two' is non-numeric → default 3 applies
    // TWO_CHANGES.length (2) < 3 → false
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: [],
        sizingProfile: null,
        floor: { changes: 'two' },
      }),
      false,
    );
  });

  it('handles absent floor parameter (undefined) using defaults', () => {
    assert.equal(
      isNonTrivial({
        changes: TWO_CHANGES,
        acceptance: [],
        sizingProfile: null,
      }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// isNonTrivial — edge cases / null-safety
// ---------------------------------------------------------------------------

describe('isNonTrivial — null-safety', () => {
  it('treats null changes as empty array (length 0)', () => {
    assert.equal(
      isNonTrivial({ changes: null, acceptance: [], sizingProfile: null }),
      false,
    );
  });

  it('treats null acceptance as empty array (length 0)', () => {
    assert.equal(
      isNonTrivial({ changes: [], acceptance: null, sizingProfile: null }),
      false,
    );
  });

  it('treats undefined changes as empty array (length 0)', () => {
    assert.equal(
      isNonTrivial({ changes: undefined, acceptance: [], sizingProfile: null }),
      false,
    );
  });
});
