import assert from 'node:assert/strict';
import test from 'node:test';
import {
  degraded,
  isDegraded,
  isGateMode,
  softFailOrThrow,
} from '../.agents/scripts/lib/degraded-mode.js';

test('degraded() returns the canonical envelope shape', () => {
  const envelope = degraded('GIT_DIFF_TIMEOUT', 'detail goes here');
  assert.deepEqual(envelope, {
    ok: false,
    degraded: true,
    reason: 'GIT_DIFF_TIMEOUT',
    detail: 'detail goes here',
  });
});

test('degraded() defaults detail to empty string when omitted', () => {
  const envelope = degraded('FOO');
  assert.equal(envelope.detail, '');
});

test('isDegraded() recognises only the full envelope shape', () => {
  assert.equal(isDegraded(degraded('X', 'y')), true);
  assert.equal(isDegraded({ ok: false, degraded: true, reason: 'X' }), true);
  assert.equal(isDegraded({ ok: true, degraded: true, reason: 'X' }), false);
  assert.equal(isDegraded({ ok: false, degraded: false, reason: 'X' }), false);
  assert.equal(isDegraded({ ok: false, degraded: true }), false);
  assert.equal(isDegraded(null), false);
  assert.equal(isDegraded(undefined), false);
  assert.equal(isDegraded('not an object'), false);
});

test('isGateMode() honours --gate-mode argv flag', () => {
  assert.equal(isGateMode({ argv: ['--gate-mode'], env: {} }), true);
  assert.equal(isGateMode({ argv: ['--other'], env: {} }), false);
  assert.equal(isGateMode({ argv: [], env: {} }), false);
});

test('isGateMode() honours MANDREL_GATE_MODE=1 env var', () => {
  assert.equal(isGateMode({ argv: [], env: { MANDREL_GATE_MODE: '1' } }), true);
  // Strict equality: only "1" enables gate-mode.
  assert.equal(
    isGateMode({ argv: [], env: { MANDREL_GATE_MODE: 'true' } }),
    false,
  );
  assert.equal(isGateMode({ argv: [], env: { MANDREL_GATE_MODE: '' } }), false);
});

test('softFailOrThrow() returns the degraded envelope outside gate-mode', () => {
  const result = softFailOrThrow('LINT_OUTPUT_PARSE_FAILED', 'bad json', {
    argv: [],
    env: {},
  });
  assert.equal(isDegraded(result), true);
  assert.equal(result.reason, 'LINT_OUTPUT_PARSE_FAILED');
  assert.equal(result.detail, 'bad json');
});

test('softFailOrThrow() throws under --gate-mode', () => {
  assert.throws(
    () =>
      softFailOrThrow('GIT_DIFF_TIMEOUT', 'hung', {
        argv: ['--gate-mode'],
        env: {},
      }),
    (err) => {
      assert.equal(err.code, 'GIT_DIFF_TIMEOUT');
      assert.equal(err.degraded, true);
      assert.match(err.message, /hard-fail/);
      return true;
    },
  );
});

test('softFailOrThrow() throws under MANDREL_GATE_MODE=1', () => {
  assert.throws(
    () =>
      softFailOrThrow('GIT_DIFF_FAILED', 'no remote', {
        argv: [],
        env: { MANDREL_GATE_MODE: '1' },
      }),
    /hard-fail: GIT_DIFF_FAILED/,
  );
});
