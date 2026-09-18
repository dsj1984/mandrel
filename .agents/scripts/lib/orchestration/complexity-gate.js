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
 *   2. **Story risk ({@link deriveStoryShape}).** The light path
 *      (`deliver-light`) reads a predicted footprint's **risk** — a migration
 *      paired with its consumers, and the `audit-rules.json` sensitive-path
 *      classes the footprint intersects — to decide whether a prompt may skip
 *      the Story-authoring ceremony. Effort is no longer an axis: Story #4764
 *      removed the artifact counts, and Story #5344 removed the declared
 *      effort ceilings that replaced them, because a prediction is a
 *      declaration and size is enforced against ground truth by the light
 *      path's diff backstop.
 *   3. **Dispatch mode ({@link resolveStoryDispatchMode}).** `/mandrel-deliver`
 *      answers a different question from the route: may the engine run in the
 *      router's own session? Only a **single-Story run** may (Story #4736).
 *
 * Story #5312 deleted the plan-side half: the planner's authored lite claim
 * (`--route-downgrade-reason`), the persist-time shape backstop that
 * validated it, the `route::lite` hint label, and the
 * `planning.complexityGate` knobs. Persist no longer routes; every Story
 * lands through the same engine and the same close gates.
 *
 * The risk taxonomy is deliberately the one `review-depth.js` already
 * applies to the landed diff at close (`deriveChangeLevel` over the
 * `audit-rules.json` sensitive-path classes): **predicted footprint at
 * dispatch, actual diff at close** — one taxonomy, two read points.
 * Sensitivity always wins: a small change whose footprint intersects a
 * sensitive-path class routes `full`, which keeps its deep code review
 * (`review-depth.js`).
 *
 * The light path still produces a Story ticket, still lands via a PR to
 * `main`, still runs every repo quality gate, and still honours
 * `rules/security-baseline.md`. That is a property of
 * `single-story-close.js`, which runs those gates regardless of route — the
 * router cannot and does not switch them off. Story #5366 deleted the frozen
 * `preserves` payload that used to restate it on every decision: nothing read
 * it, and a claim attached to a decision is not the thing that enforces it.
 *
 * @typedef {'lite'|'full'} ComplexityRoute
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { extractChangePaths } from '../story-body/story-body.js';
import { deriveChangeLevel } from './review-depth.js';

/**
 * ## Why no predicted-effort ceilings live here any more (Story #5344)
 *
 * This module used to export a frozen shape-ceilings constant — declared kinds,
 * a magnitude bucket, an uncertainty bucket, and a deployable span — which the
 * light path judged a prompt's predicted footprint against. Two rounds of
 * evidence retired them. Story #4764 had already removed the artifact counts
 * (`maxChanges`, `maxAcceptance`) because cardinality is the wrong axis in both
 * directions. Story #5313 then demoted the remaining four axes from a gate to a
 * `warnings[]` entry, at which point they decided nothing at all: every one was
 * SELF-DECLARED by the same agent asking to proceed, and an axis a caller sets
 * and no one verifies is not a measurement. Story #5344 deleted them.
 *
 * What survives is what reads something other than the caller's own claim: the
 * two absolute risk rules below (a migration paired with its consumers, and a
 * footprint intersecting a registered sensitive-path class), derived from the
 * predicted PATHS, and the diff-derived backstop that measures the actual
 * change set
 * ({@link module:lib/orchestration/light-suitability.checkLightDiffBackstop}).
 * The backstop's `LIGHT_DIFF_CEILINGS` are now the only size block on the
 * light path, and they are the only ceilings measured against ground truth.
 */

