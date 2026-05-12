import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coercePositiveInt,
  parseGateArgs,
} from '../.agents/scripts/lib/gates/gate-cli.js';

/**
 * Story #1476 — shared CLI parsing for the baseline gates. Each gate
 * previously re-implemented these same six flags + the FRICTION_*_ID env
 * fallback; the consolidation lets parsing behaviour evolve in one place.
 */

describe('coercePositiveInt', () => {
  it('accepts positive integer values (string or number)', () => {
    assert.equal(coercePositiveInt('42'), 42);
    assert.equal(coercePositiveInt(7), 7);
    assert.equal(coercePositiveInt('1'), 1);
  });

  it('rejects zero, negatives, floats, NaN, undefined, and null', () => {
    assert.equal(coercePositiveInt('0'), null);
    assert.equal(coercePositiveInt(0), null);
    assert.equal(coercePositiveInt('-1'), null);
    assert.equal(coercePositiveInt('1.5'), null);
    assert.equal(coercePositiveInt('abc'), null);
    assert.equal(coercePositiveInt(undefined), null);
    assert.equal(coercePositiveInt(null), null);
    assert.equal(coercePositiveInt(''), null);
  });
});

describe('parseGateArgs — defaults', () => {
  it('returns null/false/empty for every flag when argv is empty', () => {
    const out = parseGateArgs([], { env: {} });
    assert.deepEqual(out, {
      changedSinceRef: null,
      fullScope: false,
      epicRef: null,
      storyId: null,
      epicId: null,
      jsonPath: null,
      extras: {},
    });
  });
});

describe('parseGateArgs — --changed-since', () => {
  it('reads the explicit ref', () => {
    assert.equal(
      parseGateArgs(['--changed-since', 'origin/main'], { env: {} })
        .changedSinceRef,
      'origin/main',
    );
  });

  it('falls back to "main" when bare', () => {
    assert.equal(
      parseGateArgs(['--changed-since'], { env: {} }).changedSinceRef,
      'main',
    );
  });

  it('does not consume the next flag as the ref value', () => {
    assert.equal(
      parseGateArgs(['--changed-since', '--story', '42'], { env: {} })
        .changedSinceRef,
      'main',
    );
  });
});

describe('parseGateArgs — --full-scope', () => {
  it('is true when the flag is present anywhere in argv', () => {
    assert.equal(parseGateArgs(['--full-scope'], { env: {} }).fullScope, true);
    assert.equal(
      parseGateArgs(['--json', 'x', '--full-scope'], { env: {} }).fullScope,
      true,
    );
  });

  it('is false otherwise', () => {
    assert.equal(parseGateArgs([], { env: {} }).fullScope, false);
  });
});

describe('parseGateArgs — --epic-ref', () => {
  it('returns the ref when present and non-empty', () => {
    assert.equal(
      parseGateArgs(['--epic-ref', 'epic/1114'], { env: {} }).epicRef,
      'epic/1114',
    );
  });

  it('returns null when followed by another flag', () => {
    assert.equal(
      parseGateArgs(['--epic-ref', '--json', 'x'], { env: {} }).epicRef,
      null,
    );
  });

  it('returns null when absent', () => {
    assert.equal(parseGateArgs(['--story', '7'], { env: {} }).epicRef, null);
  });
});

describe('parseGateArgs — --story / --epic env fallback', () => {
  it('reads --story <id> / --epic <id> from argv first', () => {
    const out = parseGateArgs(['--story', '42', '--epic', '7'], { env: {} });
    assert.equal(out.storyId, 42);
    assert.equal(out.epicId, 7);
  });

  it('falls back to FRICTION_STORY_ID / FRICTION_EPIC_ID env vars', () => {
    const out = parseGateArgs([], {
      env: { FRICTION_STORY_ID: '11', FRICTION_EPIC_ID: '22' },
    });
    assert.equal(out.storyId, 11);
    assert.equal(out.epicId, 22);
  });

  it('argv wins over env when both are present', () => {
    const out = parseGateArgs(['--story', '1', '--epic', '2'], {
      env: { FRICTION_STORY_ID: '99', FRICTION_EPIC_ID: '98' },
    });
    assert.equal(out.storyId, 1);
    assert.equal(out.epicId, 2);
  });

  it('returns null when neither argv nor env yields a positive int', () => {
    const out = parseGateArgs(['--story', 'NaN'], { env: {} });
    assert.equal(out.storyId, null);
    assert.equal(out.epicId, null);
  });

  it('a malformed --story value falls through to the env fallback', () => {
    const out = parseGateArgs(['--story', '0'], {
      env: { FRICTION_STORY_ID: '5' },
    });
    assert.equal(out.storyId, 5);
  });
});

describe('parseGateArgs — --json', () => {
  it('returns the value when present', () => {
    assert.equal(
      parseGateArgs(['--json', 'out.json'], { env: {} }).jsonPath,
      'out.json',
    );
  });

  it('returns null when followed by another flag', () => {
    assert.equal(
      parseGateArgs(['--json', '--story', '1'], { env: {} }).jsonPath,
      null,
    );
  });
});

describe('parseGateArgs — extras hook for gate-specific flags', () => {
  it('passes argv to each extras parser and surfaces the returned value', () => {
    const argv = ['--baseline', 'b.json', '--coverage', 'c.json'];
    const readNext = (flag) => (a) => {
      const i = a.indexOf(flag);
      return i >= 0 ? a[i + 1] : null;
    };
    const out = parseGateArgs(argv, {
      env: {},
      extras: {
        baselinePath: readNext('--baseline'),
        coveragePath: readNext('--coverage'),
      },
    });
    assert.equal(out.extras.baselinePath, 'b.json');
    assert.equal(out.extras.coveragePath, 'c.json');
  });
});
