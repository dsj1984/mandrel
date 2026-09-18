#!/usr/bin/env node

// check-baselines.js — thin CLI shell over the unified baseline dispatcher in
// `lib/orchestration/check-baselines/phases/` (per kind: schema → floor →
// compare vs base → tolerance). Exit codes: `lib/baselines/exit-codes.js`.

// Must be the first import: fail fast before any third-party import evaluates.
import './lib/runtime-deps/ensure-installed.js';
import { EXIT_CONFIG } from './lib/baselines/exit-codes.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  applyFloors,
  assertFloorAxesExist,
  compareToFloor,
} from './lib/orchestration/check-baselines/phases/floors.js';
import {
  HELP_TEXT,
  parseArgs,
} from './lib/orchestration/check-baselines/phases/parse-args.js';
import {
  runCheckBaselines,
  selectEnabledGates,
} from './lib/orchestration/check-baselines/phases/pipeline.js';
import { formatReport } from './lib/orchestration/check-baselines/phases/report.js';

// Re-exported: tests import these from this module path.
export {
  applyFloors,
  assertFloorAxesExist,
  compareToFloor,
  formatReport,
  parseArgs,
  runCheckBaselines,
  selectEnabledGates,
};

/**
 * Returns the exit code rather than calling `process.exit()`: exiting early
 * truncates a large report at the 64 KiB pipe boundary; `runAsCli` sets
 * `process.exitCode` and lets stdout drain.
 *
 * @returns {Promise<number>} An exit code from the `EXIT_*` contract.
 */
async function main() {
  let result;
  try {
    result = await runCheckBaselines({ argv: process.argv.slice(2) });
  } catch (err) {
    const message = err?.message ?? String(err);
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: '1', error: message }, null, 2)}\n`,
    );
    return EXIT_CONFIG;
  }
  process.stdout.write(`${result.output}\n`);
  return result.exitCode;
}

runAsCli(import.meta.url, main, {
  source: 'check-baselines',
  usage: HELP_TEXT,
  propagateExitCode: true,
});
