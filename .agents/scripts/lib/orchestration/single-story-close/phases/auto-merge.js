/**
 * phases/auto-merge.js — enable GitHub native auto-merge on the PR.
 *
 * Mirrors the epic-deliver finalize call shape: squash strategy, delete
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
 */

import { gh as defaultGh } from '../../../gh-exec.js';
import { resolveAutoMergeArmCwd } from '../../auto-merge-cwd.js';

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
 * @returns {Promise<{ enabled: boolean, reason?: string }>}
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
    return {
      enabled: false,
      reason: `gh-exit-${result.status}: ${(result.stderr ?? '').trim().slice(0, 200)}`,
    };
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
 * @returns {Promise<{ autoMergeEnabled: boolean, autoMergeReason: string|null }>}
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
    progress(
      'PR',
      `✅ Auto-merge enabled on PR #${prNumber} (squash, delete-branch).`,
    );
    return { autoMergeEnabled: true, autoMergeReason: null };
  }
  progress(
    'PR',
    `⚠️ Auto-merge enablement failed (${result.reason}) — operator can merge manually.`,
  );
  return { autoMergeEnabled: false, autoMergeReason: result.reason };
}
