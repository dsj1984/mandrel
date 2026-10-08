#!/usr/bin/env node
/**
 * CLI: the SCA gate — `npm audit --audit-level=high`, honoring reviewed,
 * dated exceptions from `audit-exceptions.json`.
 *
 * The one audit invocation for `ci.yml`'s required "Dependency Vulnerability
 * Audit (SCA)" step, `dependency-audit-cron.yml`'s nightly sweep, and
 * `npm run verify`, so none of them can disagree about what counts as red.
 * The suppression rules live in `lib/audit-exceptions.js`; this file only
 * runs them and prints the verdict.
 *
 * Exit codes:
 *   0 — no blocking advisory stands after honored exceptions, and no
 *       exception is stale.
 *   1 — a blocking advisory stands, an exception is stale, the exceptions
 *       file is invalid, or npm could not evaluate the tree. The gate fails
 *       closed on every one of those.
 */
import process from 'node:process';

import { runAsCli } from '../.agents/scripts/lib/cli-utils.js';
import { Logger } from '../.agents/scripts/lib/Logger.js';
import {
  auditWithExceptions,
  EXCEPTIONS_FILE,
  EXPIRED,
  HONORED,
  loadExceptions,
  STALE,
} from './lib/audit-exceptions.js';

const HELP = {
  invocation: 'node scripts/check-npm-audit.js [--cwd <dir>]',
  summary:
    'Fail on any high or critical npm advisory, except those listed in audit-exceptions.json that production code cannot reach and whose review date has not passed.',
  flags: [['--cwd <dir>', 'Repository root. Default: process.cwd().']],
  notes: [
    'An exception is honored only while its advisory is absent from the\n`--omit=dev` audit and today (UTC) is on or before its `reviewBy` date.\nAn exception matching no current advisory is stale and fails the gate —\ndelete it once upstream ships a fix.',
  ],
};

export function parseArgs(argv) {
  const out = { cwd: process.cwd() };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--cwd') out.cwd = argv[++i] ?? out.cwd;
  }
  return out;
}

function exceptionLine({ exception, status }) {
  const label = `${exception.id} (${exception.package})`;
  if (status === HONORED) {
    return `excepted: ${label} — review by ${exception.reviewBy}`;
  }
  if (status === STALE) {
    return `✗ stale exception: ${label} matches no current advisory — delete the entry from ${EXCEPTIONS_FILE}`;
  }
  const detail =
    status === EXPIRED ? `exception expired ${exception.reviewBy}` : status;
  return `✗ exception not honored: ${label} — ${detail}`;
}

/**
 * The gate, with its I/O collaborators injectable
 * (`docs/contributing/test-seams.md`).
 *
 * @returns {{ exitCode: number, lines: string[] }}
 */
export function runCheck(argv = process.argv, deps = {}) {
  const {
    load = loadExceptions,
    audit = auditWithExceptions,
    today,
    logger = Logger,
  } = deps;
  const args = parseArgs(argv);
  const lines = [];
  let exitCode = 0;
  try {
    const exceptions = load(args.cwd);
    const result = audit(args.cwd, { exceptions, today });
    lines.push(...result.exceptions.map(exceptionLine));
    for (const a of result.advisories) {
      lines.push(`✗ blocking: ${a.id} (${a.severity}) ${a.title}`);
    }
    if (result.suppressed.length > 0) {
      lines.push(
        `${result.suppressed.length} audit entr${result.suppressed.length === 1 ? 'y' : 'ies'} suppressed by honored exceptions.`,
      );
    }
    exitCode = result.failed ? 1 : 0;
    lines.push(
      exitCode === 0
        ? '✓ npm audit gate: no blocking advisories.'
        : `✗ npm audit gate: ${result.advisories.length} blocking advisor${result.advisories.length === 1 ? 'y' : 'ies'} stand.`,
    );
  } catch (err) {
    exitCode = 1;
    lines.push(`✗ npm audit gate could not run: ${err?.message ?? err}`);
  }
  for (const line of lines) {
    (line.startsWith('✗') ? logger.error : logger.info)(line);
  }
  return { exitCode, lines };
}

runAsCli(import.meta.url, async () => runCheck().exitCode, {
  source: 'check-npm-audit',
  propagateExitCode: true,
  errorPrefix: '[check-npm-audit] ❌ Fatal error',
  usage: HELP,
});
