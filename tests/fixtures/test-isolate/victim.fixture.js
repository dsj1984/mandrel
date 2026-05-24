/**
 * Fixture for test-isolate self-test. Asserts the env var the polluter
 * leaks is unset — passes alone (clean env), fails when run after the
 * polluter under shared process state.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

test('victim: asserts the leaked env var is not set', () => {
  assert.strictEqual(process.env.TEST_ISOLATE_FIXTURE_VAR, undefined);
});
