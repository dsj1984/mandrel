/**
 * lib/orchestration/complexity-gate.js — shape-derived Story routing for the
 * deliver side (Story #4722; plan-side lite claim deleted by Story #5312).
 *
 * Three surfaces survive, all read at delivery time:
 *
 *   1. **Seed signals ({@link buildComplexitySignals}).** `/mandrel-plan`'s
 *      context envelope carries the paths a seed predicts, their repo state
 *      (existing paths predict refactors; missing ones predict creates) and
 *      the `audit-rules.json` sensitive-path classes the footprint intersects.
 *      They ground the authoring template's `changes[]` skeleton and the
 *      `/prototype` offer; they route nothing.
 *   2. **Story shape ({@link deriveStoryShape}).** The light path
 *      (`deliver-light`) reads a predicted footprint's effort and risk —
 *      distinct change kinds, declared magnitude, uncertainty,
 *      deployable/migration span, sensitive-path classes — against
 *      {@link STORY_SHAPE_CEILINGS} to decide whether a prompt may skip the
 *      Story-authoring ceremony. Artifact cardinality is deliberately not an
 *      axis (Story #4764).
 *   3. **Dispatch mode ({@link resolveStoryDispatchMode}).** `/mandrel-deliver`
 *      answers a different question from the route: may the engine run in the
 *      router's own session? Only a **single-Story run** may (Story #4736).
 *
 * Story #5312 deleted the plan-side half: the planner's authored lite claim
 * (`--route-downgrade-reason`), the persist-time shape backstop that
 * validated it, the `route::lite` hint label, and the
 * `planning.complexityGate` knobs. Persist no longer routes; every Story
 * lands through the same engine and the same close gates, and the shape
 * ceilings below are read only where a shape is actually decided on.
 *
 * The shape taxonomy is deliberately the one `review-depth.js` already
 * applies to the landed diff at close (`deriveChangeLevel` over the
 * `audit-rules.json` sensitive-path classes): **predicted shape at dispatch,
 * actual diff at close** — one taxonomy, two read points. Sensitivity always
 * wins: a small change whose footprint intersects a sensitive-path class
 * routes `full`, which keeps its fresh acceptance critic.
 *
 * {@link LITE_PATH_INVARIANTS} is the machine-readable contract that the
 * light path still produces a Story ticket, still lands via a PR to `main`,
 * still runs every repo quality gate, and still honours
 * `rules/security-baseline.md`. Those gates run in `single-story-close.js`
 * regardless of route; the router cannot and does not switch them off.
 *
 * @typedef {'lite'|'full'} ComplexityRoute
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { extractChangePaths } from '../story-body/story-body.js';
import { deriveChangeLevel } from './review-depth.js';

/**
 * Effort/risk ceilings a Story's work must fit for the `lite` route
 * ({@link deriveStoryShape}). Framework constants, not operator knobs — a
 * ceiling an operator can widen past what the inline path can safely absorb is
 * a ceiling that fails silently.
 *
 * ## Effort and risk, never artifact cardinality (Story #4764)
 *
 * These ceilings used to count the declared footprint (`maxChanges: 2`,
 * `maxAcceptance: 3`, `maxNonCreateChanges: 1`). Cardinality is the wrong axis
 * in both directions: three identical one-line edits across three files is
 * trivial work with a high count, while a 200-line rewrite of one module is a
 * single change. And the count was read off a footprint the model **declares
 * before doing the work** — a guess, and a gameable one — so counting it
 * rejected genuinely small work (mandrel-bench's hello-world scenario is a
 * server create plus a `package.json` edit plus a test create, structurally
 * over the old ceilings) while admitting whatever an optimistic declaration
 * under-counted.
 *
 * So the axes are effort, risk, and uncertainty, and the **prediction** gate
 * they form is deliberately **coarse**: it rejects clearly-epic work only.
 * Real enforcement belongs to the diff-derived backstop, which sees ground
 * truth instead of a declaration
 * ({@link module:lib/orchestration/light-suitability.checkLightDiffBackstop}).
 *
 *   - `maxChangeKinds` — distinct change KINDS, not files. N instances of one
 *                        mechanical edit is one kind at N sites; enumerating
 *                        more kinds than this is a multi-capability scope.
 *   - `maxMagnitude`   — coarse magnitude bucket, declared alongside the
 *                        footprint: `trivial` < `moderate` < `substantial`.
 *   - `maxUncertainty` — is the shape determined by the request
 *                        (`determined`), or does it still need the design
 *                        decisions `/mandrel-plan` exists to resolve
 *                        (`needs-design`)?
 *   - `maxDeployables` — named deployable roots (`apps/<x>`, `packages/<x>`, …)
 *                        the footprint spans; more than one is epic by
 *                        construction.
 *
 * Two rules ride beside the ceilings and are not tunable at all: a footprint
 * pairing a migration with its consumers is epic scope, and a footprint
 * intersecting a sensitive-path class routes `full` however small or mechanical
 * it is — the hard gate, unchanged.
 *
 * Exposed as the `ceilings` field on every {@link deriveStoryShape} decision
 * and exported directly (Story #4740) so the light path's suitability gate
 * ({@link module:lib/orchestration/light-suitability}) judges a prompt's
 * predicted footprint against the **same** axes the plan-time shape backstop
 * applies — one source, so the light entry point and the plan path can never
 * disagree about what work is trivial.
 */
