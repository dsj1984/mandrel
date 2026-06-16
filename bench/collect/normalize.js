// bench/collect/normalize.js
//
// Telemetry normalizer for the Mandrel self-benchmark harness (Epic #4211,
// Story #4217). Internal tooling only — never shipped in the distributed
// `.agents/` bundle, never run against the live repo.
//
// This module is the join point of the harness: it reads the raw artifacts a
// single (scenario × arm × run) produced —
//
//   1. the run's lifecycle NDJSON ledger (temp/epic-<id>/lifecycle.ndjson),
//   2. the per-Story signals NDJSON files,
//   3. the `claude -p --output-format json` usage/cost envelope (parsed by
//      bench/driver/run-session.js#parseSessionEnvelope),
//   4. the scenario's frozen acceptance-suite result + the acceptance-eval
//      cross-check verdict (the Quality inputs), and
//   5. the plan-vs-actual counts (planned/delivered Story counts, planned vs
//      touched file footprints)
//
// — and folds them into ONE per-run record that conforms to
// bench/schemas/scorecard.schema.json. The dimension math is delegated to
// bench/score/dimensions.js; this module owns the *extraction* of the raw
// sub-signals from the lifecycle ledger (timings, dispatch count, autonomy
// counters, and the ceremony/codegen token split) and the assembly of the
// surrounding scorecard envelope.
//
// Determinism: pure functions plus a thin file-reading shell. The NDJSON
// parser and every derivation are pure; only `normalizeRunFromPaths` touches
// the filesystem (and only to read the three artifact kinds), so the core is
// unit-testable from in-memory inputs with no I/O.

import { readFileSync } from 'node:fs';

import { computeDimensions } from '../score/dimensions.js';

/** Scorecard-record schema version this normalizer emits. */
export const SCORECARD_SCHEMA_VERSION = 1;

/**
 * Lifecycle events that bound the *codegen* spans (shippable
 * Story-implementation work). Tokens spent inside a
 * `story.dispatch.start` → `story.dispatch.end` window are codegen; everything
 * else in the session (planning between `epic.plan.start`/`epic.plan.end`,
 * orchestration, gate/close machinery) is attributed to ceremony as the
 * `total − codegen` remainder (see `deriveTokenSplit`).
 */
const STORY_DISPATCH_START = 'story.dispatch.start';
const STORY_DISPATCH_END = 'story.dispatch.end';

/** Lifecycle events that count toward the autonomy intervention tally. */
const EPIC_BLOCKED = 'epic.blocked';
const STORY_BLOCKED = 'story.blocked';
const INTERVENTION_RECORDED = 'intervention.recorded';

/**
 * Parse an NDJSON string into an array of records. Blank lines are skipped;
 * a malformed line throws with its 1-based line number so a corrupt ledger
 * fails loudly rather than silently dropping telemetry.
 *
 * Each lifecycle record has the shape written by the LedgerWriter / the thin
 * emit helpers: `{ kind, ts, seqId?, event, payload }`.
 *
 * @param {string} text
 * @returns {Array<object>}
 * @throws {SyntaxError} on a non-blank line that is not valid JSON.
 */
export function parseNdjson(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseNdjson: input must be a string');
  }
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (cause) {
      throw new SyntaxError(
        `parseNdjson: invalid JSON on line ${i + 1}: ${cause.message}`,
      );
    }
  }
  return out;
}

/**
 * The `emitted` records are the canonical lifecycle signal; the LedgerWriter
 * also writes `completed`/`failed` bookkeeping records that repeat an event
 * name without a payload. For deriving run telemetry we only ever want the
 * `emitted` records (every emit produces exactly one). Records written by the
 * thin direct-append helpers (heartbeat, dispatch-end) are already
 * `kind: 'emitted'`, so this filter unifies both producers.
 *
 * @param {Array<object>} records
 * @returns {Array<object>}
 */
function emittedRecords(records) {
  return records.filter(
    (r) => r?.event && r.kind !== 'completed' && r.kind !== 'failed',
  );
}

