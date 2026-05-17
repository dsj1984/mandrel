// .agents/scripts/lib/orchestration/lifecycle/listeners/cleaner.js
/**
 * Cleaner — lifecycle listener that owns the post-arm temp archive and
 * the terminal `epic.complete` emit. Story #2259 / Task #2265
 * (Epic #2172).
 *
 * Subscribes to:
 *   - `epic.merge.armed` → and ONLY this event.
 *
 * Side effects executed inside `handle()`:
 *   1. Emit `epic.cleanup.start`.
 *   2. Move `temp/epic-<id>/` to `temp/archive/epic-<id>-<ts>/`. The
 *      move is atomic on the same filesystem (`fs.renameSync`) so a
 *      crash between rename and ledger flush leaves either the source
 *      or the destination on disk — never both. When the source is
 *      absent (because a prior interrupted run already moved it), the
 *      step short-circuits to the resume contract: no second archive
 *      directory is created (AC-10 Cleaner idempotency).
 *   3. Emit `epic.cleanup.end`.
 *   4. Emit `epic.complete` carrying `{ epicId, prUrl }` — the terminal
 *      event of a successful Epic run. LabelTransitioner flips the
 *      Epic ticket to `agent::done` on this event (see listener
 *      README).
 *
 * Idempotency contract (AC-10): two-layer defence.
 *   1. Per-instance `Set<string>` of `${event}:${seqId}` keys — repeat
 *      `(event, seqId)` invocation short-circuits and emits nothing.
 *      This is the bus-level replay defence.
 *   2. On-disk archive probe — when the source `temp/epic-<id>/`
 *      directory is absent (the prior process moved it before
 *      crashing), the listener records the existing archive directory
 *      and proceeds to emit `epic.cleanup.end` + `epic.complete`
 *      exactly once. This defends against cross-process re-run after
 *      a crash between the rename and the `epic.cleanup.end` emit.
 *
 * Side-effect firewall: the listener emits on the bus and moves a
 * directory under `tempRoot`. It does NOT mutate ticket labels, post
 * comments, or call `notify` — downstream listeners
 * (LabelTransitioner on `epic.complete`) own those side effects.
 *
 * Why move (rename) rather than copy + delete: a rename is atomic at
 * the OS level when source and destination share a filesystem (which
 * they do — both live under `temp/`). Copy + delete leaves a window
 * where both directories exist; a crash there would produce two
 * archive entries on the next run. The rename guarantees that the
 * source either still exists OR the destination does, never neither
 * and never both.
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * Default clock — exported so tests can stub the timestamp suffix on
 * the archive directory name.
 */
export function defaultNow() {
  return new Date();
}

/**
 * Format a `Date` as a filesystem-safe timestamp suffix for the archive
 * directory name. ISO-8601 with `:` replaced by `-` so the result is
 * usable on Windows. Pure — exported for tests.
 *
 * Example: 2026-05-17T21:55:09.123Z → 2026-05-17T21-55-09-123Z
 */
export function formatArchiveTimestamp(date) {
  const iso = date.toISOString();
  return iso.replace(/[:.]/g, '-');
}

/**
 * Resolve the archive destination directory for an Epic. Pure helper
 * that builds the `<tempRoot>/archive/epic-<id>-<ts>` path. Exported
 * for tests so the layout pin is reviewable.
 */
export function resolveArchiveDest({ tempRoot, epicId, now }) {
  const suffix = formatArchiveTimestamp(now);
  return path.join(tempRoot, 'archive', `epic-${epicId}-${suffix}`);
}

/**
 * Find an existing archive directory for an Epic. Returns the absolute
 * path of the FIRST match (alphabetic order; archive names are
 * timestamped so this is also chronological), or `null` when no
 * archive exists yet. Pure — exported for tests.
 *
 * Used by the on-disk idempotency probe: when `temp/epic-<id>/` is
 * absent AND an archive directory already exists, we know a prior run
 * completed the move; the listener short-circuits to a single
 * `epic.cleanup.end` + `epic.complete` emit without re-archiving.
 */