export const STORY_SHAPE_CEILINGS = Object.freeze({
  maxChangeKinds: 2,
  maxMagnitude: 'moderate',
  maxUncertainty: 'determined',
  maxDeployables: 1,
});

/** Coarse effort buckets, ascending. Anything past `maxMagnitude` routes full. */
const MAGNITUDE_SCALE = Object.freeze(['trivial', 'moderate', 'substantial']);

/** Coarse uncertainty buckets, ascending. */
const UNCERTAINTY_SCALE = Object.freeze(['determined', 'needs-design']);

/**
 * Directory roots whose immediate child is a separately-deployable unit. A
 * footprint spanning two of them is the "multiple deployables" epic signal.
 */
const DEPLOYABLE_ROOTS = Object.freeze([
  'apps',
  'packages',
  'services',
  'functions',
  'workers',
]);

/** Paths that are schema migrations rather than ordinary source. */
const MIGRATION_PATH_RE =
  /(?:^|\/)(?:migrations?|migrate)(?:\/|$)|\.sql$|(?:^|\/)schema\.(?:prisma|rb)$/i;

/**
 * Place a declared bucket on an ordered scale. **Absent** means "not declared"
 * — no signal, so the coarse gate reads the supplied default rather than
 * rejecting. **Present but unrecognized** is a malformed claim, which cannot be
 * verified as small and therefore fails closed to the worst bucket on the
 * scale.
 *
 * @param {unknown} value
 * @param {readonly string[]} scale Ascending buckets.
 * @param {string} whenAbsent Bucket to assume when nothing was declared.
 * @returns {string}
 */
function normalizeBucket(value, scale, whenAbsent) {
  if (value === undefined || value === null || value === '') return whenAbsent;
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return scale.includes(key) ? key : scale[scale.length - 1];
}

/**
 * Resolve the distinct change KINDS in a footprint. An explicit `kinds[]`
 * declaration wins; absent one, each entry's `assumption` is its kind — which
 * is exactly the "N instances of one mechanical edit is one kind at N sites"
 * reading, since N same-assumption entries collapse to one kind.
 *
 * @param {{ changes?: unknown, kinds?: unknown }} args
 * @returns {string[]} Distinct kinds, in order of first appearance.
 */
function resolveChangeKinds({ changes, kinds }) {
  const clean = (list) =>
    list
      .filter((k) => typeof k === 'string' && k.trim() !== '')
      .map((k) => k.trim().toLowerCase());
  const declared = clean(Array.isArray(kinds) ? kinds : []);
  if (declared.length > 0) return [...new Set(declared)];
  const derived = (Array.isArray(changes) ? changes : []).map((entry) =>
    entry && typeof entry === 'object' && typeof entry.assumption === 'string'
      ? entry.assumption.trim().toLowerCase() || 'unspecified'
      : 'unspecified',
  );
  return [...new Set(derived)];
}

