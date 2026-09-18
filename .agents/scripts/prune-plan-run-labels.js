#!/usr/bin/env node

// prune-plan-run-labels.js — delete spent `plan-run::<id>` cohort labels
// across the whole repository (the close tail only reaps one Story's labels
// as it lands). The spent-ness decision lives in `plan-run-labels/reap.js` so
// this sweep and the close-path reap cannot disagree. A zero-issue label is
// kept by default: it looks exactly like one an in-flight persist just minted.
//
// Exit codes: 0 clean or reaped; 1 `--check` found reapable labels; 2 the
// sweep could not run.

// Must be the first import: fail fast before any third-party import runs.
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
 * An unknown flag throws: a typo'd `--dry-run` must not read as "delete".
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
 * Every label gets a reason line, kept ones included, so an audit can see why.
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
 * Returns the exit code instead of `process.exit()` so a long report is not
 * truncated at a pipe boundary.
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
