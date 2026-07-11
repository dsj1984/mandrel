/**
 * Retry detector — pure module (Epic #1721 / Story #1768 / Task #1773).
 *
 * Scans a `traces.ndjson` file for repeated **failed** Bash invocations
 * keyed by a stable command identity, and emits one `kind: 'retry'`
 * SignalEvent per identity whose failure count strictly exceeds the
 * configured threshold. Pure: takes a file path in, returns events out.
 * Emission to disk is the caller's job.
 *
 * ## Identity rule
 *
 * The detector groups failed Bash trace records by:
 *
 *   1. `details.normalizedHash` when present (canonical form — collapses
 *      whitespace, strips benign flags like `--no-color` / `--quiet`,
 *      and treats `npm test` ≡ `npm run test`). Set by
 *      `lib/observability/tool-trace-hook.js` (Story #1768 / Task #1775).
 *   2. `details.targetHash` as the fallback when `normalizedHash` is
 *      absent (e.g. legacy traces, or a Bash event whose command was
 *      empty / non-string and the normaliser declined to emit a hash).
 *
 * Records that have neither hash are skipped — without a stable key we
 * cannot group repeats. The grouping is by the chosen identity hash, so
 * `npm test` and `npm  run  test` (different `targetHash`, identical
 * `normalizedHash`) collapse into one bucket.
 *
 * ## Failure rule
 *
 * A trace record is treated as **failed** when its `details.exitCode`
 * is a number and not `0`. As of Epic #4406 / Story #4413 the tool-trace
 * hook captures `details.exitCode` for Bash `PostToolUse` events, so this
 * detector fires on real deliveries; records without an `exitCode` field
 * (non-Bash tools, or tools that report no exit code) are ignored, which
 * matches the decision in the parent Epic body that retry only counts
 * non-zero-exit commands.
 *
 * Successful runs after failures **do not** cancel the count — failure-
 * count is monotonic per identity. This matches the Epic's intent: once
 * a command has failed N times, the friction signal has happened, even
 * if a later attempt succeeded. The detector is observational, not a
 * status check.
 *
 * ## Tool filter
 *
 * Only trace records whose `emitter.tool === 'Bash'` participate. Edit /
 * Write / Read / Grep / Glob events are not retries — those belong to
 * other detectors (rework for file-edit churn). The tool name is read
 * from `emitter.tool` first and falls back to `details.tool` (see
 * `common.extractTool`).
 *
 * ## Privacy contract
 *
 * Identity hashes are sha256 strings produced by the hook before any
 * raw value reaches disk (see `lib/observability/tool-trace-hook.js`
 * `hashTarget`). The detector never sees plaintext commands and never
 * reverses a hash. Emitted signals carry `details.commandHash` — the
 * same `sha256:<hex>` string that drove the grouping — so downstream
 * surfaces can dedupe across a Story without ever resolving back to a
 * raw command string.
 *
 * ## Threshold semantics
 *
 * `failureCount > threshold` (strictly greater than). An identity with
 * exactly `threshold` failures does NOT emit. This matches the
 * `delivery.signals.retry.repeatCount` config surface (Epic #1720) —
 * the configured value is the maximum tolerated repeat count, not the
 * trigger count.
 *
 * ## Robustness
 *
 *   - Missing `tracesPath` file → returns `[]`. Never throws.
 *   - Malformed JSON lines → silently skipped (consistent with
 *     `lib/signals/read.js`).
 *   - Non-trace records → ignored. The file may legitimately interleave
 *     other kinds in future.
 *   - Non-Bash trace records → ignored.
 *
 * @module lib/signals/detectors/retry
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { extractTool, validateDetectorArgs } from './common.js';

/**
 * Documented argv-normalisation rules — emitted verbatim onto every
 * retry signal so the downstream renderer can show the operator which
 * paraphrases collapsed. Kept as a frozen array so callers cannot
 * mutate the canonical list.
 *
 * Mirrors the rule list in `lib/observability/tool-trace-hook.js`
 * `normaliseBashCommand` — keep these in sync when extending the
 * normaliser.
 *
 * @type {ReadonlyArray<string>}
 */
export const NORMALIZATION_RULES = Object.freeze([
  'collapse-whitespace',
  'strip-benign-flags:--no-color,--quiet',
  'npm-test-equiv-npm-run-test',
]);

/**
 * Resolve the identity key used to group a Bash trace record. Prefers
 * `details.normalizedHash` (canonical form, collapses paraphrases),
 * falls back to `details.targetHash` (raw-command hash). Returns `null`
 * when neither is present — the caller skips those records.
 *
 * @param {object} rec
 * @returns {string|null}
 */