/**
 * Parse an ISO-8601 timestamp into epoch ms, or NaN when absent/malformed.
 *
 * @param {unknown} ts
 * @returns {number}
 */
function tsMs(ts) {
  if (typeof ts !== 'string') return Number.NaN;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Derive the wall-clock duration of a run from the span of its lifecycle
 * records: `last.ts − first.ts`, in milliseconds. Records are NOT assumed to
 * be sorted, so we scan for the min and max parseable timestamp. Returns 0
 * when fewer than two timestamps are present.
 *
 * GitHub round-trip latency is intentionally inside this window — it is part
 * of Mandrel's real overhead (README § 4).
 *
 * @param {Array<object>} records  Lifecycle records.
 * @returns {number}
 */
export function deriveWallClockMs(records) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const r of records) {
    const ms = tsMs(r?.ts);
    if (!Number.isFinite(ms)) continue;
    count += 1;
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  if (count < 2) return 0;
  return Math.max(0, max - min);
}

/**
 * Count Story dispatches (sub-agent launches) — one per
 * `story.dispatch.start` record.
 *
 * @param {Array<object>} records  Emitted lifecycle records.
 * @returns {number}
 */
export function deriveDispatchCount(records) {
  let n = 0;
  for (const r of records) {
    if (r.event === STORY_DISPATCH_START) n += 1;
  }
  return n;
}

/**
 * Derive the autonomy counters from the lifecycle ledger plus the per-Story
 * signals.
 *
 *   blockedEvents — `epic.blocked` + `story.blocked` records.
 *   manualRescues — `intervention.recorded` records.
 *   hitlStops     — STOP gates the run actually halted at. In a correctly
 *                   configured unattended run these auto-proceed (count 0); a
 *                   non-zero value is a finding. They are sourced from
 *                   explicit signal records (`kind: 'hitl-stop'` or
 *                   `signal: 'hitl-stop'`) in the per-Story signals, since the
 *                   lifecycle bus has no dedicated HITL-stop event — an
 *                   auto-proceeding gate emits nothing.
 *
 * @param {object} args
 * @param {Array<object>} args.lifecycle  Emitted lifecycle records.
 * @param {Array<object>} [args.signals]  Flattened per-Story signal records.
 * @returns {{ hitlStops: number, blockedEvents: number, manualRescues: number }}
 */
export function deriveAutonomyCounters({ lifecycle, signals = [] }) {
  let blockedEvents = 0;
  let manualRescues = 0;
  for (const r of lifecycle) {
    if (r.event === EPIC_BLOCKED || r.event === STORY_BLOCKED)
      blockedEvents += 1;
    else if (r.event === INTERVENTION_RECORDED) manualRescues += 1;
  }
  let hitlStops = 0;
  for (const s of signals) {
    if (s?.kind === 'hitl-stop' || s?.signal === 'hitl-stop') hitlStops += 1;
  }
  return { hitlStops, blockedEvents, manualRescues };
}

/**
 * Split the run's total tokens into a ceremony bucket and a codegen bucket
 * using the lifecycle phase boundaries (README § 5, "Token attribution").
 *
 * Mandrel records no per-phase token actuals — the only cost source is the
 * single session-level `claude -p` envelope (`totalTokens`). So we attribute
 * the *session total* across the two buckets in proportion to the wall-clock
 * time each bucket occupied:
 *
 *   codegenMs  = Σ (story.dispatch.end.ts − matching story.dispatch.start.ts)
 *   ceremonyMs = wallClockMs − codegenMs
 *   codegenTokens  = round(totalTokens · codegenMs / wallClockMs)
 *   ceremonyTokens = totalTokens − codegenTokens   (so the two always sum to total)
 *
 * Time-proportional attribution is the honest derivation available from the
 * recorded inputs: the implementation phases that produce shippable artifacts
 * are exactly the dispatch windows, and everything else in the session
 * (planning, orchestration, gate/close machinery) is ceremony. The per-Story
 * dispatch windows are matched start→end by `storyId`; an unclosed dispatch
 * (start with no end) contributes nothing to codegen time (it never produced a
 * settled shippable result within the recorded window).
 *
 * Edge cases:
 *   - `wallClockMs === 0` (single-timestamp ledger): the whole session total
 *     is ceremony (no measurable codegen window).
 *   - `totalTokens === 0`: both buckets are 0.
 *   - control arm: typically no dispatch windows, so codegen ≈ the bare run
 *     and ceremony ≈ 0 — matching the README's "control arm sits near the
 *     floor".
 *
 * @param {object} args
 * @param {Array<object>} args.lifecycle    Emitted lifecycle records.
 * @param {number} args.totalTokens         Session total tokens (from envelope).
 * @param {number} args.wallClockMs         Derived run wall-clock.
 * @returns {{
 *   ceremonyTokens: number,
 *   codegenTokens: number,
 *   ceremonyMs: number,
 *   codegenMs: number
 * }}
 */
