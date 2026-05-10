#!/usr/bin/env node
/**
 * Refresh `baselines/coverage.json` from the most recent
 * `coverage/coverage-final.json`. Run this when you intentionally add,
 * remove, or change scope of `.agents/scripts/**` files and the
 * resulting per-file coverage shifts are expected.
 *
 * The script does NOT run the test suite itself — invoke
 * `npm run test:coverage` first (or rely on its prior run-on-disk
 * artifact). This keeps the refresh idempotent and lets operators
 * inspect coverage output before locking it in.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import {
  buildScopePredicate,
  COVERAGE_BASELINE_PATH,
  readCoverageFinal,
  scoreCoverageFinal,
  writeBaseline,
} from './lib/coverage-baseline.js';
import { Logger } from './lib/Logger.js';

const require = createRequire(import.meta.url);

function loadC8Scope(cwd) {
  return require(path.resolve(cwd, '.c8rc.cjs'));
}

function main() {
  const cwd = process.cwd();
  Logger.info('[Coverage] Updating baseline from coverage-final.json...');

  let raw;
  try {
    raw = readCoverageFinal(cwd);
  } catch (err) {
    Logger.error(`[Coverage] ❌ ${err.message}`);
    process.exit(1);
  }

  const c8Config = loadC8Scope(cwd);
  const scope = buildScopePredicate({
    include: c8Config.include ?? [],
    exclude: c8Config.exclude ?? [],
  });
  const scores = scoreCoverageFinal({ raw, cwd, scope });
  const fileCount = Object.keys(scores).length;

  const abs = writeBaseline(cwd, scores);
  Logger.info(
    `[Coverage] ✅ Baseline updated: ${fileCount} file(s) recorded at ${COVERAGE_BASELINE_PATH} (${abs}).`,
  );
}

main();