/**
 * Named deployable roots a footprint spans (`apps/web`, `packages/core`, …).
 * The repository root itself is deliberately **not** counted: a change to one
 * app plus a root-level README is one deployable, not two.
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
function resolveDeployables(paths) {
  const ids = new Set();
  for (const p of paths) {
    const segments = String(p)
      .split('/')
      .filter((s) => s !== '');
    if (segments.length >= 3 && DEPLOYABLE_ROOTS.includes(segments[0])) {
      ids.add(`${segments[0]}/${segments[1]}`);
    }
  }
  return [...ids];
}

/**
 * Does the footprint pair a schema migration with its consumers? A migration
 * plus the code that reads through it is epic scope: the two have to land
 * together and the ordering is the design work.
 *
 * @param {string[]} paths
 * @returns {boolean}
 */
function spansMigrationAndConsumers(paths) {
  const migrations = paths.filter((p) => MIGRATION_PATH_RE.test(String(p)));
  return migrations.length > 0 && migrations.length < paths.length;
}

/**
 * Stable machine-readable identifiers for every reason a shape routes `full` —
 * the `code` field on a {@link deriveStoryShape} decision (Story #4815).
 *
 * The prose in `reasons[]` is written for a human reading a gate envelope and
 * is free to be re-worded; a caller that must **branch** on *which* rule
 * objected reads this code instead. That distinction is load-bearing for the
 * light path's operator override
 * ({@link module:lib/orchestration/light-suitability.OVERRIDABLE_SHAPE_CODES}),
 * which may waive a size *prediction* but never a risk rule: keying that
 * decision off reason text would make a copy-edit a security change.
 *
 * Split three ways, and the grouping is the contract:
 *
 *   - **Ceiling rules** — `change-kinds`, `magnitude`, `uncertainty`,
 *     `deployable-span`. Coarse predictions about size, enforced for real
 *     against ground truth by the diff backstop.
 *   - **Absolute rules** — `migration-span`, `sensitive-path`. Risk, not size.
 *   - **Unknown-footprint rejections** — `no-changes`, `unreadable-changes`,
 *     `glob-footprint`, `no-acceptance`, `classification-unavailable`.
 *     Nothing was judged, so there is nothing to waive.
 *
 * A `lite` route carries `code: null`.
 */
export const SHAPE_CODES = Object.freeze({
  CHANGE_KINDS: 'change-kinds',
  MAGNITUDE: 'magnitude',
  UNCERTAINTY: 'uncertainty',
  DEPLOYABLE_SPAN: 'deployable-span',
  MIGRATION_SPAN: 'migration-span',
  SENSITIVE_PATH: 'sensitive-path',
  NO_CHANGES: 'no-changes',
  UNREADABLE_CHANGES: 'unreadable-changes',
  GLOB_FOOTPRINT: 'glob-footprint',
  NO_ACCEPTANCE: 'no-acceptance',
  CLASSIFICATION_UNAVAILABLE: 'classification-unavailable',
});

/**
 * Ordered effort/risk rules, evaluated in order; the first hit is the recorded
 * reason for a `full` route. Every rule names an effort, risk, or uncertainty
 * property of the work — none counts artifacts.
 *
 * @type {ReadonlyArray<{
 *   code: string,
 *   when: (shape: object, ceilings: typeof STORY_SHAPE_CEILINGS) => boolean,
 *   reason: (shape: object, ceilings: typeof STORY_SHAPE_CEILINGS) => string,
 * }>}
 */
