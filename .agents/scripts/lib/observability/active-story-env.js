/**
 * Active-Story env-var propagation (Epic #1030 Story #1043 / Task #1061).
 *
 * The PreToolUse / PostToolUse trace hook in
 * `lib/observability/tool-trace-hook.js` resolves the active Epic +
 * Story from `process.env.CC_EPIC_ID` and `process.env.CC_STORY_ID`.
 * This module is the single writer/clearer of those vars:
 *
 *   - `setActiveStoryEnv({ epicId, storyId, workCwd })` is called from
 *     `single-story-init.js` after the worktree is materialised. It sets the
 *     vars on the current `process.env` (so any child commands the
 *     orchestrator spawns inherit them) and exports them to a sibling
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
 * grep `CC_EPIC_ID` / `CC_STORY_ID` / `CC_SLICE_ID` to find every read site.
 *
 * Epic #4476 (M5) added `CC_SLICE_ID` (the single-delivery analogue of
 * `CC_STORY_ID` — set on the ONE long guarded session so the PostToolUse
 * hook can emit `slice.heartbeat` off the token stream) and `CC_OPERATOR`
 * (the resolved lease-owner handle, stamped onto hook-emitted heartbeats so
 * `latestHeartbeatForOwner` keeps resolving a live claim). The clear path
 * wipes all four so no stale context leaks past close.
 */
export const ACTIVE_STORY_ENV_KEYS = [
  'CC_EPIC_ID',
  'CC_STORY_ID',
  'CC_SLICE_ID',
  'CC_OPERATOR',
];

/**
 * Render the `.env.local` body. One `KEY=value` line per var, LF
 * line endings (the harness's dotenv parser tolerates CRLF too but LF
 * keeps the file deterministic across Windows / macOS / Linux).
 *
 * Story #2874 — when `epicId === null` (standalone Story, no parent
 * Epic), the `CC_EPIC_ID=` line is omitted entirely. The trace
 * hook's no-op contract reads "var absent from env" as the signal,
 * so emitting an empty `CC_EPIC_ID=` line would set the var to the
 * empty string and change the contract.
 *
 * Exported for testing.
 *
 * @param {{ epicId: number|null, storyId: number }} input
 * @returns {string}
 */
export function renderActiveStoryEnvFile({ epicId, storyId }) {
  const lines = [
    '# Auto-managed by .agents/scripts/lib/observability/active-story-env.js',
    '# Re-generated on every story-init; deleted on story-close.',
  ];
  if (epicId !== null) lines.push(`CC_EPIC_ID=${epicId}`);
  lines.push(`CC_STORY_ID=${storyId}`, '');
  return lines.join('\n');
}

/**
 * Set `CC_EPIC_ID` / `CC_STORY_ID` on the current process and (when
 * `workCwd` is provided) export them to `<workCwd>/.env.local`.
 *
 * Idempotent: re-running with the same ids is a no-op on disk; with
 * different ids the `.env.local` is overwritten.
 *
 * Story #2874 — `epicId: null` is the standalone-Story sentinel.
 * When passed:
 *   - `CC_EPIC_ID` is removed from `env` (the var MUST NOT be set
 *     to an empty string — the trace hook's `resolveActiveStory`
 *     no-op contract is keyed on the var's absence).
 *   - The rendered `.env.local` omits the `CC_EPIC_ID=` line.
 *   - `CC_STORY_ID` behaviour is unchanged.
 * All other invalid `epicId` values (`0`, negative, NaN, non-integer)
 * still throw — `null` is the only standalone signal.
 *
 * @param {{ epicId: number|null, storyId: number, workCwd?: string,
 *           env?: NodeJS.ProcessEnv, fs?: typeof nodeFs,
 *           logger?: { warn?: (m: string) => void } }} args
 * @returns {{ envSet: boolean, fileWritten: boolean, filePath: string|null }}
 */
