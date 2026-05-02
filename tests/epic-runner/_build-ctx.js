/**
 * Shared test factory — builds an `EpicRunnerContext` with sensible defaults
 * for the epic-runner unit + integration suite. Tests pass overrides for the
 * fields they exercise (e.g. a custom `dispatch`, a fake `provider`).
 *
 * `dispatch` adapter contract: receives `{ plan, concurrencyCap, signal }`
 * where `plan` is `[{ storyId, modelTier, worktree }, ...]` and returns
 * an array of `{ storyId, status, detail? }` results. Tests that need
 * per-story custom behaviour use the `spawn` legacy alias which is auto-
 * adapted to the new wave-level shape below — preserves test ergonomics
 * without churning every call site.
 *
 * Webhook safety: the default `cwd` points at a nonexistent directory and
 * `fetchImpl` is a no-op stub, so the unified `notify()` dispatcher cannot
 * resolve a real webhook URL or call the real `fetch`. Tests that exercise
 * webhook delivery must override both explicitly.
 */

import { EpicRunnerContext } from '../../.agents/scripts/lib/orchestration/context.js';

const WEBHOOK_SAFE_CWD = '/nonexistent-epic-runner-test-cwd';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

async function stubFetch() {
  return { ok: true, status: 200 };
}

/**
 * Adapt a legacy per-story `spawn(args)` adapter (`{ storyId, worktree, signal }
 * → { status, detail? }`) into a wave-level `dispatch({ plan, signal })` adapter
 * by mapping plan entries through the per-story function. Lets pre-#908 tests
 * keep their `spawn: ...` ergonomic without rewriting every call site.
 */
function adaptSpawnToDispatch(spawnFn) {
  return async ({ plan, signal }) =>
    Promise.all(
      plan.map(async (entry) => {
        const result = await spawnFn({
          storyId: entry.storyId,
          worktree: entry.worktree,
          signal,
        });
        return { storyId: entry.storyId, ...result };
      }),
    );
}

export function buildCtx(overrides = {}) {
  const { spawn: legacySpawn, dispatch: explicitDispatch, ...rest } = overrides;
  const dispatch =
    explicitDispatch ??
    (typeof legacySpawn === 'function'
      ? adaptSpawnToDispatch(legacySpawn)
      : async ({ plan }) =>
          plan.map((p) => ({ storyId: p.storyId, status: 'done' })));
  const defaults = {
    epicId: 321,
    provider: {},
    config: {
      runners: {
        epicRunner: {
          enabled: true,
          concurrencyCap: 2,
          storyRetryCount: 0,
          blockerTimeoutHours: 0,
        },
      },
    },
    logger: quietLogger(),
    cwd: WEBHOOK_SAFE_CWD,
    fetchImpl: stubFetch,
    // Default adapter returns a positive count so post-wave commit assertion
    // does not reclassify `done` stories in unrelated tests. Tests that
    // exercise the zero-delta path pass their own gitAdapter override.
    gitAdapter: async () => 1,
  };
  return new EpicRunnerContext({ ...defaults, ...rest, dispatch });
}
