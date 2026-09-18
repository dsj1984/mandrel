/**
 * The one check that a string is safe to pass to `git` as a branch name:
 * a non-empty string of `[a-zA-Z0-9._\-/]` with no leading `-` (git would
 * read it as a flag). Destructive callers pass `{ protected: true }` to also
 * reject `main`, `master`, `HEAD` and `refs/*`. Pure.
 */

import { isSafeBranchComponent } from './dependency-parser.js';

/**
 * Names that must never be forwarded to a destructive git operation.
 * The set is exposed as a frozen object so callers can introspect.
 */
export const PROTECTED_BRANCH_NAMES = Object.freeze(['main', 'master', 'HEAD']);

/**
 * Pure predicate: returns `true` iff `name` is safe to forward to a git
 * subprocess as a branch name. Does not throw.
 *
 * @param {unknown} name
 * @param {{ protected?: boolean }} [opts]
 *   When `opts.protected` is `true`, additionally reject `main`,
 *   `master`, `HEAD`, and `refs/*` (used by destructive callers).
 * @returns {boolean}
 */
export function isSafeBranchName(name, opts = {}) {
  if (typeof name !== 'string') return false;
  if (name.length === 0) return false;
  if (name.startsWith('-')) return false;
  if (!isSafeBranchComponent(name)) return false;
  if (opts.protected) {
    if (PROTECTED_BRANCH_NAMES.includes(name)) return false;
    if (name.startsWith('refs/')) return false;
  }
  return true;
}

/**
 * Throwing assertion for one or more branch names. Use this from any
 * helper that is about to forward `name` to git. The error message
 * includes the offending value verbatim so operators can grep logs.
 *
 * Pass `{ protected: true }` as the **last argument** to additionally
 * reject `main` / `master` / `HEAD` / `refs/*` — recommended for any
 * caller about to invoke a destructive git operation.
 *
 * @param {...(unknown | { protected?: boolean })} args
 * @throws {Error} when any name fails {@link isSafeBranchName}.
 * @returns {void}
 */
export function assertBranchSafe(...args) {
  let opts = {};
  let names = args;
  const last = args[args.length - 1];
  if (
    last !== null &&
    typeof last === 'object' &&
    !Array.isArray(last) &&
    ('protected' in last || Object.keys(last).length === 0)
  ) {
    opts = last;
    names = args.slice(0, -1);
  }
  for (const name of names) {
    if (!isSafeBranchName(name, opts)) {
      const repr = typeof name === 'string' ? `"${name}"` : String(name);
      const protectedNote = opts.protected
        ? ' This site rejects protected refs (main, master, HEAD, refs/*).'
        : '';
      throw new Error(
        `[branch-name-guard] Unsafe branch name detected: ${repr}. ` +
          'Branch names must be non-empty strings containing only ' +
          'alphanumeric characters, hyphens, underscores, dots, and ' +
          'slashes, and must not begin with "-".' +
          protectedNote,
      );
    }
  }
}
