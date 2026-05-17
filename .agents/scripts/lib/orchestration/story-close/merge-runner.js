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
 * `PushRetryConflictError` → throw envelope, plus the retry-exhausted /
 * generic-failure → throw envelope used by `runFinalizeMerge`. The resume
 * path (`runResumeMerge`) shares the same envelope but routes generic
 * failures through the `describeResumePushFailure` helper for consistent
 * operator-facing copy (see `comment-bodies.js`). Errors thrown from these
 * helpers reach the `runAsCli` boundary in `story-close.js` and are mapped
 * to `process.exit(1)` (Story #959 — orchestration scripts must throw
 * rather than route through the logger's fatal sink, see
 * `.agents/instructions.md`).
 *
 * Both helpers are dependency-injected: the lock acquire/release pair and
 * the push retry runner are parameters so unit tests can pin behaviour
 * without spawning the close script. Default arguments point at the
 * production wiring from `lib/epic-merge-lock.js` + `lib/push-epic-retry.js`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getRunners as defaultGetRunners } from '../../config/runners.js';
import { resolveWorkingPath } from '../../config-resolver.js';
import {
  acquireEpicMergeLock as defaultAcquire,
  releaseEpicMergeLock as defaultRelease,
  resolveGitCommonDir,
} from '../../epic-merge-lock.js';
import { mergeFeatureBranch } from '../../git-merge-orchestrator.js';
import {
  gitSpawn as defaultGitSpawn,
  gitSync as defaultGitSync,
} from '../../git-utils.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import {
  pushEpicWithRetry as defaultPushEpicWithRetry,
  PushRetryConflictError,
} from '../../push-epic-retry.js';
import {
  buildResumeMergeCommitMsg,
  describeResumePushFailure,
} from './comment-bodies.js';

/**
 * Render the lock-file path for a given main-repo `cwd` + `epicId`. Pure;
 * exported so the operator-facing error message stays a single source of
 * truth.
 */
export function lockPathDisplay(cwd, epicId) {
  return path.join(resolveGitCommonDir(cwd), `epic-${epicId}.merge.lock`);
}

/**
 * Best-effort `story.blocked` lifecycle emit (Story #2241 / Task #2247).
 * Used by the merge runner's failure paths to surface a typed `reason`
 * on the bus before re-throwing. The bus is optional — every legacy
 * caller and the existing unit fixtures pass `null` — and emit failures
 * are swallowed so the original throw (which the operator must see)
 * always reaches `runAsCli`.
 *
 * Exported so the wider story-close path (and the spawn-timeout helper
 * in `story-close.js`) can use the same low-friction wrapper.
 *
 * @param {{
 *   bus?: object|null,
 *   storyId: number|string,
 *   reason: string,
 *   logger?: { warn?: Function },
 * }} args
 * @returns {Promise<void>}
 */
export async function emitStoryBlockedSafe({ bus, storyId, reason, logger }) {
  if (!bus) return;
  try {
    await bus.emit('story.blocked', {
      storyId: Number(storyId),
      reason: String(reason),
    });
  } catch (err) {
    logger?.warn?.(
      `[story-close] ⚠️ story.blocked emit failed for #${storyId} (swallowed): ${err?.message ?? err}`,
    );
  }
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
 * generic failure modes by throwing an `Error` (Story #959 — see file
 * header). Used by both `runFinalizeMerge` (post-merge push) and
 * `runResumeMerge` (resume-after-conflict push).
 *
 * The two callers diverge only on how they format generic-failure copy:
 *   - finalize path inlines the `retries-exhausted vs other-reason` switch
 *     directly,
 *   - resume path routes through `describeResumePushFailure`.
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
      storyMergeRetry: getRunners(orchestration).storyMergeRetry,
      git,
      log,
    });
  } catch (err) {
    if (err instanceof PushRetryConflictError) {
      throw new Error(err.message);
    }
    throw err;
  }

  if (!pushOutcome.ok) {
    if (mode === 'resume') {
      const fatal = describeResumePushFailure(pushOutcome);
      if (fatal) throw new Error(fatal);
    } else {
      const reasonLabel =
        pushOutcome.reason === 'retry-exhausted'
          ? `retries exhausted after ${pushOutcome.attempts} attempt(s)`
          : pushOutcome.reason;
      throw new Error(
        `Push failed (${reasonLabel}): ${pushOutcome.result?.stderr || pushOutcome.result?.stdout || 'unknown'}`,
      );
    }
  }
  return pushOutcome;
}

