import assert from 'node:assert/strict';
import test from 'node:test';

import { compareCrap } from '../../../.agents/scripts/lib/baselines/kinds/crap.js';
import {
  MI_PREVIEW_DEFAULT_TOLERANCE,
  resolvePreviewTolerance,
} from '../../../.agents/scripts/lib/baselines/preview-gates.js';

// The preview gate must use the SAME maintainability tolerance the
// authoritative `check-baselines` gate uses (the resolved
// `quality.maintainability.tolerance` scalar). Previously the preview ignored
// it and hardcoded the default, so a project that raised its tolerance still
// saw the local pre-commit/pre-push gate flag sub-tolerance drops that CI
// accepted.

test('resolvePreviewTolerance: prefers an explicit override', () => {
  assert.equal(resolvePreviewTolerance({ explicit: 3, configured: 12 }), 3);
});

test('resolvePreviewTolerance: falls back to the configured tolerance', () => {
  // The case this fix exists for: configured 12 must win over the default.
  assert.equal(resolvePreviewTolerance({ explicit: null, configured: 12 }), 12);
  assert.equal(resolvePreviewTolerance({ configured: 12 }), 12);
});

test('resolvePreviewTolerance: uses the framework default when nothing is set', () => {
  assert.equal(resolvePreviewTolerance({}), MI_PREVIEW_DEFAULT_TOLERANCE);
  assert.equal(
    resolvePreviewTolerance({ explicit: null, configured: undefined }),
    MI_PREVIEW_DEFAULT_TOLERANCE,
  );
});

test('resolvePreviewTolerance: ignores non-finite or negative-sentinel inputs', () => {
  assert.equal(
    resolvePreviewTolerance({ explicit: Number.NaN, configured: 12 }),
    12,
  );
  // A configured 0 is a valid, intentional zero-tolerance setting.
  assert.equal(resolvePreviewTolerance({ configured: 0 }), 0);
});

// Story #4731 (AC-3) — the quality-preview CRAP regression compare
// (`compareCrap`, fed the configured crap tolerance by `runCrapPreview`)
// must honor that tolerance rather than failing on any positive delta: a
// positive delta at or under tolerance yields no violation, an over-tolerance
// delta still fails.
function crapRow(overrides = {}) {
  return {
    file: 'lib/a.js',
    method: 'doWork',
    startLine: 10,
    // cyclomatic > 1 so the c=1 flap-exemption does not swallow the row.
    cyclomatic: 5,
    coverage: 0.5,
    crap: 10,
    ...overrides,
  };
}

test('compareCrap: a positive delta at or under the configured tolerance is not a regression', () => {
  const tolerance = 0.5;
  // Delta = +0.5, exactly at tolerance → demoted (crap <= baseline + tolerance).
  const atTolerance = compareCrap({
    currentRows: [crapRow({ crap: 10.5 })],
    baselineRows: [
      { file: 'lib/a.js', method: 'doWork', startLine: 10, crap: 10 },
    ],
    newMethodCeiling: 30,
    tolerance,
  });
  assert.equal(
    atTolerance.regressions,
    0,
    'at-tolerance delta yields no violation',
  );
  assert.equal(atTolerance.violations.length, 0);

  // Delta = +0.3, under tolerance → also demoted.
  const underTolerance = compareCrap({
    currentRows: [crapRow({ crap: 10.3 })],
    baselineRows: [
      { file: 'lib/a.js', method: 'doWork', startLine: 10, crap: 10 },
    ],
    newMethodCeiling: 30,
    tolerance,
  });
  assert.equal(
    underTolerance.regressions,
    0,
    'under-tolerance delta yields no violation',
  );
});

test('compareCrap: a positive delta over the configured tolerance still fails', () => {
  const tolerance = 0.5;
  // Delta = +0.6, over tolerance → regression preserved.
  const overTolerance = compareCrap({
    currentRows: [crapRow({ crap: 10.6 })],
    baselineRows: [
      { file: 'lib/a.js', method: 'doWork', startLine: 10, crap: 10 },
    ],
    newMethodCeiling: 30,
    tolerance,
  });
  assert.equal(
    overTolerance.regressions,
    1,
    'over-tolerance delta still fails',
  );
  assert.equal(overTolerance.violations[0].kind, 'regression');
});
