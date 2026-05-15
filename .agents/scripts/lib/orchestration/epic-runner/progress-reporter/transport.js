/**
 * progress-reporter/transport.js — outbound I/O for the
 * `/epic-deliver` progress narrative.
 *
 * Extracted from the parent `progress-reporter.js` so the
 * GitHub-comment posting surface (in `composition.js`) and the
 * progress-signal aggregation (in `signals.js`) can be reasoned about
 * independently of the webhook fan-out.
 *
 * Each `emit*` helper dispatches a curated event-shaped payload through
 * the caller-supplied `notify` function. The `notify` contract is owned
 * by `lib/notifications/*` and ultimately reaches the configured webhook
 * via gh-exec (the retry/backoff loop lives there, not here — this
 * module's role is the boundary). Failures from `notify` are swallowed
 * by design: a flaky webhook URL must never crash the runner mid-wave.
 *
 * The webhook events emitted from this module are:
 *
 *   - `epic-started`  — fired once at /epic-deliver kickoff
 *   - `epic-progress` — fired at wave boundaries / blocker transitions
 *   - `epic-blocked`  — wave aggregated to blocked/failed outside halt path
 *   - `epic-unblocked` — operator flipped back to executing
 *   - `epic-complete` — pr-ready boundary, PR opened against `main`
 *
 * Each fire passes `skipComment: true` so the operator-facing GitHub
 * comments stay owned by `composition.js` (`upsertEpicRunProgress` and
 * `ProgressReporter.fire()`) — there is exactly one comment writer and
 * exactly one webhook writer per event.
 */

/**
 * Webhook event name for the curated epic-progress rollup. Distinct from
 * the `epic-run-progress` structured-comment kind in `signals.js` — the
 * comment is the operator-facing per-poll snapshot on the Epic ticket,
 * the webhook event is the coarse-grained rollup that fires at wave
 * boundaries and after blocker transitions.
 */
export const EPIC_PROGRESS_EVENT = 'epic-progress';

/**
 * Fire a curated `epic-progress` webhook event. Event-driven only — called
 * at wave boundaries and after blocker raise/clear transitions. Carries
 * the rollup payload `{ pct, done, total, currentWave, totalWaves, phase,
 * openBlockers }`, which Slack consumers and downstream subscribers use to
 * track epic progress without subscribing to per-story chatter.
 *
 * The dispatch passes `skipComment: true` — the operator-facing GitHub
 * comment is owned by `ProgressReporter.fire()` and `upsertEpicRunProgress`,
 * not by this webhook fire.
 *
 * Failures are swallowed by design: the runner must keep moving even if
 * the webhook URL is misconfigured or the network is flaky.
 *
 * @param {{
 *   notify: Function|null,
 *   epicId: number,
 *   done: number,
 *   total: number,
 *   currentWave: number,
 *   totalWaves: number,
 *   phase?: string,
 *   openBlockers?: Array<{ reason: string, storyId?: number }>,
 *   logger?: { warn?: Function },
 * }} args
 * @returns {Promise<{ payload: object } | null>}
 */
export async function emitEpicProgress({
  notify,
  epicId,
  done,
  total,
  currentWave,
  totalWaves,
  phase,
  openBlockers = [],
  logger,
}) {
  if (typeof notify !== 'function') return null;
  const epicIdNum = Number(epicId);
  if (!Number.isInteger(epicIdNum) || epicIdNum <= 0) return null;
  const totalN = Math.max(0, Number(total) || 0);
  const doneN = Math.max(0, Math.min(totalN, Number(done) || 0));
  const pct = totalN === 0 ? 0 : Math.round((doneN / totalN) * 100);
  const blockerCount = Array.isArray(openBlockers) ? openBlockers.length : 0;
  const blockerSuffix =
    blockerCount > 0
      ? ` · 🚧 ${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`
      : '';
  const message = `Epic #${epicIdNum} progress · Wave ${currentWave}/${totalWaves} · ${doneN}/${totalN} stories done (${pct}%)${blockerSuffix}`;

  const payload = {
    severity: blockerCount > 0 ? 'high' : 'medium',
    message,
    event: EPIC_PROGRESS_EVENT,
    level: 'epic',
    epicId: epicIdNum,
  };
  if (phase) payload.phase = phase;

  try {
    await notify(epicIdNum, payload, { skipComment: true });
  } catch (err) {
    logger?.warn?.(
      `[emitEpicProgress] notify dispatch failed (swallowed): ${err?.message ?? err}`,
    );
    return null;
  }
  return {
    payload: {
      pct,
      done: doneN,
      total: totalN,
      currentWave,
      totalWaves,
      phase,
      openBlockers: openBlockers ?? [],
    },
  };
}

/**
 * Fire a curated `epic-started` webhook event at /epic-deliver kickoff.
 * The Slack consumer anchors the rest of the epic narrative to this fire.
 * Failures are swallowed.
 */
