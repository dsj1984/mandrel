#!/usr/bin/env node

// scripts/check-knip-entries.js — the guard #5001 left unbuilt.
//
// Story #5001 made two changes that are individually right and jointly unsafe:
// it replaced knip's blanket `.agents/scripts/*.js!` entry glob with an
// explicit list (so an uninvoked CLI surfaces as dead), and it promoted knip's
// `files` rule to `error` (so whole-file death produces baseline rows). The
// explicit list is hand-maintained; nothing checked it.
//
// So any CLI added after #5001 is, by default, invisible to knip: absent from
// the entry list, it reads as unreachable, emits a `{ file, symbol: '*' }` row,
// and drags every lib module only it imports into the dead set with it. Story
// #5012 hit exactly this — 5 false rows — and the ratchet's natural remedy
// (accept the diff) would have written live operator CLIs into
// `baselines/dead-exports-production.json` as expected-dead, permanently. It
// was caught by luck: a base-sync conflict forced a manual read of the diff.
//
// This gate removes the luck. It derives the invoked set from the executable
// surfaces #5001's own acceptance criterion named — package.json scripts, husky
// hooks, `.github/workflows`, `.agents` workflow/skill/agent/rule markdown, and
// script-to-script spawns — and asserts it matches the entry array of whatever
// configuration knip itself would load, in both directions. See
// `lib/knip-entry-sync.js` for why liveness means *invoked* rather than
// *present*, and why documentation prose does not count.
//
// Analysis-free by construction: knip's config resolver is loaded (a
// `knip.config.ts` has to be evaluated, not parsed), but nothing is scanned —
// no knip run, no scorer, no coverage artifact. Past that it is a directory
// read and a handful of regexes, which is what keeps it cheap enough to sit in
// the required-check set next to `check-baseline-scope.js`.
//
// Not-applicable is not failure (Story #5039). A repository with no knip
// configuration at all — and one where `knip` is not installed — exits 0 with a
// skip line, the same opt-in posture `qa.gherkinLint` uses. Without that, the
// gate could not be wired into a consumer that does not run knip, and #5001's
// guard stayed unbuilt everywhere it was most needed. A configuration that
// EXISTS but cannot be resolved still exits 2: absence and breakage are
// different answers.
//
// Exit codes:
//   0  entry list matches the invoked set, or there is no configuration to check
//   1  divergence — a missing, stale, phantom, or unsuffixed entry
//   2  the check could not run (unresolvable configuration, unusable repository)

import process from 'node:process';
import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import {
  countDivergences,
  renderEntrySyncReport,
  resolveEntrySync,
} from './lib/knip-entry-sync.js';

const EXIT_PASS = 0;
const EXIT_DIVERGED = 1;
const EXIT_CANNOT_RUN = 2;

const HELP = {
  invocation: 'node scripts/check-knip-entries.js [--cwd <dir>] [--json]',
  summary:
    "Assert the explicit .agents/scripts entry list in knip's resolved configuration matches the set of CLIs something actually invokes.",
  flags: [
    ['--cwd <dir>', 'Repository root to check. Default: process.cwd().'],
    ['--json', 'Emit the report as JSON instead of text.'],
  ],
  notes: [
    'Resolves the config through knip itself, so every location knip supports works\n(knip.json/.jsonc, .knip.json(c), knip.ts/.js, knip.config.ts/.js,\npackage.json#knip). A TS config is evaluated, so a computed entry array reads\ncorrectly, and per-workspace entries count alongside the top-level array.',
    'Exit codes:\n  0  entry list matches, or there is no config to check (skip)\n  1  divergence\n  2  the check could not run — a config that EXISTS but will not resolve',
    'A missing entry is the dangerous one: knip calls the CLI dead, and accepting\nthe dead-exports diff would record a live CLI as expected-dead (Story #5012).',
  ],
};

/**
 * The gate's single exit-code decision, shared by the text and `--json` paths.
 *
 * Kept in one place for the same reason `countDivergences` is: a direction
 * added to the report must not be able to change one path's verdict and not
 * the other's. Skip outranks error outranks divergence — a repository with no
 * configuration has nothing to diverge from.
 *
 * @param {Awaited<ReturnType<typeof resolveEntrySync>>} report
 * @returns {number}
 */
function exitCodeFor(report) {
  if (report.skipped) return EXIT_PASS;
  if (report.error) return EXIT_CANNOT_RUN;
  return countDivergences(report) > 0 ? EXIT_DIVERGED : EXIT_PASS;
}

/**
 * Parse argv into an options bag. An unknown flag is a config error rather than
 * a silent no-op, matching `check-baseline-scope.js`.
 *
 * @param {string[]} argv
 * @returns {{ cwd: string | null, json: boolean }}
 */
export function parseArgs(argv = []) {
  const out = { cwd: null, json: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    i += 1;
    if (arg === '--json') out.json = true;
    else if (arg === '--cwd') {
      out.cwd = argv[i];
      i += 1;
    } else throw new Error(`unknown flag "${arg}" (try --help)`);
  }
  return out;
}

/**
 * Top-level CLI entry. Exported so tests can drive it against a fixture tree
 * without spawning a process.
 *
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 * }} [opts]
 * @returns {Promise<number>} 0 pass, 1 divergence, 2 cannot run
 */
export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`[knip-entries] ❌ ${err?.message ?? String(err)}\n`);
    return EXIT_CANNOT_RUN;
  }
  const report = await resolveEntrySync({ repoRoot: args.cwd ?? cwd });

  if (args.json) {
    stdout.write(
      `${JSON.stringify({ kind: 'knip-entry-sync', ...report }, null, 2)}\n`,
    );
  } else if (report.skipped) {
    stdout.write(`[knip-entries] ⏭️  not applicable: ${report.skipped}\n`);
  } else if (report.error) {
    stderr.write(`[knip-entries] ❌ ${report.error}\n`);
  } else {
    stdout.write(`\n--- knip-entries ---\n${renderEntrySyncReport(report)}\n`);
  }
  return exitCodeFor(report);
}

runAsCli(import.meta.url, async () => runCli(), {
  source: 'knip-entries',
  propagateExitCode: true,
  errorPrefix: '[knip-entries] ❌ Fatal error',
  usage: HELP,
});
