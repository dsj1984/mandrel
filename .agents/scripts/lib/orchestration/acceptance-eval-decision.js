/**
 * Acceptance self-eval decision core (Story #3819).
 *
 * Pure reducer that turns one round's critic verdict plus the resolved
 * round cap into the loop's next action. The CLI wrapper
 * (`acceptance-eval.js`) owns the file reads, schema validation, signal
 * emission, and ticket transitions; this module owns the *decision* so it
 * can be unit-tested in isolation.
 *
 * ## Round derivation (Story #4019)
 *
 * The round number is **derived from the signals ledger**, not from the
 * critic's self-reported `verdict.round`: every prior round appended one
 * `acceptance-eval` signal to the Story's `signals.ndjson`, so the
 * current round is `count(prior signals) + 1`. This survives a subagent
 * restart (the ledger is on disk) and removes the critic's scratch value
 * from the cap enforcement path — a critic that always reports `round: 1`
 * can no longer defeat the bounded-loop guarantee.
 *
 * ## The three terminal actions
 *
 *   - `proceed`  — every criterion is `met`. The Story may flip to
 *                  `closing`.
 *   - `redraft`  — at least one criterion is `partial`/`unmet` AND the
 *                  current round is below the cap. The agent reworks the
 *                  flagged criteria and re-runs the eval pass.
 *   - `block`    — at least one criterion is `partial`/`unmet` AND the
 *                  current round has reached (or somehow exceeded) the cap.
 *                  The Story escalates to `agent::blocked`; it never
 *                  silently proceeds to close.
 *
 * ## The undisableable cap
 *
 * `maxRounds` arrives already clamped by `lib/config/acceptance-eval.js`
 * into `[1, ceiling]`, but this reducer defends the invariant a second
 * time: a non-positive or non-integer cap is coerced to 1, so there is no
 * input — config or verdict — that yields an unbounded `redraft` chain.
 * When `round >= effectiveCap` and criteria remain unmet, the only
 * possible action is `block`.
 */

import { readFileSync } from 'node:fs';

import { runArtifactPath, signalsFile } from '../config/temp-paths.js';

/** Epic-level signals stream basename (mirrors signals-writer). */
const EPIC_SIGNALS_BASENAME = 'signals.ndjson';

/**
 * Verdicts that clear a criterion. Anything else (`partial`, `unmet`, or
 * an unrecognised value) is treated as not-yet-met and triggers rework.
 *
 * @type {ReadonlySet<string>}
 */
const MET_VERDICTS = Object.freeze(new Set(['met']));

/**
 * Coerce a candidate cap to a positive integer ≥ 1. This is the
 * last-line guard against an open loop: any degraded cap falls back to a
 * single round rather than an unbounded one.
 *
 * @param {unknown} value
 * @returns {number}
 */
function effectiveCap(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return 1;
  }
  return value;
}

/**
 * Partition a verdict's criteria into met and not-met buckets, preserving
 * order and capturing the evidence for the not-met items (used to compose
 * the blocker comment and the per-criterion signal).
 *
 * @param {Array<{ index?: number, criterion?: string, verdict?: string, evidence?: string }>} criteria
 * @returns {{
 *   metCount: number,
 *   notMet: Array<{ index: number, criterion: string, verdict: string, evidence: string }>,
 * }}
 */
function partitionCriteria(criteria) {
  const list = Array.isArray(criteria) ? criteria : [];
  const notMet = [];
  let metCount = 0;
  list.forEach((c, i) => {
    const verdict = typeof c?.verdict === 'string' ? c.verdict : 'unmet';
    if (MET_VERDICTS.has(verdict)) {
      metCount += 1;
      return;
    }
    notMet.push({
      index: Number.isInteger(c?.index) ? c.index : i,
      criterion: typeof c?.criterion === 'string' ? c.criterion : '',
      verdict,
      evidence: typeof c?.evidence === 'string' ? c.evidence : '',
    });
  });
  return { metCount, notMet };
}

/**
 * Decide the next loop action from a single round's verdict.
 *
 * @param {object} args
 * @param {{ criteria?: Array<object> }} args.verdict
 *   A verdict already validated against the acceptance-eval-verdict schema.
 *   Its `round` field, when present, is ignored — the round is supplied by
 *   the caller (derived from the signals ledger; Story #4019).
 * @param {number} args.maxRounds
 *   The resolved (already-clamped) redraft ceiling from
 *   `getAcceptanceEval(config).maxRounds`.
 * @param {number} [args.round]
 *   The current round number, derived via `deriveAcceptanceEvalRound`.
 *   Defaults to 1 when absent or invalid.
 * @returns {{
 *   decision: 'proceed' | 'redraft' | 'block',
 *   round: number,
 *   cap: number,
 *   totalCriteria: number,
 *   metCount: number,
 *   notMet: Array<{ index: number, criterion: string, verdict: string, evidence: string }>,
 *   capReached: boolean,
 * }}
 */