/** Paths that are schema migrations rather than ordinary source. */
const MIGRATION_PATH_RE =
  /(?:^|\/)(?:migrations?|migrate)(?:\/|$)|\.sql$|(?:^|\/)schema\.(?:prisma|rb)$/i;

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
 * Stable machine-readable identifiers for every reason a footprint routes
 * `full` — the `code` field on a {@link deriveStoryShape} decision
 * (Story #4815).
 *
 * The prose in `reasons[]` is written for a human reading a gate envelope and
 * is free to be re-worded; a caller that must **branch** on *which* rule
 * objected reads this code instead — keying that decision off reason text
 * would make a copy-edit a routing change.
 *
 * Split two ways since Story #5344 deleted the ceiling rules
 * (`change-kinds`, `magnitude`, `uncertainty`, `deployable-span`), and the
 * grouping is the contract:
 *
 *   - **Absolute rules** — `migration-span`, `sensitive-path`. Risk, not size,
 *     and derived from the predicted PATHS rather than a self-declared bucket.
 *     No re-slicing satisfies one.
 *   - **Unknown-footprint rejections** — `no-changes`, `unreadable-changes`,
 *     `glob-footprint`, `classification-unavailable`. Nothing was judged, so
 *     there is nothing to appeal. Story #5366 deleted `no-acceptance` with
 *     the `--acceptance` flag that was its only source: the flag clamped to a
 *     floor of one, so the zero-check behind this code could never fire.
 *
 * A `lite` route carries `code: null`.
 */
export const SHAPE_CODES = Object.freeze({
  MIGRATION_SPAN: 'migration-span',
  SENSITIVE_PATH: 'sensitive-path',
  NO_CHANGES: 'no-changes',
  UNREADABLE_CHANGES: 'unreadable-changes',
  GLOB_FOOTPRINT: 'glob-footprint',
  CLASSIFICATION_UNAVAILABLE: 'classification-unavailable',
});

/**
 * Ordered **absolute risk** rules, evaluated in order; the first hit is the
 * recorded reason for a `full` route. Neither reads a bucket the caller
 * declared about itself — both are derived from the predicted paths, which is
 * exactly why they survived the Story #5344 deletion of the effort ceilings.
 *
 * @type {ReadonlyArray<{
 *   code: string,
 *   when: (shape: object) => boolean,
 *   reason: (shape: object) => string,
 * }>}
 */
const RISK_RULES = Object.freeze([
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
      `footprint intersects sensitive-path class(es) ${s.sensitiveClasses.join(', ')} — sensitivity wins over a small footprint; full route (deep review retained)`,
  },
]);

/**
 * First absolute risk rule the footprint violates as a `{ code, reason }`
 * pair, or `null` when it clears them all.
 *
 * @param {object} shape
 * @returns {{ code: string, reason: string }|null}
 */
function firstRiskViolation(shape) {
  for (const rule of RISK_RULES) {
    if (rule.when(shape)) {
      return { code: rule.code, reason: rule.reason(shape) };
    }
  }
  return null;
}

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
 * Assemble one decision object. Module-level rather than a closure inside
 * {@link deriveStoryShape}, so each rejection family below can build its own
 * verdict through one shape.
 *
 * @param {'lite'|'full'} route
 * @param {string|null} code
 * @param {string} reason
 * @param {object|null} [shape]
 * @returns {object}
 */
function decide(route, code, reason, shape = null) {
  return { route, reasons: [reason], code, shape };
}

/**
 * Read the declared footprint into path entries, or the rejection that stands
 * in for one when it cannot be read at all — the first of the three rejection
 * families {@link SHAPE_CODES} groups. Nothing has been judged at this point,
 * so neither rejection carries a shape.
 *
 * @param {unknown} changes
 * @returns {{ entries: Array<{ path: string, isGlob?: boolean }>|null, rejection: object|null }}
 */
function readFootprintEntries(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return {
      entries: null,
      rejection: decide(
        'full',
        SHAPE_CODES.NO_CHANGES,
        'no changes[] declared — the footprint is unknown, so the work cannot be judged trivial; conservative full route',
      ),
    };
  }
  try {
    return { entries: extractChangePaths(changes), rejection: null };
  } catch (err) {
    return {
      entries: null,
      rejection: decide(
        'full',
        SHAPE_CODES.UNREADABLE_CHANGES,
        `changes[] could not be read (${err?.message ?? err}) — unknown footprint; conservative full route`,
      ),
    };
  }
}

