#!/usr/bin/env node
// cli-opt-out: top-level CLI driver invoked via npm run test:coverage; spawns child processes rather than parsing argv, so runAsCli() does not apply.
/**
 * Cross-platform driver for `npm run test:coverage`.
 *
 * Why this exists: setting `NODE_V8_COVERAGE` directly in a package.json
 * script string (`NODE_V8_COVERAGE=... node ...`) is bash-only — Windows
 * cmd.exe (npm's default script-shell on Windows) treats it as a literal
 * argument and node never sees the env var. Wrapping the run in this
 * Node script keeps the env injection portable.
 *
 * Pipeline:
 *   1. Run the test suite under `NODE_V8_COVERAGE` so each worker writes
 *      raw V8 dumps under `coverage/tmp/`.
 *   2. `c8 report` post-processes the dumps into `coverage/coverage-final.json`
 *      plus the printed text table. Include/exclude scope from `.c8rc.cjs`
 *      is passed explicitly because `c8 report` does not auto-load the
 *      config file.
 *   3. `check-baselines.js --gate coverage` compares the per-file
 *      lines/branches/functions percentages in `coverage-final.json`
 *      against the recorded floors in `baselines/coverage.json` and
 *      fails on any regression. Update the baseline with
 *      `npm run coverage:update` when you intentionally change scope.
 *
 * The previous shape of this script wrapped tests in `c8 <cmd>`. A
 * one-off A/B benchmark (now retired) showed the NODE_V8_COVERAGE +
 * `c8 report` path is ~19% faster end-to-end on a Windows dev host
 * while producing an identical `coverage-final.json` artifact for the
 * CRAP gate.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupRepoTestTempArtifacts } from './cleanup-repo-test-temp.js';
import { C8_CLI } from './lib/c8-cli-path.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const COVERAGE_DIR = path.join(ROOT, 'coverage');
const require = createRequire(import.meta.url);
const C8_CONFIG = require('../../.c8rc.cjs');
const V8_TMP = path.join(COVERAGE_DIR, 'tmp');

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

cleanupRepoTestTempArtifacts({ repoRoot: ROOT });

const includeArgs = (C8_CONFIG.include ?? []).flatMap((p) => ['--include', p]);
const excludeArgs = (C8_CONFIG.exclude ?? []).flatMap((p) => ['--exclude', p]);

const reportRun = spawnSync(
  process.execPath,
  [
    C8_CLI,
    'report',
    '--reporter=json',
    '--reporter=text',
    '--temp-directory',
    V8_TMP,
    ...includeArgs,
    ...excludeArgs,
  ],
  { cwd: ROOT, stdio: 'inherit', shell: false },
);

const checkRun = spawnSync(
  process.execPath,
  [
    path.join(ROOT, '.agents', 'scripts', 'check-baselines.js'),
    '--gate',
    'coverage',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

const exitCode =
  testRun.status !== 0
    ? testRun.status
    : reportRun.status !== 0
      ? reportRun.status
      : checkRun.status;

process.exit(exitCode ?? 1);
