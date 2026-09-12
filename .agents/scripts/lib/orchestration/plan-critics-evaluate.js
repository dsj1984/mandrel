/**
 * plan-critics-evaluate.js — shared critic-dispatch evaluation for the
 * collapsed /mandrel-plan flow (#4496 fix 6; pre-mortem only since Story #5312).
 *
 * One consumer: the `plan-critics.js` CLI, which the operator runs between
 * Author and Persist when they want the pre-mortem. The CLI loads the draft
 * artifacts, calls this module, prints the verdict as JSON, and records a
 * skip on the plan-metrics ledger; the workflow dispatches a fresh-context
 * critic sub-agent on a `dispatch: true` verdict and folds the findings into
 * a re-author round before persist.
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

import { evaluatePremortemDispatch } from './plan-critic-conditions.js';

/**
 * Resolve the `{ owner, repo }` the external-dependency probe's cross-repo arm
 * (Story #4700) measures references against, from the canonical `github` block.
 *
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
 * Evaluate the pre-mortem critic's dispatch condition over the authored
 * planning artifacts: the external-dependency probe (Story #4700) matching an
 * out-of-repo marker — a scoped package absent from `knownPackages`, a
 * cross-repo `github.com/<owner>/<repo>` reference, or a named external
 * service prerequisite.
 *
 * @param {{
 *   techSpecContent: string,
 *   tickets?: Array<object>|null,
 *   config?: object,
 *   knownPackages?: string[],
 * }} args
 * @param {string[]} [args.knownPackages] - Package specifiers the repo's own
 *   manifests declare, forwarded to the pre-mortem external-dependency probe
 *   (Story #4700). The caller (the `plan-critics.js` CLI) owns the file I/O
 *   that gathers them; this module stays pure. Empty when unresolved, which
 *   only widens what the probe treats as external.
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
