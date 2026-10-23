// Fixture for tests/scripts/run-tests.test.js — a failing todo test does not
// fail the run.
import { test } from 'node:test';

test('unfinished', { todo: true }, () => {
  throw new Error('todo failures are not failures');
});
