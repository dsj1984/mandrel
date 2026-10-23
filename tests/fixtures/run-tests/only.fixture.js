// Fixture for tests/scripts/run-tests.test.js — `--test-only` runs the
// focused test alone.
import { test } from 'node:test';

test.only('focused', () => {});
test('unfocused', () => {});
