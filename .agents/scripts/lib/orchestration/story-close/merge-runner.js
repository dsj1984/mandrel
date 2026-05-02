/**
 * merge-runner.js — collapse the duplicated epic-merge-lock try/finally and
 * the duplicated `pushEpicWithRetry` + `PushRetryConflictError` envelope
 * into two reusable helpers used by both finalizeMerge and
 * completeInProgressMerge.
 *
 * Extracted from story-close.js (Story #955, Theme A part 1) so the close
 * orchestrator becomes a thin CLI shell.
 *
 * `withEpicMergeLock` wraps acquire → user fn → release in a single
 * try/finally with consistent `🔒 Acquired` / `🔓 Released` log lines.
 * Acquisition failure throws a single, operator-actionable Error mentioning
 * the lock-file path so a stale lock can be cleared by hand.
 *
 * `pushEpicAndHandleConflicts` wraps `pushEpicWithRetry` + the
 * `PushRetryConflictError` → fatal-message envelope, plus the
 * retry-exhausted / generic-failure → fatal-message envelope used by
 * finalizeMerge. The resume path (`completeInProgressMerge`) shares the
 * same envelope but routes generic failures through the
 * `describeResumePushFailure` helper for consistent operator-facing copy
 * (see `comment-bodies.js`).
 *
 * Both helpers are dependency-injected: the lock acquire/release pair, the
 * push retry runner, and the logger sink are all parameters so unit tests
 * can pin behaviour without spawning the close script. Default arguments
 * point at the production wiring from
 * `lib/epic-merge-lock.js` + `lib/push-epic-retry.js`.
 */

import path from 'node:path';
import { getRunners as defaultGetRunners } from '../../config/runners.js';
import {
  acquireEpicMergeLock as defaultAcquire,
  releaseEpicMergeLock as defaultRelease,
} from '../../epic-merge-lock.js';
import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import {
  pushEpicWithRetry as defaultPushEpicWithRetry,
  PushRetryConflictError,
} from '../../push-epic-retry.js';
import { describeResumePushFailure } from './comment-bodies.js';

/**
 * Render the lock-file path for a given main-repo `cwd` + `epicId`. Pure;
 * exported so the operator-facing error message stays a single source of
 * truth.
 */
export function lockPathDisplay(cwd, epicId) {
  return path.join(cwd, '.git', `epic-${epicId}.merge.lock`);
}

/**
 * Acquire the per-Epic filesystem merge lock, run `fn(handle)` inside a
 * try/finally, and always release. Logs `🔒 Acquired ...` at acquire and
 * `🔓 Released epic-merge lock` on release via the supplied `log` sink.
 *
 * @template T
 * @param {number|string} epicId
 * @param {{
 *   repoRoot: string,
 *   timeoutMs?: number,
 *   log?: (tag: string, msg: string) => void,
 *   acquire?: typeof defaultAcquire,
 *   release?: typeof defaultRelease,
 * }} opts
 * @param {(handle: object) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withEpicMergeLock(
  epicId,
  {
    repoRoot,
    timeoutMs = 60_000,
    log = () => {},
    acquire = defaultAcquire,
    release = defaultRelease,
  },
  fn,
) {
  log('LOCK', `Acquiring epic-merge lock for epic #${epicId}...`);
  let lockHandle;
  try {
    lockHandle = await acquire(epicId, { repoRoot, timeoutMs });
  } catch (err) {
    throw new Error(
      `Could not acquire epic-merge lock for epic #${epicId}: ${err.message}. ` +
        `Another story closure may be in progress, or a stale lock is present at ` +
        `${lockPathDisplay(repoRoot, epicId)} — inspect and remove it manually if no ` +
        `other process is running.`,
    );
  }
  log('LOCK', `🔒 Acquired ${path.basename(lockHandle.filePath)}`);
  try {
    return await fn(lockHandle);
  } finally {
    release(lockHandle);
    log('LOCK', '🔓 Released epic-merge lock');
  }
}

/**
 * Push the Epic branch with retry, surfacing `PushRetryConflictError` and
 * generic failure modes through the supplied `Logger.fatal` (default:
 * `Logger.fatal`). Used by both `finalizeMerge` (post-merge push) and
 * `completeInProgressMerge` (resume-after-conflict push).
 *
 * The two callers diverge only on how they format generic-failure copy:
 *   - finalizeMerge inlines the `retries-exhausted vs other-reason` switch
 *     directly,
 *   - completeInProgressMerge routes through `describeResumePushFailure`.
 *
 * Pass `mode: 'resume'` to use the resume-style copy.
 *
 * @param {{
 *   cwd: string,
 *   epicBranch: string,
 *   storyBranch: string,
 *   orchestration: object,
 *   log?: (msg: string) => void,
 *   mode?: 'finalize' | 'resume',
 *   logger?: { fatal: (msg: string) => void },
 *   pushEpicWithRetry?: typeof defaultPushEpicWithRetry,
 *   git?: { gitSpawn: typeof defaultGitSpawn },
 *   getCloseRetry?: (orchestration: object) => any,
 * }} opts
 * @returns {Promise<{ ok: boolean, attempts: number, reason?: string, result?: object }>}
 */
export async function pushEpicAndHandleConflicts({
  cwd,
  epicBranch,
  storyBranch,
  orchestration,
  log = () => {},
  mode = 'finalize',
  logger = DefaultLogger,
  pushEpicWithRetry = defaultPushEpicWithRetry,
  git = { gitSpawn: defaultGitSpawn },
  getRunners = defaultGetRunners,
}) {
  let pushOutcome;
  try {
    pushOutcome = await pushEpicWithRetry({
      cwd,
      epicBranch,
      storyBranch,
      closeRetry: getRunners(orchestration).closeRetry,
      git,
      log,
    });
  } catch (err) {
    if (err instanceof PushRetryConflictError) {
      logger.fatal(err.message);
    }
    throw err;
  }

  if (!pushOutcome.ok) {
    if (mode === 'resume') {
      const fatal = describeResumePushFailure(pushOutcome);
      if (fatal) logger.fatal(fatal);
    } else {
      const reasonLabel =
        pushOutcome.reason === 'retry-exhausted'
          ? `retries exhausted after ${pushOutcome.attempts} attempt(s)`
          : pushOutcome.reason;
      logger.fatal(
        `Push failed (${reasonLabel}): ${pushOutcome.result?.stderr || pushOutcome.result?.stdout || 'unknown'}`,
      );
    }
  }
  return pushOutcome;
}
