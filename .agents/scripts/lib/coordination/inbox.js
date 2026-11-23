/**
 * The inbox: one reader's pertinent events it has not been given yet,
 * tracked by a cursor file under the anchored temp root so a worktree and
 * the main checkout share it. Advisory and fail-open.
 */

import { getCoordination } from '../config/github.js';
import { coordinationCursorPath } from '../config/temp-paths.js';
import { readJsonOrNull } from '../json-utils.js';
import { createProvider } from '../provider-factory.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { createChannel, degradedReason } from './channel.js';
import { isPertinent, resolveReader } from './pertinence.js';

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const THROTTLE_MS = 120_000;
const POLL_TIMEOUT_MS = 5000;
const SEEN_CAP = 1000;

/** The `degraded` value of a read that outran its time limit. */
export const POLL_TIMEOUT = 'poll-timeout';

const isTimestamp = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * The saved cursor, or a fresh one starting 24 hours back. `startedAt` is
 * the watermark the reader started from, so `sinceStart` re-lists everything
 * it was ever given.
 *
 * @param {string} file
 * @param {number} nowMs
 * @returns {{ since: string, startedAt: string, seen: number[], polledAt: string|null }}
 */
function loadCursor(file, nowMs) {
  const saved = readJsonOrNull(file);
  if (
    isTimestamp(saved?.since) &&
    isTimestamp(saved.startedAt) &&
    Array.isArray(saved.seen)
  ) {
    return saved;
  }
  const start = new Date(nowMs - LOOKBACK_MS).toISOString();
  return { since: start, startedAt: start, seen: [], polledAt: null };
}

/** Best-effort: an unwritten cursor only re-delivers on the next read. */
function saveCursor(file, cursor) {
  try {
    writeFileAtomic(file, `${JSON.stringify(cursor, null, 2)}\n`);
  } catch {
    // Advisory channel; the events are still returned.
  }
}

/**
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(work, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(POLL_TIMEOUT)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Read a reader's inbox; never throws. A default read advances the cursor,
 * `peek` and `sinceStart` leave it untouched, and `throttle` skips the
 * provider when the last advancing read was under 120 seconds ago.
 *
 * @param {{ config: object, storyId?: number|null, provider?: object,
 *   env?: NodeJS.ProcessEnv, peek?: boolean, sinceStart?: boolean,
 *   throttle?: boolean, now?: () => Date, cwd?: string, git?: object,
 *   timeoutMs?: number, cursorFile?: string }} opts `storyId: null` is the
 *   `--all` reader; `cursorFile` replaces the reader's shared cursor.
 * @returns {Promise<object>} `{ reader, since, events, dropped }`, or
 *   `disabled`, `skipped: 'throttled'` or `degraded` in place of the events.
 */
export async function readInbox({
  config,
  storyId = null,
  provider,
  env = process.env,
  peek = false,
  sinceStart = false,
  throttle = false,
  now = () => new Date(),
  cwd,
  git,
  timeoutMs = POLL_TIMEOUT_MS,
  cursorFile,
} = {}) {
  const reader = storyId === null ? 'all' : `story-${storyId}`;
  if (!getCoordination(config, env).enabled) return { reader, disabled: true };
  try {
    const file = cursorFile ?? coordinationCursorPath(reader, config);
    const nowMs = now().getTime();
    const cursor = loadCursor(file, nowMs);
    if (throttle && nowMs - Date.parse(cursor.polledAt) < THROTTLE_MS) {
      return { reader, skipped: 'throttled' };
    }
    const since = sinceStart ? cursor.startedAt : cursor.since;
    const source = provider ?? createProvider(config);
    const [who, polled] = await withTimeout(
      Promise.all([
        resolveReader({ storyId, provider: source, config, cwd, git }),
        createChannel({ provider: source, config }).poll(since),
      ]),
      timeoutMs,
    );
    const seen = new Set(sinceStart ? [] : cursor.seen);
    const events = polled.events.filter(
      (event) => !seen.has(event.id) && isPertinent(event, who),
    );
    if (!peek && !sinceStart) {
      saveCursor(file, {
        since: polled.watermark,
        startedAt: cursor.startedAt,
        seen: [...cursor.seen, ...events.map((e) => e.id)].slice(-SEEN_CAP),
        polledAt: new Date(nowMs).toISOString(),
      });
    }
    return { reader, since, events, dropped: polled.dropped };
  } catch (err) {
    const degraded =
      err?.message === POLL_TIMEOUT ? POLL_TIMEOUT : degradedReason(err);
    return { reader, degraded, events: [] };
  }
}
