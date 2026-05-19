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
 * Cross-event invariant guard for `wave.end` (Acceptance Spec AC-8 /
 * Repeatability AC #5 — wave completeness).
 *
 * The schema layer can declare key/value types for `outcomes` but
 * cannot enforce that the key set equals the `wave.start.storyIds` set
 * from earlier in the run. We enforce it here, before emit, so a
 * violation throws synchronously and the ledger never carries a
 * non-conformant record.
 *
 * Throws a typed `Error` with `code: 'WAVE_COMPLETENESS_VIOLATION'` and
 * attached diagnostic fields so tests and operators can reason about
 * the mismatch without grepping the message.
 *
 * @param {{ waveIndex: number, storyIds: number[], outcomes: Record<string, string> }} args
 */
export function assertWaveCompleteness({ waveIndex, storyIds, outcomes }) {
  const expected = new Set(storyIds);
  const actual = new Set(
    Object.keys(outcomes ?? {})
      .map((k) => Number(k))
      .filter((n) => Number.isInteger(n)),
  );
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length === 0 && extra.length === 0) return;
  const err = new Error(
    `wave-completeness violation for wave #${waveIndex}: ${
      missing.length ? `missing outcomes for [${missing.join(', ')}]` : ''
    }${missing.length && extra.length ? '; ' : ''}${
      extra.length ? `extra outcomes for [${extra.join(', ')}]` : ''
    }`,
  );
  err.code = 'WAVE_COMPLETENESS_VIOLATION';
  err.waveIndex = waveIndex;
  err.missing = missing;
  err.extra = extra;
  throw err;
}

/**
 * Pull the set of Story IDs that the prior checkpoint marked as part of
 * a halted wave. Story #1795 — used by the resume-check cache pre-warm:
 * Stories appearing in this set are force-fresh-fetched on resume (the
 * operator may have hand-edited their labels during the blocker
 * window); every other Story serves its resume-check from the
 * provider's in-process cache.
 *
 * Tolerant of partial/legacy checkpoint shapes: a missing or
 * unparseable checkpoint returns an empty set so the resume-check
 * gracefully degrades to "use cache for all" — the existing
 * cold-start fallback inside `getTicket` still issues the real fetch.
 *
 * @param {object | null | undefined} checkpoint
 * @returns {Set<number>}
 */
