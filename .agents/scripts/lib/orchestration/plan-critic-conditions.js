/**
 * plan-critic-conditions.js — size/heuristic-conditional dispatch decisions for
 * the /plan author-step critics (Epic #4474 PR6, design §4).
 *
 * The collapsed plan flow keeps the consolidation and pre-mortem critics as
 * fresh-context sub-agent dispatches, but makes each dispatch
 * **conditional** instead of unconditional — the dominant plan cost is
 * turns × standing context, and an unconditional critic pays a full
 * sub-agent spawn even when it provably has nothing to find. This module
 * computes those decisions deterministically so the workflow never judges
 * its own dispatch conditions:
 *
 *   - **Consolidation**: dispatch only when the existing
 *     `evaluateConsolidationPrecondition` gate says `dispatch: true` AND
 *     (the draft has more than `CONSOLIDATION_STORY_THRESHOLD` stories OR
 *     the precondition confirmed a divergence from the Delivery Slicing
 *     table). A fail-open precondition (missing/unparseable table) on a
 *     small draft is NOT a confirmed divergence — it skips, because a
 *     ≤-threshold draft is small enough for gate #2's single-view review
 *     to catch a distorted shape without a dedicated sub-agent.
 *   - **Pre-mortem**: dispatch when the ticket count is at least half
 *     of `maxTickets`, OR any configured `planning.riskHeuristics` phrase
 *     matches the plan text (case-insensitive substring), OR the
 *     **external-dependency probe** (Story #4700) finds an out-of-repo marker
 *     in the plan text. Story #4542 removed the authored-risk-verdict condition
 *     along with the verdict itself; every surviving condition reads the plan's
 *     own observable text and shape rather than a self-assessment.
 *
 * The external-dependency probe (Story #4700) is what gives the default N=1
 * path a cheap viability check: on that path the size condition is unreachable
 * (`count*2 >= maxTickets` never holds at one ticket) and a repo whose resolved
 * `planning.riskHeuristics` is empty has no phrase to match, so a plan-time
 * discoverable blocker — a scoped package the plan names that no manifest
 * declares, a cross-repo reference, an external service prerequisite — reached
 * delivery unquestioned (the swarm-os #757 shape). The probe is deliberately
 * **conservative**: it matches only explicit markers (npm scoped-package specs,
 * `github.com/<owner>/<repo>` URLs, prerequisite-keyword-anchored endpoints),
 * never NLP guesswork, so a plan with no such marker dispatches exactly as it
 * did before.
 *
 * Under-firing risk (design PR6 note): the persist validators are
 * unchanged hard gates and G2's cohort re-measures plan quality; every
 * skip decision this module produces is logged to the plan-metrics ledger
 * (`appendCriticSkip`) by the caller so under-firing is auditable.
 *
 * Pure, synchronous, no I/O. The single caller is `plan-critics-evaluate.js`,
 * driven by the `plan-critics.js` CLI that `/plan` runs between Author and
 * Persist (Story #4592); the CLI owns reading the authored artifacts and the
 * resolved config.
 */

import { evaluateConsolidationPrecondition } from './consolidation-precondition.js';

/**
 * Draft-story count above which the consolidation critic fires even
 * without a confirmed slicing divergence (#4474 PR6: "> 5 stories").
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
 * Decide the consolidation dispatch: precondition AND size/divergence.
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
 * Explicit npm scoped-package marker: `@scope/name`. Requires the leading `@`
 * and an interior `/`, so bare GitHub handles (`@dsj1984`) and the
 * `@[USERNAME]` operator-handle placeholder never match.
 */
const SCOPED_PACKAGE_MARKER = /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi;

/** Explicit cross-repo marker: a `github.com/<owner>/<repo>` URL. */
const GITHUB_REPO_MARKER =
  /github\.com\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)/gi;

/**
 * Explicit external-service prerequisite marker: a prerequisite keyword
 * followed, within the same clause, by an http(s) endpoint. The keyword gate
 * is what keeps casual documentation links from matching — only an endpoint
 * named as a precondition counts.
 */
const SERVICE_PREREQ_MARKER =
  /\b(?:requires?|required|prerequisite|provision(?:ed|ing)?|depends?\s+on|credentials?\s+for)\b[^.\n]*?\bhttps?:\/\/([a-z0-9][a-z0-9.-]*)/gi;

/** Order-preserving de-duplication. */
function uniquePreserveOrder(values) {
  return [...new Set(values)];
}

/** Quote each item for an evidence reason string. */
function quoteList(values) {
  return values.map((v) => `"${v}"`).join(', ');
}

/**
 * Scoped packages named in the plan that no repo manifest declares.
 *
 * @param {string} planText
 * @param {string[]} knownPackages - Package specifiers the repo's own
 *   manifests declare (own name + dependency maps + workspace package names).
 * @returns {string[]}
 */
function matchExternalScopedPackages(planText, knownPackages) {
  const known = new Set(
    knownPackages
      .filter((n) => typeof n === 'string')
      .map((n) => n.trim().toLowerCase()),
  );
  const matches = [];
  for (const m of planText.matchAll(SCOPED_PACKAGE_MARKER)) {
    if (!known.has(m[0].toLowerCase())) matches.push(m[0]);
  }
  return uniquePreserveOrder(matches);
}

