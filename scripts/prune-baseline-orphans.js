#!/usr/bin/env node

// scripts/prune-baseline-orphans.js — Story #5012.
//
// Delete the baseline rows that are provably inert, and nothing else.
//
// This is the cheap remedy that makes `check-baseline-scope.js` fair. A gate
// that hard-fails on a stale row is only defensible while clearing one costs a
// command rather than a full re-score: the honest alternative — re-derive the
// whole baseline — spends a coverage run or a full-tree MI pass to express a
// deletion, which is why stale rows accumulate instead.
//
// Two row classes qualify, both decidable without measuring anything:
//
//   - `absent`       — the row's file is gone from disk.
//   - `out-of-scope` — the file is still there, but the gate's own
//                      `targetDirs` / `ignoreGlobs` no longer match it.
//
// The pruner never adds a row and never re-scores one; it only drops rows, and
// readers derive the rollup from what remains. An unreadable scope config degrades to
// orphan-only pruning rather than treating unknown scope as empty scope.
//
// Exit codes:
//   0  nothing to prune (or, without `--check`, the prune was written)
//   1  `--check` found rows that would be pruned
//   2  the pruner could not run

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import '../.agents/scripts/lib/runtime-deps/ensure-installed.js';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import { getQuality } from '../.agents/scripts/lib/config/quality.js';
import { resolveConfig } from '../.agents/scripts/lib/config-resolver.js';
import { PRUNABLE_KINDS, runPrune } from './lib/baselines/orphan-pruner.js';

const EXIT_CLEAN = 0;
const EXIT_WOULD_PRUNE = 1;
const EXIT_CANNOT_RUN = 2;

const HELP = {
  invocation:
    'node scripts/prune-baseline-orphans.js [--check] [--kind <kind>] [--json]',
  summary:
    "Remove baseline rows whose file is gone from disk or has left the gate's scope. Never adds a row, never re-scores.",
  flags: [
    ['--check', 'Report what would be pruned, write nothing, exit 1 if any.'],
    ['--kind <kind>', 'Prune one kind only (repeatable). Default: all.'],
    ['--json', 'Emit the report as JSON instead of text.'],
    ['--cwd <dir>', 'Repository root to prune. Default: process.cwd().'],
  ],
  notes: [
    'Exit codes:\n  0  clean, or pruned\n  1  --check found prunable rows\n  2  the pruner could not run',
  ],
};

/**
 * Parse argv into an options bag. An unknown flag is an error, never a silent
 * no-op — a typo'd `--dry-run` must not read as "write the files".
 *
 * @param {string[]} argv
 * @returns {{ kinds: string[], check: boolean, json: boolean, cwd: string }}
 */
export function parseArgs(argv = []) {
  const out = { kinds: [], check: false, json: false, cwd: null };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const value = argv[i + 1];
    i += 1;
    if (arg === '--check') out.check = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--kind') {
      out.kinds.push(value);
      i += 1;
    } else if (arg === '--cwd') {
      out.cwd = value;
      i += 1;
    } else throw new Error(`unknown flag "${arg}" (try --help)`);
  }
  const unknown = out.kinds.filter((k) => !PRUNABLE_KINDS.includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown --kind ${unknown.join(', ')}; expected one of ${PRUNABLE_KINDS.join(', ')}`,
    );
  }
  if (out.kinds.length === 0) out.kinds = [...PRUNABLE_KINDS];
  out.cwd = out.cwd ?? process.cwd();
  return out;
}

/**
 * Render one kind's outcome as indented text lines.
 *
 * @param {object} entry
 * @param {boolean} check
 * @returns {string[]}
 */
function renderKind(entry, check) {
  if (!entry.present) return [];
  const suffix = entry.degraded
    ? ` [orphan-only: ${entry.degradedReason}]`
    : '';
  if (entry.removed.length === 0) {
    return [`  - ${entry.kind}: clean${suffix}`];
  }
  const verb = check ? 'would prune' : 'pruned';
  return [
    `  - ${entry.kind}: ${verb} ${entry.removed.length} row(s)${suffix}`,
    ...entry.removed.map((row) => `      · ${row.reason}: ${row.path}`),
  ];
}

/**
 * Render the whole report as text.
 *
 * @param {object} report
 * @returns {string}
 */
export function formatReport(report) {
  const verb = report.check ? 'would prune' : 'pruned';
  const lines = [
    `[prune-baseline-orphans] ${verb} ${report.removedCount} row(s) across ` +
      `${report.writtenCount} file(s)`,
    ...report.kinds.flatMap((entry) => renderKind(entry, report.check)),
  ];
  if (report.check && report.removedCount > 0) {
    lines.push(
      '',
      'Run without --check to write the prune:',
      '  node scripts/prune-baseline-orphans.js',
    );
  }
  return lines.join('\n');
}

/**
 * CLI entry point. Returns its exit code rather than calling `process.exit()`,
 * so `runAsCli`'s `propagateExitCode` path settles it through `flushStdio` and
 * an unbounded report is not truncated at a pipe boundary (Story #4783).
 *
 * @returns {Promise<number>}
 */
async function main() {
  let opts;
  let report;
  try {
    opts = parseArgs(process.argv.slice(2));
    const config = resolveConfig({ cwd: opts.cwd });
    report = runPrune({
      cwd: opts.cwd,
      kinds: opts.kinds,
      check: opts.check,
      quality: getQuality(config) ?? { gates: {} },
    });
  } catch (err) {
    const message = err?.message ?? String(err);
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: '1', error: message }, null, 2)}\n`,
    );
    return EXIT_CANNOT_RUN;
  }
  process.stdout.write(
    opts.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatReport(report)}\n`,
  );
  return report.check && report.removedCount > 0
    ? EXIT_WOULD_PRUNE
    : EXIT_CLEAN;
}

runAsCli(import.meta.url, main, {
  source: 'prune-baseline-orphans',
  usage: HELP,
  propagateExitCode: true,
});
