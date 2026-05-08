#!/usr/bin/env node
/**
 * Cross-platform driver for `npm run test:coverage`.
 *
 * Why this exists: setting `NODE_V8_COVERAGE` directly in a package.json
 * script string (`NODE_V8_COVERAGE=... node ...`) is bash-only — Windows
 * cmd.exe (npm's default script-shell on Windows) treats it as a literal
 * argument and node never sees the env var. Wrapping the run in this
 * Node script keeps the env injection portable.
 *
 * The benchmark in `bench/coverage-bench.js` showed Path B
 * (NODE_V8_COVERAGE + `c8 report`) is ~19% faster on a Windows dev host
 * than Path A (`c8 <cmd>` wrapper) — both produce equivalent line /
 * branch / function percentages and an identical
 * `coverage/coverage-final.json` artifact for the CRAP gate. See
 * `bench/results.log` for the run-by-run numbers.
 *
 * Threshold gate (--lines=85 --branches=70 --functions=75) and the
 * include/exclude scope live in `.c8rc.cjs`; this script does not
 * override them.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COVERAGE_DIR = path.join(ROOT, 'coverage');
const V8_TMP = path.join(COVERAGE_DIR, 'tmp');

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

rmSync(COVERAGE_DIR, { recursive: true, force: true });
mkdirSync(V8_TMP, { recursive: true });

const testRun = spawnSync(
  process.execPath,
  [
    '--experimental-test-module-mocks',
    '--test',
    '--test-concurrency=8',
    'tests/**/*.test.js',
  ],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_V8_COVERAGE: V8_TMP },
  },
);

const reportRun = spawnSync(
  NPX,
  [
    'c8',
    'report',
    '--reporter=json',
    '--reporter=text',
    '--temp-directory',
    V8_TMP,
  ],
  { cwd: ROOT, stdio: 'inherit', shell: true },
);

// Threshold values mirror .c8rc.cjs. Passed explicitly because
// `c8 check-coverage` does not auto-load `.c8rc.cjs` the same way the
// `c8 <cmd>` wrapper does, and on Windows we observed it falling back
// to the built-in 90% default. Keep these in sync with `.c8rc.cjs`.
const checkRun = spawnSync(
  NPX,
  ['c8', 'check-coverage', '--lines=85', '--branches=70', '--functions=75'],
  { cwd: ROOT, stdio: 'inherit', shell: true },
);

const exitCode =
  testRun.status !== 0
    ? testRun.status
    : reportRun.status !== 0
      ? reportRun.status
      : checkRun.status;

process.exit(exitCode ?? 1);
