// scripts/lib/baselines/scope-inventory.js
//
// Story #5012 — the ONE in-scope file inventory the honesty surface reads.
//
// A ratchet gate can be green while measuring almost nothing: nothing checks
// that a committed baseline's row set still describes the tree it claims to
// describe. Both instruments that now do — `check-baseline-scope.js` (assert)
// and `prune-baseline-orphans.js` (remedy) — resolve "which files is this kind
// supposed to have rows for?" through this module, so the gate and the pruner
// cannot disagree about scope and start fighting each other.
//
// ## Recompute from the gate's own config, never from a second walker
//
// The inventory is derived from **the same configuration the kind's refresh
// scorer reads**, through the same helpers:
//
//   - `coverage` — `.c8rc.cjs` `include` / `exclude`, applied with
//     `coverage-baseline.js#buildScopePredicate`, exactly as
//     `refresh-service.js#buildDefaultCoverageScorer` does.
//   - every other file-keyed kind — `delivery.quality.gates.<kind>.targetDirs`
//     / `.ignoreGlobs`, walked with `maintainability-utils.js#scanDirectory`,
//     exactly as `refresh-service.js#buildDefaultMaintainabilityScorer` does.
//
// A second walker written here would report the two implementations
// disagreeing as divergence — the same failure mode
// `check-baseline-drift.js` avoids by re-scoring through
// `resolveDefaultScorer` rather than a private scorer.
//
// ## Measurement-free by contract
//
// Nothing in this module runs a scorer, reads `coverage/coverage-final.json`,
// or needs a test run to have happened. It walks directories and matches
// globs. That is what makes the gate runnable on any checkout, which is in
// turn what makes hard-failing on a stale row defensible.

import { createRequire } from 'node:module';
import path from 'node:path';

import { buildScopePredicate } from '../../../.agents/scripts/lib/coverage-baseline.js';
import { scanDirectory } from '../../../.agents/scripts/lib/maintainability-utils.js';

/**
 * Per-kind classification of which divergence directions may be asserted.
 *
 * **Only a kind whose producer emits one row per in-scope file may assert the
 * MISSING direction.** This is not a conservatism knob — it is arithmetic.
 * Measured against this repository on 2026-08-05, asserting MISSING densely
 * yields 128 phantom rows for `crap` (rows are per-method and coverage-gated,
 * so a file with no scorable method legitimately has none) and 510 for
 * `duplication` (a row exists only where a clone was found). A gate that
 * reports 638 phantom findings on a healthy tree is a gate nobody reads.
 *
 * `mutation` is sparse for the same reason — an untested file has no
 * mutation row. `bundle-size` (keyed on `bundle`) is not file-keyed at all, so
 * neither direction is meaningful: its keys name artefacts, not paths on
 * disk, and a directory walk can say nothing about them.
 *
 * @type {Readonly<Record<string, { keyField: string, directions: readonly string[] }>>}
 */
export const KIND_SCOPE_POLICY = Object.freeze({
  coverage: Object.freeze({
    keyField: 'path',
    directions: Object.freeze(['missing', 'extra']),
  }),
  maintainability: Object.freeze({
    keyField: 'path',
    directions: Object.freeze(['missing', 'extra']),
  }),
  crap: Object.freeze({
    keyField: 'path',
    directions: Object.freeze(['extra']),
  }),
  duplication: Object.freeze({
    keyField: 'path',
    directions: Object.freeze(['extra']),
  }),
  mutation: Object.freeze({
    keyField: 'path',
    directions: Object.freeze(['extra']),
  }),
  'bundle-size': Object.freeze({
    keyField: 'bundle',
    directions: Object.freeze([]),
  }),
});

/** Every kind the honesty surface knows about, in report order. */
export const SCOPE_KINDS = Object.freeze(Object.keys(KIND_SCOPE_POLICY));

/**
 * The directions `kind` may assert. Unknown kinds assert nothing — a kind this
 * module has never heard of has no scope model, and inventing one would be the
 * phantom-row failure above with extra steps.
 *
 * @param {string} kind
 * @returns {readonly string[]}
 */
export function directionsFor(kind) {
  return KIND_SCOPE_POLICY[kind]?.directions ?? [];
}

/**
 * The row field `kind` keys on — `path` for the file-keyed kinds, `bundle`
 * for bundle-size. Mirrors `kinds/<kind>.js#keyField`;
 * kept here so a caller can classify without importing the kernel.
 *
 * @param {string} kind
 * @returns {string}
 */
export function keyFieldFor(kind) {
  return KIND_SCOPE_POLICY[kind]?.keyField ?? 'path';
}

/**
 * True when `kind` keys its rows on a repo-relative file path, so a directory
 * walk can be compared against its row set at all.
 *
 * @param {string} kind
 * @returns {boolean}
 */
export function isFileKeyed(kind) {
  return keyFieldFor(kind) === 'path' && Object.hasOwn(KIND_SCOPE_POLICY, kind);
}

/** Glob metacharacters that end a pattern's literal prefix. */
const GLOB_META = /[*?[\]{}!+@()]/;

/**
 * Derive directory roots to walk from a list of include globs, by taking each
 * pattern's literal leading path segments.
 *
 * The coverage gate's schema is closed and declares no `targetDirs` — its
 * scope lives entirely in `.c8rc.cjs`. Without this derivation the coverage
 * walk has no root to start from, so there is nothing to compare the row set
 * against and the whole MISSING direction goes silently inert for the one kind
 * whose producer is densest.
 *
 * `'.agents/scripts/**'` yields `.agents/scripts`; a pattern that is glob from
 * its first segment (`'**​/*.js'`) yields `.`, the repo root.
 *
 * @param {string[]} globs
 * @returns {string[]} De-duplicated roots, repo-relative POSIX.
 */
