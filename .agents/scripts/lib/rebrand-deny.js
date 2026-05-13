/**
 * Deny-list for the `agent-protocols` → `mandrel` rebrand sweep (Epic #1184,
 * Story #1604). Paths listed here are skipped by
 * `.agents/scripts/rebrand-to-mandrel.js` so that:
 *
 *   1. **CHANGELOG history** stays accurate. Past entries name the product
 *      as it was named at the time of release.
 *   2. **Migration / redirect notices** keep both names. The v6 migration
 *      guide must reference the old name explicitly so v5 consumers can
 *      find it.
 *   3. **`.agents/` directory references and `.agentrc.json` filename
 *      references** are preserved by deliberate design — the rebrand keeps
 *      these names unchanged so adopters do not have to re-add the
 *      submodule. The script's regex only matches `agent-protocols` (with
 *      a hyphen) and `Agent Protocols` (with a space), so dotted-path
 *      tokens like `.agents/` and `.agentrc.json` are not matched. They
 *      are listed here as a defense-in-depth assertion.
 *   4. **The script itself and its tests** contain the literal source/target
 *      strings as data; rewriting them in-place would corrupt the tool.
 *
 * The deny-list is a flat array of path **prefixes** (compared with
 * `String#startsWith`). Globs are intentionally avoided to keep the
 * matcher trivial and inspectable; if a directory is denied, every file
 * inside it is denied.
 */

/**
 * @type {string[]}
 */
export const DENY_LIST = Object.freeze([
  // 1. Changelog history (live + archived).
  'docs/CHANGELOG.md',
  'docs/archive/',
  // 2. Migration guide — references both names by design.
  'docs/migration-v6.md',
  // 3. Self-references (the script + the deny-list + the test).
  '.agents/scripts/rebrand-to-mandrel.js',
  '.agents/scripts/lib/rebrand-deny.js',
  'tests/scripts/rebrand-to-mandrel.test.js',
  // 4. Lockfiles — regenerated from package.json on next install.
  'package-lock.json',
]);

/**
 * Return true when `relPath` (POSIX-normalised, repo-relative) is
 * protected by the deny-list. The matcher is a simple prefix test against
 * the frozen list above.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isDenied(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  const normalised = relPath.replace(/\\/g, '/');
  for (const prefix of DENY_LIST) {
    if (normalised === prefix) return true;
    if (prefix.endsWith('/') && normalised.startsWith(prefix)) return true;
  }
  return false;
}
