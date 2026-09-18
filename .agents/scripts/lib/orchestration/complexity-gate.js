/**
 * lib/orchestration/complexity-gate.js — deliver-side Story routing: seed
 * signals for `/mandrel-plan`, footprint risk for the light path, and
 * inline-vs-subagent dispatch. Risk uses the same sensitive-path taxonomy
 * `review-depth.js` applies to the landed diff at close (predicted footprint
 * at dispatch, actual diff at close); sensitivity always wins. Close gates
 * run regardless of route — the router cannot switch them off.
 *
 * @typedef {'lite'|'full'} ComplexityRoute
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { extractChangePaths } from '../story-body/story-body.js';
import { deriveChangeLevel } from './review-depth.js';

// No predicted-size ceilings: a size the caller declares about itself is not
// a measurement. Size is bounded only by the diff backstop
// (`light-suitability.checkLightDiffBackstop`); the rules here read paths.

/** Paths that are schema migrations rather than ordinary source. */
const MIGRATION_PATH_RE =
  /(?:^|\/)(?:migrations?|migrate)(?:\/|$)|\.sql$|(?:^|\/)schema\.(?:prisma|rb)$/i;

/**
 * A migration plus the code that reads through it is epic scope: the
 * ordering is the design work.
 *
 * @param {string[]} paths
 * @returns {boolean}
 */
function spansMigrationAndConsumers(paths) {
  const migrations = paths.filter((p) => MIGRATION_PATH_RE.test(String(p)));
  return migrations.length > 0 && migrations.length < paths.length;
}

/**
 * Stable codes for why a footprint routes `full`; callers branch on these,
 * never on `reasons[]` prose. Absolute risk rules (`migration-span`,
 * `sensitive-path`) no re-slicing satisfies; the rest are unknown-footprint
 * rejections. `lite` carries `code: null`.
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
 * Absolute risk rules, in order; the first hit is the `full` reason.
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
 * Count enumerated lines (`- `, `* `, `1. `) in a seed.
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
 * Path-like tokens (a `/` plus a dotted extension) in a seed.
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
 * Advisory signals for a planning seed — they ground the authoring
 * template's `changes[]` and the `/prototype` offer and route nothing.
 * Existing paths predict refactors, missing ones creates. Never throws; a
 * failed classification yields an empty class list.
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
 * Read the footprint into path entries, or a shape-less rejection when it
 * cannot be read.
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
 * A glob footprint has unknowable width; `null` when judgeable.
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
 * Route a footprint by risk. `lite` requires a declared, parseable,
 * glob-free `changes[]`, no migration-with-consumers span, and no
 * sensitive-path class (a sensitive footprint keeps deep code review however
 * small). Anything unknown or unclassifiable fails toward `full`. Never
 * throws.
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
 * }}
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
    // Classification failed; that must never buy lite.
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
 * Decide where `/mandrel-deliver` runs a Story, from run topology only.
 * `inline` claims the router's own session, which only one Story can own:
 * sub-agent isolation matters only for concurrent dispatch (siblings race
 * worktrees and branch refs), so a single-Story run goes inline to skip the
 * spawn's cache-write premium. Shape must never grant inline — a multi-Story
 * run would put several engines on one session and checkout. Only *where*
 * changes; close gates, PR and terminal envelope are identical.
 *
 * @param {{ storyCount?: unknown }} [args] Anything but exactly 1 dispatches
 *   as a sub-agent.
 * @returns {{ mode: 'inline'|'subagent', reasons: string[] }}
 */
export function resolveStoryDispatchMode({ storyCount } = {}) {
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
