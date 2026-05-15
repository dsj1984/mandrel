/**
 * wave-record-notifications.js — webhook-emit helpers extracted from
 * `epic-execute-record-wave.js`.
 *
 * The CLI fires curated webhook events at every wave boundary (started,
 * progress, blocked, unblocked) so the host-LLM-driven `/epic-deliver` path
 * mirrors the wave-loop emits in
 * `lib/orchestration/epic-runner/phases/iterate-waves.js`. Each helper here
 * is fire-and-forget — webhook misconfig or a transient Slack outage must
 * not block the wave loop — so the impure surface is small (the inbound
 * `notifyFn` closure) and the rest is plain control flow.
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
  emitEpicUnblocked,
} from './epic-runner/progress-reporter.js';
import { countDoneStories } from './wave-record-projection.js';

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
 * Fire the curated webhook events for a wave boundary. Each emit is
 * fire-and-forget (the emit helpers swallow webhook misconfiguration), but
 * we still serialise them so the order matches the wave-loop emits in
 * `lib/orchestration/epic-runner/phases/iterate-waves.js` for the host-LLM
 * driven /epic-deliver path.
 */
export async function emitWaveBoundaryNotifications({
  injectedNotify,
  defaultNotify,
  config,
  provider,
  epicId,
  wave,
  status,
  priorWaves,
  nextWaves,
  titleById,
  totalWaves,
  nextCurrentWave,
  verified,
  blockedStoryIds,
}) {
  const notifyFn = buildNotifyFn(
    injectedNotify,
    config,
    provider,
    defaultNotify,
  );
  const totalStoriesEstimate = titleById.size;
  const doneStoriesSoFar = countDoneStories(nextWaves);
  const priorWaveRecord = priorWaves.find(
    (w) => Number(w?.index) === Number(wave),
  );
  if (priorWaves.length === 0 && wave === 0) {
    await emitEpicStarted({
      notify: notifyFn,
      epicId,
      totalWaves,
      totalStories: totalStoriesEstimate,
      logger: Logger,
    });
  }
  if (status === 'complete') {
    await emitCompleteWaveNotifications({
      notifyFn,
      epicId,
      priorWaveRecord,
      doneStoriesSoFar,
      totalStoriesEstimate,
      nextCurrentWave,
      totalWaves,
    });
    return;
  }
  await emitFailingWaveNotifications({
    notifyFn,
    epicId,
    status,
    blockedStoryIds,
    verified,
    doneStoriesSoFar,
    totalStoriesEstimate,
    nextCurrentWave,
    totalWaves,
  });
}

/** Emit the unblocked-then-progress pair for a `complete` wave. */
async function emitCompleteWaveNotifications({
  notifyFn,
  epicId,
  priorWaveRecord,
  doneStoriesSoFar,
  totalStoriesEstimate,
  nextCurrentWave,
  totalWaves,
}) {
  const resumedFromHalt =
    priorWaveRecord &&
    (priorWaveRecord.status === 'blocked' ||
      priorWaveRecord.status === 'failed');
  if (resumedFromHalt) {
    await emitEpicUnblocked({
      notify: notifyFn,
      epicId,
      resolvedBlocker: {
        reason:
          priorWaveRecord.status === 'blocked'
            ? 'story_blocked'
            : 'story_failed',
      },
      logger: Logger,
    });
  }
  await emitEpicProgress({
    notify: notifyFn,
    epicId,
    done: doneStoriesSoFar,
    total: totalStoriesEstimate,
    currentWave: nextCurrentWave,
    totalWaves,
    phase: 'iterate-waves',
    openBlockers: [],
    logger: Logger,
  });
  // The `epic-complete` webhook used to fire here, at the post-final-wave
  // / pre-finalize boundary. That preceded `gh pr create` by minutes — the
  // operator got an "Epic complete" ping with no PR to click. The fire
  // moved to `epic-deliver-finalize.js`, which emits it after the PR URL
  // is captured. See that script for the new emit point.
}

/** Emit blocked + progress (with open-blocker context) for a non-complete wave. */
async function emitFailingWaveNotifications({
  notifyFn,
  epicId,
  status,
  blockedStoryIds,
  verified,
  doneStoriesSoFar,
  totalStoriesEstimate,
  nextCurrentWave,
  totalWaves,
}) {
  const reason = status === 'blocked' ? 'story_blocked' : 'story_failed';
  const failingStoryId =
    blockedStoryIds[0] ?? verified.find((r) => r.status === 'failed')?.storyId;
  await emitEpicBlocked({
    notify: notifyFn,
    epicId,
    reason,
    storyId: failingStoryId,
    logger: Logger,
  });
  await emitEpicProgress({
    notify: notifyFn,
    epicId,
    done: doneStoriesSoFar,
    total: totalStoriesEstimate,
    currentWave: nextCurrentWave,
    totalWaves,
    phase: 'iterate-waves',
    openBlockers: [{ reason, storyId: failingStoryId }],
    logger: Logger,
  });
}
