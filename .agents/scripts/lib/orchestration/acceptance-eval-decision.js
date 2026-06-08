/**
 * Acceptance self-eval decision core (Story #3819).
 *
 * Pure, I/O-free reducer that turns one round's critic verdict plus the
 * resolved round cap into the loop's next action. The CLI wrapper
 * (`acceptance-eval.js`) owns the file reads, schema validation, signal
 * emission, and ticket transitions; this module owns the *decision* so it
 * can be unit-tested in isolation.
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
 * @param {{ round?: number, criteria?: Array<object> }} args.verdict
 *   A verdict already validated against the acceptance-eval-verdict schema.
 * @param {number} args.maxRounds
 *   The resolved (already-clamped) redraft ceiling from
 *   `getAcceptanceEval(config).maxRounds`.
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
export function decideAcceptanceEval({ verdict, maxRounds }) {
  const cap = effectiveCap(maxRounds);
  const round =
    Number.isInteger(verdict?.round) && verdict.round >= 1 ? verdict.round : 1;
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
 * round count so `/epic-plan` Phase 0 feedback fetch and the retro can
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
}) {
  return {
    kind: 'acceptance-eval',
    epicId: epicId ?? null,
    storyId,
    phase,
    source: { tool: 'acceptance-eval.js' },
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
