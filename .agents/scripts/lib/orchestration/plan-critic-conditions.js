/**
 * plan-critic-conditions.js — the pre-mortem critic's deterministic dispatch
 * decision. A spawn is costly, so the critic fires only when the
 * external-dependency probe finds an out-of-repo marker a plan-time review
 * could catch. The probe is conservative: explicit markers only, never NLP.
 * Skips are logged by the caller (`appendCriticSkip`) so under-firing is
 * auditable. Pure, synchronous, no I/O.
 */

/**
 * @typedef {Object} CriticDispatchDecision
 * @property {'pre-mortem'} critic
 * @property {boolean} dispatch
 * @property {string[]} reasons Never empty — a skip's reasons are its audit
 *   trail.
 */

/**
 * `@scope/name`: the interior `/` keeps bare handles and the `@[USERNAME]`
 * placeholder from matching.
 */
const SCOPED_PACKAGE_MARKER = /@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*/gi;

const GITHUB_REPO_MARKER =
  /github\.com\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)/gi;

/**
 * A prerequisite keyword then an http(s) endpoint in the same clause; the
 * keyword gate keeps casual doc links from matching.
 */
const SERVICE_PREREQ_MARKER =
  /\b(?:requires?|required|prerequisite|provision(?:ed|ing)?|depends?\s+on|credentials?\s+for)\b[^.\n]*?\bhttps?:\/\/([a-z0-9][a-z0-9.-]*)/gi;

function uniquePreserveOrder(values) {
  return [...new Set(values)];
}

function quoteList(values) {
  return values.map((v) => `"${v}"`).join(', ');
}

/**
 * @param {string} planText
 * @param {string[]} knownPackages - Specifiers the repo's own manifests declare.
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
 * References outside the configured repo; silent when no owner is configured
 * rather than flag every URL as foreign.
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
 * Marker-only scan of the plan text for out-of-repo dependencies.
 *
 * @param {object} input
 * @param {string} [input.planText] - Tech spec + serialized tickets.
 * @param {string[]} [input.knownPackages]
 * @param {{ owner?: string|null, repo?: string|null }|null} [input.ownerRepo]
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
 * @param {object} input
 * @param {string} [input.planText]
 * @param {string[]} [input.knownPackages]
 * @param {{ owner?: string|null, repo?: string|null }|null} [input.ownerRepo]
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
