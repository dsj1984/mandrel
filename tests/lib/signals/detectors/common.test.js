import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractTool,
  isPositiveInt,
  validateDetectorArgs,
} from '../../../../.agents/scripts/lib/signals/detectors/common.js';

// ---------------------------------------------------------------------------
// detectors/common.test.js — pin the shared signals helpers extracted in
// Story #2464. Five callers previously shipped byte-equivalent copies:
//
//   - lib/signals/detectors/hotspot.js   (isPositiveInt + extractTool)
//   - lib/signals/detectors/retry.js     (isPositiveInt + extractTool)
//   - lib/signals/detectors/rework.js    (isPositiveInt + extractTool)
//   - lib/signals/read.js                (isPositiveInt)
//   - lib/signals/schema.js              (isPositiveInt)
// ---------------------------------------------------------------------------

describe('isPositiveInt()', () => {
  it('returns true for a positive integer', () => {
    assert.equal(isPositiveInt(1), true);
    assert.equal(isPositiveInt(42), true);
    assert.equal(isPositiveInt(Number.MAX_SAFE_INTEGER), true);
  });

  it('returns false for zero', () => {
    assert.equal(isPositiveInt(0), false);
  });

  it('returns false for negative integers', () => {
    assert.equal(isPositiveInt(-1), false);
    assert.equal(isPositiveInt(-42), false);
  });

  it('returns false for non-integer numbers', () => {
    assert.equal(isPositiveInt(1.5), false);
    assert.equal(isPositiveInt(Number.NaN), false);
    assert.equal(isPositiveInt(Number.POSITIVE_INFINITY), false);
  });

  it('returns false for non-numeric inputs', () => {
    assert.equal(isPositiveInt('1'), false);
    assert.equal(isPositiveInt(null), false);
    assert.equal(isPositiveInt(undefined), false);
    assert.equal(isPositiveInt({}), false);
    assert.equal(isPositiveInt([]), false);
    assert.equal(isPositiveInt(true), false);
  });
});

