#!/usr/bin/env node
/**
 * Refresh the coverage baseline from the `coverage-final.json` on disk via
 * `refreshBaseline({ kind: 'coverage' })`. Never runs the suite, so the
 * refresh is idempotent and the output can be inspected first.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { resolveUpdaterRefreshScope } from './lib/baselines/coverage-refresh-scope.js';
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

/** `runAsCli` answers `--help` before `main`, so a usage probe never writes. */
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
    'Against an `affected`-stamped artifact only measured rows are rewritten; rows the scoped run skipped are kept.',
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
    epsilon: getBaselineEpsilon('coverage'),
    scorer: buildCoverageUpdaterScorer(cwd, {
      readCoverage: readCoverageFinal,
      loadScope: loadC8Scope,
      buildScope: buildScopePredicate,
      score: scoreCoverageFinal,
    }),
  };
  // No flag and a full artifact -> the service derives the diff via
  // `origin/main..HEAD` (its default baseRef/headRef).
  return resolveUpdaterRefreshScope(cwd, {
    fullScope,
    diffScopeRef,
    loadScope: loadC8Scope,
  })
    .then((scope) => refreshBaseline({ ...refreshOpts, ...scope }))
    .then((result) => {
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
