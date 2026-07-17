/**
 * Active-Story env-var propagation (Epic #1030 Story #1043 / Task #1061).
 *
 * The PreToolUse / PostToolUse trace hook in
 * `lib/observability/tool-trace-hook.js` resolves the active Story from
 * `process.env.CC_STORY_ID`. This module is the single writer/clearer of
 * that var:
 *
 *   - `setActiveStoryEnv({ storyId, workCwd })` is called from
 *     `single-story-init.js` after the worktree is materialised. It sets the
 *     var on the current `process.env` (so any child commands the
 *     orchestrator spawns inherit it) and exports it to a sibling
 *     `.env.local` inside the worktree. The harness re-spawns the
 *     agent with that file's contents loaded, so the trace hook fires
 *     with the right ids on the *next* tool call after init returns.
 *
 *   - `clearActiveStoryEnv({ workCwd })` is called from
 *     `story-close/post-merge-close.js` after the merge lands. It
 *     deletes the env vars from `process.env` and removes the
 *     `.env.local` file. Tooling invoked outside an active Story —
 *     planning, dispatch, ad-hoc CLI — must NOT pollute random
 *     `traces.ndjson` files; the hook's no-op contract relies on the
 *     vars being absent at that point.
 *
 * Both functions are best-effort and never throw on fs failures. The
 * trace hook is itself best-effort, so a stale `.env.local` would at
 * worst cause one extra trace line to land in a stale `temp/.../`
 * directory — annoying but not a correctness bug. We log warnings via
 * the caller's logger when provided.
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';

const ENV_LOCAL_BASENAME = '.env.local';

/**
 * Names of the env vars we own. Keeping the list central makes the
 * round-trip (set on init, clear on close) trivially auditable —
 * grep `CC_STORY_ID` / `CC_EPIC_ID` to find every read site.
 *
 * `CC_STORY_ID` is the one var this module writes. `CC_EPIC_ID` is retained
 * on the CLEAR path only: v2 has no Epics and nothing here sets it, but
 * `tool-trace-hook.js`'s `resolveActiveStory` still reads it, so wiping it at
 * close keeps the trace path's "no stale context past close" contract honest
 * against a value that leaked in from outside (a pre-upgrade `.env.local` the
 * harness already loaded, or an operator's shell).
 *
 * `CC_SLICE_ID` / `CC_OPERATOR` were removed with the heartbeat substrate:
 * their only writer was the never-called `setActiveSliceEnv` and their only
 * reader the deleted `hook-heartbeat.js`.
 */
export const ACTIVE_STORY_ENV_KEYS = ['CC_EPIC_ID', 'CC_STORY_ID'];

/**
 * Render the `.env.local` body. One `KEY=value` line per var, LF
 * line endings (the harness's dotenv parser tolerates CRLF too but LF
 * keeps the file deterministic across Windows / macOS / Linux).
 *
 * Only `CC_STORY_ID` is emitted: v2 Stories are standalone, so there is no
 * parent Epic to key. The trace hook's no-op contract reads "var absent from
 * env" as the signal, so no `CC_EPIC_ID=` line is written at all — an empty
 * one would set the var to the empty string and change the contract.
 *
 * Exported for testing.
 *
 * @param {{ storyId: number }} input
 * @returns {string}
 */
export function renderActiveStoryEnvFile({ storyId }) {
  return [
    '# Auto-managed by .agents/scripts/lib/observability/active-story-env.js',
    '# Re-generated on every story-init; deleted on story-close.',
    `CC_STORY_ID=${storyId}`,
    '',
  ].join('\n');
}

/**
 * Set `CC_STORY_ID` on the current process and (when `workCwd` is provided)
 * export it to `<workCwd>/.env.local`.
 *
 * Idempotent: re-running with the same id is a no-op on disk; with a
 * different id the `.env.local` is overwritten.
 *
 * v2 Stories are standalone — there is no parent Epic — so `CC_EPIC_ID` is
 * never set, and any pre-existing value is removed: the trace hook's
 * `resolveActiveStory` no-op contract is keyed on the var's absence, and a
 * stale epic id would key this Story's traces to a foreign Epic directory.
 *
 * @param {{ storyId: number, workCwd?: string,
 *           env?: NodeJS.ProcessEnv, fs?: typeof nodeFs,
 *           logger?: { warn?: (m: string) => void } }} args
 * @returns {{ envSet: boolean, fileWritten: boolean, filePath: string|null }}
 */
export function setActiveStoryEnv({
  storyId,
  workCwd,
  env = process.env,
  fs = nodeFs,
  logger,
} = {}) {
  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new Error(
      `[active-story-env] storyId must be a positive integer; got ${storyId}`,
    );
  }

  if ('CC_EPIC_ID' in env) delete env.CC_EPIC_ID;
  env.CC_STORY_ID = String(storyId);

  let fileWritten = false;
  let filePath = null;
  if (typeof workCwd === 'string' && workCwd.length > 0) {
    filePath = nodePath.join(workCwd, ENV_LOCAL_BASENAME);
    try {
      fs.writeFileSync(filePath, renderActiveStoryEnvFile({ storyId }), {
        encoding: 'utf8',
      });
      fileWritten = true;
    } catch (err) {
      logger?.warn?.(
        `[active-story-env] Failed to write ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { envSet: true, fileWritten, filePath };
}

/**
 * Delete `CC_EPIC_ID` / `CC_STORY_ID` from the current process env and
 * remove `<workCwd>/.env.local` when present. Best-effort; a missing
 * file is not an error.
 *
 * @param {{ workCwd?: string, env?: NodeJS.ProcessEnv,
 *           fs?: typeof nodeFs,
 *           logger?: { warn?: (m: string) => void } }} args
 * @returns {{ envCleared: boolean, fileRemoved: boolean, filePath: string|null }}
 */
export function clearActiveStoryEnv({
  workCwd,
  env = process.env,
  fs = nodeFs,
  logger,
} = {}) {
  for (const k of ACTIVE_STORY_ENV_KEYS) {
    if (k in env) delete env[k];
  }

  let fileRemoved = false;
  let filePath = null;
  if (typeof workCwd === 'string' && workCwd.length > 0) {
    filePath = nodePath.join(workCwd, ENV_LOCAL_BASENAME);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        fileRemoved = true;
      }
    } catch (err) {
      logger?.warn?.(
        `[active-story-env] Failed to remove ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { envCleared: true, fileRemoved, filePath };
}
