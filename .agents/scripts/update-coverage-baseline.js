#!/usr/bin/env node
// cli-opt-out: top-level main()-driven CLI invoked via npm run coverage:update; no runAsCli() wrapper required.
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
import { parseDiffScopeFlag } from './lib/baselines/diff-scope-cli.js';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { getBaselineEpsilon } from './lib/config/quality.js';
import {
  buildScopePredicate,
  COVERAGE_BASELINE_PATH,
  readCoverageFinal,
  scoreCoverageFinal,
} from './lib/coverage-baseline.js';
import { Logger } from './lib/Logger.js';

const require = createRequire(import.meta.url);

function loadC8Scope(cwd) {
  return require(path.resolve(cwd, '.c8rc.cjs'));
}

function parseFullScopeFlag(argv = []) {
  return argv.includes('--full-scope');
}

function main() {
  const argv = process.argv.slice(2);
  const diffScopeRef = parseDiffScopeFlag(argv);
  const fullScope = parseFullScopeFlag(argv);
  const cwd = process.cwd();
  Logger.info('[Coverage] Updating baseline from coverage-final.json...');

  if (fullScope && diffScopeRef !== null) {
    throw new Error(
      '[Coverage] --full-scope is incompatible with --diff-scope; pick one',
    );
  }

  // Build the per-kind scorer the service will invoke. The scorer receives
  // `(files, { fullScope })` and returns rows in the `{path, lines,
  // branches, functions}` shape the writer expects.
  const scorer = (files, opts) => {
    const effectiveCwd = opts?.cwd ?? cwd;
    let raw;
    try {
      raw = readCoverageFinal(effectiveCwd);
    } catch (err) {
      Logger.error(`[Coverage] ❌ ${err.message}`);
      return [];
    }

    const c8Config = loadC8Scope(effectiveCwd);
    const c8Scope = buildScopePredicate({
      include: c8Config.include ?? [],
      exclude: c8Config.exclude ?? [],
    });
    const scores = scoreCoverageFinal({
      raw,
      cwd: effectiveCwd,
      scope: c8Scope,
    });

    // In diff mode, further narrow to the service-resolved in-scope file list.
    const inScope =
      !opts?.fullScope && Array.isArray(files) && files.length > 0
        ? new Set(files)
        : null;

    const rows = Object.entries(scores)
      .filter(([relPath]) => inScope === null || inScope.has(relPath))
      .map(([relPath, score]) => ({
        path: relPath,
        lines: score?.lines ?? 0,
        branches: score?.branches ?? 0,
        functions: score?.functions ?? 0,
      }));

    const fileCount = Object.keys(scores).length;
    Logger.info(
      `[Coverage] Scored ${fileCount} file(s)${inScope ? ` (${rows.length} in scope)` : ''}.`,
    );
    return rows;
  };

  const absBaselinePath = path.resolve(cwd, COVERAGE_BASELINE_PATH);
  const epsilon = getBaselineEpsilon('coverage', null);
  const refreshOpts = {
    kind: 'coverage',
    writePath: absBaselinePath,
    epsilon,
    scorer,
  };
  if (fullScope) {
    refreshOpts.fullScope = true;
  } else if (diffScopeRef) {
    refreshOpts.baseRef = diffScopeRef;
  }
  // No flag → scopeFiles=null + fullScope=false → service derives the diff
  // via `origin/main..HEAD` (its default baseRef/headRef).

  return refreshBaseline(refreshOpts).then((result) => {
    Logger.info(
      `[Coverage] ✅ Baseline updated: ${result.envelope.rows.length} file(s) recorded at ${COVERAGE_BASELINE_PATH} (${absBaselinePath}). scope=${result.scope.mode}, wrote=${result.wrote}.`,
    );
  });
}

main().catch((err) => {
  Logger.error(`[Coverage] ❌ Fatal error: ${err?.message ?? err}`);
  process.exit(1);
});
