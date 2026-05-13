/**
 * migrate-to-v6-core.js — pure-data engine for the `migrate-to-v6.js` CLI.
 *
 * Split out so unit tests can drive the rewrite logic with in-memory
 * fixtures (objects + string buffers) and never touch the filesystem,
 * spawn `git`, or shell out. The CLI wrapper in [`../migrate-to-v6.js`](
 * ../migrate-to-v6.js) is the only seam that does I/O.
 *
 * Two transforms ship here:
 *   1. `rewriteAgentrc(config)` — applies the keymap from
 *      [`./v5-to-v6-keymap.js`](./v5-to-v6-keymap.js) to an in-memory
 *      `.agentrc.json` object. Idempotent. Returns `{ next, changes }`.
 *   2. `rewriteGitmodules(text)` and `rewritePackageJson(pkg)` — cosmetic
 *      submodule URL + peerDep bumps from `agent-protocols` → `mandrel`.
 *      Both idempotent.
 *
 * Pure, deterministic, no network, no clock, no random. Safe to import
 * from any test runner.
 */

import { V5_TO_V6_KEYMAP } from './v5-to-v6-keymap.js';

/** Submodule URL prefix that triggers the .gitmodules rewrite. */
export const LEGACY_REPO_NAME = 'agent-protocols';
export const NEW_REPO_NAME = 'mandrel';

// -----------------------------------------------------------------------------
// Dot-path helpers — small, local, no lodash. Keeps the migration CLI
// dependency-free against the consumer's installed node_modules.
// -----------------------------------------------------------------------------

/**
 * Resolve a dot path to its parent object and final segment, returning
 * `null` when any intermediate segment is missing or not a plain object.
 *
 * @param {Record<string, unknown>} root
 * @param {string} path
 * @returns {{ parent: Record<string, unknown>; key: string } | null}
 */
function resolveParent(root, path) {
  const segments = path.split('.');
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cursor[seg];
    if (next === undefined || next === null || typeof next !== 'object') {
      return null;
    }
    cursor = /** @type {Record<string, unknown>} */ (next);
  }
  return { parent: cursor, key: segments[segments.length - 1] };
}

/**
 * Set a dot path, creating intermediate plain objects as needed. The leaf
 * value is written verbatim; callers wishing to deep-merge must do so on
 * the caller side.
 *
 * @param {Record<string, unknown>} root
 * @param {string} path
 * @param {unknown} value
 */
function setPath(root, path, value) {
  const segments = path.split('.');
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cursor[seg];
    if (next === undefined || next === null || typeof next !== 'object') {
      const fresh = {};
      cursor[seg] = fresh;
      cursor = fresh;
    } else {
      cursor = /** @type {Record<string, unknown>} */ (next);
    }
  }
  cursor[segments[segments.length - 1]] = value;
}

/**
 * Check whether a dot path has a value present (including `null`, `0`,
 * `false` — anything that can be set deliberately by a consumer). Only
 * `undefined` counts as absent.
 *
 * @param {Record<string, unknown>} root
 * @param {string} path
 */
function hasPath(root, path) {
  const resolved = resolveParent(root, path);
  if (resolved === null) return false;
  return Object.hasOwn(resolved.parent, resolved.key);
}

/**
 * Walk a fresh structural clone of `value`. We avoid `structuredClone`
 * because some Node test harnesses run under older targets; JSON
 * round-trip is sufficient — `.agentrc.json` is, by definition, JSON.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Apply the v5→v6 keymap to a parsed `.agentrc.json` object. The input
 * is not mutated; the returned `next` is a deep clone with the rewrites
 * applied.
 *
 * Algorithm:
 *   - Walk the keymap in declared order. Order matters: child rewrites
 *     run before their parent removals so a parent prune doesn't strip
 *     a child that was about to be moved to a v6 destination.
 *   - For each entry, if the legacy `from` path is present:
 *       * If `to` is a string, lift the value to the new path and delete
 *         the legacy path.
 *       * If `to` is `null`, delete the legacy path outright.
 *   - Empty intermediate parents that result from deletion are pruned
 *     (e.g. once every key under `riskGates` is gone, the empty
 *     `riskGates: {}` block is removed too — otherwise `additionalProperties:
 *     false` on the v6 schema would still reject the empty stub).
 *
 * Idempotency: running this twice on the same input is a no-op the
 * second time. The keymap's `from` paths are legacy-only by
 * construction — once they're all deleted, the second pass walks the
 * same table and finds nothing to do.
 *
 * @param {Record<string, unknown>} config
 * @returns {{ next: Record<string, unknown>; changes: Array<{from: string; to: string | null; action: 'rename' | 'remove'; removedIn?: string; note: string }> }}
 */