// ---------------------------------------------------------------------------
// Story-close merge orchestration
// ---------------------------------------------------------------------------
//
// `runFinalizeMerge` and `runResumeMerge` previously lived inline in
// `story-close.js`. They both take the per-Epic merge lock, then either
// rebase + merge + push (finalize path) or commit-the-pending-merge + push
// (resume path). Extracted from story-close.js (Story #956, Theme A finishing
// touch) so the close orchestrator becomes a thin CLI shell. Both helpers
// take the same dependency-injection seams as withEpicMergeLock /
// pushEpicAndHandleConflicts so tests can pin behaviour without spawning
// the script.

/**
 * Pre-merge rebase of the Story branch onto `origin/<epicBranch>`.
 *
 * Parallel wave execution lets two Stories land on the Epic between the time
 * a later Story branched off and the time it closes. Rebasing the Story on
 * the latest Epic before the close-merge shrinks the conflict surface to the
 * Story's real delta and lets `mergeFeatureBranch`'s minor-conflict auto-
 * resolve apply surgically instead of against stale base content.
 *
 * Runs inside the per-story worktree so it does not disturb the main
 * checkout. On any failure (fetch error, rebase conflict) the rebase is
 * aborted and the caller falls through to the plain merge path, which will
 * surface the same conflict via triage.
 *
 * @returns {{ rebased: boolean, reason?: string }}
 */
function resolveStoryWorktreePath({ orchestration, storyId, repoRoot }) {
  const wtConfig = orchestration?.worktreeIsolation;
  if (!wtConfig?.enabled) return { reason: 'isolation-disabled' };
  const wtPath = resolveWorkingPath({
    worktreeEnabled: true,
    repoRoot,
    storyId,
    worktreeRoot: wtConfig.root,
  });
  if (!fs.existsSync(wtPath)) return { reason: 'worktree-missing' };
  return { wtPath };
}

function runFetchOrigin({ wtPath, epicBranch, log, gitSpawn }) {
  const fetch = gitSpawn(wtPath, 'fetch', 'origin', epicBranch);
  if (fetch.status === 0) return true;
  log('GIT', `⚠️ fetch origin ${epicBranch} failed; skipping pre-merge rebase`);
  return false;
}

function runRebaseAndAbortOnConflict({ wtPath, epicBranch, log, gitSpawn }) {
  const rebase = gitSpawn(wtPath, 'rebase', `origin/${epicBranch}`);
  if (rebase.status === 0) return true;
  gitSpawn(wtPath, 'rebase', '--abort');
  log('GIT', '⚠️ rebase conflicted; aborted — merge triage will handle overlap');
  return false;
}

export function rebaseStoryOnEpic({
  orchestration,
  storyId,
  epicBranch,
  storyBranch,
  repoRoot,
  log = () => {},
  gitSpawn = defaultGitSpawn,
}) {
  const wt = resolveStoryWorktreePath({ orchestration, storyId, repoRoot });
  if (!wt.wtPath) return { rebased: false, reason: wt.reason };
  const { wtPath } = wt;

  log('GIT', `Rebasing ${storyBranch} onto origin/${epicBranch}...`);
  if (!runFetchOrigin({ wtPath, epicBranch, log, gitSpawn })) {
    return { rebased: false, reason: 'fetch-failed' };
  }
  if (!runRebaseAndAbortOnConflict({ wtPath, epicBranch, log, gitSpawn })) {
    return { rebased: false, reason: 'rebase-conflict' };
  }
  log('GIT', `✅ Rebased ${storyBranch} onto origin/${epicBranch}`);
  return { rebased: true };
}

