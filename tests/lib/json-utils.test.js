import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deepEqual, isObject } from '../../.agents/scripts/lib/json-utils.js';

// ---------------------------------------------------------------------------
// json-utils.test.js — pin the shared JSON-shape helpers extracted in
// Story #2464. Five callers previously shipped byte-equivalent copies:
//
//   - lib/baselines/writer.js                          (deepEqual)
//   - lib/config/defaults.js                           (deepEqual)
//   - lib/observability/baseline-refresh-rate.js       (isObject)
//   - lib/observability/perf-aggregator.js             (isObject)
//   - lib/signals/schema.js                            (isObject)
// ---------------------------------------------------------------------------

describe('isObject()', () => {
  it('returns true for plain objects', () => {
    assert.equal(isObject({}), true);
    assert.equal(isObject({ a: 1 }), true);
    assert.equal(isObject(Object.create(null)), true);
  });

  it('returns false for arrays', () => {
    assert.equal(isObject([]), false);
    assert.equal(isObject([1, 2]), false);
  });

  it('returns false for null', () => {
    assert.equal(isObject(null), false);
  });

  it('returns false for primitives', () => {
    assert.equal(isObject(undefined), false);
    assert.equal(isObject(0), false);
    assert.equal(isObject('s'), false);
    assert.equal(isObject(true), false);
  });
});

describe('deepEqual()', () => {
  describe('primitives', () => {
    it('compares numbers, strings, booleans, null, undefined by ===', () => {
      assert.equal(deepEqual(1, 1), true);
      assert.equal(deepEqual('a', 'a'), true);
      assert.equal(deepEqual(true, true), true);
      assert.equal(deepEqual(null, null), true);
      assert.equal(deepEqual(undefined, undefined), true);
    });

    it('returns false for primitives of different value', () => {
      assert.equal(deepEqual(1, 2), false);
      assert.equal(deepEqual('a', 'b'), false);
      assert.equal(deepEqual(true, false), false);
    });

    it('returns false when one side is null', () => {
      assert.equal(deepEqual(null, {}), false);
      assert.equal(deepEqual({}, null), false);
      assert.equal(deepEqual(null, 0), false);
    });

    it('returns false for mismatched types', () => {
      assert.equal(deepEqual(1, '1'), false);
      assert.equal(deepEqual(0, false), false);
    });
  });

  describe('arrays', () => {
    it('returns true for two empty arrays', () => {
      assert.equal(deepEqual([], []), true);
    });

    it('returns true for elementwise-equal arrays', () => {
      assert.equal(deepEqual([1, 2, 3], [1, 2, 3]), true);
    });

    it('returns false for arrays of different length', () => {
      assert.equal(deepEqual([1, 2], [1, 2, 3]), false);
    });

    it('respects element order', () => {
      assert.equal(deepEqual([1, 2], [2, 1]), false);
    });

    it('returns false when one side is an array and the other is an object', () => {
      assert.equal(deepEqual([], {}), false);
      assert.equal(deepEqual({}, []), false);
    });
  });

  describe('objects', () => {
    it('returns true for two empty objects', () => {
      assert.equal(deepEqual({}, {}), true);
    });

    it('is insensitive to key order', () => {
      assert.equal(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
    });

    it('returns false when keys differ in count', () => {
      assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
    });

    it('returns false when a key is missing on the other side', () => {
      assert.equal(deepEqual({ a: 1, b: 2 }, { a: 1, c: 2 }), false);
    });

    it('returns false when a value differs', () => {
      assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
    });
  });

  describe('nested structures', () => {
    it('compares nested arrays and objects deeply', () => {
      const a = { a: [1, { b: [2, 3] }], c: 'x' };
      const b = { c: 'x', a: [1, { b: [2, 3] }] };
      assert.equal(deepEqual(a, b), true);
    });

    it('detects a nested mismatch', () => {
      const a = { a: [1, { b: [2, 3] }] };
      const b = { a: [1, { b: [2, 4] }] };
      assert.equal(deepEqual(a, b), false);
    });
  });
});