function resolveIdentity(rec) {
  const normalized = rec?.details?.normalizedHash;
  if (typeof normalized === 'string' && normalized.length > 0) {
    return normalized;
  }
  const target = rec?.details?.targetHash;
  if (typeof target === 'string' && target.length > 0) {
    return target;
  }
  return null;
}

/**
 * Decide whether a trace record represents a failed invocation. As of
 * Epic #4406 / Story #4413 the tool-trace hook records `details.exitCode`
 * for Bash `PostToolUse` events, so the field is present on real Bash
 * traces (and still set directly by tests). A record counts as failed
 * when `details.exitCode` is a number and not zero. Anything else
 * (missing field, null, non-number, zero) is NOT a failure and is ignored
 * entirely — the detector only counts non-zero-exit commands per the
 * parent Epic.
 *
 * @param {object} rec
 * @returns {boolean}
 */
function isFailedBash(rec) {
  const code = rec?.details?.exitCode;
  return typeof code === 'number' && code !== 0;
}

/**
 * Stream `tracesPath` line-by-line and accumulate per-identity failure
 * counts. Returns a `Map<identityHash, count>`. Missing file → empty map.
 *
 * @param {string} tracesPath
 * @returns {Promise<Map<string, number>>}
 */
async function tallyFailuresByIdentity(tracesPath) {
  const counts = new Map();

  // Existence check before opening the stream — `createReadStream`
  // defers ENOENT until the first read, which leaves the iterator in a
  // bad state on some Node versions. `fs.access` short-circuits cleanly.
  try {
    await fs.access(tracesPath);
  } catch {
    return counts;
  }

  const stream = createReadStream(tracesPath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const rawLine of rl) {
      if (rawLine.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        // Mirrors lib/signals/read.js — partial-write races are common.
        continue;
      }
      if (parsed == null || typeof parsed !== 'object') continue;
      if (parsed.kind !== 'trace') continue;

      const tool = extractTool(parsed);
      if (tool !== 'Bash') continue;

      if (!isFailedBash(parsed)) continue;

      const identity = resolveIdentity(parsed);
      if (identity == null) continue;

      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
  } finally {
    rl.close();
    if (!stream.destroyed) stream.destroy();
  }

  return counts;
}

/**
 * Detect retries against `tracesPath`. Returns a `kind: 'retry'`
 * SignalEvent for every identity whose failure count strictly exceeds
 * `threshold`. Pure — emission to disk is the caller's responsibility.
 *
 * The detector takes `threshold` as a function arg and never reaches
 * for `getSignals(config).retry.repeatCount`. Resolving the threshold
 * from config lives at the call site so this module stays import-graph-
 * free of `lib/config/*`.
 *
 * @param {object} args
 * @param {string} args.tracesPath — absolute path to a `traces.ndjson`.
 * @param {number} args.epicId — positive integer Epic ID.
 * @param {number} args.storyId — positive integer Story ID.
 * @param {number|null} [args.taskId] — positive integer Task ID, or null.
 * @param {number} args.threshold — the maximum tolerated failure count;
 *   identities with `failureCount > threshold` emit. MUST be a
 *   non-negative integer.
 * @param {() => string} [args.nowFn] — optional clock seam returning the
 *   ISO-8601 `ts` stamped onto every emitted SignalEvent. Defaults to
 *   `() => new Date().toISOString()`. Inject a fixed-return function in
 *   tests to make the emitted `ts` deterministic. MUST, when provided, be
 *   a function.
 * @returns {Promise<object[]>} array of SignalEvent objects conforming
 *   to `.agents/schemas/signal-event.schema.json`.
 */
export async function detectRetry(args) {
  const { tracesPath, epicId, storyId, taskId, threshold, nowFn } =
    validateDetectorArgs(args, { fnName: 'detectRetry' });

  const counts = await tallyFailuresByIdentity(tracesPath);

  // Stable order: sort by identity hash ascending so the same input
  // always yields the same emission sequence (eases snapshot tests and
  // downstream deduping).
  const offenders = [];
  for (const [identity, count] of counts) {
    if (count > threshold) offenders.push([identity, count]);
  }
  offenders.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const ts = nowFn();
  return offenders.map(([commandHash, failureCount]) => ({
    ts,
    kind: 'retry',
    emitter: { tool: 'retry-detector' },
    epicId,
    storyId,
    taskId,
    details: {
      commandHash,
      failureCount,
      threshold,
      normalizationRules: [...NORMALIZATION_RULES],
    },
  }));
}
