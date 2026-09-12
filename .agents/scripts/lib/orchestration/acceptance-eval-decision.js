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
 * ## Reading a verdict is not a round (Story #4874)
 *
 * Counting signals made *observation* costly: re-running the gate over an
 * already-scored verdict — a resumed sub-agent re-reading its own verdict,
 * an operator re-checking why the loop said `redraft` — appended another
 * signal and advanced the derived round, so a `redraft` could escalate to
 * `block` with no work in between. Every appended signal therefore carries
 * a `details.verdictFingerprint` content-addressing the verdict it scored,
 * and {@link resolveAcceptanceEvalRound} replays the round already recorded
 * for that fingerprint instead of minting a new one. A replay is observably
 * free: the round does not advance and no signal is appended. New work
 * produces different verdict content, hence a new fingerprint, hence a
 * genuine round.
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
 * ## The cap
 *
 * `maxRounds` arrives normalized by `lib/config/acceptance-eval.js` as a
 * non-negative integer (Story #5313: `0` means "score once, no redraft").
 * This reducer maps that onto an effective cap of scored rounds: a cap of
 * `0`, a negative value or a non-integer is coerced to 1, so there is no
 * input — config or verdict — that yields an unbounded `redraft` chain.
 * When `round >= effectiveCap` and criteria remain unmet, the only
 * possible action is `block`.
 */

import { createHash } from 'node:crypto';
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
 *   The current round number, derived via `resolveAcceptanceEvalRound`.
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
 * round count so `/mandrel-plan` Phase 0 feedback fetch and the retro can
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
  verdictFingerprint = null,
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
      // Content address of the verdict this signal scored. The replay guard
      // in `resolveAcceptanceEvalRound` matches on it, so a re-read of an
      // already-scored verdict reuses its round instead of minting one.
      ...(typeof verdictFingerprint === 'string' &&
      verdictFingerprint.length > 0
        ? { verdictFingerprint }
        : {}),
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
 * Read the `acceptance-eval` records already appended to the Story's (or AC
 * cluster's) `signals.ndjson`, in append order — the prior rounds
 * {@link resolveAcceptanceEvalRound} counts from (Story #4019).
 *
 * The read is restart-safe: the ledger lives on disk, so a subagent that
 * dies mid-loop and restarts still observes every prior round. A missing or
 * unreadable ledger degrades to "no prior rounds" and malformed lines are
 * skipped — observability corruption never wedges the gate.
 *
 * @param {object} args
 * @param {number|null} args.epicId   Parent Epic ID, or `null` for a
 *   standalone Story (routes to `<tempRoot>/standalone/stories/...`).
 * @param {number} args.storyId
 * @param {string|null} [args.clusterId] AC-cluster id (Epic #4475 M4-B).
 * @param {object} [args.config]      Resolved config (tempRoot resolution).
 * @param {(p: string) => string} [args.readFile]  Injectable reader (tests).
 * @param {(eid: number|null, sid: number, config?: object) => string} [args.signalsPathResolver]
 *   Injectable path resolver (tests). Defaults to `signalsFile`.
 * @param {(eid: number, config?: object) => string} [args.epicSignalsPathResolver]
 *   Injectable epic-stream path resolver (tests).
 * @returns {object[]} The matching records, oldest first.
 */
function readPriorAcceptanceEvalRecords({
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
    return [];
  }

  const records = [];
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
    records.push(record);
  }
  return records;
}

/**
 * Content-address a verdict so re-scoring the same verdict is recognisable
 * as a re-read rather than a new round (Story #4874).
 *
 * The fingerprint covers exactly what the decision depends on — the ordered
 * per-criterion `index` / `criterion` / `verdict` / `evidence` tuples — and
 * deliberately nothing else: the verdict's self-reported `round`, its
 * timestamp, and any authoring scratch must not make an unchanged
 * evaluation look like a new one. Conversely, real rework changes at least
 * one criterion's verdict or its evidence, so a genuine re-evaluation
 * always fingerprints differently.
 *
 * @param {{ criteria?: Array<object> }} verdict
 * @returns {string} 16 hex chars of a SHA-256 over the canonical form.
 */
export function computeVerdictFingerprint(verdict) {
  const criteria = Array.isArray(verdict?.criteria) ? verdict.criteria : [];
  const canonical = criteria.map((c) => [
    Number.isInteger(c?.index) ? c.index : null,
    typeof c?.criterion === 'string' ? c.criterion : '',
    typeof c?.verdict === 'string' ? c.verdict : '',
    typeof c?.evidence === 'string' ? c.evidence : '',
  ]);
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Resolve the round a verdict should be scored under, distinguishing a
 * genuine evaluation from a re-read of an already-scored verdict
 * (Story #4874). A genuine round is `prior-signal count + 1`, so the first
 * run reports round 1 and each completed round advances it by one.
 *
 * When the ledger already carries an `acceptance-eval` signal whose
 * `details.verdictFingerprint` matches, this invocation is a **replay**: it
 * reports that signal's round and tells the caller not to append a second
 * one, so reading is observably free and cannot escalate a `redraft` into a
 * `block`. Otherwise it is a genuine round and the counter advances exactly
 * as the pre-#4874 count-based derivation always did.
 *
 * Signals written before this field existed carry no fingerprint; they can
 * never match, so legacy ledgers keep their count-based behaviour.
 *
 * @param {object} args — {@link readPriorAcceptanceEvalRecords}'s arguments
 *   plus:
 * @param {string} args.verdictFingerprint
 * @returns {{ round: number, replay: boolean }}
 */
export function resolveAcceptanceEvalRound(args) {
  const { verdictFingerprint } = args;
  const records = readPriorAcceptanceEvalRecords(args);
  const priorIndex =
    typeof verdictFingerprint === 'string' && verdictFingerprint.length > 0
      ? records.findIndex(
          (r) => r?.details?.verdictFingerprint === verdictFingerprint,
        )
      : -1;
  if (priorIndex === -1) {
    return { round: records.length + 1, replay: false };
  }
  const recorded = records[priorIndex]?.details?.round;
  return {
    round:
      Number.isInteger(recorded) && recorded >= 1 ? recorded : priorIndex + 1,
    replay: true,
  };
}
