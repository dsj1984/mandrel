/**
 * phases/auto-merge.js — enable GitHub native auto-merge on the PR.
 *
 * Mirrors the v2 `single-story-close.js` finalize call shape: squash strategy, delete
 * the branch on merge. Non-fatal — returns `{ enabled: false, reason }`
 * on any failure so the caller can fall back to the operator-merges-button
 * path.
 *
 * Story #2990 routed the underlying `gh pr merge` call through the
 * `lib/gh-exec.js` facade (the same shim the `providers/github/`
 * gateways use). The `runner` seam is preserved so existing tests can
 * inject a synchronous fake; the default runner delegates to
 * `gh.pr.merge`, which spawns through the classified, typed-error
 * surface instead of a raw `execFileSync('gh', …)` call.
 *
 * Story #4282 made arming robust when the base branch is checked out by a
 * git worktree. The `--delete-branch` flag makes `gh` shell out to local
 * `git` (including a `git checkout <base>`); from a per-Story worktree cwd
 * that collides with the base branch already checked out by the primary
 * worktree (`fatal: '<base>' is already used by worktree`). We now resolve
 * the arm cwd to the **primary worktree root** (which holds the base
 * branch) via `resolveAutoMergeArmCwd`, so `gh`'s local checkout is a
 * no-op. `--delete-branch` is preserved verbatim, so the PR head branch is
 * still deleted on merge without depending on the repo's auto-delete
 * setting. Resolution is non-fatal — it degrades to the original cwd.
 *
 * Story #4681 made the arm survive a LOCAL-ONLY cleanup failure. Against an
 * already-mergeable PR, `gh pr merge --auto --squash --delete-branch` merges
 * immediately and then shells out to local `git` to drop the head branch.
 * When the per-Story worktree still holds `story-<id>`, that local delete
 * fails (`Cannot delete branch 'story-<id>' used by worktree at …`) and `gh`
 * exits non-zero — even though the REMOTE merge already landed. Reporting
 * that as an arm failure sent close's confirm phase straight to
 * `blockOnUnlanded`, flipping a merged Story to a stale `agent::blocked` that
 * only a hand-run `single-story-confirm-merge.js` could undo. The failure is
 * now classified: a local-cleanup-only signature reports the arm as ENABLED
 * with `localCleanupDeferred: true`, so the confirm phase polls the PR
 * (observes MERGED) and the post-land tail reaps the local ref. Every other
 * non-zero exit — a genuinely refused REMOTE merge — keeps the pre-existing
 * `enabled: false` → blocked behaviour verbatim.
 */

import { gh as defaultGh } from '../../../gh-exec.js';
import { resolveAutoMergeArmCwd } from '../../auto-merge-cwd.js';

/**
 * Arm reasons that mean **the operator deliberately owns the merge** — the PR
 * was never armed because it was asked not to be, not because arming failed.
 *
 * The distinction is load-bearing: an un-armed-by-request PR has nothing for
 * close to land, so `resolveWaitForMerge` (`./options.js`) resolves
 * `waitForMerge` to `false` for these reasons and the Story rests at
 * `agent::closing` for the human. Every *other* falsy arm outcome
 * (`pr-number-unparseable`, an `enableAutoMerge` failure) is a genuine fault
 * and still routes through the merge-unlanded block path.
 */
const OPERATOR_MERGE_ARM_REASONS = Object.freeze([
  'disabled-by-flag',
  'disabled-by-policy-strict',
]);

/**
 * @param {string|null|undefined} reason
 * @returns {boolean}
 */
export function isOperatorMergeReason(reason) {
  return OPERATOR_MERGE_ARM_REASONS.includes(reason);
}

/**
 * Signatures of a `gh pr merge --delete-branch` failure whose ONLY casualty
 * is the LOCAL head-branch cleanup that runs *after* the remote merge has
 * already been performed (or auto-merge already armed).
 *
 * Each pattern is emitted by local `git` (or `gh`'s wrapper around it) and
 * names branch DELETION specifically:
 *   - `Cannot delete branch '<name>' used by worktree at …` — `git branch -D`
 *     refusing a ref another worktree has checked out (the Story #4681 report).
 *   - `failed to delete local branch …` — `gh`'s own wrapper wording.
 *
 * Deliberately narrow on two fronts. A genuinely refused REMOTE merge ("Pull
 * request is not mergeable", a required status check, branch protection)
 * matches neither pattern and keeps the existing blocked path. Nor does the
 * bare `fatal: '<base>' is already used by worktree` checkout collision Story
 * #4282 defends against: that one aborts `gh` *before* the branch delete and
 * carries no evidence the merge stands, so it must keep failing the arm.
 */
