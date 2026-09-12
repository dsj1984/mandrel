#!/usr/bin/env node
/**
 * Refresh `baselines/coverage.json` from the most recent
 * `coverage/coverage-final.json`. Run this when you intentionally add,
 * remove, or change scope of `.agents/scripts/**` files and the
 * resulting per-file coverage shifts are expected.
 *
 * Story #3658 (Epic #2173): this CLI is now a thin wrapper around
 * `refreshBaseline({ kind: 'coverage' })` from
 * `.agents/scripts/lib/baselines/refresh-service.js`. All scoring, scope
 * resolution, envelope assembly, and persistence flows through the unified
 * service.
 *
 * The script does NOT run the test suite itself — invoke
 * `npm run test:coverage` first (or rely on its prior run-on-disk
 * artifact). This keeps the refresh idempotent and lets operators
 * inspect coverage output before locking it in.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import {
  buildCoverageUpdaterScorer,
  resolveCoverageUpdaterScope,
} from './lib/baselines/coverage-updater-cli.js';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { runAsCli } from './lib/cli-utils.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import {
  buildScopePredicate,
  COVERAGE_BASELINE_PATH,
  readCoverageFinal,
  scoreCoverageFinal,
} from './lib/coverage-baseline.js';
import { Logger } from './lib/Logger.js';

/**
 * Usage block for `--help`. This CLI *writes* on invocation, so the help
 * branch must short-circuit before `main` runs rather than inside it —
 * `runAsCli` answers help first, which makes "a usage probe never mutates a
 * baseline" structural instead of a check `main` has to remember.
 */
const USAGE = {
  invocation:
    'node .agents/scripts/update-coverage-baseline.js [--full-scope | --diff-scope <ref>]',
  summary:
    'Score → write the coverage baseline from the coverage-final.json already on disk. With no scope flag the refresh is scoped to the files changed in `origin/main..HEAD`; out-of-scope rows are preserved verbatim.',
  flags: [
    [
      '--full-scope',
      'Rescore every file in every target dir (no out-of-scope merge).',
    ],
    [
      '--diff-scope <ref>',
      'Scope the refresh to files changed between <ref> and HEAD. Incompatible with --full-scope.',
    ],
  ],
  notes: [
    'Run `npm run test:coverage` first — this script never runs the suite itself.',
  ],
};

/** CommonJS `require`, for the `.c8rc.cjs` scope config below. */
const require = createRequire(import.meta.url);

/**
 * Load the c8 include/exclude scope. Kept in the CLI rather than the extracted
 * scorer because it is the one genuinely environment-bound step — a CJS
 * `require` of a config file resolved against the working tree — and the
 * scorer takes it as a seam so a test never touches the real `.c8rc.cjs`.
 */
function loadC8Scope(cwd) {
  return require(path.resolve(cwd, '.c8rc.cjs'));
}

function main() {
  const cwd = process.cwd();
  const { fullScope, diffScopeRef } = resolveCoverageUpdaterScope(
    process.argv.slice(2),
  );
  Logger.info('[Coverage] Updating baseline from coverage-final.json...');

  const absBaselinePath = path.resolve(cwd, COVERAGE_BASELINE_PATH);
  const refreshOpts = {
    kind: 'coverage',
    writePath: absBaselinePath,
    epsilon: getBaselineEpsilon('coverage', null),
    scorer: buildCoverageUpdaterScorer(cwd, {
      readCoverage: readCoverageFinal,
      loadScope: loadC8Scope,
      buildScope: buildScopePredicate,
      score: scoreCoverageFinal,
    }),
  };
  // No flag -> scopeFiles=null + fullScope=false -> the service derives the
  // diff via `origin/main..HEAD` (its default baseRef/headRef).
  if (fullScope) refreshOpts.fullScope = true;
  else if (diffScopeRef) refreshOpts.baseRef = diffScopeRef;

  return refreshBaseline(refreshOpts).then((result) => {
    Logger.info(
      `[Coverage] ✅ Baseline updated: ${result.envelope.rows.length} file(s) recorded at ${COVERAGE_BASELINE_PATH} (${absBaselinePath}). scope=${result.scope.mode}, wrote=${result.wrote}.`,
    );
  });
}

runAsCli(import.meta.url, main, {
  source: 'coverage-baseline',
  usage: USAGE,
  onError: (err) => {
    Logger.error(`[Coverage] ❌ Fatal error: ${err?.message ?? err}`);
    process.exitCode = 1;
  },
});