/**
 * `github.com/<owner>/<repo>` references outside the configured repo. When the
 * owner is unknown (no `github.owner` configured) the arm stays silent rather
 * than flag every URL as foreign.
 *
 * @param {string} planText
 * @param {{ owner?: string|null, repo?: string|null }|null} ownerRepo
 * @returns {string[]}
 */
function matchCrossRepoRefs(planText, ownerRepo) {
  const owner =
    typeof ownerRepo?.owner === 'string'
      ? ownerRepo.owner.trim().toLowerCase()
      : '';
  if (!owner) return [];
  const repo =
    typeof ownerRepo?.repo === 'string'
      ? ownerRepo.repo.trim().toLowerCase()
      : '';
  const matches = [];
  for (const m of planText.matchAll(GITHUB_REPO_MARKER)) {
    const internal =
      m[1].toLowerCase() === owner && (!repo || m[2].toLowerCase() === repo);
    if (!internal) matches.push(`${m[1]}/${m[2]}`);
  }
  return uniquePreserveOrder(matches);
}

/**
 * Endpoints named as prerequisites in the plan text.
 *
 * @param {string} planText
 * @returns {string[]}
 */
function matchExternalServicePrereqs(planText) {
  const matches = [];
  for (const m of planText.matchAll(SERVICE_PREREQ_MARKER)) {
    matches.push(m[1]);
  }
  return uniquePreserveOrder(matches);
}

/**
 * The external-dependency probe (Story #4700): a conservative, marker-only
 * scan of the draft plan text for artifacts outside the current repo that the
 * plan depends on. A match is the pre-mortem's third dispatch condition; a
 * no-match plan behaves exactly as it did before this probe existed.
 *
 * @param {object} input
 * @param {string} [input.planText] - Concatenated plan text (tech spec +
 *   serialized tickets).
 * @param {string[]} [input.knownPackages] - Package specifiers the repo's own
 *   manifests declare, used to tell an external scoped package from a local one.
 * @param {{ owner?: string|null, repo?: string|null }|null} [input.ownerRepo] -
 *   The configured `github.owner`/`github.repo` a cross-repo reference is
 *   measured against.
 * @returns {{ matched: boolean, reasons: string[] }}
 */
export function evaluateExternalDependencyProbe({
  planText = '',
  knownPackages = [],
  ownerRepo = null,
}) {
  const text = String(planText);
  const packages = matchExternalScopedPackages(text, knownPackages);
  const crossRepo = matchCrossRepoRefs(text, ownerRepo);
  const services = matchExternalServicePrereqs(text);

  const reasons = [];
  if (packages.length > 0) {
    reasons.push(
      `External-dependency probe: scoped package(s) named in the plan but absent from the repo's own manifests: ${quoteList(packages)}.`,
    );
  }
  if (crossRepo.length > 0) {
    const scope = ownerRepo.repo
      ? `${ownerRepo.owner}/${ownerRepo.repo}`
      : ownerRepo.owner;
    reasons.push(
      `External-dependency probe: cross-repo reference(s) outside ${scope}: ${quoteList(crossRepo)}.`,
    );
  }
  if (services.length > 0) {
    reasons.push(
      `External-dependency probe: external service prerequisite endpoint(s): ${quoteList(services)}.`,
    );
  }

  return { matched: reasons.length > 0, reasons };
}

/**
 * Decide the pre-mortem dispatch: size ≥ ½ budget, a risk-heuristic phrase
 * match, or an external-dependency probe match (Story #4700).
 *
 * @param {object} input
 * @param {number} input.ticketCount - Draft ticket count (0 in the
 *   single-delivery shape — no tickets exist).
 * @param {number} input.maxTickets - The reviewability budget
 *   (`getLimits(config).maxTickets`).
 * @param {string[]} [input.riskHeuristics] - `planning.riskHeuristics`
 *   phrases from the resolved config.
 * @param {string} [input.planText] - Concatenated plan text the heuristics and
 *   the external-dependency probe match against (tech spec + serialized
 *   tickets).
 * @param {string[]} [input.knownPackages] - Package specifiers the repo's own
 *   manifests declare (own name + dependency maps + workspace package names),
 *   passed to the external-dependency probe.
 * @param {{ owner?: string|null, repo?: string|null }|null} [input.ownerRepo] -
 *   The configured `github.owner`/`github.repo`, passed to the
 *   external-dependency probe's cross-repo arm.
 * @returns {CriticDispatchDecision}
 */
export function evaluatePremortemDispatch({
  ticketCount,
  maxTickets,
  riskHeuristics = [],
  planText = '',
  knownPackages = [],
  ownerRepo = null,
}) {
  if (!Number.isInteger(maxTickets) || maxTickets <= 0) {
    throw new TypeError(
      'evaluatePremortemDispatch: maxTickets must be a positive integer',
    );
  }
  const reasons = [];

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

  const externalDeps = evaluateExternalDependencyProbe({
    planText,
    knownPackages,
    ownerRepo,
  });
  if (externalDeps.matched) {
    reasons.push(...externalDeps.reasons);
  }

  if (reasons.length > 0) {
    return { critic: 'pre-mortem', dispatch: true, reasons };
  }

  return {
    critic: 'pre-mortem',
    dispatch: false,
    reasons: [
      `Ticket count ${count} is under half the budget (maxTickets ${maxTickets}), no planning.riskHeuristics phrase matches the plan text, and the external-dependency probe found no out-of-repo markers.`,
    ],
  };
}