const EFFORT_RULES = Object.freeze([
  {
    code: SHAPE_CODES.CHANGE_KINDS,
    when: (s, c) => s.kindCount > c.maxChangeKinds,
    reason: (s, c) =>
      `${s.kindCount} distinct change kinds (${s.changeKinds.join(', ')}) > maxChangeKinds ${c.maxChangeKinds} — an explicit multi-capability enumeration, not one capability; full route`,
  },
  {
    code: SHAPE_CODES.MAGNITUDE,
    when: (s, c) =>
      MAGNITUDE_SCALE.indexOf(s.magnitude) >
      MAGNITUDE_SCALE.indexOf(c.maxMagnitude),
    reason: (s, c) =>
      `declared magnitude "${s.magnitude}" > maxMagnitude "${c.maxMagnitude}" — a substantial rewrite is effort a single inline pass should not absorb, however few files it touches; full route`,
  },
  {
    code: SHAPE_CODES.UNCERTAINTY,
    when: (s, c) =>
      UNCERTAINTY_SCALE.indexOf(s.uncertainty) >
      UNCERTAINTY_SCALE.indexOf(c.maxUncertainty),
    reason: (s) =>
      `the shape is not determined by the request (uncertainty "${s.uncertainty}") — the design decisions /mandrel-plan exists to resolve are still open; full route`,
  },
  {
    code: SHAPE_CODES.DEPLOYABLE_SPAN,
    when: (s, c) => s.deployables.length > c.maxDeployables,
    reason: (s, c) =>
      `footprint spans ${s.deployables.length} deployables (${s.deployables.join(', ')}) > maxDeployables ${c.maxDeployables} — clearly-epic scope; full route`,
  },
  {
    code: SHAPE_CODES.MIGRATION_SPAN,
    when: (s) => s.migrationSpan,
    reason: () =>
      'footprint pairs a migration with its consumers — clearly-epic scope; full route',
  },
  {
    code: SHAPE_CODES.SENSITIVE_PATH,
    when: (s) => s.sensitiveClasses.length > 0,
    reason: (s) =>
      `footprint intersects sensitive-path class(es) ${s.sensitiveClasses.join(', ')} — sensitivity wins over a small shape; full route (fresh acceptance critic retained)`,
  },
]);

/**
 * First effort/risk rule the shape violates as a `{ code, reason }` pair, or
 * `null` when it clears them all.
 *
 * @param {object} shape
 * @param {typeof STORY_SHAPE_CEILINGS} ceilings
 * @returns {{ code: string, reason: string }|null}
 */
function firstEffortViolation(shape, ceilings) {
  for (const rule of EFFORT_RULES) {
    if (rule.when(shape, ceilings)) {
      return { code: rule.code, reason: rule.reason(shape, ceilings) };
    }
  }
  return null;
}

/**
 * The non-negotiables the ceremony-lite path preserves (Story #4683 AC-2):
 * collapsing ceremony never means dropping the Story ticket, the PR-to-`main`
 * landing, the repo quality gates, or the security baseline. Attached
 * verbatim to every route decision's `preserves` field so a downstream reader
 * (or contract test) can assert the invariants held on either route.
 */
const LITE_PATH_INVARIANTS = Object.freeze({
  storyTicket: true,
  prToMain: true,
  repoGates: true,
  securityBaseline: true,
});

/**
 * Count top-level enumerated items (`- `, `* `, `1. `) in a free-form seed —
 * each enumerated line is one predicted artifact.
 *
 * @param {string} text
 * @returns {number}
 */
function countSeedArtifacts(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).length;
}

/** Cap on predicted-path extraction, to bound pathological seeds. */
const MAX_PREDICTED_PATHS = 50;

/**
 * Extract path-like tokens (at least one `/` plus a dotted extension) from a
 * free-form seed — the predicted footprint the sensitive-path and repo-state
 * signals classify.
 *
 * @param {string} text
 * @returns {string[]} Deduplicated, in order of first appearance.
 */
