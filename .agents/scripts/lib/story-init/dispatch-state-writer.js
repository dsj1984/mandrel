/**
 * lib/story-init/dispatch-state-writer.js — Story #2535 (Epic #2527).
 *
 * Writes the per-Story dispatch state file at
 * `temp/epic-<epicId>/<storyId>/story-init.state.json` so the host-crash
 * watchdog (`reconcileEpicAgentLabels` in
 * `lib/orchestration/epic-deliver-reconcile.js`) can probe the dispatch
 * PID's liveness and classify Stories as `live` / `dead` / `unknown`.
 *
 * Before this writer existed, every Story that the watchdog inspected
 * classified as `unknown` because no PID was ever recorded. With the
 * writer in place, a Story whose recorded PID has been killed (host
 * crash, OOM, manual `kill`) classifies as `dead` and the reconciler
 * can offer the operator an automatic re-dispatch plan.
 *
 * The state file shape is the canonical contract between this writer
 * and the reconciler reader:
 *
 *   - dispatchPid    : number   — `process.pid` at the time of writing.
 *   - startedAt      : string   — ISO-8601 timestamp.
 *   - branch         : string   — `story-<storyId>` (the checked-out branch).
 *   - worktreePath   : string   — absolute path to the worktree (or main
 *                                 checkout when worktree isolation is off).
 *
 * The writer is idempotent: a second invocation simply overwrites the
 * file with the new caller's PID. This matches the semantics of a Story
 * re-init (recut, branch-recreate) — the most recent dispatch owns the
 * liveness signal.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Compute the canonical state-file path for a given Story.
 *
 * @param {object} args
 * @param {string} args.repoRoot Absolute path to the main repo root (where
 *   `temp/` lives). The state file is intentionally written under the
 *   main repo's `temp/` tree, not the worktree's — the reconciler reads
 *   from there too.
 * @param {number|string} args.epicId
 * @param {number|string} args.storyId
 * @returns {string}
 */
export function dispatchStateFilePath({ repoRoot, epicId, storyId }) {
  return path.join(
    repoRoot,
    'temp',
    `epic-${epicId}`,
    String(storyId),
    'story-init.state.json',
  );
}

/**
 * Build the JSON payload written to the state file. Exported so tests can
 * assert the shape without exercising the filesystem write.
 *
 * @param {object} args
 * @param {number} args.dispatchPid
 * @param {string} args.branch        Story branch name (`story-<storyId>`).
 * @param {string} args.worktreePath  Absolute path to the worktree.
 * @param {string} [args.startedAt]   Optional ISO timestamp; defaults to now.
 * @returns {{dispatchPid:number,startedAt:string,branch:string,worktreePath:string}}
 */
export function buildDispatchStatePayload({
  dispatchPid,
  branch,
  worktreePath,
  startedAt,
}) {
  return {
    dispatchPid,
    startedAt: startedAt ?? new Date().toISOString(),
    branch,
    worktreePath,
  };
}

/**
 * Write the dispatch state file for a Story. Idempotent: overwrites an
 * existing file. Creates the `temp/epic-<id>/<storyId>/` directory tree
 * when missing. Returns the absolute path written so callers (and tests)
 * can assert location.
 *
 * @param {object} args
 * @param {string} args.repoRoot      Absolute path to the main repo root.
 * @param {number} args.epicId
 * @param {number} args.storyId
 * @param {string} args.branch        Story branch name.
 * @param {string} args.worktreePath  Absolute path to the worktree.
 * @param {number} [args.dispatchPid] Defaults to `process.pid`.
 * @param {string} [args.startedAt]   Defaults to `new Date().toISOString()`.
 * @returns {{path:string,payload:object}}
 */
export function writeDispatchStateFile({
  repoRoot,
  epicId,
  storyId,
  branch,
  worktreePath,
  dispatchPid = process.pid,
  startedAt,
}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error(
      '[dispatch-state-writer] repoRoot must be a non-empty string.',
    );
  }
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new Error(
      `[dispatch-state-writer] epicId must be a positive integer (got ${epicId}).`,
    );
  }
  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new Error(
      `[dispatch-state-writer] storyId must be a positive integer (got ${storyId}).`,
    );
  }
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new Error(
      '[dispatch-state-writer] branch must be a non-empty string.',
    );
  }
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    throw new Error(
      '[dispatch-state-writer] worktreePath must be a non-empty string.',
    );
  }

  const filePath = dispatchStateFilePath({ repoRoot, epicId, storyId });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = buildDispatchStatePayload({
    dispatchPid,
    branch,
    worktreePath,
    startedAt,
  });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path: filePath, payload };
}
