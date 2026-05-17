// .agents/scripts/lib/orchestration/lifecycle/listeners/structured-comment-poster.js
/**
 * StructuredCommentPoster — lifecycle listener that upserts structured
 * comments on the Epic ticket at wave + blocker boundaries.
 *
 * Absorbs the surface previously owned by
 * `epic-runner/wave-observer.js` (`wave-<n>-start` /
 * `wave-<n>-end` markers) and the `epic-blocked` body the BlockerHandler
 * inlined on a halt path.
 *
 * Subscribes to (per Story #2239 Task #2242):
 *   - `wave.start`    → upsert `wave-<index>-start` marker.
 *   - `wave.end`      → upsert `wave-<index>-end`   marker.
 *   - `epic.blocked`  → upsert `epic-blocked` marker.
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
    return 'epic-blocked';
  }
  return null;
}

/**
 * Render the comment body for a given event + payload. The body is
 * intentionally compact — a one-line heading plus a fenced JSON block
 * carrying the event payload verbatim — so a reader can recover the
 * lifecycle record from the GitHub comment without round-tripping
 * through the ledger.
 *
 * Note: this is NOT the rich wave-observer body (which carried
 * commit-assertion deltas and per-story bullets). The richer body is
 * still produced by the `wave-observer.js` legacy path during the
 * parallel-write window; the listener writes a minimal marker so the
 * comment surface remains owned by exactly one writer once the legacy
 * path is removed in a follow-up Story.
 */
export function renderBody(event, payload) {
  const lines = [];
  if (event === 'wave.start') {
    const idx = Number(payload?.waveIndex);
    const ids = Array.isArray(payload?.storyIds) ? payload.storyIds : [];
    lines.push(`### 🚀 Wave ${idx + 1} starting`);
    lines.push('');
    lines.push(`Stories: ${ids.length}`);
    if (ids.length) {
      lines.push('');
      for (const id of ids) lines.push(`- #${id}`);
    }
  } else if (event === 'wave.end') {
    const idx = Number(payload?.waveIndex);
    const outcomes = payload?.outcomes ?? {};
    const entries = Object.entries(outcomes);
    const okCount = entries.filter(([, v]) => v === 'done').length;
    const skippedCount = entries.filter(([, v]) => v === 'skipped').length;
    const bad = entries.length - okCount - skippedCount;
    lines.push(
      `### 🏁 Wave ${idx + 1} ${bad === 0 ? 'completed' : 'halted'}`,
    );
    lines.push('');
    lines.push(
      `Outcomes: ${okCount} done · ${skippedCount} skipped · ${bad} failed/blocked`,
    );
    if (entries.length) {
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
      throw new TypeError(
        'StructuredCommentPoster requires a numeric epicId',
      );
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
    this.events = Object.freeze(['wave.start', 'wave.end', 'epic.blocked']);
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
