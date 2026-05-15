/**
 * ProgressReporter — emits periodic progress snapshots during a wave.
 *
 * Fires every `intervalSec` (from `orchestration.runners.deliverRunner.progressReportIntervalSec`).
 * Each fire:
 *   1. Reads current state of the active wave's stories via `provider.getTicket`.
 *   2. Renders a markdown table: ID | State | Title.
 *   3. Appends a "Notable" section with mechanically-detected signals
 *      (stalled stories, blocked stories, elapsed wave time).
 *   4. Emits the rendered body to the logger AND upserts an `epic-run-progress`
 *      structured comment on the Epic issue so operators watching the ticket
 *      see a single in-place update rather than N comments.
 *   5. When `logFile` is set, also appends the rendered snapshot (with an
 *      ISO-timestamped divider) to that path. This lets the /epic-deliver
 *      skill tail the file via `Monitor` to stream progress into IDE chat even
 *      when the runner itself is invoked in a background Bash that doesn't
 *      surface stdout live.
 *
 * Disabled when `intervalSec` is 0, null, or negative.
 *
 * The reporter is tolerant of read failures — a failed provider call logs a
 * warning and skips the fire rather than crashing the runner.
 *
 * The reporter is responsible for the GitHub-comment narrative only.
 * Webhook delivery of the curated `epic-progress` event is event-driven
 * (wave boundaries, blocker transitions) and lives in `emitEpicProgress()`
 * below — the periodic timer does not mirror to the webhook.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AGENT_LABELS } from '../../label-constants.js';
import { appendSignal } from '../../observability/signals-writer.js';
import { concurrentMap } from '../../util/concurrent-map.js';
import { DEFAULT_CONCURRENCY } from '../concurrency.js';
import { parseFencedJsonComment } from '../structured-comment-parser.js';
import { runHotspotDetection } from './hotspot-detection.js';
import {
  findStructuredComment,
  upsertStructuredComment,
} from '../ticketing.js';
import { createStalledWorktreeDetector } from './progress-signals/stalled-worktree.js';

export const EPIC_RUN_PROGRESS_TYPE = 'epic-run-progress';
export const PHASE_TIMINGS_TYPE = 'phase-timings';
export const STORY_RUN_PROGRESS_TYPE = 'story-run-progress';

/**
 * Webhook event name for the curated epic-progress rollup. Distinct from
 * the `epic-run-progress` structured-comment kind above — the comment is
 * the operator-facing per-poll snapshot on the Epic ticket, the webhook
 * event is the coarse-grained rollup that fires at wave boundaries and
 * after blocker transitions.
 */
export const EPIC_PROGRESS_EVENT = 'epic-progress';

/**
 * Parse a `story-run-progress` structured comment posted by `/story-execute`.
 * Returns `null` for any malformed body — the caller falls back to the
 * ticket-label state derivation in that case.
 *
 * Expected payload shape (JSON inside a fenced json codeblock):
 *   {
 *     storyId: number,
 *     branch?: string,
 *     phase: 'init'|'implementing'|'closing'|'blocked'|'done',
 *     tasks?: [{ id, title?, state, commitSha? }],
 *     title?: string,
 *     updatedAt?: string,
 *   }
 */
export function parseStoryRunProgressComment(comment) {
  const payload = parseFencedJsonComment(comment);
  if (!payload || typeof payload !== 'object') return null;
  const phase = typeof payload.phase === 'string' ? payload.phase : undefined;
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const tasksTotal = tasks.length;
  const tasksDone = tasks.filter((t) => t && t.state === 'done').length;
  return {
    storyId: Number(payload.storyId),
    title: typeof payload.title === 'string' ? payload.title : '',
    phase,
    state: phaseToState(phase),
    tasksDone,
    tasksTotal,
  };
}

// Phase → high-level state classification. Lookup table flattens the
// previous switch so cyclomatic complexity stays at 1 (one branch in the
// `??` fallback) rather than 6 — keeps the CRAP score floor-bound under
// coverage variance.
const PHASE_TO_STATE = {
  done: 'done',
  blocked: 'blocked',
  implementing: 'in-flight',
  closing: 'in-flight',
  init: 'queued',
};

export function phaseToState(phase) {
  return PHASE_TO_STATE[phase] ?? 'unknown';
}

