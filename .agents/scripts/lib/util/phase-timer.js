import { Logger } from '../Logger.js';
/**
 * lib/util/phase-timer.js — Per-phase wall-clock timer for the Story lifecycle.
 *
 * A single Story Mode run spans two Node processes (`story-init` →
 * implement → `story-close`), so the timer supports snapshot/restore so
 * close can pick up where init left off. Phase names are drawn from a fixed
 * enum (tech spec #555 §Data Models) so the emitted `[phase-timing]` log
 * lines and the `phase-timings` structured comment share one schema.
 *
 * Semantics
 * ---------
 *  - `mark(name)` closes the current open phase (if any) at `now()` and opens
 *    a new phase at the same instant. The just-closed phase's
 *    `elapsedMs = now() - openedAt` is appended to the ordered `phases` list
 *    and a single `[phase-timing]` log line is emitted for it.
 *  - `finish()` closes the current open phase at `now()` and returns the
 *    full summary `{ storyId, totalMs, phases: [{ name, elapsedMs }, ...] }`.
 *    Idempotent — subsequent calls return the cached summary.
 *  - `snapshot()` returns a plain-object that `createPhaseTimer({ restore })`
 *    can round-trip. Used by `story-init` to hand the timer state to
 *    `story-close` via a small on-disk file in the main repo `.git/`.
 *
 * Invariants
 * ----------
 *  - Unknown phase names throw. The enum is frozen at `ALLOWED_PHASE_NAMES`.
 *  - `mark()` after `finish()` throws — caller bug, not runtime drift.
 *  - `totalMs` is wall clock from `createdAt` to `finish()` time, not a sum
 *    of `phases[].elapsedMs`. Gaps before the first `mark()` (or between
 *    restore and the next mark) are therefore captured in `totalMs` even
 *    though they are not attributable to a named phase.
 */

export const ALLOWED_PHASE_NAMES = Object.freeze([
  'worktree-create',
  'bootstrap',
  'install',
  'implement',
  'lint',
  'test',
  'close',
  'api-sync',
]);

const ALLOWED_SET = new Set(ALLOWED_PHASE_NAMES);

/**
 * @typedef {typeof ALLOWED_PHASE_NAMES[number]} PhaseName
 * @typedef {{ name: PhaseName, elapsedMs: number }} PhaseEntry
 * @typedef {{
 *   storyId: number,
 *   totalMs: number,
 *   phases: PhaseEntry[],
 * }} PhaseTimingSummary
 * @typedef {{
 *   storyId: number,
 *   createdAt: number,
 *   phases: PhaseEntry[],
 *   current: { name: PhaseName, openedAt: number } | null,
 *   finished: PhaseTimingSummary | null,
 * }} PhaseTimerSnapshot
 */

/**
 * Create a phase timer for a single Story lifecycle.
 *
 * @param {number} storyId - Numeric Story id; baked into log lines and summary.
 * @param {{
 *   now?: () => number,
 *   logger?: (line: string) => void,
 *   restore?: PhaseTimerSnapshot,
 * }} [opts]
 * @returns {{
 *   mark: (name: PhaseName) => void,
 *   finish: () => PhaseTimingSummary,
 *   snapshot: () => PhaseTimerSnapshot,
 * }}
 */
export function createPhaseTimer(storyId, opts = {}) {
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? ((line) => Logger.info(line));

  let createdAt;
  let phases;
  let current;
  let finished;
  let timerStoryId;

  if (opts.restore) {
    const snap = opts.restore;
    timerStoryId = snap.storyId;
    createdAt = snap.createdAt;
    phases = Array.isArray(snap.phases)
      ? snap.phases.map((p) => ({ ...p }))
      : [];
    current = snap.current ? { ...snap.current } : null;
    finished = snap.finished
      ? {
          ...snap.finished,
          phases: snap.finished.phases.map((p) => ({ ...p })),
        }
      : null;
  } else {
    timerStoryId = storyId;
    createdAt = now();
    phases = [];
    current = null;
    finished = null;
  }

  function closeCurrent(endAt) {
    if (!current) return;
    const elapsedMs = Math.max(0, endAt - current.openedAt);
    const entry = { name: current.name, elapsedMs };
    phases.push(entry);
    logger(
      `[phase-timing] story=${timerStoryId} phase=${entry.name} elapsedMs=${elapsedMs}`,
    );
    current = null;
  }

  function mark(name) {
    if (finished) {
      throw new Error(
        `createPhaseTimer: cannot mark('${name}') after finish() on story #${timerStoryId}`,
      );
    }
    if (!ALLOWED_SET.has(name)) {
      throw new Error(
        `createPhaseTimer: unknown phase '${name}'. Allowed: ${ALLOWED_PHASE_NAMES.join(', ')}`,
      );
    }
    const t = now();
    closeCurrent(t);
    current = { name, openedAt: t };
  }

  function finish() {
    if (finished) return finished;
    const t = now();
    closeCurrent(t);
    finished = {
      storyId: timerStoryId,
      totalMs: Math.max(0, t - createdAt),
      phases: phases.map((p) => ({ ...p })),
    };
    return finished;
  }

  function snapshot() {
    return {
      storyId: timerStoryId,
      createdAt,
      phases: phases.map((p) => ({ ...p })),
      current: current ? { ...current } : null,
      finished: finished
        ? { ...finished, phases: finished.phases.map((p) => ({ ...p })) }
        : null,
    };
  }

  return { mark, finish, snapshot };
}
