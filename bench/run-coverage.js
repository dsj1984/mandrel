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
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COVERAGE_DIR = path.join(ROOT, 'coverage');
const require = createRequire(import.meta.url);
const C8_CONFIG = require('../.c8rc.cjs');
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

// `c8 report` honors `--include` / `--exclude` per-call but does NOT
// auto-load `.c8rc.cjs` — pass them explicitly so the printed table
// matches the gate's view of scope.
const includeArgs = (C8_CONFIG.include ?? []).flatMap((p) => ['--include', p]);
const excludeArgs = (C8_CONFIG.exclude ?? []).flatMap((p) => ['--exclude', p]);

const reportRun = spawnSync(
  NPX,
  [
    'c8',
    'report',
    '--reporter=json',
    '--reporter=text',
    '--temp-directory',
    V8_TMP,
    ...includeArgs,
    ...excludeArgs,
  ],
  { cwd: ROOT, stdio: 'inherit', shell: true },
);

// Threshold + scope values mirror .c8rc.cjs. Passed explicitly because
// `c8 check-coverage` does not auto-load `.c8rc.cjs` the same way the
// `c8 <cmd>` wrapper does — without `--include` / `--exclude` here the
// gate scores over every entry in `coverage-final.json`, so the exclude
// list (CLI shells whose meaningful logic lives in unit-tested libs)
// would silently miss the gate. Keep this list in sync with `.c8rc.cjs`.
const checkRun = spawnSync(
  NPX,
  [
    'c8',
    'check-coverage',
    `--lines=${C8_CONFIG.lines}`,
    `--branches=${C8_CONFIG.branches}`,
    `--functions=${C8_CONFIG.functions}`,
    ...includeArgs,
    ...excludeArgs,
  ],
  { cwd: ROOT, stdio: 'inherit', shell: true },
);

const exitCode =
  testRun.status !== 0
    ? testRun.status
    : reportRun.status !== 0
      ? reportRun.status
      : checkRun.status;

process.exit(exitCode ?? 1);
