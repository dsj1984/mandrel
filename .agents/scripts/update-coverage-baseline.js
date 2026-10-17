#!/usr/bin/env node
/**
 * Refresh the coverage baseline from the configured `coverage.coveragePath`
 * artifact (Istanbul `coverage-final.json`) on disk via
 * `refreshBaseline({ kind: 'coverage' })`. Never runs the suite, so the
 * refresh is idempotent and the output can be inspected first.
 */

import { resolveUpdaterRefreshScope } from './lib/baselines/coverage-refresh-scope.js';
import {
  buildCoverageRefreshOpts,
  coverageUpdaterTargets,
  loadC8ScopeConfig,
  resolveCoverageUpdaterScope,
} from './lib/baselines/coverage-updater-cli.js';
import { refreshBaseline } from './lib/baselines/refresh-service.js';
import { runAsCli } from './lib/cli-utils.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';

/** `runAsCli` answers `--help` before `main`, so a usage probe never writes. */
const USAGE = {
  invocation:
    'node .agents/scripts/update-coverage-baseline.js [--full-scope | --diff-scope <ref>]',
  summary:
    'Score → write the coverage baseline from the coverage artifact (`delivery.quality.gates.coverage.coveragePath`, Istanbul coverage-final.json) already on disk. With no scope flag the refresh is scoped to the files changed in `origin/main..HEAD`; out-of-scope rows are preserved verbatim.',
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
    "Run the coverage gate's `captureScript` first (`delivery.quality.gates.coverage.captureScript`) — this script never runs the suite itself.",
    'Against an `affected`-stamped artifact only measured rows are rewritten; rows the scoped run skipped are kept.',
  ],
};

function main() {
  const cwd = process.cwd();
  const { fullScope, diffScopeRef } = resolveCoverageUpdaterScope(
    process.argv.slice(2),
  );
  const targets = coverageUpdaterTargets(
    getQuality(resolveConfig({ cwd })).coverage,
    cwd,
  );
  Logger.info(`[Coverage] Updating baseline from ${targets.coveragePath}...`);
  const refreshOpts = buildCoverageRefreshOpts(cwd, targets);
  // No flag and a full artifact -> the service derives the diff via
  // `origin/main..HEAD` (its default baseRef/headRef).
  return resolveUpdaterRefreshScope(cwd, {
    fullScope,
    diffScopeRef,
    loadScope: loadC8ScopeConfig,
    readCoverage: targets.readCoverage,
  })
    .then((scope) => refreshBaseline({ ...refreshOpts, ...scope }))
    .then((result) => {
      Logger.info(
        `[Coverage] ✅ Baseline updated: ${result.envelope.rows.length} file(s) recorded at ${targets.baselinePath} (${targets.absBaselinePath}). scope=${result.scope.mode}, wrote=${result.wrote}.`,
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
