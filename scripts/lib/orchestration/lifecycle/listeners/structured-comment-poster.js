// .agents/scripts/lib/orchestration/lifecycle/listeners/structured-comment-poster.js
import { structuredCommentMarker } from '../../ticketing.js';

/**
 * StructuredCommentPoster — lifecycle listener that upserts structured
 * comments on the Epic ticket at wave + blocker boundaries.
 *
 * Epic #2646 Story C (Task #2694) — promoted to the canonical writer for
 * the `wave-<n>-start` / `wave-<n>-end` markers that the legacy
 * `epic-runner/wave-observer.js` used to own. The listener now renders the
 * rich body the observer carried (per-story bullets, duration, commit-
 * assertion `done → failed` reclassification detail), so the bus is the
 * single source of truth for wave-boundary structured comments.
 *
 * Subscribes to:
 *   - `wave.start`        → upsert `wave-<index>-start` marker.
 *   - `wave.end`          → upsert `wave-<index>-end`   marker.
 *   - `epic.blocked`      → upsert `lifecycle-epic-blocked`   marker.
 *   - `epic.unblocked`    → upsert `lifecycle-epic-unblocked` marker.
 *
 * Idempotency contract (Acceptance Spec AC-10): the listener keeps a
 * per-instance `Set<string>` of `event:seqId` keys it has handled. A
 * repeat invocation with the same key short-circuits without calling
 * `upsertStructuredComment`. The upsert call itself is also idempotent
 * (it diffs body bytes before posting), so two-tier defense holds even
 * when the seqId cache misses.
 *
 * Marker discipline: the marker type for each event is deterministic
 * and keyed by event identity (and wave index for wave events). The
 * `findStructuredComment` path on the provider uses the same marker
 * format so collisions short-circuit to an edit rather than a new
 * comment — verified by the listener-comment.test.js suite.
 */

/**
 * Compose the marker type for a given event + payload pair. Returns
 * `null` for events the poster does not own; the listener body
 * short-circuits silently in that case.
 *
 * @param {string} event
 * @param {object} payload
 * @returns {string|null}
 */
export function markerTypeFor(event, payload) {
  if (event === 'wave.start') {
    const idx = Number(payload?.waveIndex);
    if (!Number.isInteger(idx) || idx < 0) return null;
    return `wave-${idx}-start`;
  }
  if (event === 'wave.end') {
    const idx = Number(payload?.waveIndex);
    if (!Number.isInteger(idx) || idx < 0) return null;
    return `wave-${idx}-end`;
  }
  if (event === 'epic.blocked') {
    return 'lifecycle-epic-blocked';
  }
  if (event === 'epic.unblocked') {
    // Story #2241 / Task #2246 — operator-resume marker. The marker
    // type is stable per Epic (not seqId-scoped) so re-emits during
    // recovery cycles upsert the same comment instead of fanning out.
    return 'lifecycle-epic-unblocked';
  }
  return null;
}

/**
 * Format a duration in milliseconds as a compact human-readable string.
 * Matches the legacy `wave-observer.js` rendering so retrospective
 * tooling and operator eyeballs continue to read the same shape.
 */
