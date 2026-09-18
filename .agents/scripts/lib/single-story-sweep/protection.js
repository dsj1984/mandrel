/**
 * single-story-sweep/protection.js
 *
 * Per-candidate guards run before a merged-branch candidate is reaped: a
 * merged PR is necessary but not sufficient, since the branch may still hold
 * post-merge commits, uncommitted edits, or belong to a live Story. Any check
 * that itself fails defaults to **protected** — leave a candidate alone rather
 * than destroy operator work because a query timed out. All I/O is injected.
 */

import { parseStoryBranch } from '../git-utils.js';

const DONE_LABEL = 'agent::done';

/**
 * @param {string} branch
 * @returns {number|null}
 */
export function storyIdFromBranch(branch) {
  return parseStoryBranch(branch);
}

/**
 * Closed, or carrying `agent::done`.
 *
 * @param {{state?: string|null, labels?: Array<string>}} ticket
 * @returns {boolean}
 */
export function isTicketDone(ticket) {
  if (!ticket) return false;
  if (ticket.state === 'closed') return true;
  const labels = Array.isArray(ticket.labels) ? ticket.labels : [];
  return labels.includes(DONE_LABEL);
}

/**
 * @param {{ gitSpawn: Function, repoRoot: string }} ctx
 * @param {string} ref
 */
function gitRevParse(ctx, ref) {
  const res = ctx.gitSpawn(ctx.repoRoot, 'rev-parse', ref);
  if (res?.status !== 0) {
    return {
      ok: false,
      reason: `rev-parse-failed: ${(res?.stderr || res?.stdout || '').trim() || 'unknown'}`,
    };
  }
  const sha = (res.stdout || '').trim();
  if (!sha) return { ok: false, reason: 'rev-parse-failed: empty stdout' };
  return { ok: true, sha };
}

/**
 * @param {{ gitSpawn: Function }} ctx
 * @param {string} worktreePath
 */
function gitStatusDirty(ctx, worktreePath) {
  const res = ctx.gitSpawn(worktreePath, 'status', '--porcelain');
  if (res?.status !== 0) {
    return {
      ok: false,
      reason: `status-failed: ${(res?.stderr || res?.stdout || '').trim() || 'unknown'}`,
    };
  }
  const text = (res.stdout || '').trim();
  return { ok: true, dirty: text.length > 0 };
}

/**
 * The PR's `headRefOid` — the commit GitHub actually merged.
 *
 * @param {{ ghRunner: Function }} ctx
 * @param {number} prNumber
 * @param {string} repoRoot
 */
function probePrHeadRefOid(ctx, prNumber, repoRoot) {
  try {
    const stdout = ctx.ghRunner(
      ['pr', 'view', String(prNumber), '--json', 'headRefOid'],
      { cwd: repoRoot },
    );
    const parsed = JSON.parse(stdout);
    if (
      typeof parsed?.headRefOid !== 'string' ||
      parsed.headRefOid.length === 0
    ) {
      return { ok: false, reason: 'pr-head-missing' };
    }
    return { ok: true, sha: parsed.headRefOid };
  } catch (err) {
    return {
      ok: false,
      reason: `gh-pr-view-failed: ${err?.message ?? err}`,
    };
  }
}

/**
 * Branch HEAD must equal the PR's `headRefOid`; any mismatch (post-merge
 * push, force-push, amend) protects. Unlike `merge-base --is-ancestor`, this
 * is correct for squash merges.
 */
export function checkUnpushedWork({ candidate, ctx }) {
  if (typeof candidate?.prNumber !== 'number') {
    return { protected: true, reason: 'no-pr-number' };
  }
  const branchHead = gitRevParse(ctx, candidate.branch);
  if (!branchHead.ok) {
    return { protected: true, reason: branchHead.reason };
  }
  const prHead = probePrHeadRefOid(ctx, candidate.prNumber, ctx.repoRoot);
  if (!prHead.ok) {
    return { protected: true, reason: prHead.reason };
  }
  if (branchHead.sha !== prHead.sha) {
    return { protected: true, reason: 'unpushed-work' };
  }
  return { protected: false };
}

/** No attached worktree means nothing can be dirty. */
export function checkDirtyTree({ candidate, ctx }) {
  if (!candidate.hasWorktree || !candidate.worktreePath) {
    return { protected: false };
  }
  const status = gitStatusDirty(ctx, candidate.worktreePath);
  if (!status.ok) {
    return { protected: true, reason: status.reason };
  }
  if (status.dirty) {
    return { protected: true, reason: 'dirty-tree' };
  }
  return { protected: false };
}

/** Non-`story-<n>` branches have no parent ticket and bypass this guard. */
export async function checkTicketNotDone({ candidate, ctx }) {
  const storyId = storyIdFromBranch(candidate.branch);
  if (storyId === null) return { protected: false };
  if (typeof ctx.getTicket !== 'function') {
    return { protected: true, reason: 'provider-unavailable' };
  }
  try {
    const ticket = await ctx.getTicket(storyId);
    if (!isTicketDone(ticket)) {
      return { protected: true, reason: 'ticket-not-done' };
    }
    return { protected: false };
  } catch (err) {
    return {
      protected: true,
      reason: `ticket-read-failed: ${err?.message ?? err}`,
    };
  }
}

/**
 * First protected verdict wins (single-cause reason), cheapest check first.
 *
 * @param {{
 *   candidate: {
 *     branch: string,
 *     prNumber?: number|null,
 *     hasWorktree?: boolean,
 *     worktreePath?: string|null,
 *   },
 *   ctx: {
 *     repoRoot: string,
 *     gitSpawn: Function,
 *     ghRunner: Function,
 *     getTicket?: (id: number) => Promise<object>,
 *   },
 * }} args
 * @returns {Promise<{ protected: boolean, reason?: string }>}
 */
export async function evaluateProtection({ candidate, ctx }) {
  const dirty = checkDirtyTree({ candidate, ctx });
  if (dirty.protected) return dirty;

  const ticket = await checkTicketNotDone({ candidate, ctx });
  if (ticket.protected) return ticket;

  const unpushed = checkUnpushedWork({ candidate, ctx });
  if (unpushed.protected) return unpushed;

  return { protected: false };
}
