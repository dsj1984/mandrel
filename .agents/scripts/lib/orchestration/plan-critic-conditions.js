/**
 * plan-critic-conditions.js — risk/size-conditional dispatch decisions for
 * the /plan author-step critics (Epic #4474 PR6, design §4).
 *
 * The collapsed plan flow keeps the consolidation (8.3) and pre-mortem
 * (8.5) critics as fresh-context sub-agent dispatches, but makes each
 * dispatch **conditional** instead of unconditional — the dominant plan
 * cost is turns × standing context, and an unconditional critic pays a
 * full sub-agent spawn even when it provably has nothing to find. This
 * module computes those decisions deterministically so the workflow never
 * judges its own dispatch conditions:
 *
 *   - **Consolidation (8.3)**: dispatch only when the existing
 *     `evaluateConsolidationPrecondition` gate says `dispatch: true` AND
 *     (the draft has more than `CONSOLIDATION_STORY_THRESHOLD` stories OR
 *     the precondition confirmed a divergence from the Delivery Slicing
 *     table). A fail-open precondition (missing/unparseable table) on a
 *     small draft is NOT a confirmed divergence — it skips, because a
 *     ≤-threshold draft is small enough for gate #2's single-view review
 *     to catch a distorted shape without a dedicated sub-agent.
 *   - **Pre-mortem (8.5)**: dispatch when the risk verdict's overall level
 *     is `high`, OR the ticket count is at least half of `maxTickets`, OR
 *     any configured `planning.riskHeuristics` phrase matches the plan
 *     text (case-insensitive substring).
 *
 * Under-firing risk (design PR6 note): the persist validators are
 * unchanged hard gates and G2's cohort re-measures plan quality; every
 * skip decision this module produces is logged to the plan-metrics ledger
 * (`appendCriticSkip`) by the callers so under-firing is auditable.
 *
 * Pure, synchronous, no I/O — the `plan-critics.js` CLI owns reading the
 * authored artifacts and the resolved config.
 */

import { evaluateConsolidationPrecondition } from './consolidation-precondition.js';
import { deriveRiskEnvelope } from './planning-risk.js';

/**
 * Draft-story count above which the consolidation critic fires even
 * without a confirmed slicing divergence (design §6 PR6: "> 5 stories").
 */
export const CONSOLIDATION_STORY_THRESHOLD = 5;

/**
 * @typedef {Object} CriticDispatchDecision
 * @property {'consolidation'|'pre-mortem'} critic
 * @property {boolean} dispatch
 * @property {string[]} reasons Why the critic fires — or why it is safe to
 *   skip. Never empty: a skip's reasons are the audit trail the
 *   plan-metrics ledger records.
 */

/**
 * Decide the 8.3 consolidation dispatch: precondition AND size/divergence.
 *
 * @param {object} input
 * @param {object[]} input.draftStories - The draft `tickets.json` array
 *   (raw Story objects with top-level `slug` / `depends_on` / `body`).
 * @param {string} input.specText - The text carrying the `## Delivery
 *   Slicing` table. At author time this is the authored `techspec.md`
 *   content (the Epic body carries the same folded section post-persist).
 * @returns {CriticDispatchDecision}
 */
export function evaluateConsolidationDispatch({ draftStories, specText }) {
  const precondition = evaluateConsolidationPrecondition({
    draftStories,
    epicBody: specText,
  });

  if (!precondition.dispatch) {
    return {
      critic: 'consolidation',
      dispatch: false,
      reasons: precondition.reasons,
    };
  }

  const storyCount = draftStories.length;
  const oversized = storyCount > CONSOLIDATION_STORY_THRESHOLD;
  const diverges = precondition.cause === 'divergence';

  if (!oversized && !diverges) {
    return {
      critic: 'consolidation',
      dispatch: false,
      reasons: [
        `Draft has ${storyCount} story(ies) (≤ ${CONSOLIDATION_STORY_THRESHOLD}) and no confirmed Delivery Slicing divergence — gate #2's single-view review covers a draft this small.`,
        ...precondition.reasons,
      ],
    };
  }

  const reasons = [];
  if (diverges) reasons.push(...precondition.reasons);
  if (oversized) {
    reasons.push(
      `Draft has ${storyCount} stories (> ${CONSOLIDATION_STORY_THRESHOLD}) — large enough that a distorted shape can hide from the gate #2 single view.`,
    );
  }
  if (!diverges && precondition.cause === 'fail-open') {
    reasons.push(...precondition.reasons);
  }
  return { critic: 'consolidation', dispatch: true, reasons };
}

/**
 * Decide the 8.5 pre-mortem dispatch: high risk, or size ≥ ½ budget, or a
 * risk-heuristic phrase match.
 *
 * @param {object} input
 * @param {import('./planning-risk.js').RiskVerdict} input.riskVerdict -
 *   The authored `risk-verdict.json` payload; the overall level is derived
 *   deterministically from its axes (`deriveRiskEnvelope`), never trusted
 *   as a free-standing field.
 * @param {number} input.ticketCount - Draft ticket count (0 in the
 *   single-delivery shape — no tickets exist).
 * @param {number} input.maxTickets - The reviewability budget
 *   (`getLimits(config).maxTickets`).
 * @param {string[]} [input.riskHeuristics] - `planning.riskHeuristics`
 *   phrases from the resolved config.
 * @param {string} [input.planText] - Concatenated plan text the heuristics
 *   match against (tech spec + serialized tickets + risk summary).
 * @returns {CriticDispatchDecision}
 */
export function evaluatePremortemDispatch({
  riskVerdict,
  ticketCount,
  maxTickets,
  riskHeuristics = [],
  planText = '',
}) {
  if (!Number.isInteger(maxTickets) || maxTickets <= 0) {
    throw new TypeError(
      'evaluatePremortemDispatch: maxTickets must be a positive integer',
    );
  }
  const reasons = [];

  const { overallLevel } = deriveRiskEnvelope(riskVerdict);
  if (overallLevel === 'high') {
    reasons.push(
      'Risk verdict overall level is high — predicted-rework findings are worth a fresh-context pass.',
    );
  }

  const count = Number.isInteger(ticketCount) ? ticketCount : 0;
  if (count * 2 >= maxTickets) {
    reasons.push(
      `Ticket count ${count} is at least half the reviewability budget (maxTickets ${maxTickets}).`,
    );
  }

  const haystack = String(planText).toLowerCase();
  const matched = riskHeuristics.filter(
    (phrase) =>
      typeof phrase === 'string' &&
      phrase.trim().length > 0 &&
      haystack.includes(phrase.trim().toLowerCase()),
  );
  if (matched.length > 0) {
    reasons.push(
      `planning.riskHeuristics match(es) in the plan text: ${matched.map((p) => `"${p.trim()}"`).join(', ')}.`,
    );
  }

  if (reasons.length > 0) {
    return { critic: 'pre-mortem', dispatch: true, reasons };
  }

  return {
    critic: 'pre-mortem',
    dispatch: false,
    reasons: [
      `Overall risk is ${overallLevel} (not high), ticket count ${count} is under half the budget (maxTickets ${maxTickets}), and no planning.riskHeuristics phrase matches the plan text.`,
    ],
  };
}
