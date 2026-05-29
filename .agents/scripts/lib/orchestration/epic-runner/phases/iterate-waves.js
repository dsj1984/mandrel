/**
 * Iterate-waves phase — the wave loop.
 *
 * Before the loop: flip Epic to `agent::executing` and initialize checkpoint.
 *
 * Inside the loop: dispatch each wave via StoryLauncher, apply the
 * CommitAssertion to reclassify zero-delta `done` stories as `failed`,
 * record wave history, checkpoint, and delegate blocker halts to
 * BlockerHandler. An unresumed halt short-circuits the pipeline with a
 * `halted` outcome.
 *
 * The loop body is decomposed into single-responsibility helpers so the
 * top-level `runIterateWavesPhase` stays under the cyclomatic must-fix
 * threshold:
 *   - `resolveDoneSkips` — resume-skip filtering (already-`agent::done`).
 *   - `dispatchWave` — bus-session vs. legacy launcher dispatch.
 *   - `buildWaveEndOutcomes` — assemble + invariant-check the outcomes map.
 *   - `handleWaveBlocker` — blocker emit, wait, and resume side effects.
 *
 * Epic #2646 Story C (Task #2694) — the legacy `wave-observer.js` writer
 * was retired in favor of the bus-driven
 * `lifecycle/listeners/structured-comment-poster.js`. The phase still
 * holds the commit-assertion reclassification logic (it must run
 * BEFORE `wave.end` is emitted so the listener sees the post-assertion
 * outcomes) and now passes the rich body data — `totalWaves`,
 * `startedAt`, `completedAt`, `durationMs`, and per-story rows with
 * `detail`/`newCommitCount` — through the `wave.start`/`wave.end`
 * payloads. The structured-comment-poster owns the `wave-<n>-start` /
 * `wave-<n>-end` markers (rich body inherited from the observer) and
 * the `lifecycle-epic-blocked` / `lifecycle-epic-unblocked` markers.
 *
 * `wave.end.outcomes` is invariant-checked: its key set MUST equal the
 * `wave.start.storyIds` set. The check throws before emit so a violation
 * cannot land in the ledger.
 */

import { getRunners } from '../../../config/runners.js';
import { AGENT_LABELS } from '../../../label-constants.js';
import { concurrentMap } from '../../../util/concurrent-map.js';
import {
  assertWaveCompleteness,
  collectHaltedStoryIds,
} from '../../../wave-runner/wave-checkpoint.js';
import { DEFAULT_CONCURRENCY } from '../../concurrency.js';
import { createWaveSession } from '../../wave-session.js';
import { COMMIT_ASSERTION_ZERO_DELTA_DETAIL } from '../commit-assertion.js';
import {
  emitEpicProgress,
  emitEpicStarted,
  emitEpicUnblocked,
} from '../progress-reporter.js';

/**
 * Coerce a wave's `stories` entries into the integer ID array required
 * by `wave.start.storyIds`. Stories may be wave-scheduler nodes
 * (`{ id }`), bare numbers, or numeric strings (legacy fixtures).
 * Anything non-integer is dropped so the emitted payload always
 * validates against `.agents/schemas/lifecycle/wave.start.schema.json`.
 */
function extractStoryIds(stories) {
  if (!Array.isArray(stories)) return [];
  const out = [];
  for (const s of stories) {
    const raw =
      typeof s === 'object' && s !== null ? (s.id ?? s.storyId ?? s.number) : s;
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) out.push(id);
  }
  return out;
}

/**
 * Build the `wave.start.stories` array (`{ id, title? }` entries) from a
 * wave's scheduler nodes, dropping anything that does not resolve to a
 * positive integer id. Extracted so the dispatch path reads as a single
 * call rather than an inline map/filter chain.
 *
 * @param {Array<object|number|string>} stories
 * @returns {Array<{id: number, title?: string}>}
 */
function buildWaveStartStories(stories) {
  const list = Array.isArray(stories) ? stories : [];
  return list
    .map((s) => {
      const raw =
        typeof s === 'object' && s !== null
          ? (s.id ?? s.storyId ?? s.number)
          : s;
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) return null;
      const title =
        typeof s === 'object' && s !== null && typeof s.title === 'string'
          ? s.title
          : undefined;
      return title ? { id, title } : { id };
    })
    .filter(Boolean);
}

/**
 * Apply the CommitAssertion to the launcher's per-story outcome rows.
 * Reclassifies any `done` row whose Story branch produced zero new
 * commits as `failed` with the canonical zero-delta detail. Errors from
 * the assertion are swallowed and logged — the original rows pass
 * through unchanged so a transient `git` failure cannot halt the wave.
 *
 * Epic #2646 Story C — moved here from `wave-observer.js` so the
 * post-assertion outcomes are emitted directly through the bus.
 */