export function collectHaltedStoryIds(checkpoint) {
  const halted = new Set();
  const waves = checkpoint?.waves;
  if (!Array.isArray(waves)) return halted;
  for (const wave of waves) {
    if (wave?.status !== 'halted') continue;
    const stories = Array.isArray(wave.stories) ? wave.stories : [];
    for (const story of stories) {
      const id =
        story?.storyId ??
        story?.id ??
        (typeof story === 'number' ? story : null);
      if (Number.isInteger(id) && id > 0) halted.add(id);
    }
  }
  return halted;
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
    progressReporter,
    journal,
    bus = null,
    waveSessionFactory = createWaveSession,
  } = collaborators;
  const journalSuffix = () => (journal?.path ? ` (see ${journal.path})` : '');
  const { scheduler, waves, epic } = state;

  progressReporter.setPlan({ waves });

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

  // Story #1795 — resume-check cache pre-warm.
  // Read the checkpoint once up-front and build a Set of story IDs that
  // were in a `halted` wave on the previous run. Those Stories may have
  // had their labels hand-edited by the operator during the resume
  // window, so the per-wave resume-check must still force-fresh them.
  // Every other Story serves the resume-check from the provider's
  // in-process cache — eliminating the `fresh: true` round-trip we
  // historically issued for every Story in every wave.
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

  // The framework no longer owns versioning (Epic #1720 — release tooling is
  // a consumer-project concern). The version-bump-intent module was removed
  // along with the schema knobs (`release.autoVersionBump` etc.) that drove
  // it; no replacement runs here.

  const waveHistory = [];
  while (scheduler.hasMoreWaves()) {
    const wave = scheduler.nextWave();
    logger.info?.(
      `[EpicRunner] Wave ${wave.index + 1}/${scheduler.totalWaves} dispatching ${wave.stories.length} stor${wave.stories.length === 1 ? 'y' : 'ies'}`,
    );
    const startedAt = new Date().toISOString();

    progressReporter.setWave({
      index: wave.index,
      totalWaves: scheduler.totalWaves,
      stories: wave.stories,
      startedAt,
    });
    progressReporter.start();

    // Short-circuit stories that are already `agent::done` on resume.
    // Without this, the runner re-dispatches every Story in every wave after
    // a blocker halt — each spawn creates a fresh `story-<id>` branch +
    // `.worktrees/story-<id>/` checkout + `npm ci` before the sub-agent
    // notices the ticket is already closed and bails. Filter here so the
    // launcher only sees real work.
    const waveStoryIds = wave.stories.map((s) => s.id ?? s.storyId ?? s);
    // Story #1795 — resume-check now reads labels from the cache by
    // default. Only Stories that the checkpoint reports as halted on a
    // prior wave are force-refreshed, since they're the operator-resume
    // case where labels may have been hand-edited. Cold-start tickets
    // (cache miss) fall through to the underlying provider read, which
    // historically issued the same single fetch the legacy fresh:true
    // path did.
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
    // Story #2239 — wave.start / wave.end lifecycle emits.
    //
    // When a bus is wired in, emit `wave.start` BEFORE dispatch and
    // route the wave through `wave-session.run()` so the
    // `story.dispatch.start` / `story.dispatch.end` pair lands on the
    // ledger in submission order with serial-emit ordering. The
    // wave-session's `dispatchFn` delegates to `launcher.launchWave`
    // for a single story at a time — the launcher's signature accepts
    // an array, so we wrap each call in a one-story array and unwrap
    // its single-element result.
    //
    // `wave.end.outcomes` is invariant-checked against
    // `wave.start.storyIds` before emit (AC-8). The check throws on
    // violation; the bus never sees a non-conformant payload.
    const waveStartStoryIds = extractStoryIds(wave.stories);
    const waveStartStories = (Array.isArray(wave.stories) ? wave.stories : [])
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
    if (bus) {
      await bus.emit('wave.start', {
        waveIndex: wave.index,
        storyIds: waveStartStoryIds,
        totalWaves: scheduler.totalWaves,
        stories: waveStartStories,
        startedAt,
      });
    }

    let launchResults;
    if (bus && toLaunch.length) {
      // Route the launch through a wave-session so `story.dispatch.*`
      // events land on the bus. The session's dispatchFn delegates to
      // the launcher one story at a time so the launcher contract
      // (it accepts an array) is preserved; concurrency is owned by
      // wave-session's `cap`, not the launcher.
      const session = waveSessionFactory({
        bus,
        waveIndex: wave.index,
      });
      const settled = await session.run({
        stories: toLaunch.map((s) => ({
          ...s,
          id: Number(s.id ?? s.storyId ?? s.number),
        })),
        cap: concurrencyCap,
        dispatchFn: async (story) => {
          // The launcher takes an array and returns an array; wrap and
          // unwrap. A launcher row carries `{ storyId, status, detail? }`
          // — coerce it into the child-return shape wave-session expects
          // (`{ status }` works for parseChildReturn) by passing through
          // as-is; the launcher already produces `status: 'done'|'failed'
          // |'blocked'`, which matches the outcome enum after the
          // session's coercion.
          const rows = await launcher.launchWave([story]);
          return rows[0] ?? { status: 'failed', storyId: story.id };
        },
      });
      // Convert wave-session's `returns` map back into the legacy
      // launcher-row array shape the wave loop expects downstream.
      const sessionRows = toLaunch.map((s) => {
        const id = Number(s.id ?? s.storyId ?? s.number);
        const row = settled.returns[id];
        // Defensive: a malformed-return path produces a synthetic
        // `failed` row in wave-session; preserve it.
        if (row && typeof row === 'object') {
          return {
            storyId: id,
            status: row.status ?? settled.outcomes[id] ?? 'failed',
            ...(row.detail ? { detail: row.detail } : {}),
          };
        }
        return { storyId: id, status: settled.outcomes[id] ?? 'failed' };
      });
      launchResults = [...skippedResults, ...sessionRows];
    } else {
      const spawned = toLaunch.length
        ? await launcher.launchWave(toLaunch)
        : [];
      launchResults = [...skippedResults, ...spawned];
    }
    await progressReporter.stop();

    scheduler.markWaveComplete(wave.index);
    // Epic #2646 Story C — commit-assertion reclassification used to
    // live inside `wave-observer.js`. Now that the observer is retired,
    // the phase applies the assertion inline so the post-assertion
    // outcomes flow into both the `wave.end` payload and the
    // `waveHistory` checkpoint atomically.
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
    // outcomes set MUST exactly cover the wave.start.storyIds set
    // (AC-8 wave completeness). Stories that were already-done on
    // resume show up as `skipped`. The invariant check throws before
    // emit so a violation cannot land on the bus or in the ledger.
    if (bus) {
      const outcomes = {};
      // Seed with skipped entries for resume-skip stories so the
      // outcomes map is complete even when launcher returned nothing.
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
      // Ensure every wave.start storyId is present in outcomes — if a
      // launcher row was dropped or the result set is incomplete, the
      // invariant guard surfaces it now rather than at the next emit.
      assertWaveCompleteness({
        waveIndex: wave.index,
        storyIds: waveStartStoryIds,
        outcomes,
      });
      await bus.emit('wave.end', {
        waveIndex: wave.index,
        outcomes,
        totalWaves: scheduler.totalWaves,
        startedAt,
        completedAt,
        durationMs,
        stories: results.map((row) => {
          const out = {
            storyId: Number(row.storyId),
            status: String(row.status ?? 'failed'),
          };
          if (row.detail) out.detail = String(row.detail);
          if (
            row.newCommitCount === null ||
            Number.isInteger(row.newCommitCount)
          ) {
            out.newCommitCount = row.newCommitCount;
          }
          return out;
        }),
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

    // Wave-boundary `epic-progress` fire — sum done stories across the
    // committed wave history. Counts come from per-wave `results.status`
    // (the result type WaveObserver returned), not from re-querying
    // labels, so the snapshot matches what the operator just observed
    // settle. When there are failures we delay this fire until after the
    // blocker handler so `openBlockers` carries the actual reason instead
    // of being empty for one tick.
    const doneStoriesSoFar = waveHistory.reduce(
      (acc, w) =>
        acc + (w.stories ?? []).filter((s) => s?.status === 'done').length,
      0,
    );
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
    }

    if (failures.length) {
      const firstFailure = failures[0];
      const blockerInfo = {
        reason:
          firstFailure.status === 'blocked' ? 'story_blocked' : 'story_failed',
        storyId: firstFailure.storyId,
        detail: firstFailure.detail,
      };
      // Story #2548 — Projects v2 Status column is synced inside
      // `transitionTicketState` itself; the bus cascade below triggers
      // the LabelTransitioner listener whose flip to `agent::blocked`
      // updates the column automatically. The previous inline
      // `syncColumn` mirror is redundant.
      // Story #2241 / Task #2246 — emit `story.blocked` on the bus. The
      // lifecycle BlockerHandler listener (registered by the factory)
      // classifies it and cascades to `epic.blocked`; the
      // LabelTransitioner / StructuredCommentPoster / NotifyDispatcher
      // listeners then own the label flip, structured comment, and
      // webhook side effects. The cascade is best-effort; a bus failure
      // must not abort the wait loop because the operator still needs
      // to resume the Epic.
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
      // Post-blocked progress refresh: the lifecycle NotifyDispatcher
      // listener fires `epic-blocked` from the bus cascade; we follow
      // up with an `epic-progress` snapshot carrying the open blocker
      // so a Slack consumer sees the current state alongside the
      // action-required ping. The progress fire still runs on the
      // no-resume path so the snapshot survives the halted bail-out.
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
      if (!halt.resumed) {
        return {
          ...state,
          waveHistory,
          completionState: 'halted',
        };
      }
      // Story #2548 — column sync is handled by `transitionTicketState`
      // via the LabelTransitioner listener that reacts to
      // `epic.unblocked`. No explicit mirror call needed here.
      // Story #2241 / Task #2246 — emit `epic.unblocked` once the
      // operator's resume is observed. The lifecycle BlockerHandler
      // listener clears its active-cascade tracker and the downstream
      // LabelTransitioner / NotifyDispatcher / StructuredCommentPoster
      // listeners produce the resume side effects.
      if (
        blockerHandler &&
        typeof blockerHandler.emitUnblocked === 'function'
      ) {
        try {
          await blockerHandler.emitUnblocked();
        } catch (err) {
          logger.warn?.(
            `[EpicRunner] emitUnblocked failed (swallowed): ${err?.message ?? err}${journalSuffix()}`,
          );
        }
      }
      // Legacy notify fire — kept during the bus-cutover window for
      // operators whose webhook consumers still parse the original
      // `epic-unblocked` envelope. Removed in a follow-up Story.
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
    }
  }

  return {
    ...state,
    waveHistory,
    completionState: 'completed',
  };
}
