/**
 * Shared test factory — builds an `EpicRunnerContext` with sensible defaults
 * for the epic-runner unit + integration suite. Tests pass overrides for the
 * fields they exercise (e.g. a custom `dispatch`, a fake `provider`).
 *
 * `dispatch` adapter contract: receives `{ plan, concurrencyCap, signal }`
 * where `plan` is `[{ storyId, worktree }, ...]` and returns
 * an array of `{ storyId, status, detail? }` results. Tests that need
 * per-story custom behaviour use the `spawn` legacy alias which is auto-
 * adapted to the new wave-level shape below — preserves test ergonomics
 * without churning every call site.
 *
 * Webhook safety: `notify` defaults to a no-op stub so the production
 * `notify()` import wired in `epic-runner/factory.js` never runs from
 * tests that drive the lifecycle through to allowlisted events
 * (`wave.end`, `epic.complete`, …). `fetchImpl` and a nonexistent `cwd`
 * are also stubbed but neither protects the webhook leg on their own —
 * `notify()`'s `sendWebhook` uses global `fetch`, and webhook URL
 * resolution reads from `process.env`. Tests that intentionally
 * exercise webhook delivery MUST explicitly pass `notify` (and
 * `webhookUrl` if they want the dispatcher to fire).
 */

import { EpicRunnerContext } from '../../.agents/scripts/lib/orchestration/context.js';

const WEBHOOK_SAFE_CWD = '/nonexistent-epic-runner-test-cwd';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

async function stubFetch() {
  return { ok: true, status: 200 };
}

async function stubNotify() {
  return { ok: true };
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
        deliverRunner: {
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
    notify: stubNotify,
    // Default adapter returns a positive count so post-wave commit assertion
    // does not reclassify `done` stories in unrelated tests. Tests that
    // exercise the zero-delta path pass their own gitAdapter override.
    gitAdapter: async () => 1,
  };
  return new EpicRunnerContext({ ...defaults, ...rest, dispatch });
}
