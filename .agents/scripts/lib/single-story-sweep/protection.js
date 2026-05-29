/**
 * single-story-sweep/protection.js
 *
 * Story #2011: per-candidate protection check the
 * [`single-story-sweep`](../single-story-sweep.js) runs **before** handing
 * a merged-branch candidate to `executeCleanup`. The pre-existing sweep
 * relies solely on `gh pr list --state merged` to identify reap
 * candidates. That's necessary but not sufficient — a branch whose PR has
 * been merged can still hold operator work the merge did not capture
 * (post-merge commits, uncommitted edits) or sit on a worktree whose
 * parent Story is still live.
 *
 * This module is a pure-ish protection evaluator: given a candidate
 * (with branch name and optional worktreePath) plus injected ports for
 * git, gh, and the ticketing provider, it returns
 * `{ protected: boolean, reason?: string }`. The sweep filters protected
 * candidates out of `executeCleanup` and records them in the result
 * envelope so the operator can see what was skipped.
 *
 * Three independent guards:
 *
 *   1. `unpushed-work` — branch HEAD SHA differs from the PR's
 *      `headRefOid` (the commit GitHub actually merged). Catches both
 *      post-merge commits and force-pushed divergence. Handles squash
 *      merges correctly (where `merge-base --is-ancestor` would falsely
 *      flag the branch as unmerged).
 *   2. `dirty-tree` — when a worktree is attached and `git status
 *      --porcelain` reports uncommitted edits. The operator is
 *      mid-flight.
 *   3. `ticket-not-done` — the parent Story ticket is not in a terminal
 *      state (closed, `agent::done`). Mirrors the guard
 *      [`sweepStaleStoryWorktrees`](../orchestration/plan-runner/worktree-sweep.js)
 *      already enforces at plan time.
 *
 * Failures during the checks themselves (network blip on gh, ticket
 * provider error, git rev-parse exit !=0) all default to **protected**.
 * Better to leave a candidate alone than to nuke operator work because
 * an unrelated query timed out.
 *
 * Pure with respect to its inputs; all I/O routes through the injected
 * ports so unit tests can drive the state machine without touching disk
 * or the network.
 */

import { parseStoryBranch } from '../git-utils.js';

const DONE_LABEL = 'agent::done';

/**
 * Story id from a `story-<n>` branch name. Returns `null` for any other
 * shape. Exported for tests.
 *
 * @param {string} branch
 * @returns {number|null}
 */
export function storyIdFromBranch(branch) {
  return parseStoryBranch(branch);
}

/**
 * Pure: does the ticket count as "done"? Closed state OR carrying the
 * `agent::done` label. Exported for tests.
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
 * Resolve a branch ref to its full SHA via `git rev-parse`. Returns
 * `{ ok: true, sha }` on success, `{ ok: false, reason }` on any failure.
 *
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
 * Run `git status --porcelain` inside a worktree and report whether the
 * tree is clean. Returns `{ ok: true, dirty: boolean }` on success, or
 * `{ ok: false, reason }` when the command itself fails.
 *
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
 * Probe a PR's `headRefOid` (the commit GitHub merged) via gh CLI.
 * Returns `{ ok: true, sha }` on success, `{ ok: false, reason }`
 * otherwise.
 *
 * The runner port mirrors `git-cleanup-branches.js`'s `defaultGhRunner`
 * shape: `(args, opts) => stdout`. Tests inject their own.
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
 * Sub-check: does the branch have commits the PR did not merge?
 *
 * Compares `git rev-parse <branch>` against `gh pr view --json
 * headRefOid`. Any mismatch (post-merge push, force-push divergence,
 * the operator amended) flags the branch as protected. Squash merges
 * are handled correctly: a squash where the branch is unchanged since
 * the PR was opened keeps `branch HEAD == headRefOid`; the squash
 * commit lives only on `main`.
 *
 * Exported for tests.
 */
export function checkUnpushedWork({ candidate, ctx }) {
  if (typeof candidate?.prNumber !== 'number') {
    // No PR-detected candidate — the gh probe in `planCleanup` should
    // have populated this. Without a PR number we cannot do a reliable
    // ancestry check; default to protected so we never reap a branch
    // whose merge state we cannot verify.
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

/**
 * Sub-check: does the candidate's worktree have uncommitted edits?
 *
 * Skips silently (returns `not-protected`) when no worktree is attached
 * — there is nothing to be dirty in that case; the branch-only delete
 * path is unaffected.
 *
 * Exported for tests.
 */
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

/**
 * Sub-check: is the parent Story ticket in a terminal state? Treats
 * provider failures as "still open" — better to leave a candidate alone
 * than to reap one whose status we cannot read.
 *
 * Branches that do not match the `story-<n>` shape have no parent
 * ticket to query; they bypass this guard. The sweep's branch filter
 * already excludes non-`story-*` branches upstream, so this code path
 * is reached only when the matcher passes.
 *
 * Exported for tests.
 */
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
 * Evaluate every protection guard against a single sweep candidate.
 * Returns the first protected verdict encountered (short-circuits) so
 * the reason string in the result envelope is single-cause and easy to
 * read.
 *
 * Ordering: dirty-tree (cheap, local-only) → ticket-not-done (one
 * provider call) → unpushed-work (one gh + one git call). Fail-fast on
 * the cheapest checks first.
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
