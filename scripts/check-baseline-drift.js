#!/usr/bin/env node

// scripts/check-baseline-drift.js — scheduled full-scope baseline
// drift check (Story #4776).
//
// The three per-PR enforcement sites (close-validation, pre-push, CI) are all
// diff-scoped: they compare the files a branch touched against their committed
// baseline rows. A file nobody touches after its row is written is therefore
// never re-scored, so drift introduced indirectly — a dependency getting more
// complex, coverage moving underneath a method — stays invisible indefinitely.
//
// This CLI is the periodic full-scope counterpart. It re-scores every target
// directory through the same scorer that writes the baseline, prints a per-row
// before/after table for everything that moved beyond the gate's tolerance,
// and exits non-zero when it finds any — so a consumer can wire it as a
// scheduled CI job without wrapping it in verdict-parsing glue. This repo
// schedules the maintainability kind in `.github/workflows/baseline-drift.yml`;
// a consumer materializing `.agents/` still owns its own schedule.
//
// `--require-scored` exists because the default skip-is-green contract below
// is a fail-open trap for exactly that scheduled use. Measured on this repo:
// `check-baseline-drift.js --gate crap` with no `coverage/coverage-final.json`
// present prints "✅ No baseline drift detected" and exits 0 — a nightly job
// wired that way reports green while having measured nothing. The flag turns
// every skip into exit 2, so a job that asked for a kind and did not get it
// reds instead.
//
// Exit codes:
//   0 — no drift (or every kind skipped: disabled gate, no baseline, no scorer)
//   1 — drift detected in at least one kind
//   2 — the check itself could not run (including: a requested kind was
//       skipped and `--require-scored` was passed)

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import '../.agents/scripts/lib/runtime-deps/ensure-installed.js';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import {
  DRIFT_KINDS,
  detectBaselineDrift,
  formatDriftReport,
} from './lib/baselines/drift-detector.js';

export const HELP_TEXT = `Usage: node scripts/check-baseline-drift.js [options]

Re-score the configured baselines FULL-SCOPE and report every row whose
current score has drifted from its committed baseline by more than the
gate's tolerance — including files untouched by any recent diff, which the
diff-scoped gates structurally cannot see.

Options:
  --gate <kind>       Restrict to one kind (repeatable). Default: ${DRIFT_KINDS.join(', ')}.
  --tolerance <n>     Override the per-gate absolute tolerance.
  --require-scored    Treat a skipped kind (gate disabled, no baseline, no
                      scorer, nothing scored) as a failure rather than a pass.
                      Use this in scheduled jobs: without it a kind that could
                      not be scored at all reports green.
  --json              Emit the machine-readable report instead of the table.
  -h, --help          Show this help.

Exit codes: 0 no drift · 1 drift detected · 2 the check could not run.

On drift, refresh with the printed \`*:update -- --full-scope\` command and
commit the result with a \`baseline-refresh:\` tagged subject (non-empty body).`;

/**
 * Parse the CLI surface. Unknown flags are rejected so a typo'd `--gate`
 * cannot silently widen a scheduled job's scope.
 *
 * @param {string[]} argv
 * @returns {{ kinds: string[], tolerance: number|null, json: boolean, requireScored: boolean }}
 */
export function parseArgs(argv = []) {
  const kinds = [];
  let tolerance = null;
  let json = false;
  // Lifted out of the loop rather than added to its else-if chain: the chain
  // is the file's most complex method already, and a valueless boolean flag
  // needs no positional handling to be recognised.
  const requireScored = argv.includes('--require-scored');
  const rest = argv.filter((a) => a !== '--require-scored');
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--gate' && rest[i + 1]) {
      const kind = rest[i + 1];
      if (!DRIFT_KINDS.includes(kind)) {
        throw new Error(
          `[drift] unknown --gate "${kind}"; expected one of ${DRIFT_KINDS.join(', ')}`,
        );
      }
      kinds.push(kind);
      i += 1;
    } else if (arg === '--tolerance' && rest[i + 1]) {
      const value = Number(rest[i + 1]);
      if (!Number.isFinite(value)) {
        throw new Error(
          `[drift] --tolerance must be a number (got ${rest[i + 1]})`,
        );
      }
      tolerance = value;
      i += 1;
    } else if (arg === '--json') {
      json = true;
    } else {
      throw new Error(`[drift] unrecognised argument "${arg}"`);
    }
  }
  return {
    kinds: kinds.length > 0 ? kinds : [...DRIFT_KINDS],
    tolerance,
    json,
    requireScored,
  };
}

