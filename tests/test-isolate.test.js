import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveTestFiles } from '../.agents/scripts/lib/test-isolate/list-files.js';
import {
  parseSingleFileTap,
  parseSuiteTap,
} from '../.agents/scripts/lib/test-isolate/parse-tap.js';
import {
  bisectFlipper,
  diagnoseIsolation,
} from '../.agents/scripts/lib/test-isolate/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

test('parseSuiteTap extracts top-level file pass/fail with failing leaves', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: tests/foo.test.js',
    '    # Subtest: case A',
    '    ok 1 - case A',
    '    # Subtest: case B',
    '    not ok 2 - case B',
    'ok 1 - tests/foo.test.js',
    '# Subtest: tests/bar.test.js',
    '    # Subtest: case X',
    '    not ok 1 - case X',
    'not ok 2 - tests/bar.test.js',
  ].join('\n');
  const map = parseSuiteTap(tap);
  assert.deepStrictEqual(map.get('tests/foo.test.js'), {
    status: 'pass',
    failingTests: ['case B'],
  });
  assert.deepStrictEqual(map.get('tests/bar.test.js'), {
    status: 'fail',
    failingTests: ['case X'],
  });
});

test('parseSingleFileTap maps exit code and collects failing leaves', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: case A',
    'ok 1 - case A',
    '# Subtest: case B',
    'not ok 2 - case B',
  ].join('\n');
  assert.deepStrictEqual(parseSingleFileTap(tap, 0), {
    status: 'pass',
    failingTests: ['case B'],
  });
  assert.deepStrictEqual(parseSingleFileTap(tap, 1), {
    status: 'fail',
    failingTests: ['case B'],
  });
});

test('resolveTestFiles defaults to all tests under tests/', () => {
  const files = resolveTestFiles({ repoRoot: REPO_ROOT });
  assert.ok(files.length > 50, `expected many test files, got ${files.length}`);
  assert.ok(files.every((f) => f.endsWith('.test.js')));
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.ok(!files.some((f) => f.includes('.worktrees')));
});

test('resolveTestFiles supports an explicit relative file', () => {
  const files = resolveTestFiles({
    pattern: 'tests/test-isolate.test.js',
    repoRoot: REPO_ROOT,
  });
  assert.deepStrictEqual(files, ['tests/test-isolate.test.js']);
});

test('resolveTestFiles applies glob filters to the discovered universe', () => {
  const files = resolveTestFiles({
    pattern: 'tests/baselines/**/*.test.js',
    repoRoot: REPO_ROOT,
  });
  assert.ok(files.length > 0);
  assert.ok(files.every((f) => f.startsWith('tests/baselines/')));
});

test('diagnoseIsolation detects env-var leak from the fixture polluter', async () => {
  const files = [
    'tests/fixtures/test-isolate/victim.fixture.js',
    'tests/fixtures/test-isolate/polluter.fixture.js',
  ];
  const report = await diagnoseIsolation({
    repoRoot: REPO_ROOT,
    files,
    suiteConcurrency: 1,
    workers: 2,
    maxBisectTargets: 0,
  });

  const polluterDiff = report.envMutators.find(
    (m) => m.file === 'tests/fixtures/test-isolate/polluter.fixture.js',
  );
  assert.ok(
    polluterDiff,
    'polluter fixture should be flagged as an env-mutator',
  );
  assert.ok(
    polluterDiff.envDiff.added.includes('TEST_ISOLATE_FIXTURE_VAR'),
    `expected TEST_ISOLATE_FIXTURE_VAR in added env vars, got ${JSON.stringify(polluterDiff.envDiff)}`,
  );

  const victimIsolated = report.isolated.find(
    (r) => r.file === 'tests/fixtures/test-isolate/victim.fixture.js',
  );
  assert.strictEqual(victimIsolated.status, 'pass');
});

test('bisectFlipper narrows pool by binary halving when target fails with polluter', async () => {
  // Simulated polluter = 'F4'. Target fails iff F4 is in the candidate set.
  const runSuiteFn = async ({ files }) => {
    const targetFails = files.includes('target') && files.includes('F4');
    return {
      results: files.map((f) => ({
        file: f,
        status: f === 'target' && targetFails ? 'fail' : 'pass',
        failingTests: [],
      })),
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  };

  const result = await bisectFlipper({
    repoRoot: '/x',
    target: 'target',
    candidates: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'],
    concurrency: 1,
    maxDepth: 8,
    runSuiteFn,
  });

  assert.deepStrictEqual(result.suspects, ['F4']);
  assert.strictEqual(result.inconclusive, false);
});

test('bisectFlipper marks inconclusive when neither half reproduces failure', async () => {
  const runSuiteFn = async ({ files }) => ({
    results: files.map((f) => ({
      file: f,
      status: 'pass',
      failingTests: [],
    })),
    exitCode: 0,
    stdout: '',
    stderr: '',
  });

  const result = await bisectFlipper({
    repoRoot: '/x',
    target: 'target',
    candidates: ['F1', 'F2', 'F3', 'F4'],
    concurrency: 1,
    maxDepth: 4,
    runSuiteFn,
  });

  assert.strictEqual(result.inconclusive, true);
});
