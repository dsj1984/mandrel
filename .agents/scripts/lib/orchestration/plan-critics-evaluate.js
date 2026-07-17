/**
 * plan-critics-evaluate.js — shared critic-dispatch evaluation for the
 * collapsed /plan flow (#4496 fix 6).
 *
 * One consumer: the `plan-critics.js` CLI, which `/plan` runs between its
 * Author and Persist steps. The CLI loads the draft artifacts, calls this
 * module, prints the verdict as JSON, and records every skip on the
 * plan-metrics ledger; the workflow dispatches a fresh-context critic
 * sub-agent on a `dispatch: true` verdict and folds the findings into a
 * re-author round before persist.
 *
 * Story #4592 moved that evaluation here from `run-plan-persist.js`, which
 * ran it after authoring was finished and immediately before
 * `createStoryIssues` — the one point where a `dispatch: true` verdict has
 * no re-author loop to route to. Persist no longer evaluates critics; this
 * module has exactly one evaluation point.
 *
 * Pure evaluation: no file I/O, no GitHub calls, no ledger writes — the
 * caller owns artifact loading and skip recording.
 *
 * @module lib/orchestration/plan-critics-evaluate
 */

import { getLimits } from '../config-resolver.js';
import {
  evaluateConsolidationDispatch,
  evaluatePremortemDispatch,
} from './plan-critic-conditions.js';
import { evaluateTextHygiene } from './plan-text-hygiene.js';

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
 * the authored planning artifacts (#4474 PR6 conditions, unchanged):
 *
 *   - Consolidation: skipped outright when `tickets` is null/absent (the
 *     single-delivery shape authors no draft tickets); otherwise the
 *     deterministic precondition + size/divergence conditions.
 *   - Pre-mortem: ticket count at least half `maxTickets`, OR any
 *     `planning.riskHeuristics` phrase matching the plan text. Story #4542
 *     retired its authored-risk-level condition with the verdict itself.
 *   - Text hygiene (Story #4599, advisory-only): deterministic body lints
 *     (dangling-citation / open-question / slicing-mass) over the draft
 *     stories. It has no `dispatch` semantics and spawns nothing — its
 *     `findings[]` are re-author-round input, and the consolidation /
 *     premortem dispatch verdicts are untouched by it.
 *
 * @param {{
 *   techSpecContent: string,
 *   tickets?: Array<object>|null,
 *   config?: object,
 * }} args
 * @returns {{
 *   consolidation: { critic: string, dispatch: boolean, reasons: string[] },
 *   premortem: { critic: string, dispatch: boolean, reasons: string[] },
 *   textHygiene: { critic: string, findings: Array<object> },
 * }}
 */
export function evaluatePlanCritics({
  techSpecContent,
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
    ticketCount: ticketList?.length ?? 0,
    maxTickets: getLimits(config).maxTickets,
    riskHeuristics: resolveRiskHeuristics(config),
    planText: [
      techSpecContent ?? '',
      ticketList ? JSON.stringify(ticketList) : '',
    ].join('\n'),
  });

  const textHygiene = {
    critic: 'text-hygiene',
    findings: evaluateTextHygiene({ draftStories: ticketList }).findings,
  };

  return { consolidation, premortem, textHygiene };
}