async function applyCommitAssertion({
  stories,
  commitAssertion,
  epicId,
  logger,
}) {
  const rows = Array.isArray(stories) ? stories : [];
  if (!commitAssertion) return rows.map((r) => ({ ...r }));
  const doneIds = rows.filter((r) => r.status === 'done').map((r) => r.storyId);
  if (doneIds.length === 0) return rows.map((r) => ({ ...r }));
  let deltas;
  try {
    deltas = await commitAssertion.check(doneIds, { epicId });
  } catch (err) {
    logger?.warn?.(
      `[iterate-waves] commit-assertion check failed: ${err?.message ?? err}`,
    );
    return rows.map((r) => ({ ...r }));
  }
  const byId = new Map(deltas.map((d) => [d.storyId, d]));
  return rows.map((row) => {
    if (row.status !== 'done') return { ...row };
    const delta = byId.get(row.storyId);
    if (!delta || delta.newCommitCount !== 0) return { ...row };
    return {
      ...row,
      status: 'failed',
      detail: COMMIT_ASSERTION_ZERO_DELTA_DETAIL,
      newCommitCount: 0,
    };
  });
}

/**
 * Resume-skip resolution. Reads fresh labels for the wave's Stories and
 * splits them into the Stories that still need launching (`toLaunch`)
 * and the synthetic `skipped`-as-`done` rows for Stories already carrying
 * `agent::done` on resume (`skippedResults`).
 *
 * Without this, the runner re-dispatches every Story in every wave after
 * a blocker halt — each spawn creates a fresh `story-<id>` branch +
 * `.worktrees/story-<id>/` checkout + `npm ci` before the sub-agent
 * notices the ticket is already closed and bails.
 *
 * Story #1795 — only Stories the checkpoint reports as halted on a prior
 * wave are force-refreshed (`fresh: true`); every other Story serves the
 * resume-check from the provider's in-process cache.
 *
 * @returns {Promise<{toLaunch: Array<object>, skippedResults: Array<object>}>}
 */
async function resolveDoneSkips({
  wave,
  provider,
  haltedStoryIds,
  ctx,
  scheduler,
  logger,
}) {
  const waveStoryIds = wave.stories.map((s) => s.id ?? s.storyId ?? s);
  const freshStates = await concurrentMap(
    waveStoryIds,
    async (id) => {
      try {
        const opts = haltedStoryIds.has(id) ? { fresh: true } : {};
        const ticket = await provider.getTicket(id, opts);
        return { id, labels: ticket?.labels ?? [] };
      } catch {
        return { id, labels: [] };
      }
    },
    {
      concurrency:
        ctx.concurrency?.progressReporter ??
        DEFAULT_CONCURRENCY.progressReporter,
    },
  );
  const doneIds = new Set(
    freshStates
      .filter((s) => s.labels.includes(AGENT_LABELS.DONE))
      .map((s) => s.id),
  );
  const toLaunch = wave.stories.filter(
    (s) => !doneIds.has(s.id ?? s.storyId ?? s),
  );
  const skippedResults = [...doneIds].map((storyId) => ({
    storyId,
    status: 'done',
    detail: 'already agent::done on resume; dispatch skipped',
  }));
  if (skippedResults.length) {
    logger.info?.(
      `[EpicRunner] Wave ${wave.index + 1}/${scheduler.totalWaves} skipping ${skippedResults.length} already-done stor${skippedResults.length === 1 ? 'y' : 'ies'}: ${[...doneIds].map((id) => `#${id}`).join(', ')}`,
    );
  }
  return { toLaunch, skippedResults };
}

/**
 * Convert a single wave-session settled return into the legacy
 * launcher-row shape (`{ storyId, status, detail? }`) the wave loop
 * consumes downstream. A malformed-return path produces a synthetic
 * `failed` row in wave-session; this preserves it.
 *
 * @param {object} story Scheduler node for the launched Story.
 * @param {{returns: Record<number, object>, outcomes: Record<number, string>}} settled
 * @returns {{storyId: number, status: string, detail?: string}}
 */
function sessionRowFor(story, settled) {
  const id = Number(story.id ?? story.storyId ?? story.number);
  const row = settled.returns[id];
  if (row && typeof row === 'object') {
    return {
      storyId: id,
      status: row.status ?? settled.outcomes[id] ?? 'failed',
      ...(row.detail ? { detail: row.detail } : {}),
    };
  }
  return { storyId: id, status: settled.outcomes[id] ?? 'failed' };
}

