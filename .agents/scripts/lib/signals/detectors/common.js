/**
 * detectors/common.js — shared predicates for the signals layer.
 */

/**
 * The canonical numeric-id guard for signal writers and readers.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

/**
 * `emitter.tool` is canonical; `details.tool` is accepted defensively.
 *
 * @param {object} rec
 * @returns {string|null}
 */
export function extractTool(rec) {
  if (typeof rec?.emitter?.tool === 'string' && rec.emitter.tool.length > 0) {
    return rec.emitter.tool;
  }
  if (typeof rec?.details?.tool === 'string' && rec.details.tool.length > 0) {
    return rec.details.tool;
  }
  return null;
}

/**
 * Shared detector argument guard. Messages are prefixed with `fnName`;
 * shape/`tracesPath`/`nowFn` failures throw `TypeError`, id and `threshold`
 * failures `RangeError`. A field whose `require*` flag is off is neither
 * validated nor returned.
 *
 * @param {object} args — the detector's raw argument object.
 * @param {object} opts
 * @param {string} opts.fnName — error-message prefix (e.g. `'detectRework'`).
 * @param {boolean} [opts.requireTracesPath=true]
 * @param {boolean} [opts.requireStoryId=true] — also gates the optional `taskId`.
 * @param {boolean} [opts.requireThreshold=true]
 * @returns {{
 *   tracesPath: string|undefined,
 *   epicId: number,
 *   storyId: number|undefined,
 *   taskId: number|null|undefined,
 *   threshold: number|undefined,
 *   nowFn: () => string,
 * }}
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