/**
 * Run the finalize-path merge: optional rebase, checkout + pull --rebase,
 * merge --no-ff, push (with retry/conflict handling). Branch cleanup is
 * deferred to after worktree reap (git refuses to delete a branch still
 * checked out by a worktree).
 *
 * The caller (story-close.js) holds the per-Epic merge lock across the
 * entire close flow, so this helper no longer acquires it itself.
 *
 * @param {{
 *   epicBranch: string,
 *   storyBranch: string,
 *   storyTitle: string,
 *   storyId: number|string,
 *   epicId: number|string,
 *   cwd: string,
 *   orchestration: object,
 *   log?: (tag: string, msg: string) => void,
 *   logger?: { error: (msg: string) => void },
 *   gitSync?: typeof defaultGitSync,
 *   gitSpawn?: typeof defaultGitSpawn,
 * }} opts
 */
function buildMergeMessage(storyTitle, storyId) {
  return `feat: ${storyTitle.charAt(0).toLowerCase() + storyTitle.slice(1)} (resolves #${storyId})`;
}

function buildVerboseMergeLogger(logger) {
  return (_level, _ctx, msg, meta) => {
    const tail = meta ? ` ${JSON.stringify(meta)}` : '';
    logger.error(`[merge] ${msg}${tail}`);
  };
}

function throwOnMajorConflict({ result, epicBranch }) {
  if (result.merged || !result.major) return;
  throw new Error(
    `Major merge conflict on story close: ` +
      `${result.conflicts.files} file(s), ${result.conflicts.lines} marker(s). ` +
      `Conflicting files: ${result.conflicts.fileList.join(', ')}. ` +
      `Merge has been aborted. Resolve manually on ${epicBranch}, then ` +
      `re-run this script.`,
  );
}

function logMergeOutcome({ result, log }) {
  if (!result.autoResolved) {
    log('GIT', '✅ Merge successful');
    return;
  }
  log(
    'GIT',
    `✅ Merge completed with auto-resolved minor conflicts ` +
      `(${result.conflicts.files} file(s) resolved to theirs)`,
  );
  for (const f of result.autoResolvedFiles ?? []) {
    log(
      'GIT',
      `  ↳ auto-resolved ${f.file} (${f.discardedLines} base line(s) discarded; trailer in merge commit)`,
    );
  }
}

export async function runFinalizeMerge({
  epicBranch,
  storyBranch,
  storyTitle,
  storyId,
  epicId: _epicId,
  cwd,
  orchestration,
  bus = null,
  log = () => {},
  logger = DefaultLogger,
  gitSync = defaultGitSync,
  gitSpawn = defaultGitSpawn,
}) {
  rebaseStoryOnEpic({
    orchestration,
    storyId,
    epicBranch,
    storyBranch,
    repoRoot: cwd,
    log,
    gitSpawn,
  });

  log('GIT', `Checking out ${epicBranch}...`);
  gitSync(cwd, 'checkout', epicBranch);
  gitSpawn(cwd, 'pull', '--rebase', 'origin', epicBranch);

  log('GIT', `Merging ${storyBranch} into ${epicBranch} (--no-ff)...`);
  const result = mergeFeatureBranch(
    cwd,
    storyBranch,
    buildVerboseMergeLogger(logger),
    { message: buildMergeMessage(storyTitle, storyId) },
  );

  // Story #2241 / Task #2247 — surface a `story.blocked` lifecycle emit
  // on the typed merge-failure paths before re-throwing so the bus
  // ledger (and any subscribed BlockerHandler listener) sees the
  // typed reason. The emit is best-effort; the throw is the canonical
  // signal that the close was halted.
  try {
    throwOnMajorConflict({ result, epicBranch });
  } catch (err) {
    await emitStoryBlockedSafe({
      bus,
      storyId,
      reason: 'merge-conflict:major',
      logger,
    });
    throw err;
  }
  logMergeOutcome({ result, log });

  log('GIT', `Pushing ${epicBranch}...`);
  let pushOutcome;
  try {
    pushOutcome = await pushEpicAndHandleConflicts({
      cwd,
      epicBranch,
      storyBranch,
      orchestration,
      log: (msg) => log('GIT', msg),
      mode: 'finalize',
    });
  } catch (err) {
    await emitStoryBlockedSafe({
      bus,
      storyId,
      reason: 'push-failed:finalize',
      logger,
    });
    throw err;
  }
  if (pushOutcome.attempts > 1) {
    log(
      'GIT',
      `✅ Push succeeded on attempt ${pushOutcome.attempts} after sibling session landed on ${epicBranch}`,
    );
  }
}