// Fixed ordering for the rendered phase-timings table. Matches the enum
// in lib/util/phase-timer.js so rows line up with how operators think
// about the story lifecycle rather than re-sorting by alphabet or
// frequency.
const PHASE_ORDER = [
  'worktree-create',
  'bootstrap',
  'install',
  'implement',
  'lint',
  'test',
  'close',
  'api-sync',
];

const STATE_EMOJI = {
  done: '✅',
  blocked: '🚧',
  'in-flight': '🔧',
  queued: '⏳',
  unknown: '❓',
};

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
      // network blip, schema drift). Surface to the same logger that
      // appendToLogFile uses so the failure mode is visible in the log
      // tail rather than hidden inside the interval handler.
      this.fire().catch((err) => {
        this.logger.warn?.(
          `[ProgressReporter] fire() failed: ${err?.message ?? err}`,
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
          // each /story-execute sub-agent updates this on every Task
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
                title: truncate(fromComment.title ?? '', 60),
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
                state: deriveState(ticket),
                title: truncate(ticket?.title ?? '', 60),
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
   * closed before /story-execute existed). Either outcome is stable for the
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
    const done = rows.filter((r) => r.state === 'done').length;
    const total = rows.length;
    const totalWaves = this.plan?.length ?? this.currentWave?.totalWaves ?? '?';
    const currentWaveNum = this.currentWave
      ? this.currentWave.index + 1
      : (this.plan?.length ?? '?');
    const waveLabel = `Wave ${currentWaveNum}/${totalWaves}`;
    const elapsedSrc =
      this.epicStartedAt ?? this.currentWave?.startedAt ?? null;
    const elapsed = elapsedSrc
      ? ` · ${formatElapsed(this.now() - new Date(elapsedSrc))} elapsed`
      : '';

    const header = `### 📊 Progress — ${waveLabel} · ${done}/${total} closed${elapsed}`;

    const includeWaveCol = rows.some((r) => Number.isInteger(r.wave));
    const table = includeWaveCol
      ? [
          '| Wave | ID | State | Title |',
          '|---|---|---|---|',
          ...rows.map(
            (r) =>
              `| ${r.wave + 1} | #${r.id} | ${STATE_EMOJI[r.state] ?? ''} ${r.state} | ${escapePipes(r.title)} |`,
          ),
        ].join('\n')
      : [
          '| ID | State | Title |',
          '|---|---|---|',
          ...rows.map(
            (r) =>
              `| #${r.id} | ${STATE_EMOJI[r.state] ?? ''} ${r.state} | ${escapePipes(r.title)} |`,
          ),
        ].join('\n');

    const notable = await this.#renderNotable(rows);
    const phaseBlock = renderPhaseTimingsSection(phaseSummaries);
    const parts = [header, '', table, '', '**Notable**', notable];
    if (phaseBlock) parts.push('', phaseBlock);
    return parts.join('\n');
  }

  async #renderNotable(rows) {
    const items = [];
    const blocked = rows.filter((r) => r.state === 'blocked');
    if (blocked.length) {
      items.push(
        `- 🚧 ${blocked.length} stor${blocked.length === 1 ? 'y' : 'ies'} blocked: ${blocked.map((r) => `#${r.id}`).join(', ')}`,
      );
    }
    const inFlight = rows.filter((r) => r.state === 'in-flight');
    if (inFlight.length) {
      items.push(
        `- 🔧 ${inFlight.length} in flight: ${inFlight.map((r) => `#${r.id}`).join(', ')}`,
      );
    }
    const unknown = rows.filter((r) => r.state === 'unknown');
    if (unknown.length) {
      items.push(
        `- ❓ ${unknown.length} unreadable (token scope / network?): ${unknown.map((r) => `#${r.id}`).join(', ')}`,
      );
    }
    const ctx = { wave: this.currentWave };
    const detectorResults = await Promise.all(
      this.detectors.map(async (detector) => {
        try {
          const fn =
            typeof detector === 'function' ? detector : detector?.detect;
          if (typeof fn !== 'function') return [];
          const out = await fn.call(detector, rows, ctx);
          return Array.isArray(out) ? out : [];
        } catch (err) {
          this.logger.warn?.(
            `[ProgressReporter] detector failed: ${err.message}`,
          );
          return [];
        }
      }),
    );
    for (const bullets of detectorResults) {
      for (const b of bullets) items.push(b.startsWith('- ') ? b : `- ${b}`);
    }

    if (!items.length) items.push('- (none)');
    return items.join('\n');
  }
}