/**
 * Dispatch a wave's launchable Stories.
 *
 * When a bus is wired in, route the launch through a `wave-session` so
 * the `story.dispatch.start` / `story.dispatch.end` pair lands on the
 * ledger in submission order. The session's `dispatchFn` delegates to
 * `launcher.launchWave` one Story at a time (the launcher signature
 * accepts an array, so each call wraps a one-Story array and unwraps the
 * single-element result); concurrency is owned by wave-session's `cap`.
 *
 * When no bus is present, fall back to the legacy launcher path.
 *
 * Either way, the synthetic `skippedResults` rows are prepended so the
 * returned array covers the full wave.
 *
 * @returns {Promise<Array<object>>} launcher-row array for the whole wave.
 */
async function dispatchWave({
  wave,
  toLaunch,
  skippedResults,
  bus,
  launcher,
  concurrencyCap,
  waveSessionFactory,
}) {
  if (bus && toLaunch.length) {
    const session = waveSessionFactory({ bus, waveIndex: wave.index });
    const settled = await session.run({
      stories: toLaunch.map((s) => ({
        ...s,
        id: Number(s.id ?? s.storyId ?? s.number),
      })),
      cap: concurrencyCap,
      dispatchFn: async (story) => {
        const rows = await launcher.launchWave([story]);
        return rows[0] ?? { status: 'failed', storyId: story.id };
      },
    });
    const sessionRows = toLaunch.map((s) => sessionRowFor(s, settled));
    return [...skippedResults, ...sessionRows];
  }
  const spawned = toLaunch.length ? await launcher.launchWave(toLaunch) : [];
  return [...skippedResults, ...spawned];
}

/**
 * Assemble the `wave.end.outcomes` map from the post-assertion result
 * rows and the resume-skip rows, then invariant-check it against the
 * `wave.start.storyIds` set (AC-8 wave completeness). The check throws
 * before the caller emits so a violation cannot land on the bus or in
 * the ledger.
 *
 * Stories that were already-done on resume show up as `skipped`. Any
 * launcher status outside the outcome enum collapses to `failed`.
 *
 * @returns {Record<number, string>} the validated outcomes map.
 */
function buildWaveEndOutcomes({
  waveIndex,
  waveStartStoryIds,
  results,
  skippedResults,
}) {
  const outcomes = {};
  for (const row of skippedResults) {
    outcomes[row.storyId] = 'skipped';
  }
  for (const row of results) {
    const id = Number(row.storyId);
    if (!Number.isInteger(id)) continue;
    const outcome =
      row.status === 'done' ||
      row.status === 'blocked' ||
      row.status === 'failed' ||
      row.status === 'skipped'
        ? row.status
        : 'failed';
    outcomes[id] = outcome;
  }
  assertWaveCompleteness({ waveIndex, storyIds: waveStartStoryIds, outcomes });
  return outcomes;
}

/**
 * Map a post-assertion result row into the `wave.end.stories[]` entry
 * shape. Pulls `storyId`/`status` (always present) and the optional
 * `detail` / `newCommitCount` diagnostics.
 *
 * @param {object} row
 * @returns {{storyId: number, status: string, detail?: string, newCommitCount?: number|null}}
 */
function waveEndStoryEntry(row) {
  const out = {
    storyId: Number(row.storyId),
    status: String(row.status ?? 'failed'),
  };
  if (row.detail) out.detail = String(row.detail);
  if (row.newCommitCount === null || Number.isInteger(row.newCommitCount)) {
    out.newCommitCount = row.newCommitCount;
  }
  return out;
}

/**
 * Handle a wave that produced failures: emit `story.blocked` on the bus,
 * fire the post-blocked progress snapshot, wait for operator resume via
 * `blockerWait`, and — on resume — fire the resume side effects
 * (`epic.unblocked` cascade, legacy `epic-unblocked` notify, cleared
 * progress).
 *
 * Returns `{ resumed }`. When `resumed` is `false` the caller
 * short-circuits the wave loop with a `halted` completion state.
 *
 * The bus emits and the unblocked cascade are best-effort: a transient
 * failure must not abort the wait loop, because the operator still needs
 * to resume the Epic.
 *
 * @returns {Promise<{resumed: boolean}>}
 */
