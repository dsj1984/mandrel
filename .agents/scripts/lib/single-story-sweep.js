/**
 * single-story-sweep.js — Sweep merged `story-*` branches at init.
 *
 * Wraps `git-cleanup.js` with a fixed policy tuned for the
 * `/single-story-execute` boot path:
 *
 *   - Scope: `story-*` only (never touches `epic/*`, `story/<id>/*`, etc.).
 *   - Mode:  --execute --remote (delete local + origin + prune trackers).
 *   - Skip:  the current run's `storyBranch` is always excluded, even if a
 *            stale PR for the same id were already merged.
 *   - Errors are caught and surfaced in the envelope. The caller MUST NOT
 *            propagate sweep failures — story init proceeds either way.
 *
 * Re-exports the same `planCleanup` / `executeCleanup` injection seams so
 * tests can stub git/`gh` without touching the CLI.
 */

import {
  buildGlobFilter,
  executeCleanup as defaultExecuteCleanup,
  planCleanup as defaultPlanCleanup,
} from '../git-cleanup.js';

const STORY_BRANCH_INCLUDE = 'story-*';

/**
 * Sweep merged `story-*` branches in `cwd`.
 *
 * @param {{
 *   cwd: string,
 *   baseBranch: string,
 *   currentStoryBranch: string,
 *   logger?: { info?: (m: string) => void, warn?: (m: string) => void },
 *   planCleanupFn?: typeof defaultPlanCleanup,
 *   executeCleanupFn?: typeof defaultExecuteCleanup,
 * }} args
 * @returns {{
 *   ok: boolean,
 *   skipped: boolean,
 *   candidates: number,
 *   localDeleted: number,
 *   remoteDeleted: number,
 *   failures: Array<{ branch: string|null, scope: string, stderr?: string }>,
 *   error?: string,
 * }}
 */
export function sweepMergedStoryBranches({
  cwd,
  baseBranch,
  currentStoryBranch,
  logger = {},
  planCleanupFn = defaultPlanCleanup,
  executeCleanupFn = defaultExecuteCleanup,
} = {}) {
  const log = {
    info: typeof logger.info === 'function' ? logger.info : () => {},
    warn: typeof logger.warn === 'function' ? logger.warn : () => {},
  };

  if (typeof cwd !== 'string' || cwd.length === 0) {
    return zeroResult({ error: 'cwd is required' });
  }
  if (typeof baseBranch !== 'string' || baseBranch.length === 0) {
    return zeroResult({ error: 'baseBranch is required' });
  }

  // Exclude the current story branch. `currentStoryBranch` may be absent
  // when the caller is sweeping outside an init context (e.g. tests).
  const exclude =
    typeof currentStoryBranch === 'string' && currentStoryBranch.length > 0
      ? [currentStoryBranch]
      : [];
  const filter = buildGlobFilter({
    include: [STORY_BRANCH_INCLUDE],
    exclude,
  });

  let plan;
  try {
    plan = planCleanupFn({ cwd, baseBranch, filter });
  } catch (err) {
    const msg = err?.message ?? String(err);
    log.warn(`[single-story-sweep] plan failed: ${msg}`);
    return zeroResult({ error: `plan: ${msg}` });
  }

  if (plan.candidates.length === 0) {
    log.info('[single-story-sweep] no merged story branches to reap.');
    return {
      ok: true,
      skipped: false,
      candidates: 0,
      localDeleted: 0,
      remoteDeleted: 0,
      failures: [],
    };
  }

  let result;
  try {
    result = executeCleanupFn({
      candidates: plan.candidates,
      cwd,
      remote: true,
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    log.warn(`[single-story-sweep] execute failed: ${msg}`);
    return {
      ok: false,
      skipped: false,
      candidates: plan.candidates.length,
      localDeleted: 0,
      remoteDeleted: 0,
      failures: [{ branch: null, scope: 'execute', stderr: msg }],
      error: `execute: ${msg}`,
    };
  }

  const localDeleted = result.local.filter((r) => r.ok).length;
  const remoteDeleted = result.remote.filter((r) => r.ok).length;
  const summary = `${localDeleted} local + ${remoteDeleted} remote`;
  if (result.ok) {
    log.info(`[single-story-sweep] reaped ${summary}.`);
  } else {
    log.warn(
      `[single-story-sweep] reaped ${summary} with ${result.failures.length} failure(s) — init continues.`,
    );
  }

  return {
    ok: result.ok,
    skipped: false,
    candidates: plan.candidates.length,
    localDeleted,
    remoteDeleted,
    failures: result.failures,
  };
}

function zeroResult({ error }) {
  return {
    ok: false,
    skipped: true,
    candidates: 0,
    localDeleted: 0,
    remoteDeleted: 0,
    failures: [],
    error,
  };
}