export function setActiveStoryEnv({
  epicId,
  storyId,
  workCwd,
  env = process.env,
  fs = nodeFs,
  logger,
} = {}) {
  if (epicId !== null && (!Number.isInteger(epicId) || epicId <= 0)) {
    throw new Error(
      `[active-story-env] epicId must be a positive integer or null; got ${epicId}`,
    );
  }
  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new Error(
      `[active-story-env] storyId must be a positive integer; got ${storyId}`,
    );
  }

  if (epicId === null) {
    // Standalone Story — ensure CC_EPIC_ID is absent so the trace
    // hook's no-op contract sees "no epic" rather than "epic=''".
    if ('CC_EPIC_ID' in env) delete env.CC_EPIC_ID;
  } else {
    env.CC_EPIC_ID = String(epicId);
  }
  env.CC_STORY_ID = String(storyId);

  let fileWritten = false;
  let filePath = null;
  if (typeof workCwd === 'string' && workCwd.length > 0) {
    filePath = nodePath.join(workCwd, ENV_LOCAL_BASENAME);
    try {
      fs.writeFileSync(
        filePath,
        renderActiveStoryEnvFile({ epicId, storyId }),
        {
          encoding: 'utf8',
        },
      );
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

/**
 * Render the single-delivery `.env.local` body. The single-delivery executor
 * (`deliver-epic-single.md`) walks the Delivery Slicing table inside ONE long
 * session; there is no Story fan-out and thus no `CC_STORY_ID`. Instead the
 * "current slice" is exported as `CC_SLICE_ID` so the PostToolUse hook emits
 * `slice.heartbeat` — the watchdog's forward-progress signal for the single
 * session — as a free byproduct of tool activity.
 *
 * `CC_STORY_ID` MUST be absent (its presence would make the hook emit
 * `story.heartbeat` and the trace path key off a non-existent Story). The
 * optional `operator` handle is emitted as `CC_OPERATOR` only when supplied.
 *
 * Exported for testing.
 *
 * @param {{ epicId: number, sliceId: string, operator?: string }} input
 * @returns {string}
 */
export function renderActiveSliceEnvFile({ epicId, sliceId, operator }) {
  const lines = [
    '# Auto-managed by .agents/scripts/lib/observability/active-story-env.js',
    '# Re-generated on every slice-start; deleted on epic-close.',
    `CC_EPIC_ID=${epicId}`,
    `CC_SLICE_ID=${sliceId}`,
  ];
  if (typeof operator === 'string' && operator.length > 0) {
    lines.push(`CC_OPERATOR=${operator}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Set `CC_EPIC_ID` / `CC_SLICE_ID` (+ optional `CC_OPERATOR`) on the current
 * process and, when `workCwd` is provided, export them to
 * `<workCwd>/.env.local` for the harness to reload on the next tool call. The
 * single-delivery analogue of {@link setActiveStoryEnv}; called at each
 * `slice.start` boundary so the hook's throttled `slice.heartbeat` is keyed to
 * the slice currently being implemented.
 *
 * `CC_STORY_ID` is explicitly removed so a prior Story context (if any ever
 * leaked in) cannot make the hook emit the wrong heartbeat shape.
 *
 * @param {{ epicId: number, sliceId: string, operator?: string|null,
 *           workCwd?: string, env?: NodeJS.ProcessEnv, fs?: typeof nodeFs,
 *           logger?: { warn?: (m: string) => void } }} args
 * @returns {{ envSet: boolean, fileWritten: boolean, filePath: string|null }}
 */
export function setActiveSliceEnv({
  epicId,
  sliceId,
  operator,
  workCwd,
  env = process.env,
  fs = nodeFs,
  logger,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new Error(
      `[active-story-env] epicId must be a positive integer; got ${epicId}`,
    );
  }
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    throw new Error(
      `[active-story-env] sliceId must be a non-empty string; got ${sliceId}`,
    );
  }
  const normOperator =
    typeof operator === 'string' && operator.length > 0 ? operator : undefined;

  if ('CC_STORY_ID' in env) delete env.CC_STORY_ID;
  env.CC_EPIC_ID = String(epicId);
  env.CC_SLICE_ID = sliceId;
  if (normOperator) env.CC_OPERATOR = normOperator;
  else if ('CC_OPERATOR' in env) delete env.CC_OPERATOR;

  let fileWritten = false;
  let filePath = null;
  if (typeof workCwd === 'string' && workCwd.length > 0) {
    filePath = nodePath.join(workCwd, ENV_LOCAL_BASENAME);
    try {
      fs.writeFileSync(
        filePath,
        renderActiveSliceEnvFile({ epicId, sliceId, operator: normOperator }),
        { encoding: 'utf8' },
      );
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
