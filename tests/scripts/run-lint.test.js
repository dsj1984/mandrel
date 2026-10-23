import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runLintTasks } from '../../scripts/run-lint.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/**
 * A spawn double: every task exits 0 unless `outcomes` maps a fragment of its
 * argv to `{ code }` or `{ signal }`. Records each call's argv and options.
 */
function fakeSpawn(outcomes = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ argv: [cmd, ...args].join(' '), opts });
    const child = new EventEmitter();
    const key = Object.keys(outcomes).find((k) => args.join(' ').includes(k));
    const { code = 0, signal = null } = key ? outcomes[key] : {};
    setImmediate(() => child.emit('exit', signal ? null : code, signal));
    return child;
  };
  return { spawn, calls };
}

async function run(outcomes) {
  const lines = [];
  const { spawn, calls } = fakeSpawn(outcomes);
  const outcome = await runLintTasks({ spawn, write: (l) => lines.push(l) });
  return { ...outcome, lines, calls };
}

test('a clean run exits 0 and prints no failure line', async () => {
  const { exitCode, failures, lines } = await run();
  assert.equal(exitCode, 0);
  assert.deepEqual(failures, []);
  assert.deepEqual(lines, []);
});

test('every failed task is named with its exit code, in roster order', async () => {
  const { exitCode, lines } = await run({
    'check-comment-policy.js': { code: 2 },
    'biome ci': { code: 1 },
  });
  assert.deepEqual(lines, [
    '[run-lint] ✗ biome exited 1',
    '[run-lint] ✗ comment-policy exited 2',
  ]);
  assert.equal(exitCode, 1, 'the first failure in roster order sets the code');
});

test('exit 101 is flagged as a crash', async () => {
  const { exitCode, lines } = await run({ 'biome ci': { code: 101 } });
  assert.deepEqual(lines, [
    '[run-lint] ✗ biome exited 101 (Rust panic exit: the tool crashed; see its stderr above)',
  ]);
  assert.equal(exitCode, 101);
});

test('a task killed by a signal is named with the signal and exits 1', async () => {
  const { exitCode, failures, lines } = await run({
    'markdownlint-cli2': { signal: 'SIGKILL' },
  });
  assert.deepEqual(lines, ['[run-lint] ✗ markdownlint killed by SIGKILL']);
  assert.deepEqual(failures, [
    { name: 'markdownlint', code: null, signal: 'SIGKILL' },
  ]);
  assert.equal(exitCode, 1);
});

test('only the biome task gets RUST_BACKTRACE=1; other tasks inherit the env', async () => {
  const { calls } = await run();
  const biome = calls.filter((c) => c.argv.includes('biome ci'));
  assert.equal(biome.length, 1);
  assert.equal(biome[0].opts.env.RUST_BACKTRACE, '1');
  assert.equal(biome[0].opts.env.PATH, process.env.PATH);
  for (const call of calls.filter((c) => !c.argv.includes('biome ci'))) {
    assert.equal(call.opts.env, undefined, `${call.argv} must inherit env`);
  }
});

test('--help prints usage and runs no linter', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/run-lint.js'), '--help'],
    { encoding: 'utf8', cwd: REPO_ROOT, timeout: 30_000 },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /node scripts\/run-lint\.js/);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /\[run-lint\] ✗|Checked \d+ files/,
  );
});