export function rewriteAgentrc(config) {
  /** @type {Record<string, unknown>} */
  const next = deepClone(config);
  /** @type {Array<{from: string; to: string | null; action: 'rename' | 'remove'; removedIn?: string; note: string}>} */
  const changes = [];

  for (const entry of V5_TO_V6_KEYMAP) {
    if (!hasPath(next, entry.from)) continue;
    const resolved = resolveParent(next, entry.from);
    if (resolved === null) continue;
    const { parent, key } = resolved;
    const legacyValue = parent[key];

    if (entry.to !== null) {
      // Don't trample a value that the user (or an earlier keymap entry)
      // already placed at the destination. This is the second leg of
      // idempotency: if a previous run renamed `epicRunner` → `deliverRunner`
      // and the consumer then re-introduces an `epicRunner` block,
      // we'd otherwise silently overwrite the new block. Skipping with
      // a noted no-op is the safer default.
      if (!hasPath(next, entry.to)) {
        const transformed =
          typeof entry.transform === 'function'
            ? entry.transform(legacyValue, { from: entry.from, to: entry.to })
            : legacyValue;
        setPath(next, entry.to, transformed);
      }
      delete parent[key];
      changes.push({
        from: entry.from,
        to: entry.to,
        action: 'rename',
        ...(entry.removedIn ? { removedIn: entry.removedIn } : {}),
        note: entry.note,
      });
    } else {
      delete parent[key];
      changes.push({
        from: entry.from,
        to: null,
        action: 'remove',
        ...(entry.removedIn ? { removedIn: entry.removedIn } : {}),
        note: entry.note,
      });
    }

    // Prune the now-possibly-empty parent if and only if the parent is a
    // plain object with zero remaining keys. We only walk one level up
    // — multi-level pruning is brittle and the keymap orders its
    // parent-removal entries explicitly anyway.
    pruneEmptyParent(next, entry.from);
  }

  return { next, changes };
}

/**
 * Drop the immediate parent of `path` when that parent is now an empty
 * plain object. Used after a removal/rename to keep the residual
 * config clean of stub blocks. Idempotent and safe on missing paths.
 *
 * @param {Record<string, unknown>} root
 * @param {string} path
 */
function pruneEmptyParent(root, path) {
  const segments = path.split('.');
  if (segments.length < 2) return;
  const parentPath = segments.slice(0, -1).join('.');
  const parentResolved = resolveParent(root, parentPath);
  if (parentResolved === null) return;
  const parentValue = parentResolved.parent[parentResolved.key];
  if (
    parentValue !== null &&
    typeof parentValue === 'object' &&
    !Array.isArray(parentValue) &&
    Object.keys(/** @type {Record<string, unknown>} */ (parentValue)).length ===
      0
  ) {
    delete parentResolved.parent[parentResolved.key];
  }
}

/**
 * Rewrite the consumer's `.gitmodules` text to point at the renamed
 * GitHub repository. Conservative: only substitutes the well-known
 * legacy repo basename inside an `agent-protocols(.git)?` URL suffix.
 * Idempotent — a `.gitmodules` that already names `mandrel` is returned
 * unchanged. Returns `{ next, changed }`.
 *
 * @param {string} text
 * @returns {{ next: string; changed: boolean }}
 */
