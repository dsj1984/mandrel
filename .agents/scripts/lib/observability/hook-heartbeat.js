/**
 * hook-heartbeat.js — Epic #4476 (M5): heartbeats OFF the token stream.
 *
 * Today the `story.heartbeat` / `slice.heartbeat` forward-progress signal the
 * `/deliver` §2e Idle Watchdog (`wave-tick.js --check-idle 30`) reads is an
 * **LLM obligation**: the delivery workflow instructs the agent to run
 * `story-phase.js` / `slice-phase.js --event heartbeat` at least once per
 * meaningful step, and every such call is a full-priced LLM turn re-reading
 * ~100k of cached context just to append one NDJSON line.
 *
 * This module makes that liveness signal a **free byproduct of the agent
 * doing any work**. It is invoked from the existing PostToolUse trace hook
 * (`tool-trace-hook.js`), so every tool call the agent makes refreshes the
 * heartbeat — no dedicated bookkeeping turn required. The record it appends is
 * byte-for-byte the same `story.heartbeat` / `slice.heartbeat` shape the
 * watchdog already consumes (emitted through the same
 * `emit-story-heartbeat.js` / `emit-slice-lifecycle.js` emitters), so the
 * watchdog needs no change: the signal is preserved, only its emission
 * mechanism moves off the token stream.
 *
 * ## Robustness contract (mirrors `tool-trace-hook.js`)
 *   - **No-op outside an active Story / slice.** When neither a valid
 *     `{ CC_EPIC_ID, CC_STORY_ID }` (fan-out child) nor a valid
 *     `{ CC_EPIC_ID, CC_SLICE_ID }` (single-delivery session) pair is present
 *     in the environment, `emitHeartbeatFromHook` returns without touching the
 *     filesystem.
 *   - **Best-effort.** Every failure is swallowed. A heartbeat is
 *     observability, not state; a hook must never block tool execution.
 *   - **Throttled across processes.** Command hooks are spawned as fresh
 *     `node` processes per tool call, so in-process state cannot throttle. The
 *     throttle is anchored to the **mtime of a sidecar marker file** under the
 *     Epic temp dir: at most one heartbeat per `HEARTBEAT_MIN_INTERVAL_MS`
 *     lands, regardless of how many tool calls fire in that window. This keeps
 *     the ledger from ballooning while still refreshing liveness faster than
 *     the watchdog's threshold.
 */

import { statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { epicTempDir } from '../config/temp-paths.js';
import { emitSliceHeartbeat } from '../orchestration/lifecycle/emit-slice-lifecycle.js';
import { emitStoryHeartbeat } from '../orchestration/lifecycle/emit-story-heartbeat.js';

/**
 * Default minimum wall-clock gap between two hook-emitted heartbeats for the
 * same target. Comfortably below the watchdog's default 30-minute staleness
 * threshold, so an actively-working agent never trips a false stall, while
 * still bounding ledger growth to ~1 line/minute of activity.
 */
export const HEARTBEAT_MIN_INTERVAL_MS = 60_000;

/**
 * Resolve the heartbeat target from the active-Story / active-slice env vars.
 *
 * Precedence: a present `CC_STORY_ID` (fan-out Story child) wins over
 * `CC_SLICE_ID` (single-delivery session) — the two are never set together in
 * practice, but the ordering keeps the resolution deterministic if they were.
 *
 * A `story.heartbeat` requires a parent `epicId` (its schema pins
 * `epicId >= 1`), so a **standalone** Story (`CC_STORY_ID` set, `CC_EPIC_ID`
 * absent) yields `null` — there is no Epic-scoped ledger to write to and the
 * standalone path is not watched by the Epic idle watchdog. The trace hook
 * still records that context's traces; only the heartbeat is skipped.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ kind: 'story', epicId: number, storyId: number, operator?: string }
 *          | { kind: 'slice', epicId: number, sliceId: string, operator?: string }
 *          | null}
 */
export function resolveHeartbeatTarget(env = process.env) {
  const epicRaw = env.CC_EPIC_ID;
  const storyRaw = env.CC_STORY_ID;
  const sliceRaw = env.CC_SLICE_ID;
  const operator =
    typeof env.CC_OPERATOR === 'string' && env.CC_OPERATOR.length > 0
      ? env.CC_OPERATOR
      : undefined;

  const epicId = epicRaw ? Number.parseInt(epicRaw, 10) : Number.NaN;
  const epicOk = Number.isInteger(epicId) && epicId > 0;

  if (storyRaw) {
    const storyId = Number.parseInt(storyRaw, 10);
    if (!Number.isInteger(storyId) || storyId <= 0) return null;
    // story.heartbeat has no meaning without a parent Epic ledger.
    if (!epicOk) return null;
    return {
      kind: 'story',
      epicId,
      storyId,
      ...(operator ? { operator } : {}),
    };
  }

  if (sliceRaw) {
    if (typeof sliceRaw !== 'string' || sliceRaw.length === 0) return null;
    if (!epicOk) return null;
    return {
      kind: 'slice',
      epicId,
      sliceId: sliceRaw,
      ...(operator ? { operator } : {}),
    };
  }

  return null;
}

/**
 * Stable, filesystem-safe marker basename for a target. The marker's mtime is
 * the throttle anchor; its contents are irrelevant.
 *
 * @param {{ kind: string, storyId?: number, sliceId?: string }} target
 * @returns {string}
 */
export function heartbeatMarkerName(target) {
  const key =
    target.kind === 'story'
      ? `story-${target.storyId}`
      : `slice-${String(target.sliceId).replace(/[^A-Za-z0-9._-]/g, '_')}`;
  return `.heartbeat-${key}`;
}

/**
 * Throttle predicate. Returns `true` when no marker exists yet, or the marker
 * is older than `intervalMs`. Any stat error (missing file / unreadable) is
 * treated as "emit" — the safe direction for a liveness signal.
 *
 * @param {{ markerPath: string, now: Date, intervalMs: number, statFn?: typeof statSync }} args
 * @returns {boolean}
 */
export function shouldEmitHeartbeat({
  markerPath,
  now,
  intervalMs,
  statFn = statSync,
}) {
  try {
    const st = statFn(markerPath);
    return now.getTime() - st.mtimeMs >= intervalMs;
  } catch {
    return true;
  }
}

/**
 * Update (or create) the throttle marker so its mtime is `now`. Best-effort:
 * a failure here at worst lets the next tool call emit a second heartbeat.
 *
 * @param {string} markerPath
 * @param {Date} now
 */
function touchMarker(markerPath, now) {
  try {
    writeFileSync(markerPath, '', { flag: 'a' });
    utimesSync(markerPath, now, now);
  } catch {
    // swallow — throttle degrades to "emit again next call", never fatal.
  }
}

/**
 * Emit one throttled heartbeat for the active target, if any. The whole body
 * is best-effort: any failure returns a `{ emitted: false }` envelope rather
 * than throwing, so the calling PostToolUse hook never blocks the tool.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]        Defaults to `process.env`.
 * @param {Date} [opts.now]                     Injected clock (tests).
 * @param {number} [opts.intervalMs]            Throttle window.
 * @param {object} [opts.config]                Resolved config (tempRoot).
 * @returns {{ emitted: boolean, reason?: string, kind?: string, ledgerPath?: string }}
 */
export function emitHeartbeatFromHook({
  env = process.env,
  now = new Date(),
  intervalMs = HEARTBEAT_MIN_INTERVAL_MS,
  config,
} = {}) {
  try {
    const target = resolveHeartbeatTarget(env);
    if (!target) return { emitted: false, reason: 'no-target' };

    const markerPath = path.join(
      epicTempDir(target.epicId, config),
      heartbeatMarkerName(target),
    );
    if (!shouldEmitHeartbeat({ markerPath, now, intervalMs })) {
      return { emitted: false, reason: 'throttled', kind: target.kind };
    }

    const timestamp = now.toISOString();
    let res;
    if (target.kind === 'story') {
      res = emitStoryHeartbeat({
        epicId: target.epicId,
        storyId: target.storyId,
        phase: 'implementing',
        timestamp,
        ...(target.operator ? { operator: target.operator } : {}),
        config: config ?? undefined,
      });
    } else {
      res = emitSliceHeartbeat({
        epicId: target.epicId,
        sliceId: target.sliceId,
        phase: 'implementing',
        timestamp,
        ...(target.operator ? { operator: target.operator } : {}),
        config: config ?? undefined,
      });
    }
    touchMarker(markerPath, now);
    return { emitted: true, kind: target.kind, ledgerPath: res?.ledgerPath };
  } catch {
    return { emitted: false, reason: 'error' };
  }
}
