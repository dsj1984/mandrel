#!/usr/bin/env node

// .agents/scripts/prune-plan-run-labels.js — Story #5189.
//
// Sweep the repository's `plan-run::<id>` cohort labels and delete the ones
// that are provably spent.
//
// The close tail reaps incrementally — one Story's own labels, as it lands —
// which keeps a healthy repository flat but does nothing about a pile that
// already exists, and nothing about a cohort whose last Story was closed by
// hand rather than by a close. This is the surface that burns an accumulated
// pile down: it reads the whole label vocabulary through the paginating
// listing port, so what it can see is bounded by the repository rather than by
// an API page.
//
// The decision is not made here — `lib/orchestration/plan-run-labels/reap.js`
// owns it, so this sweep and the close-path reap cannot come to different
// conclusions about when a label is spent. In short: reapable means the label
// carries at least one issue and every one of them is closed. A label carrying
// zero issues is NOT reapable by default, because that shape is exactly what
// an in-flight `plan-persist` looks like between minting its label and
// creating its Stories; `--include-unreferenced` is the explicit opt-in for an
// operator who knows no persist is running.
//
// Exit codes:
//   0  nothing reapable (or, without `--check`, the reap was performed)
//   1  `--check` found at least one label that would be reaped
//   2  the sweep could not run

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  REAP_REASONS,
  sweepCohortLabels,
} from './lib/orchestration/plan-run-labels/reap.js';
import { createProvider } from './lib/provider-factory.js';

const EXIT_CLEAN = 0;
const EXIT_WOULD_REAP = 1;
const EXIT_CANNOT_RUN = 2;

const HELP = {
  invocation:
    'node .agents/scripts/prune-plan-run-labels.js [--check] [--json] [--include-unreferenced] [--cwd <dir>]',
  summary:
    'Delete the plan-run:: cohort labels whose Stories are all closed. Never touches any other label axis, and never changes how a cohort label is minted.',
  flags: [
    ['--check', 'Report what would be reaped, delete nothing, exit 1 if any.'],
    ['--json', 'Emit the report as JSON instead of text.'],
    [
      '--include-unreferenced',
      'Also reap cohort labels carrying zero issues. Off by default: that shape is indistinguishable from a label an in-flight plan-persist just minted.',
    ],
    ['--cwd <dir>', 'Repository root to sweep. Default: process.cwd().'],
  ],
  notes: [
    'Reapable = the label carries at least one issue AND every issue carrying it\nis closed. One open issue anywhere in the cohort keeps the label.',
    'Exit codes:\n  0  clean, or reaped\n  1  --check found reapable labels\n  2  the sweep could not run',
  ],
};

/**
 * Parse argv into an options bag. An unknown flag is an error, never a silent
 * no-op — a typo'd `--dry-run` must not read as "delete the labels".
 *
 * @param {string[]} argv
 * @returns {{ check: boolean, json: boolean, includeUnreferenced: boolean, cwd: string }}
 */
export function parseArgs(argv = []) {
  const out = {
    check: false,
    json: false,
    includeUnreferenced: false,
    cwd: null,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    const value = argv[i + 1];
    i += 1;
    if (arg === '--check') out.check = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--include-unreferenced') out.includeUnreferenced = true;
    else if (arg === '--cwd') {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('--cwd requires a directory');
      }
      out.cwd = value;
      i += 1;
    } else throw new Error(`unknown flag "${arg}" (try --help)`);
  }
  out.cwd = out.cwd ?? process.cwd();
  return out;
}

/**
 * One human-readable line per cohort label, naming the reason it was kept or
 * reaped. The reason is printed for every label, not only the reapable ones —
 * an operator auditing a pile of 235 needs to see why the other 234 stayed.
 *
 * @param {object} decision
 * @param {boolean} check
 * @returns {string}
 */
function renderDecision(decision, check) {
  if (!decision.reapable) {
    const suffix =
      decision.reason === REAP_REASONS.OPEN_STORIES
        ? ` (open: ${decision.openIssues.join(', ') || 'unknown'})`
        : '';
    return `  · keep   ${decision.label} — ${decision.reason}${suffix}`;
  }
  const verb = check ? 'would reap' : 'reaped';
  return `  · ${verb} ${decision.label} — ${decision.reason} (${decision.issueCount} closed issue(s))`;
}

/**
 * Render the whole report as text.
 *
 * @param {object} report
 * @returns {string}
 */
export function formatReport(report) {
  const verb = report.check ? 'would reap' : 'reaped';
  const count = report.check ? report.reapable.length : report.deleted.length;
  const lines = [
    `[prune-plan-run-labels] ${verb} ${count} of ${report.evaluated} cohort ` +
      `label(s) (${report.totalLabels} label(s) in the repository)`,
    ...report.decisions.map((d) => renderDecision(d, report.check)),
  ];
  for (const failure of report.failed) {
    lines.push(`  ! failed  ${failure.label} — ${failure.detail}`);
  }
  if (report.check && report.reapable.length > 0) {
    lines.push(
      '',
      'Run without --check to delete them:',
      '  node .agents/scripts/prune-plan-run-labels.js',
    );
  }
  return lines.join('\n');
}

/**
 * The whole sweep — argv in, exit code out, report written through `writeFn`.
 *
 * Exported with its provider/config/output surfaces as default-parameter
 * seams (`docs/contributing/test-seams.md`) so a test drives the *real* argv parsing,
 * report rendering and exit-code decision against a stub provider. Without
 * that, the only testable thing here would be a re-implementation of the
 * decision, which is precisely the copy that drifts.
 *
 * @param {string[]} argv
 * @param {{
 *   createProviderFn?: Function,
 *   resolveConfigFn?: Function,
 *   writeFn?: (text: string) => void,
 *   warnFn?: (message: string) => void,
 * }} [seams]
 * @returns {Promise<number>} the process exit code.
 */
export async function runSweep(
  argv,
  {
    createProviderFn = createProvider,
    resolveConfigFn = resolveConfig,
    writeFn = (text) => process.stdout.write(text),
    warnFn = (message) => Logger.warn(`[prune-plan-run-labels] ${message}`),
  } = {},
) {
  let opts;
  let report;
  try {
    opts = parseArgs(argv);
    report = await sweepCohortLabels({
      provider: createProviderFn(resolveConfigFn({ cwd: opts.cwd })),
      includeUnreferenced: opts.includeUnreferenced,
      check: opts.check,
      onWarn: warnFn,
    });
  } catch (err) {
    const message = err?.message ?? String(err);
    writeFn(
      `${JSON.stringify({ schemaVersion: '1', error: message }, null, 2)}\n`,
    );
    return EXIT_CANNOT_RUN;
  }
  writeFn(
    opts.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatReport(report)}\n`,
  );
  return report.check && report.reapable.length > 0
    ? EXIT_WOULD_REAP
    : EXIT_CLEAN;
}

/**
 * CLI entry point. Returns its exit code rather than calling `process.exit()`,
 * so `runAsCli`'s `propagateExitCode` path settles it through `flushStdio` and
 * an unbounded report is not truncated at a pipe boundary (Story #4783).
 *
 * @returns {Promise<number>}
 */
async function main() {
  return runSweep(process.argv.slice(2));
}

runAsCli(import.meta.url, main, {
  source: 'prune-plan-run-labels',
  usage: HELP,
  propagateExitCode: true,
});
