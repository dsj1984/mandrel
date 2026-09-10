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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  attributionExitCode,
  auditAdvisories,
  deriveVerdict,
  diffAdvisories,
  renderAdvisoryDetail,
  renderAttribution,
  UNKNOWN,
} from './lib/audit-attribution.js';
import { execFileCapture } from './lib/child-exec.js';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

/** The label the nightly sweep keys its reusable tracking issue on. */
const TRACKING_LABEL = 'meta::dependency-advisory';

const HELP = {
  invocation:
    'node .agents/scripts/check-audit-attribution.js --base <ref> [--cwd <dir>]',
  summary:
    'Say whether a red high-severity npm advisory came from this pull request or was already on its merge base.',
  flags: [
    ['--base <ref>', 'Base commit or ref to attribute against. Required.'],
    ['--cwd <dir>', 'Repository root. Default: process.cwd().'],
    [
      '--no-tracking-issue',
      "Skip the `gh issue list` lookup for the nightly sweep's tracking issue.",
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
    // A runner with no `gh` credentials would spend a subprocess to fail; the
    // verdict never depended on the lookup, so let the caller skip it.
    else if (a === '--no-tracking-issue') out.trackingIssue = false;
  }
  return out;
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

// `execFileCapture` owns the stdout ceiling, `shell: false` and error
// normalisation for the whole tree — a lockfile is large enough that a
// re-forked local ceiling would be a real defect, not a style point.
const defaultGit = (cwd, ...args) => execFileCapture('git', args, { cwd });

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
    auditHead = auditAdvisories,
    auditBase = auditAdvisories,
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

  const head = auditTheHead({ args, auditHead });
  if (head.reason) {
    return report({ verdict: UNKNOWN, args, logger, reason: head.reason });
  }

  const { baseAudit, reason } = auditTheBase({
    args,
    git,
    auditBase,
    materialize,
    cleanup,
  });
  const { introduced, preExisting } = diffAdvisories({
    head: head.advisories,
    base: baseAudit?.advisories ?? null,
  });

  // Per advisory: the merge base is "already failing for this" exactly when it
  // carries every advisory the head does. A base red for its own advisory must
  // not absolve a diff that added a different one.
  const verdict = deriveVerdict({
    headFailed: true,
    baseAudit: baseAudit && { failed: introduced.length === 0 },
  });
  return report({
    verdict,
    args,
    logger,
    reason,
    trackingIssue: resolveTrackingIssue({
      verdict,
      args,
      lookupTrackingIssue,
    }),
    introduced,
    preExisting,
  });
}

/**
 * Audit the head tree, converting both no-verdict cases — the audit itself
 * broke, or the head is clean — into a `reason` the caller reports as
 * `unknown`. Neither is an accusation, and neither is worth auditing a base for.
 *
 * @param {{ args: object, auditHead: Function }} ctx
 * @returns {{ advisories?: Array<object>, reason: string|null }}
 */
function auditTheHead({ args, auditHead }) {
  try {
    const head = auditHead(args.cwd);
    return head.failed
      ? { advisories: head.advisories, reason: null }
      : {
          reason:
            'the head tree audits clean, so there is nothing to attribute',
        };
  } catch (err) {
    return { reason: msg(err) };
  }
}

/**
 * Look the nightly sweep's tracking issue up, unless there is no verdict to
 * attach it to or `--no-tracking-issue` said not to spend the round-trip.
 *
 * @param {{ verdict: string, args: object, lookupTrackingIssue: Function }} ctx
 * @returns {number|null}
 */
function resolveTrackingIssue({ verdict, args, lookupTrackingIssue }) {
  if (verdict === UNKNOWN || !args.trackingIssue) return null;
  return safeLookup(lookupTrackingIssue, args.cwd);
}

/**
 * Materialize the merge base and audit it, converting every way that can fail
 * into a `reason` rather than a throw. The scratch directory is always removed.
 *
 * @param {object} ctx
 * @returns {{ baseAudit: object|null, reason: string|null }}
 */
function auditTheBase({ args, git, auditBase, materialize, cleanup }) {
  let dir = null;
  try {
    dir = materialize({ cwd: args.cwd, base: args.base, git });
    return { baseAudit: auditBase(dir), reason: null };
  } catch (err) {
    return { baseAudit: null, reason: msg(err) };
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
  introduced = [],
  preExisting = [],
}) {
  const lines = [
    ...renderAttribution({
      verdict,
      baseRef: args.base,
      trackingIssue,
      reason,
    }),
    // The two lists are reported separately even when the verdict is
    // `introduced-by-this-diff`: an author fixing B still needs to know A is
    // not theirs.
    ...renderAdvisoryDetail({ introduced, preExisting }),
  ];
  for (const line of lines) logger.info(line);
  return {
    verdict,
    exitCode: attributionExitCode(verdict),
    lines,
    introduced,
    preExisting,
  };
}

/**
 * Look up the open tracking issue by LABEL, not a title search: GitHub's
 * issue search index lags, and the nightly sweep keys the same issue the same
 * way for the same reason.
 */
function defaultLookupTrackingIssue(cwd) {
  const out = execFileCapture(
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
    { cwd },
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
