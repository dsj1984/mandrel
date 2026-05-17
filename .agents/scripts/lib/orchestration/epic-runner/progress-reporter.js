/**
 * progress-reporter.js — facade module for the /epic-deliver progress
 * narrative. Story #1847 split the original 1158-LOC monolith into three
 * sibling sub-modules under `progress-reporter/`:
 *
 *   - `composition.js` — structured-comment body builders and the
 *     `ProgressReporter` class's pure rendering helpers.
 *   - `transport.js` — the curated webhook emit surface (epic-started,
 *     epic-progress, epic-blocked, epic-unblocked, epic-complete).
 *   - `signals.js` — pure parse/aggregate over `story-run-progress` and
 *     `phase-timings` structured comments + the shared state lookup
 *     tables (PHASE_TO_STATE, PHASE_ORDER, STATE_EMOJI).
 *
 * The `ProgressReporter` class — the periodic-emission orchestration
 * shell — lives here and composes the sub-modules. All other public
 * symbols are re-exported below so existing import paths
 * (`epic-execute-record-wave.js`, the test suite, `wave-record-notifications.js`)
 * continue to resolve without churn.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AGENT_LABELS } from '../../label-constants.js';
import { appendSignal } from '../../observability/signals-writer.js';
import { concurrentMap } from '../../util/concurrent-map.js';
import { DEFAULT_CONCURRENCY } from '../concurrency.js';
import {
  findStructuredComment,
  upsertStructuredComment,
} from '../ticketing.js';
import { runHotspotDetection } from './hotspot-detection.js';
import {
  deriveState as deriveStateFromComposition,
  renderProgressBody as renderProgressBodyFromComposition,
  truncate as truncateFromComposition,
  upsertEpicRunProgress as upsertEpicRunProgressFromComposition,
} from './progress-reporter/composition.js';
import { escalateFireFailure } from './progress-reporter/fire-escalation.js';
import {
  aggregatePhaseTimings as aggregatePhaseTimingsFromSignals,
  EPIC_RUN_PROGRESS_TYPE as EPIC_RUN_PROGRESS_TYPE_FROM_SIGNALS,
  PHASE_TIMINGS_TYPE as PHASE_TIMINGS_TYPE_FROM_SIGNALS,
  parsePhaseTimingsComment as parsePhaseTimingsCommentFromSignals,
  parseStoryRunProgressComment as parseStoryRunProgressCommentFromSignals,
  phaseToState as phaseToStateFromSignals,
  renderPhaseTimingsSection as renderPhaseTimingsSectionFromSignals,
  STORY_RUN_PROGRESS_TYPE as STORY_RUN_PROGRESS_TYPE_FROM_SIGNALS,
} from './progress-reporter/signals.js';
import {
  EPIC_PROGRESS_EVENT as EPIC_PROGRESS_EVENT_FROM_TRANSPORT,
  emitEpicBlocked as emitEpicBlockedFromTransport,
  emitEpicComplete as emitEpicCompleteFromTransport,
  emitEpicProgress as emitEpicProgressFromTransport,
  emitEpicStarted as emitEpicStartedFromTransport,
  emitEpicUnblocked as emitEpicUnblockedFromTransport,
} from './progress-reporter/transport.js';
import { createStalledWorktreeDetector } from './progress-signals/stalled-worktree.js';

// Re-exports — sub-module surfaces are aliased back to the parent path so
// existing imports (epic-execute-record-wave.js, the test suite,
// wave-record-notifications.js) keep resolving.
export const EPIC_RUN_PROGRESS_TYPE = EPIC_RUN_PROGRESS_TYPE_FROM_SIGNALS;
export const PHASE_TIMINGS_TYPE = PHASE_TIMINGS_TYPE_FROM_SIGNALS;
export const STORY_RUN_PROGRESS_TYPE = STORY_RUN_PROGRESS_TYPE_FROM_SIGNALS;
export const EPIC_PROGRESS_EVENT = EPIC_PROGRESS_EVENT_FROM_TRANSPORT;
export const emitEpicProgress = emitEpicProgressFromTransport;
export const emitEpicStarted = emitEpicStartedFromTransport;
export const emitEpicBlocked = emitEpicBlockedFromTransport;
export const emitEpicUnblocked = emitEpicUnblockedFromTransport;
export const emitEpicComplete = emitEpicCompleteFromTransport;
export const parseStoryRunProgressComment =
  parseStoryRunProgressCommentFromSignals;
export const parsePhaseTimingsComment = parsePhaseTimingsCommentFromSignals;
export const aggregatePhaseTimings = aggregatePhaseTimingsFromSignals;
export const renderPhaseTimingsSection = renderPhaseTimingsSectionFromSignals;
export const phaseToState = phaseToStateFromSignals;
export const upsertEpicRunProgress = upsertEpicRunProgressFromComposition;
export { runHotspotDetection };

export class ProgressReporter {
  /**
   * @param {{
   *   provider: import('../../ITicketingProvider.js').ITicketingProvider,
   *   epicId: number,
   *   intervalSec?: number,
   *   concurrency?: number,
   *   cwd?: string,
   *   config?: object,
   *   detectors?: Array<Function|{ detect: Function }>,
   *   logger?: { info?: Function, warn?: Function },
   *   now?: () => Date,
   *   setInterval?: typeof setInterval,
   *   clearInterval?: typeof clearInterval,
   *   logFile?: string | null,
   *   appendFile?: typeof import('node:fs/promises').appendFile,
   *   mkdir?: typeof import('node:fs/promises').mkdir,
   * }} opts
   *   `config`: resolved config bag forwarded to `signals-writer.appendSignal`
   *   so the per-Story `signals.ndjson` stream lands under the configured
   *   `tempRoot` instead of `process.cwd()`/'temp'.
   */
  constructor(opts = {}) {
    this.provider = opts.provider;
    this.epicId = opts.epicId;
    this.config = opts.config;
    if (!this.provider) {
      throw new TypeError('ProgressReporter requires a provider');
    }
    if (!Number.isInteger(this.epicId)) {
      throw new TypeError('ProgressReporter requires a numeric epicId');
    }
    this.intervalSec = Number(opts.intervalSec ?? 0);
    this.logger = opts.logger ?? console;
    // The periodic timer no longer mirrors to the webhook. Webhook
    // delivery of `epic-progress` is event-driven (wave boundaries,
    // blocker transitions) — see `emitEpicProgress()` below — so the
    // webhook narrative stays focused on the epic rollup instead of every
    // poll interval. Factory passes no `notify` to the reporter anymore;
    // the field is removed to make the responsibility split obvious.
    const cap = opts.concurrency ?? DEFAULT_CONCURRENCY.progressReporter;
    this.concurrency =
      Number.isInteger(cap) && cap >= 1
        ? cap
        : DEFAULT_CONCURRENCY.progressReporter;
    this.now = opts.now ?? (() => new Date());
    this._setInterval = opts.setInterval ?? setInterval;
    this._clearInterval = opts.clearInterval ?? clearInterval;

    this.detectors = Array.isArray(opts.detectors)
      ? opts.detectors.filter(Boolean)
      : [createStalledWorktreeDetector({ cwd: opts.cwd })];

    // Friction signals are appended directly to the per-Story
    // `signals.ndjson` stream via `signals-writer.appendSignal` — no
    // GitHub-comment emitter is wired here (Epic #1030 Story #1042).

    // Optional file sink — when set, every rendered snapshot is appended to
    // this path prefixed by an ISO-timestamped divider. Enables operators
    // (or the /epic-deliver skill) to tail progress in real time even when
    // the runner's stdout is swallowed by a background Bash invocation.
    // Tests omit `logFile` to keep the filesystem clean.
    this.logFile = opts.logFile ?? null;
    this._appendFile = opts.appendFile ?? appendFile;
    this._mkdir = opts.mkdir ?? mkdir;
    this.logFileReady = false;

    this.timer = null;
    this.emitting = false;
    // Counter for consecutive `fire()` failures. Resets to 0 on the first
    // successful fire. When it hits `fireEscalationThreshold`, the reporter
    // emits a friction signal and transitions the Epic to `agent::blocked`
    // so a persistent provider/auth/rate-limit failure stops masquerading
    // as a slow run. See `#escalateFireFailure()` below.
    this.consecutiveFireFailures = 0;
    this.fireEscalationThreshold = Number.isInteger(
      opts.fireEscalationThreshold,
    )
      ? opts.fireEscalationThreshold
      : 3;
    // Cache of per-story phase-timing summaries keyed by storyId. Stories
    // that have posted a `phase-timings` comment hold a parsed summary;
    // stories that are done but posted no summary hold the sentinel
    // `'absent'`. Sentinel-caching prevents re-fetching comments that will
    // never materialize (e.g. legacy stories that closed before this
    // feature shipped). Once a story is done, the comment body is
    // immutable — so one fetch per story per epic run is sufficient.
    this.phaseTimingCache = new Map();
    // Cache of per-story `story-run-progress` reads keyed by storyId. Holds
    // the parsed payload once the Story reaches a terminal `phase` (`done`
    // or `blocked`); holds the sentinel `'absent'` once a fetch confirms no
    // comment exists. Both states make the comment effectively immutable for
    // the remainder of the epic run, so caching saves one provider call per
    // story per fire.
    this.storyProgressCache = new Map();
    this.currentWave = null; // { index, totalWaves, stories: [...], startedAt }
    // Full plan: ordered list of waves, each `{ index, stories: [storyId,...] }`.
    // Set once via `setPlan()` at runner start so each fire renders every wave
    // (queued / in-flight / done) rather than only the active one.
    this.plan = null;
    this.epicStartedAt = null;
  }

  /**
   * Provide the full wave plan once at runner start so subsequent fires can
   * render every wave (not just the active one). `waves` is the same shape
   * `WaveScheduler` consumes — an array of arrays of story objects (or ids).
   *
   * @param {{ waves: Array<Array<number|{id?:number,number?:number,storyId?:number,title?:string}>>, startedAt?: string }} plan
   */
  setPlan(plan) {
    if (!plan || !Array.isArray(plan.waves)) {
      this.plan = null;
      return;
    }
    this.plan = plan.waves.map((stories, index) => ({
      index,
      stories: (stories ?? []).map((s) => {
        if (typeof s === 'object' && s !== null) {
          const id = s.id ?? s.number ?? s.storyId;
          return { id: Number(id), title: s.title ?? '' };
        }
        return { id: Number(s), title: '' };
      }),
    }));
    this.epicStartedAt = plan.startedAt ?? this.now().toISOString();
  }

  /**
   * Returns true when the reporter is configured to emit.
   */
  isEnabled() {
    return Number.isFinite(this.intervalSec) && this.intervalSec > 0;
  }

  /**
   * Update the wave the reporter tracks. Called by the epic-runner each wave.
   *
   * @param {{ index: number, totalWaves: number, stories: Array<number|{id:number}>, startedAt?: string }} wave
   */
  setWave(wave) {
    if (!wave) {
      this.currentWave = null;
      return;
    }
    const stories = (wave.stories ?? []).map((s) =>
      typeof s === 'object' ? (s.id ?? s.storyId) : s,
    );
    this.currentWave = {
      index: wave.index,
      totalWaves: wave.totalWaves,
      stories,
      startedAt: wave.startedAt ?? this.now().toISOString(),
    };
  }

  /**
   * Begin periodic emission. No-op when disabled. Safe to call multiple times.
   */
  start() {
    if (!this.isEnabled() || this.timer) return;
    this.timer = this._setInterval(() => {
      // The reporter is non-fatal by design — a failed read or upsert must
      // not crash the runner — but a silent .catch(() => {}) here masks
      // exactly the kind of degradation operators need to see (rate-limit,
      // network blip, schema drift). `tick()` owns the fire-outcome
      // bookkeeping (consecutive-failure counter, 3-strikes escalation) and
      // is exposed for tests to invoke directly without the timer.
      this.tick().catch((tickErr) => {
        this.logger.warn?.(
          `[ProgressReporter] tick() unexpected failure: ${tickErr?.message ?? tickErr}`,
        );
      });
    }, this.intervalSec * 1000);
    if (this.timer?.unref) this.timer.unref();
    if (this.logFile && this.currentWave) {
      const waveNum = (this.currentWave.index ?? 0) + 1;
      const totalWaves =
        this.currentWave.totalWaves ?? this.plan?.length ?? '?';
      this.#appendToLogFile(
        `### ⏱ ${this.now().toISOString()} — Wave ${waveNum}/${totalWaves} starting\n\n`,
      ).catch((err) => {
        this.logger.warn?.(
          `[ProgressReporter] log header write failed: ${err.message}`,
        );
      });
    }
  }

  /**
   * Stop periodic emission and emit one final snapshot.
   */
  async stop() {
    if (this.timer) {
      this._clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isEnabled()) {
      await this.fire();
    }
  }

  /**
   * Emit one progress snapshot. Idempotent wrt re-entrancy — concurrent fires
   * drop to a single in-flight emit to avoid comment-upsert thrash.
   */
  async fire() {
    if (this.emitting) return null;
    if (!this.currentWave && !this.plan) return null;
    this.emitting = true;
    try {
      // When a plan is set, fetch state for every story in every wave so the
      // table covers the whole epic. Otherwise fall back to the current wave
      // only (back-compat: callers that haven't migrated to setPlan).
      const allIds = this.plan
        ? this.plan.flatMap((w) => w.stories.map((s) => s.id))
        : (this.currentWave?.stories ?? []);
      const fetched = await concurrentMap(
        allIds,
        async (id) => {
          // Prefer the `story-run-progress` structured comment (post-#908,
          // each /story-deliver sub-agent updates this on every Task
          // transition). When no comment exists yet — or it is malformed —
          // fall back to the legacy ticket-label state derivation so we
          // continue to render meaningful state during the rollout window
          // before every Story has migrated to the comment writer.
          const fromComment = await this.#tryReadStoryProgress(id);
          if (fromComment) {
            return [
              id,
              {
                state: fromComment.state,
                title: truncateFromComposition(fromComment.title ?? '', 60),
                tasksDone: fromComment.tasksDone,
                tasksTotal: fromComment.tasksTotal,
              },
            ];
          }
          try {
            const ticket = await this.provider.getTicket(id, {
              maxAgeMs: 10_000,
            });
            return [
              id,
              {
                state: deriveStateFromComposition(ticket, AGENT_LABELS),
                title: truncateFromComposition(ticket?.title ?? '', 60),
              },
            ];
          } catch (err) {
            // Preserve the post-#448 fail-loud contract: the error must still
            // propagate so a persistent GraphQL-read regression halts the
            // wave instead of rendering unreadable rows forever. Emit a
            // rate-limited `friction` comment onto the affected Story first
            // so the operator sees the failure directly on the ticket rather
            // than only in CI logs.
            await this.#emitFetchFailureFriction(id, err);
            throw err;
          }
        },
        { concurrency: this.concurrency },
      );
      const byId = new Map(fetched);
      const rows = this.plan
        ? this.plan.flatMap((w) =>
            w.stories.map((s) => ({
              wave: w.index,
              id: s.id,
              ...byId.get(s.id),
              title: byId.get(s.id)?.title || s.title || '',
            })),
          )
        : (this.currentWave?.stories ?? []).map((id) => ({
            id,
            ...byId.get(id),
          }));
      const phaseSummaries = await this.#collectPhaseTimingSummaries(rows);
      const body = await this.#render(rows, phaseSummaries);
      this.logger.info?.(body);
      if (this.logFile) {
        try {
          await this.#appendToLogFile(
            `### ⏱ ${this.now().toISOString()}\n\n${body}\n\n---\n\n`,
          );
        } catch (err) {
          this.logger.warn?.(
            `[ProgressReporter] log file append failed: ${err.message}`,
          );
        }
      }
      try {
        await upsertStructuredComment(
          this.provider,
          this.epicId,
          EPIC_RUN_PROGRESS_TYPE,
          body,
        );
      } catch (err) {
        this.logger.warn?.(
          `[ProgressReporter] comment upsert failed: ${err.message}`,
        );
      }
      return { rows, body };
    } finally {
      this.emitting = false;
    }
  }

  /**
   * Attempt to read the `story-run-progress` structured comment for a Story.
   * Returns `null` for any read failure or malformed body — the caller falls
   * back to ticket labels in that case. Failures are logged at warn level so
   * persistent issues remain visible without breaking the render path.
   *
   * Caches both terminal-phase parses and absent-comment results: a Story
   * either eventually publishes a comment (then transitions through phases
   * to `done`/`blocked` once and stays there) or never does (legacy stories
   * closed before /story-deliver existed). Either outcome is stable for the
   * remainder of the epic run.
   */
  async #tryReadStoryProgress(storyId) {
    const cached = this.storyProgressCache.get(storyId);
    if (cached === 'absent') return null;
    if (cached) return cached;
    try {
      const comment = await findStructuredComment(
        this.provider,
        storyId,
        STORY_RUN_PROGRESS_TYPE,
      );
      const parsed = parseStoryRunProgressComment(comment);
      if (!parsed) {
        this.storyProgressCache.set(storyId, 'absent');
        return null;
      }
      if (parsed.state === 'done' || parsed.state === 'blocked') {
        this.storyProgressCache.set(storyId, parsed);
      }
      return parsed;
    } catch (err) {
      this.logger.warn?.(
        `[ProgressReporter] story-run-progress fetch failed for #${storyId}: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  async #appendToLogFile(chunk) {
    if (!this.logFile) return;
    if (!this.logFileReady) {
      await this._mkdir(dirname(this.logFile), { recursive: true });
      this.logFileReady = true;
    }
    await this._appendFile(this.logFile, chunk, 'utf8');
  }

  /**
   * One reporter tick: invoke `fire()` and update the consecutive-failure
   * counter. On `fireEscalationThreshold` consecutive failures, trigger the
   * escalation path exactly once at the threshold boundary (further failures
   * increment but do not re-escalate until a successful fire resets the
   * counter). Exposed for tests to drive deterministically without timers.
   */
  async tick() {
    try {
      await this.fire();
      if (this.consecutiveFireFailures > 0) {
        this.consecutiveFireFailures = 0;
      }
    } catch (err) {
      this.consecutiveFireFailures += 1;
      this.logger.warn?.(
        `[ProgressReporter] fire() failed (${this.consecutiveFireFailures}/${this.fireEscalationThreshold}): ${err?.message ?? err}`,
      );
      if (this.consecutiveFireFailures === this.fireEscalationThreshold) {
        await escalateFireFailure({
          provider: this.provider,
          epicId: this.epicId,
          config: this.config,
          threshold: this.fireEscalationThreshold,
          err,
          logger: this.logger,
        });
      }
    }
  }

  async #emitFetchFailureFriction(storyId, err) {
    if (!Number.isInteger(this.epicId) || !storyId) return;
    try {
      await appendSignal({
        epicId: Number(this.epicId),
        storyId: Number(storyId),
        signal: {
          kind: 'friction',
          timestamp: new Date().toISOString(),
          epicId: Number(this.epicId),
          storyId: Number(storyId),
          category: 'poller-fetch-failure',
          source: { tool: 'epic-runner/progress-reporter.js' },
          details: String(err?.message ?? err).slice(0, 500),
        },
        config: this.config,
      });
    } catch (emitErr) {
      this.logger.warn?.(
        `[ProgressReporter] friction signal append failed for #${storyId}: ${emitErr?.message ?? emitErr}`,
      );
    }
  }

  /**
   * Fetch and parse `phase-timings` structured comments for any `done`
   * story we haven't already cached. Returns the ordered list of parsed
   * summaries for currently-done stories in the plan, suitable for
   * aggregation by `#renderPhaseTimings`.
   */
  async #collectPhaseTimingSummaries(rows) {
    const doneRows = rows.filter((r) => r.state === 'done');
    await concurrentMap(
      doneRows,
      async (r) => {
        if (this.phaseTimingCache.has(r.id)) return;
        try {
          const comment = await findStructuredComment(
            this.provider,
            r.id,
            PHASE_TIMINGS_TYPE,
          );
          const parsed = parsePhaseTimingsComment(comment);
          this.phaseTimingCache.set(r.id, parsed ?? 'absent');
        } catch (err) {
          this.logger.warn?.(
            `[ProgressReporter] phase-timings fetch failed for #${r.id}: ${err.message}`,
          );
          // Don't cache on error — a transient read failure should retry
          // next tick, whereas a parsed-absent sentinel is permanent.
        }
      },
      { concurrency: this.concurrency },
    );
    return doneRows
      .map((r) => this.phaseTimingCache.get(r.id))
      .filter((v) => v && v !== 'absent');
  }

  async #render(rows, phaseSummaries = []) {
    const phaseSummariesBlock = renderPhaseTimingsSection(phaseSummaries);
    return renderProgressBodyFromComposition({
      rows,
      plan: this.plan,
      currentWave: this.currentWave,
      epicStartedAt: this.epicStartedAt,
      now: this.now,
      detectors: this.detectors,
      phaseSummariesBlock,
      logger: this.logger,
    });
  }
}
