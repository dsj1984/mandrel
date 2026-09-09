#!/usr/bin/env node
/**
 * CLI: assert `package.json`'s pinned-override safety notes still describe
 * the pins they document.
 *
 * The `"//"` notes on a pinned `overrides` entry are consulted at exactly one
 * moment — when someone is deciding whether bumping it is safe. A note that
 * quotes a version the pin has since moved past answers that question wrong,
 * and nothing was checking. This gate makes the note unable to fall behind.
 *
 * Exit codes:
 *   0 — every documented override matches its note and its direct range.
 *   1 — drift: a stale note, a broken lockstep, or a note for a pin that is
 *       gone.
 *   2 — the check could not run (no readable `package.json`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { auditPinnedOverrideNotes } from './lib/pinned-override-notes.js';

const EXIT_PASS = 0;
const EXIT_DRIFT = 1;
const EXIT_CANNOT_RUN = 2;

const HELP = {
  invocation:
    'node .agents/scripts/check-pinned-override-notes.js [--cwd <dir>] [--json]',
  summary:
    'Assert every "//" note documenting a pinned npm override states the range that override actually carries, and that its direct dependency range matches.',
  flags: [
    ['--cwd <dir>', 'Repository root to check. Default: process.cwd().'],
    ['--json', 'Emit the findings as JSON instead of text.'],
  ],
  notes: [
    'Checks are derived from the "//" keys themselves — any `overrides.<name>`\nnote is covered, so a second pinned override is guarded by writing its note.',
    'A note quoting no semver range at all is not scored: prose that names no\nversion cannot go stale.',
    'Exit codes:\n  0  notes match their pins\n  1  drift (stale note, broken lockstep, or a note for a removed pin)\n  2  the check could not run',
  ],
};

export function parseArgs(argv) {
  const out = { cwd: process.cwd(), json: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--cwd') out.cwd = argv[++i] ?? out.cwd;
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

/**
 * @param {string[]} [argv]
 * @param {{ readPackage?: (cwd: string) => object, logger?: object }} [deps]
 * @returns {number} process exit code
 */
export function runCheck(argv = process.argv, deps = {}) {
  const { readPackage = defaultReadPackage, logger = Logger } = deps;
  const args = parseArgs(argv);

  let pkg;
  try {
    pkg = readPackage(args.cwd);
  } catch (err) {
    logger.error(
      `[pinned-override-notes] ✖ could not read package.json: ${String(err?.message ?? err)}`,
    );
    return EXIT_CANNOT_RUN;
  }

  const report = auditPinnedOverrideNotes(pkg);
  if (args.json) {
    logger.info(JSON.stringify(report, null, 2));
    return report.findings.length > 0 ? EXIT_DRIFT : EXIT_PASS;
  }

  if (report.findings.length === 0) {
    logger.info(
      `[pinned-override-notes] ✅ ${report.checked.length} documented override pin(s) match their notes.`,
    );
    return EXIT_PASS;
  }
  for (const finding of report.findings) {
    logger.error(
      `[pinned-override-notes] ✖ ${finding.kind}: ${finding.detail}`,
    );
  }
  return EXIT_DRIFT;
}

function defaultReadPackage(cwd) {
  return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
}

runAsCli(import.meta.url, async () => runCheck(), {
  source: 'pinned-override-notes',
  propagateExitCode: true,
  errorPrefix: '[pinned-override-notes] ❌ Fatal error',
  usage: HELP,
});
