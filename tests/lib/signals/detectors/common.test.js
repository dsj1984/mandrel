import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractTool,
  isPositiveInt,
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