/**
 * Commit a pending in-progress merge (resume path) using the
 * conventional-commit subject from `buildResumeMergeCommitMsg`. No-op when
 * `.git/MERGE_HEAD` is absent (merge already committed by the operator).
 */
function isMergePending(cwd) {
  return fs.existsSync(path.join(cwd, '.git', 'MERGE_HEAD'));
}

function commitPendingMerge({ cwd, storyTitle, storyId, gitSpawn }) {
  return gitSpawn(
    cwd,
    'commit',
    '--no-verify',
    '-m',
    buildResumeMergeCommitMsg(storyTitle, storyId),
  );
}

export function finalizeMergeIfPending({
  cwd,
  epicBranch,
  storyBranch,
  storyTitle,
  storyId,
  log = () => {},
  gitSpawn = defaultGitSpawn,
}) {
  if (!isMergePending(cwd)) {
    log(
      'GIT',
      '⚠️ No MERGE_HEAD found — merge already committed; proceeding to push',
    );
    return;
  }
  log('GIT', 'Finalizing in-progress merge (git commit --no-verify)');
  const commit = commitPendingMerge({ cwd, storyTitle, storyId, gitSpawn });
  if (commit.status !== 0) {
    throw new Error(
      `Failed to finalize merge commit: ${commit.stderr || commit.stdout || 'unknown'}. ` +
        `Check that all conflicts are resolved and staged on ${epicBranch}.`,
    );
  }
  log('GIT', `✅ Merge of ${storyBranch} finalized on ${epicBranch}`);
}

/**
 * Run the resume-path merge: finalize the in-progress merge (if any), then
 * push. Used by `runStoryClose` when prior state is `partial-merge`. The
 * caller holds the per-Epic merge lock across the entire close flow.
 */
export async function runResumeMerge({
  cwd,
  epicBranch,
  storyBranch,
  storyTitle,
  storyId,
  epicId: _epicId,
  orchestration,
  bus = null,
  logger = DefaultLogger,
  log = () => {},
  gitSpawn = defaultGitSpawn,
}) {
  try {
    finalizeMergeIfPending({
      cwd,
      epicBranch,
      storyBranch,
      storyTitle,
      storyId,
      log,
      gitSpawn,
    });
  } catch (err) {
    await emitStoryBlockedSafe({
      bus,
      storyId,
      reason: 'merge-finalize-failed:resume',
      logger,
    });
    throw err;
  }
  log('GIT', `Pushing ${epicBranch}...`);
  try {
    await pushEpicAndHandleConflicts({
      cwd,
      epicBranch,
      storyBranch,
      orchestration,
      log: (msg) => log('GIT', msg),
      mode: 'resume',
    });
  } catch (err) {
    await emitStoryBlockedSafe({
      bus,
      storyId,
      reason: 'push-failed:resume',
      logger,
    });
    throw err;
  }
}
