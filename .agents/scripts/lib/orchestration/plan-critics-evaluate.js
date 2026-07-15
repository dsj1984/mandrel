/**
 * plan-critics-evaluate.js — shared critic-dispatch evaluation for the
 * collapsed /plan flow (#4496 fix 6; extracted from the `plan-critics.js`
 * CLI so the persist surface folds the same evaluation in as a pre-write
 * phase).
 *
 * Two consumers:
 *   - `plan-persist.js` (via `runPlanPersist`) — evaluates the dispatch
 *     conditions as a deterministic pre-write phase, prints the verdicts,
 *     and records every skip on the plan-metrics ledger, so the headless
 *     path never pays a standalone CLI turn for the same decision.
 *   - `plan-critics.js` — the standalone CLI survives one release as a
 *     thin shim over this module for the attended pre-gate evaluation
 *     (the verdict folds into gate #2's view before the persist runs).
 *
 * Pure evaluation: no file I/O, no GitHub calls, no ledger writes — the
 * callers own artifact loading and skip recording.
 *
 * @module lib/orchestration/plan-critics-evaluate
 */

import { getLimits } from '../config-resolver.js';
import {
  evaluateConsolidationDispatch,
  evaluatePremortemDispatch,
} from './plan-critic-conditions.js';

/**
 * Resolve the planning risk heuristics list from the canonical config
 * block (same resolution `plan-context.js` and the decompose context use).
 *
 * @param {object} config
 * @returns {string[]}
 */
function resolveRiskHeuristics(config = {}) {
  if (Array.isArray(config.planning?.riskHeuristics)) {
    return config.planning.riskHeuristics;
  }
  return [];
}

/**
 * Evaluate the consolidation + pre-mortem critic dispatch conditions over
 * the authored planning artifacts (design §4 / #4474 PR6 conditions,
 * unchanged):
 *
 *   - Consolidation: skipped outright when `tickets` is null/absent (the
 *     single-delivery shape authors no draft tickets); otherwise the
 *     deterministic precondition + size/divergence conditions.
 *   - Pre-mortem: risk verdict overall level high, OR ticket count at least
 *     half `maxTickets`, OR any `planning.riskHeuristics` phrase matching
 *     the plan text.
 *
 * @param {{
 *   techSpecContent: string,
 *   riskVerdict: { summary?: string },
 *   tickets?: Array<object>|null,
 *   config?: object,
 * }} args
 * @returns {{
 *   consolidation: { critic: string, dispatch: boolean, reasons: string[] },
 *   premortem: { critic: string, dispatch: boolean, reasons: string[] },
 * }}
 */
export function evaluatePlanCritics({
  techSpecContent,
  riskVerdict,
  tickets = null,
  config = {},
}) {
  const ticketList = Array.isArray(tickets) ? tickets : null;
  const consolidation =
    ticketList === null
      ? {
          critic: 'consolidation',
          dispatch: false,
          reasons: [
            'single-delivery shape — no draft tickets exist to consolidate.',
          ],
        }
      : evaluateConsolidationDispatch({
          draftStories: ticketList,
          specText: techSpecContent,
        });

  const premortem = evaluatePremortemDispatch({
    riskVerdict,
    ticketCount: ticketList?.length ?? 0,
    maxTickets: getLimits(config).maxTickets,
    riskHeuristics: resolveRiskHeuristics(config),
    planText: [
      techSpecContent ?? '',
      ticketList ? JSON.stringify(ticketList) : '',
      riskVerdict?.summary ?? '',
    ].join('\n'),
  });

  return { consolidation, premortem };
}