/**
 * The one rejection a footprint that WAS read can still earn before any risk
 * rule is reached: an unknowable width (a glob). Returns `null` when the
 * footprint is judgeable.
 *
 * It used to have a sibling — a zero-length acceptance list — which Story
 * #5366 removed along with the `--acceptance` flag that fed it. The flag
 * clamped its own value to a floor of one, so the branch was unreachable from
 * the only caller in the tree.
 *
 * @param {Array<{ isGlob?: boolean }>} entries
 * @param {object} shape
 * @returns {object|null}
 */
function unjudgeableFootprintRejection(entries, shape) {
  if (entries.some((e) => e.isGlob)) {
    return decide(
      'full',
      SHAPE_CODES.GLOB_FOOTPRINT,
      'changes[] contains a glob path — unknown footprint width; conservative full route',
      shape,
    );
  }
  return null;
}

/**
 * Assemble the risk shape of a footprint — the evidence
 * {@link deriveStoryShape} decides on and carries on its result.
 *
 * @param {{
 *   paths: string[],
 *   sensitiveClasses: string[],
 * }} args
 * @returns {{
 *   siteCount: number,
 *   migrationSpan: boolean,
 *   sensitiveClasses: string[],
 * }}
 */
function buildRiskShape({ paths, sensitiveClasses }) {
  return {
    siteCount: paths.length,
    migrationSpan: spansMigrationAndConsumers(paths),
    sensitiveClasses,
  };
}

/**
 * Derive the complexity route from a footprint's **risk** (Story #4722
 * AC-3/AC-4; re-anchored off artifact cardinality by Story #4764; the declared
 * effort ceilings deleted by Story #5344) — the single function the light
 * path's suitability gate reads, so prediction-time and close-time can never
 * disagree about what is sensitive.
 *
 * `lite` requires:
 *
 *   - a declared, parseable, glob-free `changes[]` footprint — width is not
 *     counted, but an unknown footprint cannot be classified for risk;
 *   - no migration-with-consumers span;
 *   - a footprint intersecting **no** sensitive-path class
 *     (`deriveChangeLevel`, the taxonomy close applies to the landed diff).
 *     Sensitivity always wins (AC-6): a sensitive footprint routes `full`
 *     however small or mechanical, which keeps the deep code review via
 *     `review-depth.js#resolveDepth`. Since Story #5343 it does NOT also buy a
 *     fresh acceptance critic — that owner follows the ceremony profile.
 *
 * **Size is not a rule here.** It was, and Story #5344 removed it: every size
 * axis was a bucket the caller declared about its own request, and the light
 * path's diff backstop measures the real change set afterwards. What is left
 * reads the predicted paths, which is evidence.
 *
 * Everything else — an unknown/undeclared footprint or an unreadable
 * sensitive-path manifest — fails toward `full`. Total: never throws.
 *
 * @param {{
 *   changes?: unknown,
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args]
 * @returns {{
 *   route: ComplexityRoute,
 *   reasons: string[],
 *   code: string|null,
 *   shape: ReturnType<typeof buildRiskShape>|null,
 * }} `code` is the stable {@link SHAPE_CODES} identifier for the rule that
 *   rejected the footprint (`null` on `lite`) — the field a caller branches
 *   on, since `reasons[]` is human prose and free to be re-worded.
 */
export function deriveStoryShape({
  changes,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const { entries, rejection } = readFootprintEntries(changes);
  if (rejection !== null) return rejection;

  const paths = entries.map((e) => e.path);
  const { level, classes } = deriveChangeLevel({
    changedFiles: paths,
    injectedRules,
    selectSensitivePathClassesFn,
  });
  const shape = buildRiskShape({ paths, sensitiveClasses: classes });

  const unjudgeable = unjudgeableFootprintRejection(entries, shape);
  if (unjudgeable !== null) return unjudgeable;

  const violation = firstRiskViolation(shape);
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
    `no absolute risk rule fires across ${shape.siteCount} predicted path(s): no migration-with-consumers span, no sensitive-path class — inline-eligible; size is bounded by the diff backstop`,
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
