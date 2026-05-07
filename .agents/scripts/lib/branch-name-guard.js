/**
 * branch-name-guard.js — Canonical branch-name safety assertion.
 *
 * Single source of truth for "is this string safe to forward to a `git`
 * subprocess as a branch name?". Consolidates the duplicated assertion
 * logic that previously lived in `git-branch-lifecycle.js` and
 * `git-branch-cleanup.js`, so the two sites cannot drift apart.
 *
 * The guard is the **union** of every check that either previous site
 * performed plus an explicit deny-list for protected refs and a leading-
 * dash trap. When in doubt, fail closed.
 *
 * Rejected:
 *   - `null` / `undefined` / non-string values
 *   - empty string
 *   - any character outside `[a-zA-Z0-9._\-/]` (catches whitespace, shell
 *     metacharacters, glob characters, and so on)
 *   - leading `-` (would otherwise be parsed as a CLI flag by git, even
 *     though the regex character class allows hyphens elsewhere)
 *   - protected refs: `main`, `master`, `HEAD`, and any name starting
 *     with `refs/` (case-insensitive for `HEAD` only — `main` and
 *     `master` are case-sensitive because their lowercase form is the
 *     real-world default; uppercase variants are accepted as legitimate
 *     branch names if a project chooses to use them)
 *
 * All exports are pure: they read no config, spawn no subprocesses, and
 * make no network calls.
 */

import { isSafeBranchComponent } from './dependency-parser.js';

/**
 * Names that must never be passed to a destructive git operation through
 * one of these helpers. Lowercase, since `main` / `master` are the
 * real-world protected refs.
 */
const PROTECTED_BRANCHES = new Set(['main', 'master']);

/**
 * Pure predicate: returns `true` iff `name` is safe to forward to a git
 * subprocess as a branch name. Does not throw.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSafeBranchName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0) return false;
  if (name.startsWith('-')) return false;
  if (!isSafeBranchComponent(name)) return false;
  if (PROTECTED_BRANCHES.has(name)) return false;
  if (name === 'HEAD') return false;
  if (name.startsWith('refs/')) return false;
  return true;
}

/**
 * Throwing assertion for one or more branch names. Use this from any
 * helper that is about to forward `name` to git. The error message
 * includes the offending value verbatim so operators can grep logs.
 *
 * @param {...unknown} names
 * @throws {Error} when any name fails {@link isSafeBranchName}.
 * @returns {void}
 */
export function assertBranchSafe(...names) {
  for (const name of names) {
    if (!isSafeBranchName(name)) {
      const repr = typeof name === 'string' ? `"${name}"` : String(name);
      throw new Error(
        `[branch-name-guard] Unsafe branch name detected: ${repr}. ` +
          'Branch names must be non-empty, contain only alphanumeric ' +
          'characters, hyphens, underscores, dots, and slashes, must not ' +
          'begin with "-", and must not be a protected ref ' +
          '(main, master, HEAD, refs/*).',
      );
    }
  }
}
