// Fixture for tests/scripts/run-tests.test.js — one failing test.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('fails', () => {
  assert.equal(1, 2);
});