export function rewriteGitmodules(text) {
  if (typeof text !== 'string') {
    return { next: text, changed: false };
  }
  // Match the basename `agent-protocols` only where it appears as the
  // tail of a URL path (preceded by `/`) and is either the literal
  // string ending the URL or followed by `.git`. This avoids rewriting
  // unrelated occurrences (comments, paths) that happen to contain the
  // legacy name.
  const pattern = /\/agent-protocols(\.git)?(?=$|[\s"'#])/gmu;
  if (!pattern.test(text)) {
    return { next: text, changed: false };
  }
  const next = text.replace(
    /\/agent-protocols(\.git)?(?=$|[\s"'#])/gmu,
    (_, dotGit) => `/${NEW_REPO_NAME}${dotGit ?? ''}`,
  );
  return { next, changed: next !== text };
}

/**
 * Rewrite a parsed `package.json` object: bump any reference to
 * `agent-protocols` inside `dependencies`, `devDependencies`,
 * `peerDependencies`, or `optionalDependencies` to `mandrel`, preserving
 * the version range. Idempotent. Returns `{ next, changed, changes }`.
 *
 * @param {Record<string, unknown>} pkg
 * @returns {{ next: Record<string, unknown>; changed: boolean; changes: Array<{ section: string; from: string; to: string; range: string }> }}
 */
export function rewritePackageJson(pkg) {
  const next = deepClone(pkg);
  /** @type {Array<{ section: string; from: string; to: string; range: string }>} */
  const changes = [];
  const sections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  for (const section of sections) {
    const block = next[section];
    if (block === null || block === undefined || typeof block !== 'object') {
      continue;
    }
    const blockObj = /** @type {Record<string, string>} */ (block);
    if (Object.hasOwn(blockObj, LEGACY_REPO_NAME)) {
      const range = blockObj[LEGACY_REPO_NAME];
      // Don't overwrite an existing `mandrel` entry — the consumer may
      // have added it manually with a different version pin.
      if (!Object.hasOwn(blockObj, NEW_REPO_NAME)) {
        blockObj[NEW_REPO_NAME] = range;
      }
      delete blockObj[LEGACY_REPO_NAME];
      changes.push({
        section,
        from: LEGACY_REPO_NAME,
        to: NEW_REPO_NAME,
        range,
      });
    }
  }
  return { next, changed: changes.length > 0, changes };
}

/**
 * Run all three rewrites against an in-memory snapshot. Used by both
 * the CLI wrapper (after it reads files) and unit tests (which pass
 * fixture objects directly).
 *
 * @param {{ agentrc: Record<string, unknown> | null; gitmodules: string | null; packageJson: Record<string, unknown> | null }} input
 * @returns {{
 *   agentrc: { next: Record<string, unknown>; changes: ReturnType<typeof rewriteAgentrc>['changes'] } | null;
 *   gitmodules: { next: string; changed: boolean } | null;
 *   packageJson: { next: Record<string, unknown>; changed: boolean; changes: ReturnType<typeof rewritePackageJson>['changes'] } | null;
 *   summary: { agentrcChanges: number; gitmodulesChanged: boolean; packageJsonChanges: number; totalChanges: number; alreadyV6: boolean };
 * }}
 */
export function planMigration(input) {
  const agentrc = input.agentrc !== null ? rewriteAgentrc(input.agentrc) : null;
  const gitmodules =
    input.gitmodules !== null ? rewriteGitmodules(input.gitmodules) : null;
  const packageJson =
    input.packageJson !== null ? rewritePackageJson(input.packageJson) : null;

  const agentrcChanges = agentrc?.changes.length ?? 0;
  const gitmodulesChanged = gitmodules?.changed ?? false;
  const packageJsonChanges = packageJson?.changes.length ?? 0;
  const totalChanges =
    agentrcChanges + (gitmodulesChanged ? 1 : 0) + packageJsonChanges;

  return {
    agentrc,
    gitmodules,
    packageJson,
    summary: {
      agentrcChanges,
      gitmodulesChanged,
      packageJsonChanges,
      totalChanges,
      alreadyV6: totalChanges === 0,
    },
  };
}
