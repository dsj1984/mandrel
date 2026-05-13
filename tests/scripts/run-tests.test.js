import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildNodeTestArgs,
  runTestSuite,
} from '../../.agents/scripts/run-tests.js';

test('buildNodeTestArgs preserves the default test glob and appends extra args', () => {
  assert.deepEqual(buildNodeTestArgs(['tests/foo.test.js']), [
    '--experimental-test-module-mocks',
    '--test',
    '--test-concurrency=8',
    'tests/**/*.test.js',
    'tests/foo.test.js',
  ]);
});

test('runTestSuite cleans reserved temp even when the test process fails', () => {
  const calls = [];
  const status = runTestSuite({
    argv: ['tests/failing.test.js'],
    cwd: '/repo',
    spawn: (_cmd, args, opts) => {
      calls.push({ kind: 'spawn', args, opts });
      return { status: 12 };
    },
    cleanup: (opts) => {
      calls.push({ kind: 'cleanup', opts });
    },
  });

  assert.equal(status, 12);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'spawn');
  assert.equal(calls[1].kind, 'cleanup');
  assert.deepEqual(calls[1].opts, { repoRoot: '/repo' });
});
