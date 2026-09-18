/**
 * Persist the cross-run audit ledger, which an ephemeral checkout would
 * otherwise discard.
 */

import { DEFAULT_LEDGER_PATH } from '../findings/audit-ledger.js';
import { gh as defaultGh } from '../gh-exec.js';
import { gitSync } from '../git-utils.js';
import { openLedgerPullRequest, probeGit } from './ledger-pr.js';

const DEFAULT_BASE_BRANCH = 'main';

/**
 * @param {Date|string|number} [now]
 * @returns {string}
 */
function isoDate(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  return date.toISOString().slice(0, 10);
}

/**
 * Explicit, then config, then `main`; a failed config resolve must never break
 * a sweep that has already done its work.
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
 * `unpersisted`: the ledger changed but there is no `origin` or HEAD is off
 * the base branch, so a commit here would not reach shared state.
 *
 * @param {object} [params]
 * @param {string} [params.ledgerPath]
 * @param {string} [params.baseBranch]
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
 * Pathspec-scoped, so unrelated dirt never counts.
 * @param {(args: string[]) => string} probe
 * @param {string} ledgerPath
 * @returns {boolean}
 */
function ledgerIsDirty(probe, ledgerPath) {
  return probe(['status', '--porcelain', '--', ledgerPath]).length > 0;
}

/**
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
 * `''` when detached or commitless — both read as "not the base branch".
 * @param {(args: string[]) => string} probe
 * @returns {string}
 */
function headBranchOf(probe) {
  return probe(['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
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
 * Marks the summary `unpersisted: true` (and warns) when the checkout cannot
 * keep the new memory.
 *
 * @param {object} [params]
 * @param {object|null} [params.ledger]
 * @param {string} [params.ledgerPath]
 * @param {boolean} [params.dryRun]
 * @param {boolean} [params.ledgerCommit]
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
 * Failures are fatal and name their step; callers run this after printing the
 * run summary so a broken remote never costs the sweep's findings.
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