async function handleWaveBlocker({
  failures,
  bus,
  blockerWait,
  blockerHandler,
  notifyFn,
  epicId,
  doneStoriesSoFar,
  totalStories,
  scheduler,
  logger,
  journal,
  journalSuffix,
}) {
  const firstFailure = failures[0];
  const blockerInfo = {
    reason:
      firstFailure.status === 'blocked' ? 'story_blocked' : 'story_failed',
    storyId: firstFailure.storyId,
    detail: firstFailure.detail,
  };
  if (bus && Number.isInteger(blockerInfo.storyId)) {
    try {
      await bus.emit('story.blocked', {
        storyId: Number(blockerInfo.storyId),
        reason: blockerInfo.reason,
      });
    } catch (err) {
      logger.warn?.(
        `[EpicRunner] story.blocked emit failed (swallowed): ${err?.message ?? err}${journalSuffix()}`,
      );
      await journal?.record({
        module: 'EpicRunner',
        op: 'bus.emit(story.blocked)',
        error: err,
        recovery: 'swallowed',
      });
    }
  }
  const halt = blockerWait
    ? await blockerWait(blockerInfo)
    : { resumed: false, reasonToStop: 'no-wait-helper' };
  await emitEpicProgress({
    notify: notifyFn,
    epicId,
    done: doneStoriesSoFar,
    total: totalStories,
    currentWave: scheduler.currentWave,
    totalWaves: scheduler.totalWaves,
    phase: 'iterate-waves',
    openBlockers: [
      { reason: blockerInfo.reason, storyId: blockerInfo.storyId },
    ],
    logger,
  });
  if (!halt.resumed) return { resumed: false };
  if (blockerHandler && typeof blockerHandler.emitUnblocked === 'function') {
    try {
      await blockerHandler.emitUnblocked();
    } catch (err) {
      logger.warn?.(
        `[EpicRunner] emitUnblocked failed (swallowed): ${err?.message ?? err}${journalSuffix()}`,
      );
    }
  }
  // Curated `epic-unblocked` notify fire for webhook consumers that
  // parse the legacy envelope alongside the bus-driven cascade. This is
  // a permanent dual-path: `emitUnblocked` drives the bus listeners and
  // this call drives the standalone webhook surface; neither subsumes
  // the other.
  await emitEpicUnblocked({
    notify: notifyFn,
    epicId,
    resolvedBlocker: blockerInfo,
    logger,
  });
  await emitEpicProgress({
    notify: notifyFn,
    epicId,
    done: doneStoriesSoFar,
    total: totalStories,
    currentWave: scheduler.currentWave,
    totalWaves: scheduler.totalWaves,
    phase: 'iterate-waves',
    openBlockers: [],
    logger,
  });
  return { resumed: true };
}

/**
 * Sum the `done` Stories across the committed wave history. Counts come
 * from per-wave `results.status`, not from re-querying labels, so the
 * snapshot matches what the operator just observed settle.
 *
 * @param {Array<{stories?: Array<{status?: string}>}>} waveHistory
 * @returns {number}
 */
function countDoneStories(waveHistory) {
  return waveHistory.reduce(
    (acc, w) =>
      acc + (w.stories ?? []).filter((s) => s?.status === 'done').length,
    0,
  );
}

