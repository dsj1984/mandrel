/**
 * plan-critics-evaluate.js — the pre-mortem dispatch evaluation for the
 * `plan-critics.js` CLI, run between Author and Persist so a
 * `dispatch: true` verdict still has a re-author loop to route to. Pure: the
 * caller owns artifact loading and skip recording.
 *
 * @module lib/orchestration/plan-critics-evaluate
 */

import { evaluatePremortemDispatch } from './plan-critic-conditions.js';

/**
 * @param {object} config
 * @returns {{ owner: string|null, repo: string|null }}
 */
function resolveOwnerRepo(config = {}) {
  return {
    owner: config.github?.owner ?? null,
    repo: config.github?.repo ?? null,
  };
}

/**
 * @param {{
 *   techSpecContent: string,
 *   tickets?: Array<object>|null,
 *   config?: object,
 *   knownPackages?: string[],
 * }} args
 * @param {string[]} [args.knownPackages] - Specifiers the repo's manifests
 *   declare; empty only widens what counts as external.
 * @returns {{
 *   premortem: { critic: string, dispatch: boolean, reasons: string[] },
 * }}
 */
export function evaluatePlanCritics({
  techSpecContent,
  tickets = null,
  config = {},
  knownPackages = [],
}) {
  const ticketList = Array.isArray(tickets) ? tickets : null;
  const premortem = evaluatePremortemDispatch({
    planText: [
      techSpecContent ?? '',
      ticketList ? JSON.stringify(ticketList) : '',
    ].join('\n'),
    knownPackages,
    ownerRepo: resolveOwnerRepo(config),
  });

  return { premortem };
}
