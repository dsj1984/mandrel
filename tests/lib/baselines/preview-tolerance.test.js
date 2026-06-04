import assert from 'node:assert/strict';
import test from 'node:test';

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
