/**
 * wave-record-notifications.js — webhook-emit helpers for the per-Story
 * status recorder CLI (`epic-execute-record-wave.js`).
 *
 * Story #4155 (Epic #4151) — the Epic `/deliver` runtime cut over from the
 * wave-batch scheduler to the continuous ready-set core, so these emits are
 * no longer keyed to a wave boundary. The recorder fires curated webhook
 * events per recorder beat: `epic-started` once (on the first recorded
 * Story), `epic-progress` with the run's done/total counts (re-derived from
 * the checkpoint's flat per-Story `stories` map), and `epic-blocked` when a
 * Story in this beat blocked or failed. Each helper is fire-and-forget —
 * webhook misconfig or a transient Slack outage must not block the loop.
 *
 * These helpers stay in their own module to keep the parent CLI a thin
 * runner shell. They are not part of the pure projection layer; they
 * intentionally call `notify` (or the test-injected stand-in) and Logger.
 */

import { Logger } from '../Logger.js';
import {
  emitEpicBlocked,
  emitEpicProgress,
  emitEpicStarted,
} from './epic-runner/progress-reporter/transport.js';

/**
 * Build the notify-bound closure used by the curated webhook emitters. When
 * a test passes `injectedNotify`, we route through it verbatim; otherwise
 * thread `orchestration` + `provider` into the default `notify` so the
 * downstream hook layer has everything it needs.
 */
export function buildNotifyFn(injectedNotify, config, provider, defaultNotify) {
  if (injectedNotify) return injectedNotify;
  return (ticketId, payload, opts = {}) =>
    defaultNotify(ticketId, payload, {
      orchestration: config.orchestration,
      provider,
      ...opts,
    });
}

/**
 * Count Stories in a terminal `done` state across the checkpoint's flat
 * per-Story `stories` status map. Pure helper.
 *
 * @param {Record<string, { status?: string }>|undefined} stories
 * @returns {number}
 */
export function countDoneStories(stories) {
  const map = stories && typeof stories === 'object' ? stories : {};
  let done = 0;
  for (const rec of Object.values(map)) {
    if (rec?.status === 'done') done += 1;
  }
  return done;
}

/**
 * Fire the curated webhook events for a recorder beat. Each emit is
 * fire-and-forget (the emit helpers swallow webhook misconfiguration), but
 * we still serialise them so the order is deterministic.
 *
 * - `epic-started` fires exactly once: on the very first recorded Story
 *   (signalled by `firstRecord === true`), before any Story has been
 *   recorded on a prior beat.
 * - `epic-progress` always fires with the run's done/total counts.
 * - `epic-blocked` fires when this beat recorded at least one blocked or
 *   failed Story.
 *
 * @param {{
 *   injectedNotify?: Function,
 *   defaultNotify: Function,
 *   config: object,
 *   provider: object,
 *   epicId: number,
 *   firstRecord: boolean,
 *   stories: Record<string, { status?: string }>,
 *   verified: Array<{ storyId: number, status: string }>,
 *   blockedStoryIds: number[],
 * }} args
 */
export async function emitRecordNotifications({
  injectedNotify,
  defaultNotify,
  config,
  provider,
  epicId,
  firstRecord,
  stories,
  verified,
  blockedStoryIds,
}) {
  const notifyFn = buildNotifyFn(
    injectedNotify,
    config,
    provider,
    defaultNotify,
  );
  const map = stories && typeof stories === 'object' ? stories : {};
  const totalStories = Object.keys(map).length;
  const doneStories = countDoneStories(map);

  if (firstRecord) {
    await emitEpicStarted({
      notify: notifyFn,
      epicId,
      totalStories,
      logger: Logger,
    });
  }

  const blockedIds = Array.isArray(blockedStoryIds) ? blockedStoryIds : [];
  const failedStoryId = (verified ?? []).find(
    (r) => r.status === 'failed',
  )?.storyId;
  const failingStoryId = blockedIds[0] ?? failedStoryId;
  const hasFailure = blockedIds.length > 0 || failedStoryId != null;

  if (hasFailure) {
    await emitEpicBlocked({
      notify: notifyFn,
      epicId,
      reason: blockedIds.length > 0 ? 'story_blocked' : 'story_failed',
      storyId: failingStoryId,
      logger: Logger,
    });
  }

  await emitEpicProgress({
    notify: notifyFn,
    epicId,
    done: doneStories,
    total: totalStories,
    phase: 'wave-loop',
    openBlockers: hasFailure
      ? [
          {
            reason: blockedIds.length > 0 ? 'story_blocked' : 'story_failed',
            storyId: failingStoryId,
          },
        ]
      : [],
    logger: Logger,
  });
}