function deriveState(ticket) {
  if (!ticket) return 'unknown';
  const labels = ticket.labels ?? [];
  const state = (ticket.state ?? '').toString().toUpperCase();
  if (state === 'CLOSED' || labels.includes(AGENT_LABELS.DONE)) return 'done';
  if (labels.includes(AGENT_LABELS.BLOCKED)) return 'blocked';
  if (labels.includes(AGENT_LABELS.EXECUTING)) return 'in-flight';
  if (labels.includes(AGENT_LABELS.READY)) return 'queued';
  return 'unknown';
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function escapePipes(s) {
  return String(s).replace(/\|/g, '\\|');
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Render and upsert the rolled-up `epic-run-progress` comment on the Epic.
 *
 * Called by `/epic-deliver` Step 2b (`epic-execute-record-wave.js`) after
 * each wave completes. The caller folds `state.waves[]` from the
 * `epic-run-state` checkpoint into the per-wave rows and persists the
 * unified rollup as a fenced-JSON payload on the Epic ticket via
 * `upsertStructuredComment`. There is no separate per-wave structured
 * comment — `epic-run-progress` is the single operator-facing summary,
 * grouped by wave.
 *
 * The payload schema is pinned by `epic-execute.md` Step 2b / tech spec
 * #902:
 *
 *   {
 *     "kind": "epic-run-progress",
 *     "epicId": <number>,
 *     "currentWave": <number>,
 *     "totalWaves": <number>,
 *     "waves": [ { wave, concurrencyCap?, stories[] } ],
 *     "startedAt"?: "<iso8601>",
 *     "updatedAt": "<iso8601>"
 *   }
 *
 * The function does not re-derive Story state from labels — it trusts the
 * `waves` argument supplied by the caller, which itself is the projection
 * of the validated, verified per-Story rows recorded on the checkpoint.
 *
 * @param {{
 *   provider: import('../../ITicketingProvider.js').ITicketingProvider,
 *   epicId: number,
 *   waves: Array<{
 *     wave: number,
 *     concurrencyCap?: number,
 *     stories?: Array<{ id: number, title?: string, state?: string,
 *                       tasksDone?: number, tasksTotal?: number,
 *                       blockerCommentId?: string }>,
 *   }>,
 *   currentWave: number,
 *   totalWaves: number,
 *   startedAt?: string,
 *   now?: () => Date,
 * }} args
 * @returns {Promise<{ body: string, payload: object }>} the rendered body
 *   and payload that were upserted onto the Epic.
 */
export async function upsertEpicRunProgress({
  provider,
  epicId,
  waves,
  currentWave,
  totalWaves,
  startedAt,
  now = () => new Date(),
} = {}) {
  if (!provider || typeof provider.postComment !== 'function') {
    throw new TypeError(
      'upsertEpicRunProgress requires a provider with postComment',
    );
  }
  const epicIdNum = Number(epicId);
  if (!Number.isInteger(epicIdNum) || epicIdNum <= 0) {
    throw new TypeError('upsertEpicRunProgress requires a numeric epicId');
  }
  const totalWavesNum = Number(totalWaves);
  if (!Number.isInteger(totalWavesNum) || totalWavesNum < 0) {
    throw new TypeError(
      'upsertEpicRunProgress requires a non-negative integer totalWaves',
    );
  }
  const currentWaveNum = Number(currentWave);
  if (!Number.isInteger(currentWaveNum) || currentWaveNum < 0) {
    throw new TypeError(
      'upsertEpicRunProgress requires a non-negative integer currentWave',
    );
  }
  const wavesArr = Array.isArray(waves) ? waves : [];

  const updatedAt = now().toISOString();
  const normalizedWaves = wavesArr.map((w) => {
    const stories = Array.isArray(w?.stories) ? w.stories : [];
    const out = {
      wave: Number(w?.wave),
      stories,
    };
    if (Number.isInteger(w?.concurrencyCap)) {
      out.concurrencyCap = Number(w.concurrencyCap);
    }
    return out;
  });

  const payload = {
    kind: EPIC_RUN_PROGRESS_TYPE,
    epicId: epicIdNum,
    currentWave: currentWaveNum,
    totalWaves: totalWavesNum,
    waves: normalizedWaves,
    updatedAt,
  };
  if (typeof startedAt === 'string' && startedAt) {
    payload.startedAt = startedAt;
  }

  const totalStories = normalizedWaves.reduce(
    (acc, w) => acc + w.stories.length,
    0,
  );
  const doneStories = normalizedWaves.reduce(
    (acc, w) => acc + w.stories.filter((s) => s?.state === 'done').length,
    0,
  );
  const header = `### 📊 Epic Progress — Wave ${Math.min(currentWaveNum + 1, Math.max(totalWavesNum, 1))}/${totalWavesNum || '?'} · ${doneStories}/${totalStories} stories done`;

  const tableLines = ['| Wave | ID | State | Title |', '|---|---|---|---|'];
  if (normalizedWaves.length === 0) {
    tableLines.push('| — | — | _(no waves yet)_ | — |');
  } else {
    for (const w of normalizedWaves) {
      if (w.stories.length === 0) {
        tableLines.push(`| ${w.wave + 1} | — | _(empty wave)_ | — |`);
        continue;
      }
      for (const s of w.stories) {
        const state = String(s?.state ?? 'unknown');
        const emoji = STATE_EMOJI[state] ?? '';
        const id = Number(s?.id ?? 0);
        const title = escapePipes(truncate(String(s?.title ?? ''), 60));
        tableLines.push(
          `| ${w.wave + 1} | #${id} | ${emoji} ${state} | ${title} |`,
        );
      }
    }
  }

  const body = [
    header,
    '',
    tableLines.join('\n'),
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');

  await upsertStructuredComment(
    provider,
    epicIdNum,
    EPIC_RUN_PROGRESS_TYPE,
    body,
  );

  return { body, payload };
}

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

// runHotspotDetection lives in `./hotspot-detection.js` so this file
// stays focused on the periodic-progress + comment-render surface.
// Re-exported here for backwards compatibility — Epic-close call sites
// can import either path.
export { runHotspotDetection };

/**
 * Extract the `{ phases, ... }` payload from a `phase-timings` structured
 * comment. Comment body is the fenced-JSON format produced by
 * `renderPhaseTimingsCommentBody` in story-close. Returns `null`
 * for any parse failure — the caller treats that as "no summary
 * available" without erroring out progress rendering.
 */
export function parsePhaseTimingsComment(comment) {
  const payload = parseFencedJsonComment(comment);
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.phases)) return null;
  return {
    storyId: Number(payload.storyId),
    totalMs: Number(payload.totalMs) || 0,
    phases: payload.phases
      .filter(
        (p) =>
          p &&
          typeof p.name === 'string' &&
          Number.isFinite(Number(p.elapsedMs)),
      )
      .map((p) => ({ name: p.name, elapsedMs: Number(p.elapsedMs) })),
  };
}

/**
 * Aggregate a list of `phase-timings` summaries into per-phase median,
 * p95, and sample count. Returns phases ordered by the canonical
 * `PHASE_ORDER` so the rendered table always has the same row sequence —
 * operators should never have to hunt for the `install` row.
 */
export function aggregatePhaseTimings(summaries) {
  const buckets = new Map();
  for (const s of summaries) {
    if (!s || !Array.isArray(s.phases)) continue;
    for (const p of s.phases) {
      if (!buckets.has(p.name)) buckets.set(p.name, []);
      buckets.get(p.name).push(p.elapsedMs);
    }
  }
  const rows = [];
  for (const name of PHASE_ORDER) {
    const samples = buckets.get(name);
    if (!samples || samples.length === 0) continue;
    rows.push({
      name,
      median: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      n: samples.length,
    });
  }
  // Include any unexpected phase names at the tail so a future enum
  // addition surfaces in the table instead of being silently dropped.
  for (const [name, samples] of buckets.entries()) {
    if (PHASE_ORDER.includes(name)) continue;
    rows.push({
      name,
      median: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      n: samples.length,
    });
  }
  return rows;
}

function percentile(samples, q) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  // Nearest-rank method — clamped so q=1 picks the last element.
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[idx];
}

/**
 * Render the aggregated phase-timings table. Returns `null` when there
 * are no summaries to render so the caller can elide the section
 * entirely rather than emitting an empty stub.
 */
export function renderPhaseTimingsSection(summaries) {
  if (!Array.isArray(summaries) || summaries.length === 0) return null;
  const rows = aggregatePhaseTimings(summaries);
  if (rows.length === 0) return null;
  const header = `### Phase timings (last ${summaries.length} completed stor${summaries.length === 1 ? 'y' : 'ies'})`;
  const table = [
    '| Phase | median ms | p95 ms | n |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.name} | ${r.median} | ${r.p95} | ${r.n} |`),
  ].join('\n');
  return `${header}\n\n${table}`;
}