export function deriveTokenSplit({ lifecycle, totalTokens, wallClockMs }) {
  const total =
    typeof totalTokens === 'number' && totalTokens >= 0
      ? Math.trunc(totalTokens)
      : 0;
  const wall =
    typeof wallClockMs === 'number' && wallClockMs > 0 ? wallClockMs : 0;

  // Sum the matched dispatch windows. Match start→end per storyId; a start
  // with no matching end contributes no codegen time.
  const openStartMsByStory = new Map();
  let codegenMs = 0;
  for (const r of lifecycle) {
    const storyId = r?.payload?.storyId;
    const ms = tsMs(r.ts);
    if (r.event === STORY_DISPATCH_START && Number.isFinite(ms)) {
      openStartMsByStory.set(storyId, ms);
    } else if (r.event === STORY_DISPATCH_END && Number.isFinite(ms)) {
      const startMs = openStartMsByStory.get(storyId);
      if (Number.isFinite(startMs) && ms >= startMs) {
        codegenMs += ms - startMs;
        openStartMsByStory.delete(storyId);
      }
    }
  }
  // Codegen time can never exceed the run's wall-clock (overlapping parallel
  // dispatches could otherwise sum past it); clamp so the proportion is valid.
  if (wall > 0 && codegenMs > wall) codegenMs = wall;
  const ceremonyMs = wall > 0 ? Math.max(0, wall - codegenMs) : 0;

  let codegenTokens = 0;
  if (total > 0 && wall > 0) {
    codegenTokens = Math.round((total * codegenMs) / wall);
    if (codegenTokens > total) codegenTokens = total;
  }
  const ceremonyTokens = total - codegenTokens;

  return { ceremonyTokens, codegenTokens, ceremonyMs, codegenMs };
}

/**
 * Extract the usage/cost fields the scorecard needs from a parsed `claude -p`
 * envelope. Accepts either the normalized shape returned by
 * `run-session.js#parseSessionEnvelope` (`{ usage: { totalTokens, … }, cost:
 * { totalUsd } }`) or a raw envelope (`{ usage: { input_tokens, … },
 * total_cost_usd }`), so the normalizer is robust to being handed either.
 *
 * @param {object} envelope
 * @returns {{
 *   totalTokens: number,
 *   inputTokens: number,
 *   outputTokens: number,
 *   costUsd: number|null
 * }}
 */
export function extractUsage(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return { totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: null };
  }
  const usage =
    envelope.usage && typeof envelope.usage === 'object' ? envelope.usage : {};

  // Normalized shape (from parseSessionEnvelope).
  if (typeof usage.totalTokens === 'number') {
    const totalUsd =
      envelope.cost && typeof envelope.cost === 'object'
        ? envelope.cost.totalUsd
        : null;
    return {
      totalTokens: nonNeg(usage.totalTokens),
      inputTokens: nonNeg(usage.inputTokens),
      outputTokens: nonNeg(usage.outputTokens),
      costUsd: typeof totalUsd === 'number' && totalUsd >= 0 ? totalUsd : null,
    };
  }

  // Raw envelope shape.
  const inputTokens = nonNeg(usage.input_tokens);
  const outputTokens = nonNeg(usage.output_tokens);
  const cacheCreate = nonNeg(usage.cache_creation_input_tokens);
  const cacheRead = nonNeg(usage.cache_read_input_tokens);
  const totalUsd =
    typeof envelope.total_cost_usd === 'number' && envelope.total_cost_usd >= 0
      ? envelope.total_cost_usd
      : null;
  return {
    totalTokens: inputTokens + outputTokens + cacheCreate + cacheRead,
    inputTokens,
    outputTokens,
    costUsd: totalUsd,
  };
}