export function findExistingArchive({
  tempRoot,
  epicId,
  readdirFn = readdirSync,
}) {
  const archiveRoot = path.join(tempRoot, 'archive');
  let entries;
  try {
    entries = readdirFn(archiveRoot, { withFileTypes: true });
  } catch (err) {
    // Missing archive root is the typical first-run case.
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const prefix = `epic-${epicId}-`;
  const matches = entries
    .filter((e) => e.isDirectory && e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => e.name)
    .sort();
  if (matches.length === 0) return null;
  return path.join(archiveRoot, matches[0]);
}

/**
 * Cleaner listener.
 */
export class Cleaner {
  /**
   * @param {object} opts
   * @param {object} opts.bus
   * @param {number} opts.epicId
   * @param {string} opts.tempRoot - absolute or repo-relative path; the
   *   listener resolves `<tempRoot>/epic-<id>/` as the source and
   *   `<tempRoot>/archive/epic-<id>-<ts>/` as the destination.
   * @param {() => Date} [opts.now] - injectable clock for tests.
   * @param {typeof renameSync} [opts.renameFn] - injectable rename for
   *   tests.
   * @param {typeof existsSync} [opts.existsFn] - injectable presence
   *   probe for tests.
   * @param {typeof mkdirSync} [opts.mkdirFn] - injectable directory
   *   creator for tests.
   * @param {typeof readdirSync} [opts.readdirFn] - injectable directory
   *   reader for the existing-archive probe.
   * @param {{ info?: Function, warn?: Function, debug?: Function }} [opts.logger]
   */
  constructor(opts = {}) {
    if (
      !opts.bus ||
      typeof opts.bus.on !== 'function' ||
      typeof opts.bus.emit !== 'function'
    ) {
      throw new TypeError('Cleaner requires a bus with on() and emit()');
    }
    if (!Number.isInteger(opts.epicId) || opts.epicId < 1) {
      throw new TypeError('Cleaner requires a numeric epicId');
    }
    if (typeof opts.tempRoot !== 'string' || opts.tempRoot.length === 0) {
      throw new TypeError('Cleaner requires a non-empty tempRoot string');
    }
    this.bus = opts.bus;
    this.epicId = opts.epicId;
    this.tempRoot = opts.tempRoot;
    this.now = typeof opts.now === 'function' ? opts.now : defaultNow;
    this.renameFn = opts.renameFn ?? renameSync;
    this.existsFn = opts.existsFn ?? existsSync;
    this.mkdirFn = opts.mkdirFn ?? mkdirSync;
    this.readdirFn = opts.readdirFn ?? readdirSync;
    this.logger = opts.logger ?? console;
    /** @type {Set<string>} `${event}:${seqId}` idempotency cache. */
    this._seen = new Set();
    /**
     * Classification log — every `epic.merge.armed` observed lands
     * here with the outcome (`archived`, `existing-archive`,
     * `skipped-duplicate`, `failed`). Mirrors the
     * Finalizer / AutomergeArmer "no silent skip" surface.
     */
    this.classifications = [];
    // Frozen tuple — Cleaner subscribes to EXACTLY one event.
    this.events = Object.freeze(['epic.merge.armed']);
  }

  register() {
    return this.events.map((event) =>
      this.bus.on(event, async (ctx) => this.handle(ctx)),
    );
  }

  async handle({ event, seqId, payload }) {
    const key = `${event}:${seqId}`;
    if (this._seen.has(key)) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'skipped',
        reason: 'duplicate-seqId',
      });
      this.logger.debug?.(`[Cleaner] skip duplicate ${key} (idempotent)`);
      return;
    }
    this._seen.add(key);

    const prUrl = payload?.prUrl;
    if (typeof prUrl !== 'string' || prUrl.length === 0) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: 'no-pr-url',
      });
      return;
    }

    const epicId = this.epicId;
    const epicDir = path.join(this.tempRoot, `epic-${epicId}`);

    // 1. Announce cleanup.start.
    try {
      await this.bus.emit('epic.cleanup.start', { epicId });
    } catch (err) {
      this.classifications.push({
        event,
        seqId,
        outcome: 'failed',
        reason: `start-emit-failed:${err?.message ?? err}`,
      });
      this.logger.warn?.(
        `[Cleaner] epic.cleanup.start emit failed: ${err?.message ?? err}`,
      );
      return;
    }

    // 2. Archive. Three states:
    //    (a) source exists — rename it under `archive/`. Happy path.
    //    (b) source absent + archive present — resume after a crash
    //        between rename and the cleanup.end emit. Record the
    //        existing archive and proceed to emit cleanup.end +
    //        epic.complete.
    //    (c) source absent + archive absent — nothing to archive (e.g.
    //        the ledger writer never created the epic temp dir).
    //        Proceed to emit cleanup.end + epic.complete anyway.
    let archivedTo;
    let outcome;
    if (this.existsFn(epicDir)) {
      const dest = resolveArchiveDest({
        tempRoot: this.tempRoot,
        epicId,
        now: this.now(),
      });
      try {
        this.mkdirFn(path.dirname(dest), { recursive: true });
        this.renameFn(epicDir, dest);
      } catch (err) {
        this.classifications.push({
          event,
          seqId,
          outcome: 'failed',
          reason: `archive-failed:${err?.message ?? err}`,
        });
        this.logger.warn?.(
          `[Cleaner] archive rename failed (${epicDir} → ${dest}): ${err?.message ?? err}`,
        );
        return;
      }
      archivedTo = dest;
      outcome = 'archived';
    } else {
      const existing = findExistingArchive({
        tempRoot: this.tempRoot,
        epicId,
        readdirFn: this.readdirFn,
      });
      archivedTo = existing;
      outcome = existing ? 'existing-archive' : 'no-source';
      this.logger.info?.(
        existing
          ? `[Cleaner] source ${epicDir} absent; existing archive ${existing} — resume contract honored.`
          : `[Cleaner] source ${epicDir} absent and no prior archive — nothing to do.`,
      );
    }

    this.classifications.push({
      event,
      seqId,
      outcome,
      epicId,
      archivedTo,
    });

    // 3. cleanup.end + epic.complete. Even when there is nothing to
    //    archive, the terminal events MUST still fire — `epic.complete`
    //    is what flips the Epic ticket to `agent::done`.
    try {
      await this.bus.emit('epic.cleanup.end', { epicId });
    } catch (err) {
      this.logger.warn?.(
        `[Cleaner] epic.cleanup.end emit failed (swallowed): ${err?.message ?? err}`,
      );
      return;
    }
    try {
      await this.bus.emit('epic.complete', { epicId, prUrl });
    } catch (err) {
      this.logger.warn?.(
        `[Cleaner] epic.complete emit failed (swallowed): ${err?.message ?? err}`,
      );
    }
  }

  reset() {
    this._seen.clear();
    this.classifications = [];
  }
}

export function createCleaner(opts) {
  return new Cleaner(opts);
}