const LOCAL_CLEANUP_FAILURE =
  /cannot delete branch[^\n]*used by worktree|failed to delete (?:the )?local branch/i;

/**
 * Whether a non-zero `gh pr merge` exit is attributable solely to local
 * branch cleanup, leaving the remote merge/arm itself intact.
 *
 * Module-private on purpose: `enableAutoMergeWith` is the only caller and the
 * only surface worth pinning, so the classification is asserted through it
 * rather than through a test-only export.
 *
 * @param {string|undefined|null} stderr
 * @returns {boolean}
 */
function isLocalCleanupOnlyFailure(stderr) {
  return LOCAL_CLEANUP_FAILURE.test(String(stderr ?? ''));
}

/**
 * Enable GitHub native auto-merge on the PR. Non-fatal.
 *
 * @param {{
 *   cwd: string,
 *   prNumber: number,
 *   gh?: ReturnType<typeof import('../../../gh-exec.js').createGh>,
 *   runner?: (args: string[], opts: object) => ({ status: number, stdout?: string, stderr?: string } | Promise<{ status: number, stdout?: string, stderr?: string }>),
 *   resolveArmCwd?: (cwd: string) => string,
 * }} opts
 * @returns {Promise<{ enabled: boolean, reason?: string, localCleanupDeferred?: boolean }>}
 */
export async function enableAutoMergeWith({
  cwd,
  prNumber,
  gh,
  runner,
  resolveArmCwd = resolveAutoMergeArmCwd,
}) {
  const exec = runner ?? makeDefaultGhAutoMergeRunner(gh ?? defaultGh);
  // Re-point the arm at the base-branch (primary) worktree so gh's
  // `--delete-branch` local `git checkout <base>` cannot collide with the
  // base branch already checked out by the primary worktree (Story #4282).
  const armCwd = resolveArmCwd(cwd);
  try {
    const result = await exec(
      [
        'pr',
        'merge',
        String(prNumber),
        '--auto',
        '--squash',
        '--delete-branch',
      ],
      { cwd: armCwd },
    );
    if (result.status === 0) return { enabled: true };
    const detail = `gh-exit-${result.status}: ${(result.stderr ?? '').trim().slice(0, 200)}`;
    if (isLocalCleanupOnlyFailure(result.stderr)) {
      // The remote side stands; only the local head-branch cleanup failed.
      // Report ENABLED so the confirm phase polls the real PR state instead
      // of blocking a merge that already landed, and flag the deferred
      // cleanup for the land tail's `git branch -D` to finish.
      return { enabled: true, localCleanupDeferred: true, reason: detail };
    }
    return { enabled: false, reason: detail };
  } catch (err) {
    return { enabled: false, reason: `gh-spawn-error: ${err?.message ?? err}` };
  }
}

/**
 * Build the default `gh pr merge` runner that adapts the async
 * `lib/gh-exec.js` facade into the synchronous-looking
 * `{ status, stdout, stderr }` envelope `enableAutoMergeWith` consumes.
 *
 * The adapter swallows non-zero exits (mapping the typed `GhExecError`
 * carrier back to its `code` + `stderr`) because auto-merge enablement
 * is intentionally non-fatal — the caller treats failures as "operator
 * merges manually".
 */
