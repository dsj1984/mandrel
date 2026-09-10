/**
 * lib/audit-to-stories/ledger-commit.js — persist the cross-run audit ledger.
 *
 * The `--auto` sweep's whole value is memory: `baselines/audit-ledger.json`
 * is what lets the next run tell a re-detection from a fresh finding and an
 * accepted risk from an unseen one. A scheduled sweep, though, typically runs
 * on an ephemeral checkout — a fresh clone that is deleted when the job ends —
 * so the ledger `--auto` writes is discarded and every later sweep starts from
 * an empty memory. The sweep is then permanently amnesiac, and the ledger's
 * suppression and regression signals never fire.
 *
 * This module closes that hole from both ends:
 *
 *   - {@link runLedgerCommit} (`--auto --ledger-commit`) commits the changed
 *     ledger onto a `chore/audit-ledger-<YYYY-MM-DD>-<shortsha>` branch cut
 *     from `origin/<base>`, pushes it, and opens a PR against
 *     `project.baseBranch` through the `gh` wrapper.
 *     Auto-merge is never requested: a ledger PR records machine-derived state
 *     a human should glance at, so landing it stays an operator decision.
 *   - {@link resolveLedgerSummary} answers the question the *unflagged* sweep
 *     needs — "would this ledger survive?" — so a run that cannot persist (no
 *     `origin`, or HEAD parked off the base branch) says so in its summary,
 *     and on stderr, instead of silently discarding the state.
 *
 * Both take injectable `git` / `gh` seams (`.agents/rules/test-seams.md`) so
 * the branch/commit/push/PR argv shape is assertable without a live remote.
 * The logic lives here rather than in `audit-to-stories.js` so the CLI file's
 * complexity budget does not absorb a git driver.
 */

import { gh as defaultGh } from '../gh-exec.js';
import { gitSync } from '../git-utils.js';
import { DEFAULT_LEDGER_PATH } from './ledger.js';
import { openLedgerPullRequest, probeGit } from './ledger-pr.js';

/** Fallback base branch when config carries no `project.baseBranch`. */
const DEFAULT_BASE_BRANCH = 'main';

/**
 * Render the `YYYY-MM-DD` stamp both the branch name and the commit subject
 * carry, so one sweep produces one identifiable ledger branch per day.
 * @param {Date|string|number} [now]
 * @returns {string}
 */