export function decideAcceptanceEval({ verdict, maxRounds, round: roundIn }) {
  const cap = effectiveCap(maxRounds);
  const round = Number.isInteger(roundIn) && roundIn >= 1 ? roundIn : 1;
  const { metCount, notMet } = partitionCriteria(verdict?.criteria);
  const totalCriteria = metCount + notMet.length;
  const allMet = notMet.length === 0;
  const capReached = round >= cap;

  let decision;
  if (allMet) {
    decision = 'proceed';
  } else if (capReached) {
    decision = 'block';
  } else {
    decision = 'redraft';
  }

  return {
    decision,
    round,
    cap,
    totalCriteria,
    metCount,
    notMet,
    capReached,
  };
}

/**
 * Build the per-criterion acceptance-eval signal payload for the retro /
 * feedback substrate. Carries which acceptance items needed rework and the
 * round count so `/plan` Phase 0 feedback fetch and the retro can
 * surface acceptance churn. PII-free by construction — it carries only
 * acceptance-item indices, verdicts, and the terminal decision.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {number | null} args.epicId
 * @param {ReturnType<typeof decideAcceptanceEval>} args.outcome
 * @param {string} [args.phase]
 * @returns {object} The signal record (sans `ts`, which the caller stamps).
 */
export function buildAcceptanceEvalSignal({
  storyId,
  epicId,
  outcome,
  phase = 'implement',
  clusterId = null,
}) {
  return {
    kind: 'acceptance-eval',
    epicId: epicId ?? null,
    storyId: storyId ?? null,
    // Epic #4475 (M4-B): single-delivery acceptance critics score an AC
    // *cluster*, not a Story. `clusterId` scopes the per-cluster round count
    // on the epic-level signals stream; omitted (null) for the per-Story path.
    ...(typeof clusterId === 'string' && clusterId.length > 0
      ? { clusterId }
      : {}),
    phase,
    emitter: { tool: 'acceptance-eval.js' },
    details: {
      decision: outcome.decision,
      round: outcome.round,
      cap: outcome.cap,
      totalCriteria: outcome.totalCriteria,
      metCount: outcome.metCount,
      reworkedCount: outcome.notMet.length,
      reworkedCriteria: outcome.notMet.map((c) => ({
        index: c.index,
        verdict: c.verdict,
      })),
    },
  };
}

/**
 * Derive the current acceptance-eval round for a Story by counting the
 * `acceptance-eval` signals already appended to the Story's
 * `signals.ndjson` (Story #4019). Round = prior-signal count + 1, so the
 * first run reports round 1 and each completed round (which appends one
 * signal via `acceptance-eval.js`) advances the derived round by one.
 *
 * The derivation is restart-safe: the ledger lives on disk, so a subagent
 * that dies mid-loop and restarts still observes every prior round. A
 * missing or malformed ledger degrades to round 1 (no prior rounds), and
 * malformed lines are skipped — observability corruption never wedges the
 * gate.
 *
 * @param {object} args
 * @param {number|null} args.epicId   Parent Epic ID, or `null` for a
 *   standalone Story (routes to `<tempRoot>/standalone/stories/...`).
 * @param {number} args.storyId
 * @param {object} [args.config]      Resolved config (tempRoot resolution).
 * @param {(p: string) => string} [args.readFile]  Injectable reader (tests).
 * @param {(eid: number|null, sid: number, config?: object) => string} [args.signalsPathResolver]
 *   Injectable path resolver (tests). Defaults to `signalsFile`.
 * @returns {number} The 1-based current round.
 */
export function deriveAcceptanceEvalRound({
  epicId,
  storyId,
  clusterId = null,
  config,
  readFile = (p) => readFileSync(p, 'utf8'),
  signalsPathResolver = signalsFile,
  epicSignalsPathResolver = (eid, cfg) =>
    runArtifactPath(eid, EPIC_SIGNALS_BASENAME, cfg),
}) {
  // Epic #4475 (M4-B): single-delivery critics score AC clusters, not
  // Stories. When `clusterId` is supplied the round is counted per cluster
  // off the epic-level signals stream; otherwise the per-Story path
  // (unchanged) counts by `storyId` off the Story's stream.
  const clusterMode =
    typeof clusterId === 'string' &&
    clusterId.length > 0 &&
    Number.isInteger(epicId);

  let text;
  try {
    text = clusterMode
      ? readFile(epicSignalsPathResolver(epicId, config))
      : readFile(signalsPathResolver(epicId ?? null, storyId, config));
  } catch (_err) {
    // No ledger yet → no prior rounds.
    return 1;
  }

  let priorRounds = 0;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (_err) {
      continue; // Malformed line — skip, never throw.
    }
    if (!record || typeof record !== 'object') continue;
    if (record.kind !== 'acceptance-eval') continue;
    if (clusterMode) {
      if (record.clusterId !== clusterId) continue;
    } else if (record.storyId !== storyId) {
      continue;
    }
    priorRounds += 1;
  }
  return priorRounds + 1;
}
