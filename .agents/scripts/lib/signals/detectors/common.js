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
  const gates = {
    always: true,
    requireTracesPath: opts.requireTracesPath ?? true,
    requireStoryId: opts.requireStoryId ?? true,
    requireThreshold: opts.requireThreshold ?? true,
  };

  if (args == null || typeof args !== 'object') {
    throw new TypeError(
      `${fnName}: args must be an object with at minimum { tracesPath, epicId, storyId, threshold }; got ${args}`,
    );
  }

  const values = { ...args, taskId: args.taskId ?? null };
  for (const rule of DETECTOR_ARG_RULES) {
    const value = values[rule.field];
    if (gates[rule.gate] && rule.invalid(value)) {
      throw new rule.Error(`${fnName}: ${rule.message(value)}`);
    }
  }

  return {
    tracesPath: gates.requireTracesPath ? values.tracesPath : undefined,
    epicId: values.epicId,
    storyId: gates.requireStoryId ? values.storyId : undefined,
    taskId: gates.requireStoryId ? values.taskId : undefined,
    threshold: gates.requireThreshold ? values.threshold : undefined,
    nowFn: args.nowFn ?? (() => new Date().toISOString()),
  };
}

const DETECTOR_ARG_RULES = [
  {
    field: 'nowFn',
    gate: 'always',
    invalid: (v) => v != null && typeof v !== 'function',
    Error: TypeError,
    message: (v) =>
      `nowFn, when provided, must be a function (got ${typeof v})`,
  },
  {
    field: 'tracesPath',
    gate: 'requireTracesPath',
    invalid: (v) => typeof v !== 'string' || v.length === 0,
    Error: TypeError,
    message: (v) => `tracesPath must be a non-empty string (got ${v})`,
  },
  {
    field: 'epicId',
    gate: 'always',
    invalid: (v) => !isPositiveInt(v),
    Error: RangeError,
    message: (v) => `epicId must be a positive integer (got ${v})`,
  },
  {
    field: 'storyId',
    gate: 'requireStoryId',
    invalid: (v) => !isPositiveInt(v),
    Error: RangeError,
    message: (v) => `storyId must be a positive integer (got ${v})`,
  },
  {
    field: 'taskId',
    gate: 'requireStoryId',
    invalid: (v) => v !== null && !isPositiveInt(v),
    Error: RangeError,
    message: (v) => `taskId must be a positive integer or null (got ${v})`,
  },
  {
    field: 'threshold',
    gate: 'requireThreshold',
    invalid: (v) => !Number.isInteger(v) || v < 0,
    Error: RangeError,
    message: (v) => `threshold must be a non-negative integer (got ${v})`,
  },
];
