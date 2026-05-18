/**
 * phases/branch-restore.js — capture + restore the main-repo's starting
 * branch around the merge-lock-protected close (Story #2138 / #2141; moved
 * into the phases pipeline by Story #2460, Epic #2453).
 *
 * The orchestrator captures the starting branch BEFORE entering the
 * merge lock and runs `restoreStartingBranch` in a `finally` block, so
 * any throw inside `runStoryCloseLocked` leaves the operator on the
 * branch they came in on rather than stranded mid-rebase / mid-merge.
 *
 * Public surface:
 *   - captureStartingBranch(cwd, deps?)    ← exported (story-close.js re-export)
 *   - restoreStartingBranch(opts, deps?)   ← exported (story-close.js re-export)
 */

import { gitSpawn as defaultGitSpawn } from '../../../git-utils.js';
import { Logger } from '../../../Logger.js';

/**
 * Capture the main-repo's current branch name before `runStoryCloseLocked`
 * runs. Returns `{ ok: true, branch }` on success, `{ ok: false, reason }`
 * when HEAD is detached or `git rev-parse` fails.
 *
 * @param {string} cwd
 * @param {{ gitSpawn?: typeof defaultGitSpawn }} [deps]
 * @returns {{ ok: true, branch: string } | { ok: false, reason: string }}
 */
export function captureStartingBranch(cwd, deps = {}) {
  const gitSpawn = deps.gitSpawn ?? defaultGitSpawn;
  const res = gitSpawn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (res.status !== 0) {
    return {
      ok: false,
      reason: `rev-parse-failed: ${res.stderr || 'unknown'}`,
    };
  }
  const branch = (res.stdout || '').trim();
  if (!branch || branch === 'HEAD') {
    return { ok: false, reason: 'detached-head' };
  }
  return { ok: true, branch };
}

/**
 * Restore the main-repo to `startingBranch` via `git switch`. Refuses the
 * switch when the destination tree is dirty (`git status --porcelain` is
 * non-empty). Never invokes `git reset --hard` or `git checkout --force`.
 *
 * Returns a structured envelope so callers (and tests) can assert which
 * branch they end up on and why.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {{ ok: boolean, branch?: string, reason?: string }} opts.captured
 * @param {{ gitSpawn?: typeof defaultGitSpawn, logger?: object }} [deps]
 * @returns {{ restored: boolean, branch?: string, reason?: string, skipped?: boolean }}
 */
export function restoreStartingBranch({ cwd, captured }, deps = {}) {
  const gitSpawn = deps.gitSpawn ?? defaultGitSpawn;
  const log = deps.logger ?? Logger;
  if (!captured || captured.ok !== true) {
    return {
      restored: false,
      skipped: true,
      reason: captured?.reason
        ? `no-starting-branch: ${captured.reason}`
        : 'no-starting-branch',
    };
  }
  const { branch } = captured;
  const currentRes = gitSpawn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (currentRes.status === 0 && currentRes.stdout.trim() === branch) {
    return { restored: true, branch, reason: 'already-on-branch' };
  }
  const statusRes = gitSpawn(cwd, 'status', '--porcelain');
  if (statusRes.status !== 0) {
    log.warn?.(
      `[story-close] branch-restore: \`git status --porcelain\` failed in ${cwd}: ${statusRes.stderr || 'unknown'}`,
    );
    return {
      restored: false,
      branch,
      reason: `status-failed: ${statusRes.stderr || 'unknown'}`,
    };
  }
  if (statusRes.stdout.length > 0) {
    log.error?.(
      `[story-close] branch-restore: refusing to switch to \`${branch}\` — working tree is dirty in ${cwd}. ` +
        `Resolve the local changes manually, then \`git switch ${branch}\`.`,
    );
    return { restored: false, branch, reason: 'dirty-tree' };
  }
  const switchRes = gitSpawn(cwd, 'switch', branch);
  if (switchRes.status !== 0) {
    log.warn?.(
      `[story-close] branch-restore: \`git switch ${branch}\` failed: ${switchRes.stderr || 'unknown'}`,
    );
    return {
      restored: false,
      branch,
      reason: `switch-failed: ${switchRes.stderr || 'unknown'}`,
    };
  }
  return { restored: true, branch };
}