/**
 * Render the `--require-scored` verdict for a completed run.
 *
 * A skip is the detector's honest answer to "I could not score this kind" —
 * `{ ok: true, skipped: '<reason>' }` — and the default contract maps that to
 * a pass so an ad-hoc run does not red because coverage happened to be absent.
 * Under `--require-scored` the same answer is a failure: the caller named the
 * kinds it wanted measured, and a kind that was not measured is a gap, not a
 * clean bill of health.
 *
 * Returns `null` when the flag is off or nothing was skipped, so the caller
 * keeps the run's own 0/1 verdict untouched. Both "off" and "nothing skipped"
 * are answered here rather than at the call site: the caller is the file's
 * ratcheted entry point, and this is the branch's natural home anyway.
 *
 * @param {{ results?: Array<{ kind: string, skipped?: string }> }} run
 * @param {boolean} requireScored  Whether `--require-scored` was passed.
 * @returns {string|null} the operator-facing failure note, or null.
 */
function requireScoredFailure(run, requireScored) {
  if (!requireScored) return null;
  const skipped = (run?.results ?? []).filter((r) => r?.skipped);
  if (skipped.length === 0) return null;
  const detail = skipped.map((r) => `${r.kind} (${r.skipped})`).join(', ');
  return (
    `[drift] ❌ --require-scored: ${skipped.length} requested kind(s) were ` +
    `not scored — ${detail}. The verdict above covers only the kinds that ` +
    'DID score, which is why it can read clean. A scheduled run that cannot ' +
    'measure a kind is not a clean run; fix the cause (a missing coverage ' +
    'artifact, a missing baseline, a disabled gate) or drop the kind from ' +
    'the invocation.'
  );
}

/**
 * Run the drift check and render it. Returns the process exit code rather
 * than exiting, so the whole path is unit-testable.
 *
 * @param {{ argv?: string[], cwd?: string, detect?: typeof detectBaselineDrift }} opts
 * @returns {Promise<{ exitCode: number, output: string }>}
 */
export async function runCheckBaselineDrift({
  argv = [],
  cwd = process.cwd(),
  detect = detectBaselineDrift,
} = {}) {
  const args = parseArgs(argv);
  const run = await detect({
    kinds: args.kinds,
    cwd,
    tolerance: args.tolerance,
  });
  const base = args.json
    ? JSON.stringify({ schemaVersion: '1', ...run }, null, 2)
    : formatDriftReport(run);
  // The note is appended rather than substituted: the drift table is still the
  // useful half of the report for whichever kinds DID score. A note present at
  // all means a requested kind went unmeasured, which is exit 2 regardless of
  // what the measured kinds reported.
  const unscored = requireScoredFailure(run, args.requireScored);
  if (unscored) return { exitCode: 2, output: `${base}\n${unscored}` };
  return { exitCode: run.ok ? 0 : 1, output: base };
}

/**
 * Run the drift check and *return* its exit code rather than calling
 * `process.exit()` — this CLI prints one row per drifted baseline entry
 * full-scope, so its report is exactly the kind of payload that outgrows the
 * 64 KiB pipe buffer under a `| tee`. `process.exit()` terminates before a
 * queued async pipe write drains, silently truncating it (Story #4783, the
 * same defect `check-baselines.js` carried). Handing the code back lets
 * `runAsCli`'s `propagateExitCode` path settle it through
 * `settleCli`/`flushStdio` instead. The 0/1/2 contract documented at the top
 * of this file is unchanged — only *when* the process leaves is.
 *
 * @returns {Promise<number>} 0 no drift, 1 drift detected, 2 could not run.
 */
async function main() {
  let result;
  try {
    result = await runCheckBaselineDrift({ argv: process.argv.slice(2) });
  } catch (err) {
    process.stdout.write(`${err?.message ?? String(err)}\n`);
    return 2;
  }
  process.stdout.write(`${result.output}\n`);
  return result.exitCode;
}

runAsCli(import.meta.url, main, {
  source: 'check-baseline-drift',
  usage: HELP_TEXT,
  exitCode: 2,
  propagateExitCode: true,
});