export function deriveWalkRoots(globs) {
  const roots = new Set();
  for (const glob of Array.isArray(globs) ? globs : []) {
    if (typeof glob !== 'string' || glob.length === 0) continue;
    const literal = [];
    for (const segment of glob.split('/')) {
      if (GLOB_META.test(segment)) break;
      literal.push(segment);
    }
    roots.add(literal.join('/') || '.');
  }
  return [...roots];
}

/**
 * Walk `roots` under `cwd` and return canonical repo-relative POSIX paths.
 *
 * Delegates to `scanDirectory`, which already owns the supported-extension set
 * and the ignored-directory set (`node_modules`, `.git`, `temp`, `.worktrees`,
 * …) that every scorer walks with. Passing `ignoreGlobs` straight through
 * means an ignored file is dropped by the identical matcher the scorer uses.
 *
 * @param {{ cwd: string, roots: string[], ignoreGlobs?: string[] }} params
 * @returns {string[]}
 */
function walkRoots({ cwd, roots, ignoreGlobs = [] }) {
  const absolute = [];
  for (const root of roots) {
    const abs = path.isAbsolute(root) ? root : path.resolve(cwd, root);
    scanDirectory(abs, absolute, { cwd, ignoreGlobs });
  }
  return absolute.map((abs) =>
    path.relative(cwd, abs).split(path.sep).join('/'),
  );
}

/**
 * Build the coverage inventory from `.c8rc.cjs`.
 *
 * Roots come from the literal prefixes of `include`; the walked set is then
 * filtered through the same `buildScopePredicate` the coverage scorer applies,
 * so `exclude` is honoured by one implementation rather than two.
 *
 * @param {{ cwd: string, requireFn?: (id: string) => object }} params
 * @returns {{ files: string[] | null, roots: string[], degraded: boolean, reason: string | null }}
 */
function coverageInventory({ cwd, requireFn }) {
  const load = requireFn ?? createRequire(path.join(cwd, 'noop.cjs'));
  let config;
  try {
    config = load(path.resolve(cwd, '.c8rc.cjs'));
  } catch (err) {
    return {
      files: null,
      roots: [],
      degraded: true,
      reason: `.c8rc.cjs unreadable: ${err?.message ?? err}`,
    };
  }
  const include = Array.isArray(config?.include) ? config.include : [];
  const exclude = Array.isArray(config?.exclude) ? config.exclude : [];
  if (include.length === 0) {
    return {
      files: null,
      roots: [],
      degraded: true,
      reason: '.c8rc.cjs declares no include globs',
    };
  }
  const roots = deriveWalkRoots(include);
  const inScope = buildScopePredicate({ include, exclude });
  return {
    files: walkRoots({ cwd, roots }).filter(inScope),
    roots,
    degraded: false,
    reason: null,
  };
}

/**
 * Build the inventory for a `targetDirs`-configured kind (everything except
 * coverage). Reads the gate's own `targetDirs` / `ignoreGlobs` off the
 * normalized quality block — the same two keys its refresh scorer reads.
 *
 * @param {{ kind: string, cwd: string, gate: object }} params
 * @returns {{ files: string[] | null, roots: string[], degraded: boolean, reason: string | null }}
 */
function targetDirsInventory({ kind, cwd, gate }) {
  const roots = Array.isArray(gate?.targetDirs) ? gate.targetDirs : [];
  const ignoreGlobs = Array.isArray(gate?.ignoreGlobs) ? gate.ignoreGlobs : [];
  if (roots.length === 0) {
    return {
      files: null,
      roots: [],
      degraded: true,
      reason: `delivery.quality.gates.${kind}.targetDirs is empty or unset`,
    };
  }
  return {
    files: walkRoots({ cwd, roots, ignoreGlobs }),
    roots,
    degraded: false,
    reason: null,
  };
}

/**
 * Resolve the set of files `kind` is configured to have rows for.
 *
 * Never throws: an unreadable or absent scope config degrades to
 * `{ files: null, degraded: true, reason }`. Callers treat a degraded
 * inventory as "scope unknown" — the gate reports it and skips that kind's
 * scope directions, the pruner falls back to orphan-only pruning. Neither may
 * infer emptiness from it: a `files: []` inventory would make every committed
 * row look out-of-scope and hand the pruner a licence to delete the baseline.
 *
 * @param {{
 *   kind: string,
 *   cwd?: string,
 *   quality?: object,
 *   requireFn?: (id: string) => object,
 * }} params
 * @returns {{
 *   kind: string,
 *   keyField: string,
 *   directions: readonly string[],
 *   files: string[] | null,
 *   roots: string[],
 *   degraded: boolean,
 *   reason: string | null,
 * }}
 */
export function buildScopeInventory({
  kind,
  cwd = process.cwd(),
  quality,
  requireFn,
} = {}) {
  const base = {
    kind,
    keyField: keyFieldFor(kind),
    directions: directionsFor(kind),
  };
  if (!isFileKeyed(kind)) {
    return {
      ...base,
      files: null,
      roots: [],
      degraded: false,
      reason: `${kind} is not file-keyed (rows key on "${base.keyField}")`,
    };
  }
  const resolved =
    kind === 'coverage'
      ? coverageInventory({ cwd, requireFn })
      : targetDirsInventory({
          kind,
          cwd,
          gate: quality?.gates?.[kind] ?? {},
        });
  return { ...base, ...resolved };
}