function makeDefaultGhAutoMergeRunner(gh) {
  return async function defaultGhAutoMergeRunner(args, _opts) {
    // `args` always starts with `pr merge <prNumber>` — pass everything
    // after the third element to `gh.pr.merge` as flags so the facade
    // owns the `gh pr merge <id> …` argv assembly.
    const [, , prIdStr, ...flags] = args;
    try {
      const result = await gh.pr.merge(prIdStr, flags);
      return {
        status: 0,
        stdout: result?.stdout ?? '',
        stderr: result?.stderr ?? '',
      };
    } catch (err) {
      // Duck-type: any error carrying a numeric `.code` (or `.status`,
      // which the legacy `execFileSync` shim used) + an optional
      // `.stderr` is mapped back to the `{ status, stdout, stderr }`
      // envelope `enableAutoMergeWith` consumes. The typed
      // `GhExecError` carriers from `lib/gh-exec.js` already fit this
      // shape; bare `Error`s without a code fall through to the spawn-
      // error reason in the parent catch.
      const numericCode =
        typeof err?.code === 'number'
          ? err.code
          : typeof err?.status === 'number'
            ? err.status
            : null;
      if (numericCode !== null) {
        return {
          status: numericCode,
          stdout:
            typeof err.stdout === 'string'
              ? err.stdout
              : (err.stdout?.toString?.() ?? ''),
          stderr:
            typeof err.stderr === 'string'
              ? err.stderr
              : (err.stderr?.toString?.() ?? String(err?.message ?? err)),
        };
      }
      throw err;
    }
  };
}

/**
 * Dispatch auto-merge enablement based on `--no-auto-merge`, an
 * unparseable PR number, or a `gh` failure. Returns the structured
 * `{ autoMergeEnabled, autoMergeReason }` pair the result envelope needs.
 *
 * @param {{
 *   cwd: string,
 *   prNumber: number|null,
 *   prUrl: string,
 *   noAutoMerge: boolean,
 *   autoMergePolicy?: 'trust-ci'|'strict',
 *   gh?: ReturnType<typeof import('../../../gh-exec.js').createGh>,
 *   progress: (tag: string, msg: string) => void,
 * }} args
 * @returns {Promise<{ autoMergeEnabled: boolean, autoMergeReason: string|null, localCleanupDeferred?: boolean }>}
 *   `localCleanupDeferred` is true when the arm stands but `gh`'s local
 *   head-branch delete failed (Story #4681) — the land tail owns the reap.
 */
export async function runAutoMergePhase({
  cwd,
  prNumber,
  prUrl,
  noAutoMerge,
  autoMergePolicy = 'trust-ci',
  gh,
  progress,
}) {
  if (noAutoMerge) {
    progress('PR', '⏭  Auto-merge disabled (--no-auto-merge).');
    return { autoMergeEnabled: false, autoMergeReason: 'disabled-by-flag' };
  }
  // `delivery.ci.autoMerge: "strict"` opts standalone Stories out of
  // auto-merge (parallel to the Epic path's strict predicate): the PR opens
  // and waits for an operator merge instead of arming native auto-merge.
  // The default `"trust-ci"` keeps arming on green required CI — GitHub's
  // native `--auto` is the required-check gate, so no client-side predicate
  // is needed here (unlike the Epic path, which gates on local
  // audit/review/retro signals a standalone Story does not produce).
  if (autoMergePolicy === 'strict') {
    progress(
      'PR',
      '⏭  Auto-merge skipped (delivery.ci.autoMerge="strict") — operator merges.',
    );
    return {
      autoMergeEnabled: false,
      autoMergeReason: 'disabled-by-policy-strict',
    };
  }
  if (prNumber == null) {
    progress(
      'PR',
      `⚠️ Auto-merge skipped: could not parse PR number from URL ${prUrl}.`,
    );
    return {
      autoMergeEnabled: false,
      autoMergeReason: 'pr-number-unparseable',
    };
  }
  const result = await enableAutoMergeWith({ cwd, prNumber, gh });
  if (result.enabled) {
    if (result.localCleanupDeferred) {
      // Warning, never a block (Story #4681): the merge/arm stands and the
      // land tail reaps the local ref once the worktree releases it.
      progress(
        'PR',
        `⚠️ Auto-merge armed on PR #${prNumber}, but gh's LOCAL branch cleanup failed ` +
          `(${result.reason}) — deferring the local ref reap to the land tail; the merge stands.`,
      );
      return {
        autoMergeEnabled: true,
        autoMergeReason: null,
        localCleanupDeferred: true,
      };
    }
    progress(
      'PR',
      `✅ Auto-merge enabled on PR #${prNumber} (squash, delete-branch).`,
    );
    return {
      autoMergeEnabled: true,
      autoMergeReason: null,
      localCleanupDeferred: false,
    };
  }
  progress(
    'PR',
    `⚠️ Auto-merge enablement failed (${result.reason}) — operator can merge manually.`,
  );
  return {
    autoMergeEnabled: false,
    autoMergeReason: result.reason,
    localCleanupDeferred: false,
  };
}
