/**
 * ProgressReporter — emits periodic progress snapshots during a wave.
 *
 * Fires every `intervalSec` (from `orchestration.runners.epicRunner.progressReportIntervalSec`).
 * Each fire:
 *   1. Reads current state of the active wave's stories via `provider.getTicket`.
 *   2. Renders a markdown table: ID | State | Title.
 *   3. Appends a "Notable" section with mechanically-detected signals
 *      (stalled stories, blocked stories, elapsed wave time).
 *   4. Emits the rendered body to the logger AND upserts an `epic-run-progress`
 *      structured comment on the Epic issue so operators watching the ticket
 *      see a single in-place update rather than N comments.
 *   5. When `logFile` is set, also appends the rendered snapshot (with an
 *      ISO-timestamped divider) to that path. This lets the /epic-execute
 *      skill tail the file via `Monitor` to stream progress into IDE chat even
 *      when the runner itself is invoked in a background Bash that doesn't
 *      surface stdout live.
 *
 * Disabled when `intervalSec` is 0, null, or negative.
 *
 * The reporter is tolerant of read failures — a failed provider call logs a
 * warning and skips the fire rather than crashing the runner.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AGENT_LABELS } from '../../label-constants.js';
import { concurrentMap } from '../../util/concurrent-map.js';
import { DEFAULT_CONCURRENCY } from '../concurrency.js';
import { parseFencedJsonComment } from '../structured-comment-parser.js';
import {
  findStructuredComment,
  upsertStructuredComment,
} from '../ticketing.js';
import { createStalledWorktreeDetector } from './progress-signals/stalled-worktree.js';

export const EPIC_RUN_PROGRESS_TYPE = 'epic-run-progress';
export const PHASE_TIMINGS_TYPE = 'phase-timings';
export const STORY_RUN_PROGRESS_TYPE = 'story-run-progress';
export const WAVE_RUN_PROGRESS_TYPE = 'wave-run-progress';

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

function phaseToState(phase) {
  switch (phase) {
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'implementing':
    case 'closing':
      return 'in-flight';
    case 'init':
      return 'queued';
    default:
      return 'unknown';
  }
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
   *   detectors?: Array<Function|{ detect: Function }>,
   *   frictionEmitter?: { emit: Function } | null,
   *   logger?: { info?: Function, warn?: Function },
   *   now?: () => Date,
   *   setInterval?: typeof setInterval,
   *   clearInterval?: typeof clearInterval,
   *   logFile?: string | null,
   *   appendFile?: typeof import('node:fs/promises').appendFile,
   *   mkdir?: typeof import('node:fs/promises').mkdir,
   * }} opts
   */
  constructor(opts = {}) {
    this.provider = opts.provider;
    this.epicId = opts.epicId;
    if (!this.provider) {
      throw new TypeError('ProgressReporter requires a provider');
    }
    if (!Number.isInteger(this.epicId)) {
      throw new TypeError('ProgressReporter requires a numeric epicId');
    }
    this.intervalSec = Number(opts.intervalSec ?? 0);
    this.logger = opts.logger ?? console;
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

    // Optional friction emitter for auto-posting structured comments onto
    // affected Story tickets when the poller's per-Story `getTicket` read
    // fails. Undefined in legacy callers — those paths keep the prior silent
    // behavior (warn-log-only) until the coordinator wires an emitter in.
    this.frictionEmitter = opts.frictionEmitter ?? null;

    // Optional file sink — when set, every rendered snapshot is appended to
    // this path prefixed by an ISO-timestamped divider. Enables operators
    // (or the /epic-execute skill) to tail progress in real time even when
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
    if (!this.frictionEmitter) return;
    const body = [
      `### 🚧 Friction — poller getTicket failed`,
      '',
      `- Story: \`#${storyId}\``,
      `- Epic: \`#${this.epicId}\``,
      `- Error: \`${String(err?.message ?? err).slice(0, 500)}\``,
      '',
      "The epic runner failed to read this Story's labels during its wave",
      'progress poll. If this is the GraphQL `variableNotUsed: $issueId` class',
      'of failure the Story will render as `unknown` in the progress table and',
      'the poller will retry next tick.',
    ].join('\n');
    try {
      await this.frictionEmitter.emit({
        ticketId: Number(storyId),
        markerKey: 'poller-fetch-failure',
        body,
      });
    } catch (emitErr) {
      this.logger.warn?.(
        `[ProgressReporter] friction emit failed for #${storyId}: ${emitErr?.message ?? emitErr}`,
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
 * Parse a `wave-run-progress` structured comment posted by `/wave-execute`.
 *
 * Returns the canonical payload object on success, or `null` for any
 * malformed input — the caller (epic-execute Step 5 rollup) treats `null`
 * as "wave snapshot unavailable" and substitutes `{ wave: N, stories: [] }`
 * rather than crashing the rollup.
 *
 * The schema mirrors the writer in `wave-run-progress-writer.js` and is
 * pinned by tech spec #902:
 *
 *   {
 *     "kind": "wave-run-progress",
 *     "epicId": <number>,
 *     "wave": <number>,
 *     "concurrencyCap": <number>,
 *     "stories": [ { id, title, state, ... } ],
 *     "updatedAt": "<iso8601>"
 *   }
 *
 * Validation is intentionally strict on the discriminator (`kind`) and the
 * shape of `stories[]`, but tolerant on optional fields (e.g. missing
 * `concurrencyCap` defaults to `0`) so a future schema bump that adds
 * fields doesn't break the parser.
 *
 * @param {{ body?: unknown } | null | undefined} comment
 * @returns {{
 *   kind: 'wave-run-progress',
 *   epicId: number,
 *   wave: number,
 *   concurrencyCap: number,
 *   stories: object[],
 *   updatedAt?: string,
 * } | null}
 */
export function parseWaveRunProgressComment(comment) {
  const payload = parseFencedJsonComment(comment);
  if (!payload || typeof payload !== 'object') return null;
  if (payload.kind !== WAVE_RUN_PROGRESS_TYPE) return null;
  const epicId = Number(payload.epicId);
  const wave = Number(payload.wave);
  if (!Number.isInteger(epicId) || epicId <= 0) return null;
  if (!Number.isInteger(wave) || wave < 0) return null;
  if (!Array.isArray(payload.stories)) return null;
  const concurrencyCap = Number.isInteger(payload.concurrencyCap)
    ? Number(payload.concurrencyCap)
    : 0;
  return {
    kind: WAVE_RUN_PROGRESS_TYPE,
    epicId,
    wave,
    concurrencyCap,
    stories: payload.stories,
    updatedAt:
      typeof payload.updatedAt === 'string' ? payload.updatedAt : undefined,
  };
}

/**
 * Render and upsert the rolled-up `epic-run-progress` comment on the Epic.
 *
 * Called by `/epic-execute` Step 5 after each wave completes. Aggregates the
 * per-wave snapshots produced by `parseWaveRunProgressComment` into a single
 * operator-facing summary (header + per-wave table) and persists it as a
 * fenced-JSON payload on the Epic ticket via `upsertStructuredComment`.
 *
 * The payload schema is pinned by `epic-execute.md` Step 5 / tech spec #902:
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
 * `waves` argument supplied by the caller, which itself is folded from the
 * already-validated `wave-run-progress` snapshots.
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
