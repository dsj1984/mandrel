/**
 * detectors/common.js — shared helpers for the signals layer.
 *
 * Hoisted out of three detector modules (hotspot, retry, rework) plus
 * `signals/read.js` and `signals/schema.js`, all of which shipped
 * byte-equivalent copies of these predicates. See Story #2464.
 */

/**
 * Return true when `v` is a positive (strictly > 0) integer. Used by every
 * signal writer and reader as the canonical numeric-id guard.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

/**
 * Pull the tool name from a trace record. The hook writes the tool name
 * into `source.tool` and (defensively) into `details.tool` — we accept
 * either so older traces still classify correctly.
 *
 * @param {object} rec
 * @returns {string|null}
 */
export function extractTool(rec) {
  if (typeof rec?.source?.tool === 'string' && rec.source.tool.length > 0) {
    return rec.source.tool;
  }
  if (typeof rec?.details?.tool === 'string' && rec.details.tool.length > 0) {
    return rec.details.tool;
  }
  return null;
}

/**
 * Validate and normalize the shared detector argument preamble.
 *
 * `detectRework`, `detectRetry`, and `detectHotspot` previously shipped a
 * near-identical guard block: the `args` object-shape `TypeError`, the
 * `nowFn` function-type `TypeError`, the positive-integer `RangeError`s for
 * the id fields, the non-empty-string `tracesPath` check, and the
 * non-negative-integer `threshold` check. Story #4077 hoists that preamble
 * here so the three detectors share one error-message contract.
 *
 * Error wording stays per-detector-accurate by prefixing every message with
 * `fnName` (e.g. `detectRework: …`). Error *types* are preserved exactly:
 * the `args`/`tracesPath`/`nowFn` guards throw `TypeError`; the id and
 * `threshold` guards throw `RangeError`.
 *
 * The validated fields are gated by the `require*` flags so the same helper
 * serves both the Story-scoped detectors (rework/retry — full preamble) and
 * the Epic-scoped hotspot detector (only `epicId` + `nowFn`). A field that
 * is not required is neither validated nor read.
 *
 * @param {object} args — the detector's raw argument object.
 * @param {object} opts
 * @param {string} opts.fnName — the calling detector's name, used verbatim as
 *   the prefix on every thrown error message (e.g. `'detectRework'`).
 * @param {boolean} [opts.requireTracesPath=true] — validate + return
 *   `tracesPath` (non-empty string).
 * @param {boolean} [opts.requireStoryId=true] — validate + return `storyId`
 *   (positive integer) and the optional `taskId` (positive integer or null).
 * @param {boolean} [opts.requireThreshold=true] — validate + return
 *   `threshold` (non-negative integer).
 * @returns {{
 *   tracesPath: string|undefined,
 *   epicId: number,
 *   storyId: number|undefined,
 *   taskId: number|null|undefined,
 *   threshold: number|undefined,
 *   nowFn: () => string,
 * }} the normalized argument set. Fields gated off by a `require*` flag are
 *   omitted (left `undefined`).
 */
export function validateDetectorArgs(args, opts) {
  const { fnName } = opts;
  const requireTracesPath = opts.requireTracesPath ?? true;
  const requireStoryId = opts.requireStoryId ?? true;
  const requireThreshold = opts.requireThreshold ?? true;

  if (args == null || typeof args !== 'object') {
    throw new TypeError(
      `${fnName}: args must be an object with at minimum { tracesPath, epicId, storyId, threshold }; got ${args}`,
    );
  }

  const { tracesPath, epicId, storyId, threshold } = args;
  const taskId = args.taskId ?? null;

  if (args.nowFn != null && typeof args.nowFn !== 'function') {
    throw new TypeError(
      `${fnName}: nowFn, when provided, must be a function (got ${typeof args.nowFn})`,
    );
  }
  const nowFn = args.nowFn ?? (() => new Date().toISOString());

  if (requireTracesPath) {
    if (typeof tracesPath !== 'string' || tracesPath.length === 0) {
      throw new TypeError(
        `${fnName}: tracesPath must be a non-empty string (got ${tracesPath})`,
      );
    }
  }

  if (!isPositiveInt(epicId)) {
    throw new RangeError(
      `${fnName}: epicId must be a positive integer (got ${epicId})`,
    );
  }

  if (requireStoryId) {
    if (!isPositiveInt(storyId)) {
      throw new RangeError(
        `${fnName}: storyId must be a positive integer (got ${storyId})`,
      );
    }
    if (taskId !== null && !isPositiveInt(taskId)) {
      throw new RangeError(
        `${fnName}: taskId must be a positive integer or null (got ${taskId})`,
      );
    }
  }

  if (requireThreshold) {
    if (!Number.isInteger(threshold) || threshold < 0) {
      throw new RangeError(
        `${fnName}: threshold must be a non-negative integer (got ${threshold})`,
      );
    }
  }

  return {
    tracesPath: requireTracesPath ? tracesPath : undefined,
    epicId,
    storyId: requireStoryId ? storyId : undefined,
    taskId: requireStoryId ? taskId : undefined,
    threshold: requireThreshold ? threshold : undefined,
    nowFn,
  };
}
