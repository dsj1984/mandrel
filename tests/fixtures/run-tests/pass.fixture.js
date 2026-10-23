// Fixture for tests/scripts/run-tests.test.js — two passing tests with
// distinct names, so a name pattern can be seen to filter one out.
import { test } from 'node:test';

test('alpha-kept', () => {});
test('beta-dropped', () => {});