function isoDate(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve `project.baseBranch` defensively: an explicit value wins, then
 * config, then `main`. A failed config resolve must never break a sweep that
 * has already done its real work.
 * @param {string} [explicit]
 * @returns {Promise<string>}
 */
async function resolveBaseBranch(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  try {
    const { resolveConfig } = await import('../config-resolver.js');
    const branch = resolveConfig()?.project?.baseBranch;
    if (typeof branch === 'string' && branch.length > 0) return branch;
  } catch (_) {
    // fall through to the default
  }
  return DEFAULT_BASE_BRANCH;
}

/**
 * Inspect whether the ledger changed and whether this checkout could persist
 * it at all. Module-local: the two exported entry points below are the whole
 * public surface, so a probe helper never becomes a second way in.
 *
 * `unpersisted` is the signal the unflagged `--auto` summary carries: the
 * sweep produced new memory, and this checkout has nowhere to put it — either
 * there is no `origin` to push to or HEAD is not on the base branch, so a
 * commit here would not reach the repository's shared state.
 *
 * @param {object} [params]
 * @param {string} [params.ledgerPath] — defaults to `baselines/audit-ledger.json`.
 * @param {string} [params.baseBranch] — defaults to resolved `project.baseBranch`.
 * @param {string} [params.cwd]
 * @param {(cwd: string, ...args: string[]) => string} [params.git]
 * @returns {Promise<{ ledgerPath: string, baseBranch: string, changed: boolean,
 *   hasOrigin: boolean, headBranch: string, onBaseBranch: boolean,
 *   unpersisted: boolean }>}
 */
async function assessLedgerPersistence({
  ledgerPath = DEFAULT_LEDGER_PATH,
  baseBranch,
  cwd = process.cwd(),
  git = gitSync,
} = {}) {
  const base = await resolveBaseBranch(baseBranch);
  const probe = (args) => probeGit(git, cwd, args);
  const changed = ledgerIsDirty(probe, ledgerPath);
  const hasOrigin = hasOriginRemote(probe);
  const headBranch = headBranchOf(probe);

  return {
    ledgerPath,
    baseBranch: base,
    changed,
    hasOrigin,
    headBranch,
    onBaseBranch: headBranch === base,
    unpersisted: changed && (!hasOrigin || headBranch !== base),
  };
}

/**
 * Has the sweep actually written new memory? Scoped to the ledger pathspec, so
 * unrelated dirt in the checkout is never mistaken for it.
 * @param {(args: string[]) => string} probe
 * @param {string} ledgerPath
 * @returns {boolean}
 */
function ledgerIsDirty(probe, ledgerPath) {
  return probe(['status', '--porcelain', '--', ledgerPath]).length > 0;
}

/**
 * Is there an `origin` to push to at all? The ephemeral-clone shape that makes
 * a sweep amnesiac usually has none.
 * @param {(args: string[]) => string} probe
 * @returns {boolean}
 */
function hasOriginRemote(probe) {
  return probe(['remote'])
    .split('\n')
    .map((line) => line.trim())
    .includes('origin');
}

/**
 * The branch HEAD is on, or `''` when the checkout is detached or has no
 * commits — both of which read as "not the base branch", which is the answer
 * the callers need.
 * @param {(args: string[]) => string} probe
 * @returns {string}
 */
function headBranchOf(probe) {
  return probe(['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * Warn that the reconciled ledger has nowhere to go. Names the file, because
 * "state will be lost" is unactionable without knowing which state.
 * @param {{ ledgerPath: string, baseBranch: string, hasOrigin: boolean, headBranch: string }} state
 * @returns {string}
 */
function unpersistedWarning(state) {
  const cause = state.hasOrigin
    ? `HEAD is on "${state.headBranch || '(detached)'}", not the base branch "${state.baseBranch}"`
    : 'this checkout has no "origin" remote';
  return `ledger not persisted: ${state.ledgerPath} changed but ${cause}, so this sweep's memory will be lost when the checkout goes away. Re-run with --ledger-commit to open a PR for it, or commit ${state.ledgerPath} by hand.`;
}

/**
 * Resolve the `--auto` summary's `ledger` field, annotating it with
 * `unpersisted: true` (and warning on stderr) when the sweep produced memory
 * this checkout cannot keep.
 *
 * The whole decision lives here rather than in the CLI so `runAuto` stays a
 * straight-line assembly of its summary: `dryRun` and `ledgerCommit` are
 * passed through raw and branched on once, in one place.
 *
 * @param {object} [params]
 * @param {object|null} [params.ledger] — the plan's ledger summary, or null.
 * @param {string} [params.ledgerPath]
 * @param {boolean} [params.dryRun] — nothing was written, so nothing is at risk.
 * @param {boolean} [params.ledgerCommit] — a PR is about to persist it.
 * @param {string} [params.cwd]
 * @param {(cwd: string, ...args: string[]) => string} [params.git]
 * @param {{ warn: Function }} [params.logger]
 * @returns {Promise<object|null>} the (possibly annotated) ledger summary.
 */
export async function resolveLedgerSummary({
  ledger = null,
  ledgerPath = DEFAULT_LEDGER_PATH,
  dryRun,
  ledgerCommit,
  cwd,
  git,
  logger,
} = {}) {
  if (dryRun || ledgerCommit) return ledger;
  const state = await assessLedgerPersistence({ ledgerPath, cwd, git });
  if (!state.unpersisted) return ledger;
  logger?.warn?.(unpersistedWarning(state));
  return { ...(ledger ?? { path: ledgerPath }), unpersisted: true };
}

/**
 * Commit the changed ledger onto a unique branch cut from the remote base and
 * open a PR for it.
 *
 * Assesses the checkout, then hands the whole write sequence to
 * {@link openLedgerPullRequest}. Every git/`gh` failure is fatal and names its
 * step; the caller runs this *after* printing the run summary, so a broken
 * remote never costs the operator the sweep's findings.
 *
 * @param {object} [params]
 * @param {string} [params.ledgerPath]
 * @param {string} [params.baseBranch]
 * @param {string} [params.cwd]
 * @param {(cwd: string, ...args: string[]) => string} [params.git]
 * @param {{ pr: { create: (flags: string[]) => Promise<unknown> } }} [params.gh]
 * @param {Date|string|number} [params.now]
 * @returns {Promise<{ committed: boolean, reason?: string, branch?: string,
 *   subject?: string, baseBranch?: string, prUrl?: string|null,
 *   resumed?: boolean, ledgerPath: string }>}
 */
export async function runLedgerCommit({
  ledgerPath = DEFAULT_LEDGER_PATH,
  baseBranch,
  cwd = process.cwd(),
  git = gitSync,
  gh = defaultGh,
  now,
} = {}) {
  const state = await assessLedgerPersistence({
    ledgerPath,
    baseBranch,
    cwd,
    git,
  });
  return openLedgerPullRequest({
    state,
    ledgerPath,
    cwd,
    git,
    gh,
    date: isoDate(now),
  });
}
