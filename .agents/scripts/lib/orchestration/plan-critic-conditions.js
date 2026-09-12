/**
 * plan-critic-conditions.js — the pre-mortem critic's dispatch decision for
 * the `/mandrel-plan` critic CLI (Epic #4474 PR6, design §4; narrowed to one
 * arm by Story #5312).
 *
 * The critic is a fresh-context sub-agent dispatch, and the dispatch is
 * **conditional**: the dominant plan cost is turns × standing context, and an
 * unconditional critic pays a full sub-agent spawn even when it provably has
 * nothing to find. This module computes the decision deterministically so
 * the workflow never judges its own dispatch condition.
 *
 * One trigger survives: the **external-dependency probe** (Story #4700),
 * which finds an out-of-repo marker in the plan text — a scoped package the
 * plan names that no manifest declares, a cross-repo reference, an external
 * service prerequisite — so a plan-time discoverable blocker does not reach
 * delivery unquestioned (the swarm-os #757 shape). The probe is deliberately
 * **conservative**: it matches only explicit markers (npm scoped-package
 * specs, `github.com/<owner>/<repo>` URLs, prerequisite-keyword-anchored
 * endpoints), never NLP guesswork.
 *
 * Story #5312 deleted the two triggers that sat beside it — the ticket count
 * reaching half a `maxTickets` budget, and a `planning.riskHeuristics` phrase
 * matching the plan text — with the constants they read. The count trigger
 * was unreachable at the default N=1; the phrase list was empty in every
 * consumer that resolved it. The consolidation critic went with them: its
 * one deterministic input was a `## Delivery Slicing` table no Story carries.
 *
 * Under-firing risk (design PR6 note): the persist validators are unchanged
 * hard gates; every skip decision this module produces is logged to the
 * plan-metrics ledger (`appendCriticSkip`) by the caller so under-firing is
 * auditable.
 *
 * Pure, synchronous, no I/O. The single caller is `plan-critics-evaluate.js`,
 * driven by the `plan-critics.js` CLI the operator runs between Author and
 * Persist when they want the critic; the CLI owns reading the authored
 * artifacts and the resolved config.
 */

/**
 * @typedef {Object} CriticDispatchDecision
 * @property {'pre-mortem'} critic
 * @property {boolean} dispatch
 * @property {string[]} reasons Why the critic fires — or why it is safe to
 *   skip. Never empty: a skip's reasons are the audit trail the
 *   plan-metrics ledger records.
 */

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
 * plan depends on. A match is the pre-mortem's dispatch condition; a no-match
 * plan skips the critic.
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
 * Decide the pre-mortem dispatch: an external-dependency probe match
 * (Story #4700) — the one deterministic trigger left after Story #5312.
 *
 * @param {object} input
 * @param {string} [input.planText] - Concatenated plan text the probe
 *   matches against (tech spec + serialized tickets).
 * @param {string[]} [input.knownPackages] - Package specifiers the repo's own
 *   manifests declare (own name + dependency maps + workspace package names),
 *   passed to the external-dependency probe.
 * @param {{ owner?: string|null, repo?: string|null }|null} [input.ownerRepo] -
 *   The configured `github.owner`/`github.repo`, passed to the
 *   external-dependency probe's cross-repo arm.
 * @returns {CriticDispatchDecision}
 */
export function evaluatePremortemDispatch({
  planText = '',
  knownPackages = [],
  ownerRepo = null,
}) {
  const externalDeps = evaluateExternalDependencyProbe({
    planText,
    knownPackages,
    ownerRepo,
  });
  if (externalDeps.matched) {
    return {
      critic: 'pre-mortem',
      dispatch: true,
      reasons: externalDeps.reasons,
    };
  }

  return {
    critic: 'pre-mortem',
    dispatch: false,
    reasons: [
      'The external-dependency probe found no out-of-repo markers in the plan text.',
    ],
  };
}
