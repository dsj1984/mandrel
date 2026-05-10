#!/usr/bin/env node
/**
 * Per-file coverage gate. Compares the current
 * `coverage/coverage-final.json` against the floors recorded in
 * `baselines/coverage.json` and exits non-zero on any regression OR on
 * any in-scope file missing from the baseline.
 *
 * Wired into `npm run test:coverage` (after `c8 report`) and intended
 * to be run standalone via `npm run coverage:check`. Update the
 * baseline with `npm run coverage:update` when a scope change is
 * intentional.
 *
 * Why "new file = fail" (vs the maintainability gate's "new file =
 * info"): a brand-new untested CLI shell would otherwise sail through
 * with 0% coverage because there's no recorded floor to drop below.
 * Forcing an explicit baseline entry makes that decision visible in
 * the diff.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import {
  buildScopePredicate,
  COVERAGE_BASELINE_PATH,
  compareScores,
  readBaseline,
  readCoverageFinal,
  scoreCoverageFinal,
} from './lib/coverage-baseline.js';
import { Logger } from './lib/Logger.js';

const require = createRequire(import.meta.url);

function loadC8Scope(cwd) {
  return require(path.resolve(cwd, '.c8rc.cjs'));
}

function fmtPct(v) {
  return v === null || v === undefined ? 'n/a' : `${v.toFixed(2)}%`;
}

function main() {
  const cwd = process.cwd();
  Logger.info('[Coverage] Verifying per-file coverage against baseline...');

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
  const current = scoreCoverageFinal({ raw, cwd, scope });

  const baseline = readBaseline(cwd);
  if (baseline === null) {
    Logger.warn(
      `[Coverage] ⚠ No baseline found at ${COVERAGE_BASELINE_PATH}. Run \`npm run coverage:update\` to create one.`,
    );
    process.exit(0);
  }

  const stats = compareScores(current, baseline);

  for (const r of stats.regressions) {
    Logger.error(`[Coverage] ❌ REGRESSION in ${r.file}`);
    for (const d of r.drops) {
      Logger.error(
        `                ${d.axis}: ${fmtPct(d.current)} (baseline ${fmtPct(d.baseline)}, drop -${d.drop.toFixed(2)})`,
      );
    }
  }
  for (const n of stats.newFiles) {
    Logger.error(
      `[Coverage] ❌ NEW FILE not in baseline: ${n.file} (lines=${fmtPct(n.current.lines)}, branches=${fmtPct(n.current.branches)}, functions=${fmtPct(n.current.functions)})`,
    );
  }
  for (const r of stats.removedFiles) {
    Logger.info(`[Coverage] ➖ Baseline entry no longer in scope: ${r.file}`);
  }

  Logger.info('\n--- Coverage Baseline Report ---');
  Logger.info(`Total files in scope: ${Object.keys(current).length}`);
  Logger.info(
    `Pass:                 ${Object.keys(current).length - stats.regressions.length - stats.newFiles.length}`,
  );
  Logger.info(`Regressions:          ${stats.regressions.length}`);
  Logger.info(`New (unbaselined):    ${stats.newFiles.length}`);
  Logger.info(`Improvements:         ${stats.improvements.length}`);
  Logger.info(`Removed from scope:   ${stats.removedFiles.length}`);
  Logger.info('---------------------------------\n');

  if (stats.regressions.length > 0 || stats.newFiles.length > 0) {
    Logger.error(
      '[Coverage] ❌ Per-file gate failed. Either improve coverage on the offending file(s) or — if the change is intentional — run `npm run coverage:update` to ratchet the baseline.',
    );
    process.exit(1);
  }

  Logger.info('[Coverage] ✅ Per-file coverage check passed.');
}

main();