export async function emitEpicStarted({
  notify,
  epicId,
  totalWaves,
  totalStories,
  title,
  logger,
}) {
  if (typeof notify !== 'function') return null;
  const epicIdNum = Number(epicId);
  if (!Number.isInteger(epicIdNum) || epicIdNum <= 0) return null;
  const message = `Epic #${epicIdNum} started · ${totalWaves} wave${totalWaves === 1 ? '' : 's'} · ${totalStories} stor${totalStories === 1 ? 'y' : 'ies'}${title ? ` — ${title}` : ''}`;
  try {
    await notify(
      epicIdNum,
      {
        severity: 'medium',
        message,
        event: 'epic-started',
        level: 'epic',
        epicId: epicIdNum,
      },
      { skipComment: true },
    );
  } catch (err) {
    logger?.warn?.(
      `[emitEpicStarted] notify dispatch failed (swallowed): ${err?.message ?? err}`,
    );
  }
  return null;
}

/**
 * Fire a curated `epic-blocked` webhook event when a wave aggregates to
 * `blocked` or `failed` outside the `BlockerHandler.halt` code path (the
 * /epic-deliver host-LLM loop has no handler instance — it calls this
 * helper directly from `epic-execute-record-wave.js`). The payload shape
 * matches the inline emit in `BlockerHandler.halt` so downstream consumers
 * see one canonical envelope regardless of which entry point fired.
 * Failures are swallowed.
 */
export async function emitEpicBlocked({
  notify,
  epicId,
  reason,
  storyId,
  logger,
}) {
  if (typeof notify !== 'function') return null;
  const epicIdNum = Number(epicId);
  if (!Number.isInteger(epicIdNum) || epicIdNum <= 0) return null;
  const storyPart = storyId ? ` (story #${storyId})` : '';
  const message = `🚨 Action Required: Epic #${epicIdNum}${storyPart} blocked: ${reason}`;
  try {
    await notify(
      epicIdNum,
      {
        severity: 'high',
        message,
        event: 'epic-blocked',
        level: 'epic',
        epicId: epicIdNum,
      },
      { skipComment: true },
    );
  } catch (err) {
    logger?.warn?.(
      `[emitEpicBlocked] notify dispatch failed (swallowed): ${err?.message ?? err}`,
    );
  }
  return null;
}

/**
 * Fire a curated `epic-unblocked` webhook event after the operator flips
 * the Epic label back to `agent::executing`. Paired with `epic-blocked` so
 * downstream consumers can track open-blocker lifecycle. Failures are
 * swallowed.
 */
export async function emitEpicUnblocked({
  notify,
  epicId,
  resolvedBlocker,
  logger,
}) {
  if (typeof notify !== 'function') return null;
  const epicIdNum = Number(epicId);
  if (!Number.isInteger(epicIdNum) || epicIdNum <= 0) return null;
  const reasonPart = resolvedBlocker?.reason
    ? ` (${resolvedBlocker.reason})`
    : '';
  const message = `Epic #${epicIdNum} unblocked${reasonPart} · resuming.`;
  try {
    await notify(
      epicIdNum,
      {
        severity: 'medium',
        message,
        event: 'epic-unblocked',
        level: 'epic',
        epicId: epicIdNum,
      },
      { skipComment: true },
    );
  } catch (err) {
    logger?.warn?.(
      `[emitEpicUnblocked] notify dispatch failed (swallowed): ${err?.message ?? err}`,
    );
  }
  return null;
}

/**
 * Fire a curated `epic-complete` webhook event at the `pr-ready` boundary
 * of /epic-deliver — the merge PR has been opened against `main` and the
 * operator can click through. Bookends the `epic-started` fire at kickoff.
 * Failures are swallowed.
 *
 * Earlier the fire lived at the post-final-wave / pre-finalize boundary in
 * `epic-execute-record-wave.js`, but that preceded `gh pr create` by minutes
 * — operators got an "Epic complete" ping with nothing to action. The
 * single emit point is now `epic-deliver-finalize.js`, immediately after
 * the PR URL is captured. The legacy dispatcher path's own inline
 * `epic-complete` webhook (`epic-lifecycle-detector.js`) is also gated to
 * the comment surface only for the same reason.
 *
 * @param {{
 *   notify: Function,
 *   epicId: number|string,
 *   totalStories?: number,
 *   totalWaves?: number,
 *   prUrl?: string|null,
 *   logger?: { warn?: Function },
 * }} args
 */
export async function emitEpicComplete({
  notify,
  epicId,
  totalStories,
  totalWaves,
  prUrl,
  logger,
}) {
  if (typeof notify !== 'function') return null;
  const epicIdNum = Number(epicId);
  if (!Number.isInteger(epicIdNum) || epicIdNum <= 0) return null;
  const wavePart = Number.isFinite(Number(totalWaves))
    ? ` · ${totalWaves} wave${Number(totalWaves) === 1 ? '' : 's'}`
    : '';
  const storyPart = Number.isFinite(Number(totalStories))
    ? ` · ${totalStories} stor${Number(totalStories) === 1 ? 'y' : 'ies'}`
    : '';
  const prPart = prUrl ? ` · PR: ${prUrl}` : '';
  const message = `Epic #${epicIdNum} complete${wavePart}${storyPart}${prPart}.`;
  try {
    await notify(
      epicIdNum,
      {
        severity: 'medium',
        message,
        event: 'epic-complete',
        level: 'epic',
        epicId: epicIdNum,
        prUrl: prUrl ?? null,
      },
      { skipComment: true },
    );
  } catch (err) {
    logger?.warn?.(
      `[emitEpicComplete] notify dispatch failed (swallowed): ${err?.message ?? err}`,
    );
  }
  return null;
}
