#!/usr/bin/env node
/**
 * CLI: attribute a red `npm audit` result to the diff or to the merge base.
 *
 * Runs from `ci.yml` immediately after the required "Dependency Vulnerability
 * Audit (SCA)" step fails, and only on a pull request. It re-audits the merge
 * base's committed lockfile and says, as the first line a reader sees,
 * whether this branch caused the failure.
 *
 * The verdict never changes whether the branch may land — see
 * `attributionExitCode` in `lib/audit-attribution.js`. It changes how long it
 * takes to understand why it may not.
 *
 * Exit codes:
 *   0 — the probe could not reach a verdict (`unknown`); the SCA step's own
 *       failure stands unmodified.
 *   1 — a verdict was reached: `pre-existing` or `introduced-by-this-diff`.
 *       Both fail, because the advisory is real either way.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  attributionExitCode,
  deriveVerdict,
  renderAttribution,
  UNKNOWN,
} from './lib/audit-attribution.js';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

/** The label the nightly sweep keys its reusable tracking issue on. */
const TRACKING_LABEL = 'meta::dependency-advisory';

const HELP = {
  invocation:
    'node .agents/scripts/check-audit-attribution.js --base <ref> [--cwd <dir>] [--no-tracking-issue]',
  summary:
    'Say whether a red high-severity npm advisory came from this pull request or was already on its merge base.',
  flags: [
    ['--base <ref>', 'Base commit or ref to attribute against. Required.'],
    ['--cwd <dir>', 'Repository root. Default: process.cwd().'],
    [
      '--no-tracking-issue',
      `Skip the ${TRACKING_LABEL} issue lookup (offline / no GH_TOKEN).`,
    ],
  ],
  notes: [
    'Run it only after the required SCA step has already failed — it re-audits\nthe base to attribute that failure, and reports `unknown` when the head\naudits clean.',
    "Exit codes:\n  0  unknown — the probe degraded; the SCA step's own failure stands\n  1  a verdict was reached (pre-existing or introduced-by-this-diff)",
    'Both real verdicts exit 1. A check that passed on `pre-existing` would let\nadvisories accumulate on `main` unnoticed, which is what the nightly sweep\n(.github/workflows/dependency-audit-cron.yml) exists to prevent.',
  ],
};

export function parseArgs(argv) {
  const out = { base: null, cwd: process.cwd(), trackingIssue: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i] ?? null;
    else if (a === '--cwd') out.cwd = argv[++i] ?? out.cwd;
    else if (a === '--no-tracking-issue') out.trackingIssue = false;
  }
  return out;
}

/**
 * Run `npm audit --audit-level=high` over a dependency manifest pair.
 *
 * `--package-lock-only` audits the committed lockfile without installing, so
 * the probe never touches the job's own `node_modules`: an attribution
 * mechanism that could disturb the tree it is reporting on would be a worse
 * defect than the one it explains.
 *
 * @param {string} dir directory holding package.json + package-lock.json
 * @returns {{ failed: boolean }}
 */
function auditDir(dir) {
  try {
    execFileSync(
      'npm',
      ['audit', '--audit-level=high', '--package-lock-only'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { failed: false };
  } catch (err) {
    // npm exits non-zero for "advisories found" and for "could not audit"
    // alike. Only a real audit verdict carries a report on stdout; anything
    // else is a probe failure the caller must read as `unknown`.
    const stdout = String(err?.stdout ?? '');
    if (/vulnerabilit/i.test(stdout)) return { failed: true };
    throw new Error(
      `npm audit could not evaluate the base tree: ${String(err?.stderr ?? err?.message ?? err).slice(0, 200)}`,
    );
  }
}

/**
 * Materialize the base commit's manifest pair into a scratch directory.
 *
 * Read out of git rather than from a checkout — the job's working tree is the
 * head, and swapping files in it to run a probe is exactly the kind of side
 * effect this must not have.
 *
 * @returns {string} the scratch directory (caller removes it)
 */
function materializeBase({ cwd, base, git }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-attribution-'));
  for (const file of ['package.json', 'package-lock.json']) {
    writeFileSync(path.join(dir, file), git(cwd, 'show', `${base}:${file}`));
  }
  return dir;
}

const defaultGit = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * The decision core, with every I/O collaborator injectable
 * (`.agents/rules/test-seams.md` rules 1-2, 4) so the whole verdict table is
 * reachable without a git history, a network, or an npm spawn.
 *
 * @returns {{ verdict: string, exitCode: number, lines: string[] }}
 */
export function runAttribution(argv = process.argv, deps = {}) {
  const {
    git = defaultGit,
    auditHead = auditDir,
    auditBase = auditDir,
    materialize = materializeBase,
    lookupTrackingIssue = defaultLookupTrackingIssue,
    cleanup = (dir) => rmSync(dir, { recursive: true, force: true }),
    logger = Logger,
  } = deps;
  const args = parseArgs(argv);

  if (!args.base) {
    const lines = renderAttribution({
      verdict: UNKNOWN,
      reason: 'no --base ref was supplied',
    });
    for (const line of lines) logger.info(line);
    return { verdict: UNKNOWN, exitCode: 0, lines };
  }

  let headFailed;
  try {
    headFailed = auditHead(args.cwd).failed;
  } catch (err) {
    return report({ verdict: UNKNOWN, args, logger, reason: msg(err) });
  }
  if (!headFailed) {
    return report({
      verdict: UNKNOWN,
      args,
      logger,
      reason: 'the head tree audits clean, so there is nothing to attribute',
    });
  }

  let dir = null;
  let baseAudit = null;
  let reason = null;
  try {
    dir = materialize({ cwd: args.cwd, base: args.base, git });
    baseAudit = auditBase(dir);
  } catch (err) {
    reason = msg(err);
  } finally {
    if (dir) {
      try {
        cleanup(dir);
      } catch {
        // A leaked scratch dir under the OS temp root is not worth failing a
        // report over.
      }
    }
  }

  const verdict = deriveVerdict({ headFailed, baseAudit });
  const trackingIssue =
    args.trackingIssue && verdict !== UNKNOWN
      ? safeLookup(lookupTrackingIssue, args.cwd)
      : null;
  return report({ verdict, args, logger, reason, trackingIssue });
}

function msg(err) {
  return String(err?.message ?? err).slice(0, 200);
}

function report({
  verdict,
  args,
  logger,
  reason = null,
  trackingIssue = null,
}) {
  const lines = renderAttribution({
    verdict,
    baseRef: args.base,
    trackingIssue,
    reason,
  });
  for (const line of lines) logger.info(line);
  return { verdict, exitCode: attributionExitCode(verdict), lines };
}

/**
 * Look up the open tracking issue by LABEL, not a title search: GitHub's
 * issue search index lags, and the nightly sweep keys the same issue the same
 * way for the same reason.
 */
function defaultLookupTrackingIssue(cwd) {
  const out = execFileSync(
    'gh',
    [
      'issue',
      'list',
      '--label',
      TRACKING_LABEL,
      '--state',
      'open',
      '--limit',
      '1',
      '--json',
      'number',
      '--jq',
      '.[0].number // empty',
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  return out ? Number(out) : null;
}

function safeLookup(lookup, cwd) {
  try {
    const n = lookup(cwd);
    return Number.isInteger(n) ? n : null;
  } catch {
    // No token, no network, no `gh` — the verdict is still worth printing.
    return null;
  }
}

runAsCli(import.meta.url, async () => runAttribution().exitCode, {
  source: 'audit-attribution',
  propagateExitCode: true,
  errorPrefix: '[audit-attribution] ❌ Fatal error',
  usage: HELP,
});