function extractPredictedPaths(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const re = /(?:^|[\s`'"([])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8})/gm;
  const seen = new Set();
  let match = re.exec(text);
  while (match !== null && seen.size < MAX_PREDICTED_PATHS) {
    seen.add(match[1]);
    match = re.exec(text);
  }
  return [...seen];
}

/**
 * Build the advisory complexity **signals** for a planning seed. Signals,
 * not routing: the result carries `routingAuthority: false` and no `route`
 * field — they ground the authoring template's pre-resolved `changes[]` and
 * the `/prototype` offer, nothing else (Story #5312 deleted the risk-heuristic
 * hits and the `planning.complexityGate` echo that used to ride alongside).
 *
 *   - `artifactCount`         — enumerated items in the seed, a rough width
 *                               signal for the operator's eye only.
 *   - `predictedPaths`        — path-like tokens the seed names, in order of
 *                               first appearance (capped).
 *   - `repoState`             — which predicted paths exist in the repo (existing
 *                               paths predict refactors; missing predict
 *                               creates).
 *   - `sensitivePathClasses`  — `audit-rules.json` sensitive-path classes the
 *                               predicted footprint intersects (the same
 *                               taxonomy close applies to the landed diff).
 *
 * Total: never throws; a failed classification degrades to an empty class
 * list (the honest "no signal", never a verdict).
 *
 * @param {{
 *   seedText?: string,
 *   cwd?: string,
 *   pathExistsFn?: (absPath: string) => boolean,
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args]
 * @returns {{
 *   artifactCount: number,
 *   predictedPaths: string[],
 *   repoState: { existingPaths: string[], missingPaths: string[] },
 *   sensitivePathClasses: string[],
 *   advisory: true,
 *   routingAuthority: false,
 * }}
 */
export function buildComplexitySignals({
  seedText = '',
  cwd,
  pathExistsFn = existsSync,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const text = typeof seedText === 'string' ? seedText : '';

  const predictedPaths = extractPredictedPaths(text);
  const root = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  const existingPaths = [];
  const missingPaths = [];
  for (const p of predictedPaths) {
    let exists = false;
    try {
      exists = pathExistsFn(path.resolve(root, p)) === true;
    } catch {
      exists = false;
    }
    (exists ? existingPaths : missingPaths).push(p);
  }

  const { classes } = deriveChangeLevel({
    changedFiles: predictedPaths,
    injectedRules,
    selectSensitivePathClassesFn,
  });

  return {
    artifactCount: countSeedArtifacts(text),
    predictedPaths,
    repoState: { existingPaths, missingPaths },
    sensitivePathClasses: classes,
    advisory: /** @type {const} */ (true),
    routingAuthority: /** @type {const} */ (false),
  };
}

/**
 * Assemble the effort/risk shape of a footprint — the evidence
 * {@link deriveStoryShape} decides on and carries on its result.
 *
 * @param {{
 *   changes: unknown[],
 *   paths: string[],
 *   acceptance?: unknown,
 *   kinds?: unknown,
 *   magnitude?: unknown,
 *   uncertainty?: unknown,
 *   sensitiveClasses: string[],
 * }} args
 * @returns {{
 *   siteCount: number,
 *   changeKinds: string[],
 *   kindCount: number,
 *   magnitude: string,
 *   uncertainty: string,
 *   acceptanceCount: number,
 *   deployables: string[],
 *   migrationSpan: boolean,
 *   sensitiveClasses: string[],
 * }}
 */
function buildEffortShape({
  changes,
  paths,
  acceptance,
  kinds,
  magnitude,
  uncertainty,
  sensitiveClasses,
}) {
  const changeKinds = resolveChangeKinds({ changes, kinds });
  return {
    siteCount: paths.length,
    changeKinds,
    kindCount: changeKinds.length,
    magnitude: normalizeBucket(magnitude, MAGNITUDE_SCALE, 'moderate'),
    uncertainty: normalizeBucket(uncertainty, UNCERTAINTY_SCALE, 'determined'),
    acceptanceCount: Array.isArray(acceptance) ? acceptance.length : 0,
    deployables: resolveDeployables(paths),
    migrationSpan: spansMigrationAndConsumers(paths),
    sensitiveClasses,
  };
}

/**
 * Derive the complexity route from an authored Story's **effort and risk**
 * (Story #4722 AC-3/AC-4; re-anchored off artifact cardinality by Story #4764)
 * — the single shape function persist's backstop and `/mandrel-deliver`'s dispatch
 * derivation both read, so the two can never disagree about the same body.
 *
 * `lite` requires **every** signal to agree, against
 * {@link STORY_SHAPE_CEILINGS}:
 *
 *   - a declared, parseable, glob-free `changes[]` footprint — width is not
 *     counted, but an unknown width cannot be judged;
 *   - at least one acceptance criterion (a Story with no contract cannot be
 *     judged trivial). The criteria are **not** capped: criterion count is
 *     contract detail, not effort;
 *   - at most `maxChangeKinds` distinct change kinds, magnitude no worse than
 *     `maxMagnitude`, uncertainty no worse than `maxUncertainty`, and at most
 *     `maxDeployables` deployable roots — plus no migration-with-consumers
 *     span. These are the clearly-epic rejections, and nothing finer: the
 *     declared footprint is a guess, so the diff-derived backstop does the real
 *     enforcement (see {@link STORY_SHAPE_CEILINGS});
 *   - a footprint intersecting **no** sensitive-path class
 *     (`deriveChangeLevel`, the taxonomy close applies to the landed diff).
 *     Sensitivity always wins (AC-6): a sensitive footprint routes `full`
 *     however small or mechanical, which keeps the fresh acceptance critic via
 *     `ceremony-routing.js`.
 *
 * Everything else — an unknown/undeclared footprint, a malformed magnitude or
 * uncertainty claim, or an unreadable sensitive-path manifest — fails toward
 * `full`. Total: never throws.
 *
 * @param {{
 *   changes?: unknown,
 *   acceptance?: unknown,
 *   kinds?: unknown,
 *   magnitude?: unknown,
 *   uncertainty?: unknown,
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args] `kinds` declares the distinct change kinds explicitly (absent, each
 *   entry's `assumption` is its kind); `magnitude` and `uncertainty` are the
 *   declared coarse buckets.
 * @returns {{
 *   route: ComplexityRoute,
 *   reasons: string[],
 *   code: string|null,
 *   shape: ReturnType<typeof buildEffortShape>|null,
 *   ceilings: typeof STORY_SHAPE_CEILINGS,
 *   preserves: typeof LITE_PATH_INVARIANTS,
 * }} `code` is the stable {@link SHAPE_CODES} identifier for the rule that
 *   rejected the shape (`null` on `lite`) — the field a caller branches on,
 *   since `reasons[]` is human prose and free to be re-worded.
 */
export function deriveStoryShape({
  changes,
  acceptance,
  kinds,
  magnitude,
  uncertainty,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const ceilings = STORY_SHAPE_CEILINGS;
  const preserves = LITE_PATH_INVARIANTS;
  const decide = (route, code, reason, shape = null) => ({
    route,
    reasons: [reason],
    code,
    shape,
    ceilings,
    preserves,
  });

  if (!Array.isArray(changes) || changes.length === 0) {
    return decide(
      'full',
      SHAPE_CODES.NO_CHANGES,
      'no changes[] declared — the footprint is unknown, so the work cannot be judged trivial; conservative full route',
    );
  }

  let entries;
  try {
    entries = extractChangePaths(changes);
  } catch (err) {
    return decide(
      'full',
      SHAPE_CODES.UNREADABLE_CHANGES,
      `changes[] could not be read (${err?.message ?? err}) — unknown footprint; conservative full route`,
    );
  }

  const paths = entries.map((e) => e.path);
  const { level, classes } = deriveChangeLevel({
    changedFiles: paths,
    injectedRules,
    selectSensitivePathClassesFn,
  });
  const shape = buildEffortShape({
    changes,
    paths,
    acceptance,
    kinds,
    magnitude,
    uncertainty,
    sensitiveClasses: classes,
  });

  if (entries.some((e) => e.isGlob)) {
    return decide(
      'full',
      SHAPE_CODES.GLOB_FOOTPRINT,
      'changes[] contains a glob path — unknown footprint width; conservative full route',
      shape,
    );
  }
  if (shape.acceptanceCount === 0) {
    return decide(
      'full',
      SHAPE_CODES.NO_ACCEPTANCE,
      'no acceptance criteria — the contract cannot be judged trivial; conservative full route',
      shape,
    );
  }

  const violation = firstEffortViolation(shape, ceilings);
  if (violation !== null) {
    return decide('full', violation.code, violation.reason, shape);
  }

  if (level !== 'low') {
    // `deriveChangeLevel` degraded to its null fail-safe (unreadable
    // manifest / failed selector): there is no evidence the footprint is
    // non-sensitive, and a classification failure must never buy lite.
    return decide(
      'full',
      SHAPE_CODES.CLASSIFICATION_UNAVAILABLE,
      'sensitive-path classification unavailable — cannot verify the footprint is non-sensitive; conservative full route',
      shape,
    );
  }

  return decide(
    'lite',
    null,
    `trivial shape: ${shape.kindCount} change kind(s) (${shape.changeKinds.join(', ')}) ≤ ${ceilings.maxChangeKinds} across ${shape.siteCount} site(s), magnitude ${shape.magnitude} ≤ ${ceilings.maxMagnitude}, shape ${shape.uncertainty}, no epic-scope span, no sensitive-path class — inline-eligible; non-negotiables preserved`,
    shape,
  );
}

/**
 * Decide how `/mandrel-deliver` executes a Story: **run topology, and nothing else.**
 *
 * **`inline` names one indivisible resource: the router's own session.** Two
 * Stories cannot both own it, so exactly one premise can grant it —
 * **run topology (Story #4736)**: a run resolving a *single* Story executes
 * inline whatever its shape, because sub-agent isolation is load-bearing only
 * for CONCURRENT dispatch (two workers sharing a checkout race on worktrees and
 * branch refs) and a one-Story run has no sibling to race. It therefore pays
 * the spawn premium (a boot is a cache WRITE at full rate, where an inline
 * continuation is a cache read at ~10%; ~$1.43/M vs ~$1.07/M on comparable
 * bench work) for nothing.
 *
 * **Shape cannot grant it (Story #4829).** The shape read used to return
 * `inline` for any lite-shaped body in a multi-Story run, inheriting no
 * topology guard. Measured twice on 2026-07-29: a two-Story and a three-Story
 * run came back `inline` for *every* Story while `stories-wave-tick.js`
 * reported the whole set ready under a concurrency cap of five — a router
 * following both signals literally runs several engines over one session and
 * one checkout, the precise hazard the sub-agent path exists to prevent.
 *
 * **So this function reads only `storyCount` (Story #5006).** #4829 left the
 * body parse, the shape derivation, the `route::lite` hint note and the
 * `planning.complexityGate.enabled` branch in place to populate a `route`
 * field for reporting — but the sole consumer, `resolve-stories.js`, reads
 * `.mode` and discards the rest, so every one of those inputs was a parse
 * whose result nothing could act on. A caller that wants the shape calls
 * {@link deriveStoryShape} directly, as the light path and plan-persist do.
 *
 * Inline execution removes model-side fan-out only — it changes **where** the
 * engine runs, never **what** runs. Every deterministic
 * `single-story-close.js` gate, the PR to `main`, and the
 * `story-deliver-terminal` envelope are identical in both modes; see the
 * module header's non-negotiables.
 *
 * @param {{ storyCount?: unknown }} [args] `storyCount` is the number of
 *   Stories the invoking `/mandrel-deliver` run resolved. Omitted (or not exactly 1)
 *   means the run cannot be shown sibling-free and therefore dispatches as a
 *   sub-agent — never an assumed 1.
 * @returns {{ mode: 'inline'|'subagent', reasons: string[] }}
 */
export function resolveStoryDispatchMode({ storyCount } = {}) {
  // The ONLY `inline` exit in this function, and the guard is the whole
  // contract: an inline verdict must mean the engine can actually run inline.
  if (storyCount === 1) {
    return {
      mode: 'inline',
      reasons: [
        'single-Story run — execute deliver-story inline; sub-agent isolation is load-bearing only for concurrent dispatch, and a one-Story run has no sibling to race (close gates, PR, and terminal envelope unchanged)',
      ],
    };
  }

  return {
    mode: 'subagent',
    reasons: [
      "multi-Story (or unknown-size) run — a concurrent sibling would have to share the router's session, racing worktrees and branch refs; sub-agent dispatch",
    ],
  };
}