export async function runIterateWavesPhase(ctx, collaborators, state) {
  const { epicId, provider, config, logger } = ctx;
  const { concurrencyCap } = getRunners(config).deliverRunner;
  const {
    notify: notifyFn,
    epicRunStateStore,
    blockerHandler,
    blockerWait,
    launcher,
    commitAssertion,
    journal,
    bus = null,
    waveSessionFactory = createWaveSession,
  } = collaborators;
  const journalSuffix = () => (journal?.path ? ` (see ${journal.path})` : '');
  const { scheduler, waves, epic } = state;

  // Epic-level `agent::executing` flip is owned by the LabelTransitioner
  // lifecycle listener (subscribes to `epic.unblocked` on resume) and by
  // the upstream dispatch surface that flips the Epic before this phase
  // is reached on a cold start. The Projects v2 Status column is now
  // synced inside `transitionTicketState` itself (Story #2548), so no
  // explicit column-board mirror call is needed here.
  await epicRunStateStore.initialize({
    totalWaves: scheduler.totalWaves,
    concurrencyCap,
  });

  // Story #1795 — resume-check cache pre-warm. Read the checkpoint once
  // up-front and build the force-fresh Set; see `resolveDoneSkips`.
  const checkpoint = await epicRunStateStore.read().catch(() => null);
  const haltedStoryIds = collectHaltedStoryIds(checkpoint);

  // Curated webhook fires: `epic-started` anchors the epic narrative; the
  // initial `epic-progress` puts the consumer at 0% with the full
  // story-count denominator. Both are fire-and-forget; webhook misconfig
  // must not block dispatch.
  const totalStories = waves.reduce(
    (acc, w) => acc + (Array.isArray(w) ? w.length : 0),
    0,
  );
  await emitEpicStarted({
    notify: notifyFn,
    epicId,
    totalWaves: scheduler.totalWaves,
    totalStories,
    title: epic?.title,
    logger,
  });
  await emitEpicProgress({
    notify: notifyFn,
    epicId,
    done: 0,
    total: totalStories,
    currentWave: 0,
    totalWaves: scheduler.totalWaves,
    phase: 'iterate-waves',
    openBlockers: [],
    logger,
  });

  const waveHistory = [];
  while (scheduler.hasMoreWaves()) {
    const wave = scheduler.nextWave();
    logger.info?.(
      `[EpicRunner] Wave ${wave.index + 1}/${scheduler.totalWaves} dispatching ${wave.stories.length} stor${wave.stories.length === 1 ? 'y' : 'ies'}`,
    );
    const startedAt = new Date().toISOString();

    const { toLaunch, skippedResults } = await resolveDoneSkips({
      wave,
      provider,
      haltedStoryIds,
      ctx,
      scheduler,
      logger,
    });

    // Story #2239 — wave.start / wave.end lifecycle emits. When a bus is
    // wired in, emit `wave.start` BEFORE dispatch. `wave.end.outcomes` is
    // invariant-checked against `wave.start.storyIds` before emit (AC-8).
    const waveStartStoryIds = extractStoryIds(wave.stories);
    const waveStartStories = buildWaveStartStories(wave.stories);
    if (bus) {
      await bus.emit('wave.start', {
        waveIndex: wave.index,
        storyIds: waveStartStoryIds,
        totalWaves: scheduler.totalWaves,
        stories: waveStartStories,
        startedAt,
      });
    }

    const launchResults = await dispatchWave({
      wave,
      toLaunch,
      skippedResults,
      bus,
      launcher,
      concurrencyCap,
      waveSessionFactory,
    });

    scheduler.markWaveComplete(wave.index);
    // Epic #2646 Story C — commit-assertion reclassification used to live
    // inside `wave-observer.js`. Now that the observer is retired, the
    // phase applies the assertion inline so the post-assertion outcomes
    // flow into both the `wave.end` payload and the `waveHistory`
    // checkpoint atomically.
    const results = await applyCommitAssertion({
      stories: launchResults,
      commitAssertion,
      epicId,
      logger,
    });
    const completedAt = new Date().toISOString();
    const durationMs = startedAt
      ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
      : null;
    const failures = results.filter(
      (r) => r.status === 'failed' || r.status === 'blocked',
    );

    // Emit wave.end with the post-commit-assertion outcomes map. The
    // outcomes set MUST exactly cover the wave.start.storyIds set (AC-8).
    if (bus) {
      const outcomes = buildWaveEndOutcomes({
        waveIndex: wave.index,
        waveStartStoryIds,
        results,
        skippedResults,
      });
      await bus.emit('wave.end', {
        waveIndex: wave.index,
        outcomes,
        totalWaves: scheduler.totalWaves,
        startedAt,
        completedAt,
        durationMs,
        stories: results.map(waveEndStoryEntry),
      });
    }

    waveHistory.push({
      index: wave.index,
      status: failures.length ? 'halted' : 'completed',
      stories: results,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    await epicRunStateStore.write({
      currentWave: scheduler.currentWave,
      totalWaves: scheduler.totalWaves,
      waves: waveHistory,
    });

    // Wave-boundary `epic-progress` fire. When there are failures we
    // delay this fire until after the blocker handler so `openBlockers`
    // carries the actual reason instead of being empty for one tick.
    const doneStoriesSoFar = countDoneStories(waveHistory);
    if (!failures.length) {
      await emitEpicProgress({
        notify: notifyFn,
        epicId,
        done: doneStoriesSoFar,
        total: totalStories,
        currentWave: scheduler.currentWave,
        totalWaves: scheduler.totalWaves,
        phase: 'iterate-waves',
        openBlockers: [],
        logger,
      });
      continue;
    }

    const { resumed } = await handleWaveBlocker({
      failures,
      bus,
      blockerWait,
      blockerHandler,
      notifyFn,
      epicId,
      doneStoriesSoFar,
      totalStories,
      scheduler,
      logger,
      journal,
      journalSuffix,
    });
    if (!resumed) {
      return {
        ...state,
        waveHistory,
        completionState: 'halted',
      };
    }
  }

  return {
    ...state,
    waveHistory,
    completionState: 'completed',
  };
}