/**
 * Coerce to a non-negative integer (0 on miss).
 * @param {unknown} v
 * @returns {number}
 */
function nonNeg(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.trunc(v)
    : 0;
}

/**
 * Build one per-run scorecard record from already-parsed in-memory inputs.
 * This is the pure core — no filesystem access — so it is fully unit-testable.
 *
 * @param {object} args
 * @param {object} args.run             Run identity / stamp.
 * @param {string} args.run.runId
 * @param {string} args.run.timestamp   ISO-8601 run-complete time.
 * @param {{ id: string, displayName?: string }} args.run.model
 * @param {string} args.run.frameworkVersion
 * @param {{ node: string, os: string, host?: string }} args.run.env
 * @param {'hello-world'|'crud-db'} args.run.scenario
 * @param {'mandrel'|'control'} args.run.arm
 * @param {Array<object>} args.lifecycle   Parsed lifecycle NDJSON records.
 * @param {Array<object>} [args.signals]   Flattened per-Story signal records.
 * @param {object} args.envelope           Parsed `claude -p` usage envelope.
 * @param {object} args.quality            Frozen-suite + judge inputs:
 *   `{ frozenSuitePassed, frozenSuiteTotal, acceptanceEvalScore? }`.
 * @param {object} [args.planning]         Plan-vs-actual inputs:
 *   `{ rePlanCount?, plannedStoryCount?, deliveredStoryCount?,
 *      fileFootprintDrift?|{plannedPaths, actualPaths} }`. Ignored for control.
 * @param {object} [args.rawRefs]          Provenance breadcrumbs for `rawRefs`.
 * @returns {object} A scorecard record conforming to scorecard.schema.json.
 */
export function buildScorecard({
  run,
  lifecycle = [],
  signals = [],
  envelope,
  quality,
  planning = {},
  rawRefs,
}) {
  if (!run || typeof run !== 'object') {
    throw new TypeError('buildScorecard: run identity is required');
  }
  const required = [
    'runId',
    'timestamp',
    'model',
    'frameworkVersion',
    'env',
    'scenario',
    'arm',
  ];
  for (const key of required) {
    if (run[key] === undefined || run[key] === null) {
      throw new TypeError(`buildScorecard: run.${key} is required`);
    }
  }
  if (run.arm !== 'mandrel' && run.arm !== 'control') {
    throw new TypeError(
      `buildScorecard: run.arm must be "mandrel" or "control", got ${String(run.arm)}`,
    );
  }
  if (!quality || typeof quality !== 'object') {
    throw new TypeError('buildScorecard: quality inputs are required');
  }

  const emitted = emittedRecords(lifecycle);

  // ---- Lifecycle-derived raw sub-signals -------------------------------
  const wallClockMs = deriveWallClockMs(emitted);
  const dispatches = deriveDispatchCount(emitted);
  const autonomy = deriveAutonomyCounters({ lifecycle: emitted, signals });
  const usage = extractUsage(envelope);
  const split = deriveTokenSplit({
    lifecycle: emitted,
    totalTokens: usage.totalTokens,
    wallClockMs,
  });

  // ---- Dimension math (delegated to the scorer) ------------------------
  const dimensions = computeDimensions({
    arm: run.arm,
    quality: {
      frozenSuitePassed: quality.frozenSuitePassed,
      frozenSuiteTotal: quality.frozenSuiteTotal,
      acceptanceEvalScore:
        run.arm === 'control' && quality.acceptanceEvalScore === undefined
          ? null
          : (quality.acceptanceEvalScore ?? null),
    },
    planningFidelity: {
      rePlanCount: planning.rePlanCount,
      plannedStoryCount: planning.plannedStoryCount,
      deliveredStoryCount: planning.deliveredStoryCount,
      fileFootprintDrift: planning.fileFootprintDrift,
      plannedPaths: planning.plannedPaths,
      actualPaths: planning.actualPaths,
    },
    autonomy,
    efficiency: {
      wallClockMs,
      totalTokens: usage.totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      dispatches,
      costUsd: usage.costUsd,
    },
    overheadRatio: {
      ceremonyTokens: split.ceremonyTokens,
      codegenTokens: split.codegenTokens,
      ceremonyMs: split.ceremonyMs,
      codegenMs: split.codegenMs,
    },
  });

  const scorecard = {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    runId: run.runId,
    timestamp: run.timestamp,
    model:
      typeof run.model === 'string'
        ? { id: run.model }
        : {
            id: run.model.id,
            ...(run.model.displayName
              ? { displayName: run.model.displayName }
              : {}),
          },
    frameworkVersion: run.frameworkVersion,
    env: {
      node: run.env.node,
      os: run.env.os,
      ...(run.env.host ? { host: run.env.host } : {}),
    },
    scenario: run.scenario,
    arm: run.arm,
    dimensions,
  };

  if (rawRefs && typeof rawRefs === 'object') {
    scorecard.rawRefs = rawRefs;
  }

  return scorecard;
}

