/**
 * push-epic-retry.js — Bounded retry for concurrent epic-branch pushes.
 *
 * story-close holds a per-Epic filesystem lock for the rebase / merge /
 * push sequence, but that lock is local to one machine. N sprint sessions on
 * different machines (or different Claude Code web workers) will not see each
 * other's lock and can race on `origin/epic/<id>`. Whoever pushes second will
 * be rejected with a non-fast-forward error.
 *
 * This module provides `pushEpicWithRetry`: first push attempt is a direct
 * `git push` — single-session behaviour is byte-identical to pre-change code.
 * Only on a non-fast-forward rejection do we enter the retry loop: fetch the
 * advanced remote, reset local epic onto `origin/<epic>`, reapply the story
 * merge, and retry the push. A real content conflict during re-apply is
 * non-recoverable: we abort the merge (restoring a clean tree) and throw a
 * `PushRetryConflictError` naming the conflicting files.
 */

import { DEFAULT_STORY_MERGE_RETRY } from './config/runners.js';

/**
 * Stderr patterns git emits when `git push` is rejected because the remote
 * tip has advanced beyond our local branch head. Only these patterns trigger
 * a retry; every other push error surfaces immediately so we do not mask
 * permission denials, protected-branch rejections, or network errors behind
 * a retry loop.
 */
const NON_FAST_FORWARD_PATTERNS = [
  /non-fast-forward/i,
  /fetch first/i,
  /failed to push some refs/i,
  /\[rejected\]/,
  /Updates were rejected/i,
];

export function isNonFastForwardPush(stderr) {
  if (!stderr) return false;
  return NON_FAST_FORWARD_PATTERNS.some((p) => p.test(stderr));
}

/**
 * Thrown when the retry loop's re-apply step (`git merge --no-ff story-<id>`
 * onto the freshly-fetched epic tip) hits a real content conflict. The
 * caller should surface this to the operator — we do not attempt automated
 * resolution. The merge is aborted before throwing so the working tree is
 * clean and recoverable.
 */
export class PushRetryConflictError extends Error {
  constructor(conflictFiles, gitStderr) {
    const fileList = conflictFiles.length
      ? conflictFiles.join(', ')
      : '(unknown)';
    super(
      `Content conflict while reapplying story merge onto origin/epic. ` +
        `Conflicting file(s): ${fileList}. ` +
        `The merge has been aborted and the working tree is clean — no ` +
        `half-merged files remain. Resolve manually by rebasing the story ` +
        `branch onto the updated epic, committing, and re-running ` +
        `story-close.\n\n` +
        `git stderr:\n${gitStderr}`,
    );
    this.name = 'PushRetryConflictError';
    this.conflictFiles = conflictFiles;
  }
}

/** Re-apply the story merge during a non-ff retry, optionally pinning the
 * conventional-commit subject so the post-merge `(resolves #N)` grep keeps
 * finding the merge commit (without it, git falls back to its default
 * `Merge branch …` subject and the grep misses). */
function runRetryMerge({ cwd, git, storyBranch, mergeMessage }) {
  return mergeMessage
    ? git.gitSpawn(cwd, 'merge', '--no-ff', '-m', mergeMessage, storyBranch)
    : git.gitSpawn(cwd, 'merge', '--no-ff', '--no-edit', storyBranch);
}

/** Collect the list of files with unmerged paths after a failed merge. */
function collectConflictFiles(cwd, git) {
  const result = git.gitSpawn(cwd, 'diff', '--name-only', '--diff-filter=U');
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Push `epicBranch` with a bounded retry on non-fast-forward rejections.
 *
 * The first attempt is a direct push (no fetch, no reapply) so single-session
 * runs behave identically to the pre-change path. Retries fetch the advanced
 * remote, reset local `<epicBranch>` to `origin/<epicBranch>`, and reapply
 * `<storyBranch>` via `merge --no-ff --no-edit`.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.epicBranch
 * @param {string} opts.storyBranch
 * @param {{ maxAttempts?: number, backoffMs?: number[] }} [opts.storyMergeRetry]
 * @param {{ gitSpawn: (cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string } }} opts.git
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ ok: boolean, attempts: number, reason?: string, result: object }>}
 * @throws {PushRetryConflictError} On content conflict during re-apply.
 */
export async function pushEpicWithRetry({
  cwd,
  epicBranch,
  storyBranch,
  storyMergeRetry,
  git,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
  mergeMessage = null,
}) {
  if (!cwd) throw new Error('pushEpicWithRetry: cwd is required');
  if (!epicBranch) throw new Error('pushEpicWithRetry: epicBranch is required');
  if (!storyBranch)
    throw new Error('pushEpicWithRetry: storyBranch is required');
  if (!git || typeof git.gitSpawn !== 'function') {
    throw new Error('pushEpicWithRetry: git.gitSpawn injection is required');
  }

  const maxAttempts =
    storyMergeRetry?.maxAttempts ?? DEFAULT_STORY_MERGE_RETRY.maxAttempts;
  const backoffMs =
    storyMergeRetry?.backoffMs ?? DEFAULT_STORY_MERGE_RETRY.backoffMs;

  let lastResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = git.gitSpawn(cwd, 'push', '--no-verify', 'origin', epicBranch);
    if (lastResult.status === 0) {
      return { ok: true, attempts: attempt, result: lastResult };
    }

    if (!isNonFastForwardPush(lastResult.stderr)) {
      return {
        ok: false,
        attempts: attempt,
        result: lastResult,
        reason: 'non-retryable-push-error',
      };
    }

    if (attempt === maxAttempts) {
      return {
        ok: false,
        attempts: attempt,
        result: lastResult,
        reason: 'retry-exhausted',
      };
    }

    const backoff = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
    log(
      `[push-epic-retry] Push rejected (non-fast-forward) on attempt ` +
        `${attempt}/${maxAttempts}; fetching remote and reapplying after ` +
        `${backoff}ms backoff.`,
    );
    await sleep(backoff);

    const fetchResult = git.gitSpawn(cwd, 'fetch', 'origin', epicBranch);
    if (fetchResult.status !== 0) {
      return {
        ok: false,
        attempts: attempt,
        result: fetchResult,
        reason: 'fetch-failed',
      };
    }

    const resetResult = git.gitSpawn(
      cwd,
      'reset',
      '--hard',
      `origin/${epicBranch}`,
    );
    if (resetResult.status !== 0) {
      return {
        ok: false,
        attempts: attempt,
        result: resetResult,
        reason: 'reset-failed',
      };
    }

    const mergeResult = runRetryMerge({
      cwd,
      git,
      storyBranch,
      mergeMessage,
    });
    if (mergeResult.status !== 0) {
      const conflicts = collectConflictFiles(cwd, git);
      git.gitSpawn(cwd, 'merge', '--abort');
      throw new PushRetryConflictError(
        conflicts,
        mergeResult.stderr || mergeResult.stdout || '',
      );
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    result: lastResult,
    reason: 'retry-exhausted',
  };
}