describe('extractTool()', () => {
  it('prefers source.tool when present', () => {
    const rec = {
      source: { tool: 'Edit' },
      details: { tool: 'Write' },
    };
    assert.equal(extractTool(rec), 'Edit');
  });

  it('falls back to details.tool when source.tool is absent', () => {
    const rec = { details: { tool: 'Write' } };
    assert.equal(extractTool(rec), 'Write');
  });

  it('falls back to details.tool when source.tool is empty string', () => {
    const rec = { source: { tool: '' }, details: { tool: 'Write' } };
    assert.equal(extractTool(rec), 'Write');
  });

  it('falls back to details.tool when source.tool is not a string', () => {
    const rec = { source: { tool: 123 }, details: { tool: 'Write' } };
    assert.equal(extractTool(rec), 'Write');
  });

  it('returns null when both source.tool and details.tool are missing', () => {
    assert.equal(extractTool({}), null);
    assert.equal(extractTool({ source: {} }), null);
    assert.equal(extractTool({ details: {} }), null);
    assert.equal(extractTool({ source: {}, details: {} }), null);
  });

  it('returns null when both fields are empty strings', () => {
    const rec = { source: { tool: '' }, details: { tool: '' } };
    assert.equal(extractTool(rec), null);
  });

  it('returns null for null/undefined records (no throw)', () => {
    assert.equal(extractTool(null), null);
    assert.equal(extractTool(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// validateDetectorArgs() — the shared argument-validation preamble hoisted
// out of detectRework / detectRetry / detectHotspot in Story #4077. The three
// detectors previously shipped a near-identical guard block; this helper owns
// the error-message contract so they stay consistent.
// ---------------------------------------------------------------------------

describe('validateDetectorArgs() — full preamble (rework/retry shape)', () => {
  const baseArgs = () => ({
    tracesPath: '/tmp/traces.ndjson',
    epicId: 10,
    storyId: 20,
    taskId: 30,
    threshold: 2,
  });

  it('returns the normalized arg set for a valid full argument object', () => {
    const out = validateDetectorArgs(baseArgs(), { fnName: 'detectRework' });
    assert.equal(out.tracesPath, '/tmp/traces.ndjson');
    assert.equal(out.epicId, 10);
    assert.equal(out.storyId, 20);
    assert.equal(out.taskId, 30);
    assert.equal(out.threshold, 2);
    assert.equal(typeof out.nowFn, 'function');
  });

  it('defaults taskId to null when omitted', () => {
    const { taskId, ...rest } = baseArgs();
    const out = validateDetectorArgs(rest, { fnName: 'detectRework' });
    assert.equal(out.taskId, null);
  });

  it('defaults nowFn to a real ISO clock when omitted', () => {
    const out = validateDetectorArgs(baseArgs(), { fnName: 'detectRetry' });
    assert.match(out.nowFn(), /^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns the injected nowFn unchanged when provided', () => {
    const FIXED = '2026-01-02T03:04:05.678Z';
    const out = validateDetectorArgs(
      { ...baseArgs(), nowFn: () => FIXED },
      { fnName: 'detectRetry' },
    );
    assert.equal(out.nowFn(), FIXED);
  });

  it('throws TypeError when args is null or not an object', () => {
    assert.throws(
      () => validateDetectorArgs(null, { fnName: 'detectRework' }),
      TypeError,
    );
    assert.throws(
      () => validateDetectorArgs(undefined, { fnName: 'detectRework' }),
      TypeError,
    );
    assert.throws(
      () => validateDetectorArgs(42, { fnName: 'detectRework' }),
      TypeError,
    );
  });

  it('throws TypeError when tracesPath is missing or empty', () => {
    assert.throws(
      () =>
        validateDetectorArgs(
          { ...baseArgs(), tracesPath: '' },
          { fnName: 'detectRework' },
        ),
      TypeError,
    );
    assert.throws(
      () =>
        validateDetectorArgs(
          { ...baseArgs(), tracesPath: 42 },
          { fnName: 'detectRework' },
        ),
      TypeError,
    );
  });

  it('throws RangeError for a non-positive epicId', () => {
    assert.throws(
      () =>
        validateDetectorArgs(
          { ...baseArgs(), epicId: 0 },
          { fnName: 'detectRework' },
        ),
      RangeError,
    );
  });

  it('throws RangeError for a non-positive storyId', () => {
    assert.throws(
      () =>
        validateDetectorArgs(
          { ...baseArgs(), storyId: -1 },
          { fnName: 'detectRework' },
        ),
      RangeError,
    );
  });

  it('throws RangeError for a non-positive taskId (when not null)', () => {
    assert.throws(
      () =>
        validateDetectorArgs(
          { ...baseArgs(), taskId: 0 },
          { fnName: 'detectRework' },
        ),
      RangeError,
    );
  });

  it('throws RangeError for a negative threshold', () => {
    assert.throws(
      () =>
        validateDetectorArgs(
          { ...baseArgs(), threshold: -1 },
          { fnName: 'detectRework' },
        ),
      RangeError,
    );
  });

  it('throws TypeError when nowFn is provided but not a function', () => {
    assert.throws(
      () =>
        validateDetectorArgs(
          { ...baseArgs(), nowFn: 42 },
          { fnName: 'detectRework' },
        ),
      TypeError,
    );
  });

  it('prefixes every thrown message with the supplied fnName', () => {
    assert.throws(
      () => validateDetectorArgs(null, { fnName: 'detectRetry' }),
      /^TypeError: detectRetry: /,
    );
    assert.throws(
      () =>
        validateDetectorArgs(
          { ...baseArgs(), epicId: 0 },
          { fnName: 'detectRetry' },
        ),
      /^RangeError: detectRetry: epicId/,
    );
  });
});

describe('validateDetectorArgs() — gated preamble (hotspot shape)', () => {
  it('validates only args/nowFn/epicId when the require flags are off', () => {
    const out = validateDetectorArgs(
      { epicId: 7 },
      {
        fnName: 'detectHotspot',
        requireTracesPath: false,
        requireStoryId: false,
        requireThreshold: false,
      },
    );
    assert.equal(out.epicId, 7);
    assert.equal(out.tracesPath, undefined);
    assert.equal(out.storyId, undefined);
    assert.equal(out.taskId, undefined);
    assert.equal(out.threshold, undefined);
    assert.equal(typeof out.nowFn, 'function');
  });

  it('still throws RangeError for a non-positive epicId', () => {
    assert.throws(
      () =>
        validateDetectorArgs(
          { epicId: 0 },
          {
            fnName: 'detectHotspot',
            requireTracesPath: false,
            requireStoryId: false,
            requireThreshold: false,
          },
        ),
      RangeError,
    );
  });

  it('does not require tracesPath/storyId/threshold when gated off', () => {
    assert.doesNotThrow(() =>
      validateDetectorArgs(
        { epicId: 1 },
        {
          fnName: 'detectHotspot',
          requireTracesPath: false,
          requireStoryId: false,
          requireThreshold: false,
        },
      ),
    );
  });
});