function formatDuration(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m${rem > 0 ? ` ${rem}s` : ''}`;
}

/**
 * Render the comment body for a given event + payload. Wave events
 * use the rich body inherited from the legacy wave-observer writer
 * (heading with `Wave X/Y`, per-story bullets, duration, JSON fence
 * with the full payload). Blocker events stay compact.
 */
export function renderBody(event, payload) {
  const lines = [];
  if (event === 'wave.start') {
    const idx = Number(payload?.waveIndex);
    const totalWaves = Number(payload?.totalWaves);
    const stories = Array.isArray(payload?.stories) ? payload.stories : [];
    const ids = Array.isArray(payload?.storyIds) ? payload.storyIds : [];
    const startedAt = payload?.startedAt;
    const heading = Number.isInteger(totalWaves)
      ? `### 🚀 Wave ${idx + 1}/${totalWaves} starting`
      : `### 🚀 Wave ${idx + 1} starting`;
    lines.push(heading);
    lines.push('');
    if (startedAt) {
      lines.push(`Started: \`${startedAt}\``);
    }
    const count = stories.length || ids.length;
    lines.push(`Stories: ${count}`);
    if (stories.length) {
      lines.push('');
      for (const s of stories) {
        const id = Number(s?.id ?? s?.storyId);
        const title = typeof s?.title === 'string' && s.title ? s.title : null;
        lines.push(`- #${id}${title ? ` — ${title}` : ''}`);
      }
    } else if (ids.length) {
      lines.push('');
      for (const id of ids) lines.push(`- #${id}`);
    }
  } else if (event === 'wave.end') {
    const idx = Number(payload?.waveIndex);
    const totalWaves = Number(payload?.totalWaves);
    const outcomes = payload?.outcomes ?? {};
    const stories = Array.isArray(payload?.stories) ? payload.stories : [];
    const completedAt = payload?.completedAt;
    const durationMs = payload?.durationMs;
    const entries = Object.entries(outcomes);
    const okCount = entries.filter(([, v]) => v === 'done').length;
    const skippedCount = entries.filter(([, v]) => v === 'skipped').length;
    const bad = entries.length - okCount - skippedCount;
    const heading = Number.isInteger(totalWaves)
      ? `### 🏁 Wave ${idx + 1}/${totalWaves} ${bad === 0 ? 'completed' : 'halted'}`
      : `### 🏁 Wave ${idx + 1} ${bad === 0 ? 'completed' : 'halted'}`;
    lines.push(heading);
    lines.push('');
    if (completedAt) {
      const formatted = formatDuration(durationMs);
      lines.push(
        `Completed: \`${completedAt}\`${formatted ? ` (${formatted})` : ''}`,
      );
    }
    lines.push(
      `Outcomes: ${okCount} done · ${skippedCount} skipped · ${bad} failed/blocked`,
    );
    if (stories.length) {
      lines.push('');
      for (const s of stories) {
        const id = Number(s?.storyId);
        const status = String(s?.status ?? 'failed');
        const icon =
          status === 'done' ? '✅' : status === 'skipped' ? '⏭️' : '❌';
        const detail =
          typeof s?.detail === 'string' && s.detail ? ` — ${s.detail}` : '';
        lines.push(`- ${icon} #${id} \`${status}\`${detail}`);
      }
    } else if (entries.length) {
      lines.push('');
      for (const [id, outcome] of entries) {
        const icon =
          outcome === 'done' ? '✅' : outcome === 'skipped' ? '⏭️' : '❌';
        lines.push(`- ${icon} #${id} \`${outcome}\``);
      }
    }
  } else if (event === 'epic.blocked') {
    lines.push('### 🚧 Epic blocked');
    lines.push('');
    lines.push(`Reason: \`${payload?.reason ?? 'unknown'}\``);
    if (Number.isInteger(payload?.sourceStoryId)) {
      lines.push(`Source: #${payload.sourceStoryId}`);
    }
  } else if (event === 'epic.unblocked') {
    lines.push('### ✅ Epic unblocked');
    lines.push('');
    lines.push(`Reason: \`${payload?.reason ?? 'unknown'}\``);
    if (Number.isInteger(payload?.sourceStoryId)) {
      lines.push(`Source: #${payload.sourceStoryId}`);
    }
  }
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({ kind: event, ...payload }, null, 2));
  lines.push('```');
  return lines.join('\n');
}

export class StructuredCommentPoster {
  /**
   * @param {object} opts
   * @param {object} opts.provider Ticketing provider passed to
   *   `upsertStructuredComment`.
   * @param {number} opts.epicId Target ticket id (the Epic).
   * @param {Function} opts.upsertStructuredComment Injected upsert
   *   function (the runner passes the canonical one from
   *   `lib/orchestration/ticketing.js`).
   * @param {{ warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (!opts.provider) {
      throw new TypeError('StructuredCommentPoster requires a provider');
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('StructuredCommentPoster requires a numeric epicId');
    }
    if (typeof opts.upsertStructuredComment !== 'function') {
      throw new TypeError(
        'StructuredCommentPoster requires an upsertStructuredComment function',
      );
    }
    this.provider = opts.provider;
    this.epicId = opts.epicId;
    this._upsert = opts.upsertStructuredComment;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` keys we've handled. */
    this._seen = new Set();
    this.events = Object.freeze([
      'wave.start',
      'wave.end',
      'epic.blocked',
      'epic.unblocked',
    ]);
  }

  register(bus) {
    if (!bus || typeof bus.on !== 'function') {
      throw new TypeError(
        'StructuredCommentPoster.register requires a bus with on()',
      );
    }
    return this.events.map((event) =>
      bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.logger.debug?.(
        `[StructuredCommentPoster] skip duplicate ${key} (idempotent)`,
      );
      return;
    }
    this._seen.add(key);

    const type = markerTypeFor(event, payload);
    if (!type) return;
    const body = renderBody(event, payload);
    try {
      await this._upsert(this.provider, this.epicId, type, body);
    } catch (err) {
      this.logger.warn?.(
        `[StructuredCommentPoster] upsert ${type} failed: ${err?.message ?? err}`,
      );
    }
  }

  resetSeen() {
    this._seen.clear();
  }
}

export function createStructuredCommentPoster(opts) {
  return new StructuredCommentPoster(opts);
}

/**
 * Marker-helper exports — used by retrospective tooling and parity
 * tests to locate the wave-start/wave-end structured comments without
 * importing the marker-format helper from ticketing.js. The marker
 * strings here are the on-comment HTML markers (rendered by
 * `upsertStructuredComment` from the marker type), so callers can
 * `body.includes(waveStartMarker(0))` directly.
 *
 * Epic #2646 Story C — the retired `wave-observer.js` exported the
 * same names; tests import from here now.
 */
export function waveStartMarker(index) {
  return structuredCommentMarker(`wave-${index}-start`);
}

export function waveEndMarker(index) {
  return structuredCommentMarker(`wave-${index}-end`);
}