/**
 * Filesystem shell over `buildScorecard`: read the lifecycle NDJSON, the
 * per-Story signals NDJSON files, and the `claude -p` envelope JSON from disk,
 * then assemble the scorecard. The Quality and planning inputs are passed
 * in-memory by the caller (they come from the frozen-suite/judge run and the
 * decomposer output, not from a single artifact file on disk).
 *
 * @param {object} args
 * @param {object} args.run                 Run identity (see buildScorecard).
 * @param {string} args.lifecyclePath       Path to lifecycle.ndjson.
 * @param {string[]} [args.signalsPaths]    Paths to per-Story signals.ndjson.
 * @param {string} args.costEnvelopePath    Path to the captured envelope JSON.
 * @param {object} args.quality             Quality inputs.
 * @param {object} [args.planning]          Plan-vs-actual inputs.
 * @param {object} [args.rawRefs]           Provenance overrides; when omitted,
 *   the supplied paths are recorded.
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]  Injectable
 *   reader (tests).
 * @returns {object} A scorecard record.
 */
export function normalizeRunFromPaths(
  {
    run,
    lifecyclePath,
    signalsPaths = [],
    costEnvelopePath,
    quality,
    planning = {},
    rawRefs,
  },
  deps = {},
) {
  const read = deps.readFileImpl ?? readFileSync;

  if (typeof lifecyclePath !== 'string' || lifecyclePath.length === 0) {
    throw new TypeError('normalizeRunFromPaths: lifecyclePath is required');
  }
  if (typeof costEnvelopePath !== 'string' || costEnvelopePath.length === 0) {
    throw new TypeError('normalizeRunFromPaths: costEnvelopePath is required');
  }

  const lifecycle = parseNdjson(read(lifecyclePath, 'utf8'));

  const signals = [];
  for (const p of signalsPaths) {
    const recs = parseNdjson(read(p, 'utf8'));
    for (const r of recs) signals.push(r);
  }

  const envelope = JSON.parse(read(costEnvelopePath, 'utf8'));

  const resolvedRawRefs = rawRefs ?? {
    lifecycleNdjson: lifecyclePath,
    ...(signalsPaths.length > 0 ? { signalsNdjson: [...signalsPaths] } : {}),
    costEnvelope: costEnvelopePath,
  };

  return buildScorecard({
    run,
    lifecycle,
    signals,
    envelope,
    quality,
    planning,
    rawRefs: resolvedRawRefs,
  });
}
