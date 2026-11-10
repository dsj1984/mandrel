/**
 * conflicts.js — which of a conflicting PR's paths a custom merge driver
 * resolves. Reads a local `git merge-tree` of base and head, and
 * `git check-attr merge` (so a consumer's own driver rows count).
 */

import { gitSpawn } from '../git-utils.js';

/** `check-attr merge` values that name no custom driver. */
const BUILTIN_MERGE_VALUES = new Set([
  'unspecified',
  'set',
  'unset',
  'text',
  'binary',
  'union',
]);

const ATTR_SEPARATOR = ': merge: ';

/**
 * @param {string} stdout `git check-attr merge -- <paths>` output
 * @returns {Map<string, string>} path → attribute value
 */
function parseCheckAttr(stdout) {
  const values = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const at = line.lastIndexOf(ATTR_SEPARATOR);
    if (at > 0)
      values.set(
        line.slice(0, at),
        line.slice(at + ATTR_SEPARATOR.length).trim(),
      );
  }
  return values;
}

/**
 * Merge base and head locally (fetching only those two refs) and mark each
 * conflicted path driver-merged or not. `null` when git could not tell.
 *
 * @param {{ cwd: string, base: string, number: number, headSha: string,
 *   spawn?: Function }} args
 * @returns {{ clean: boolean, paths: Array<{ path: string, driver: boolean }> }|null}
 */
export function resolveConflict({
  cwd,
  base,
  number,
  headSha,
  spawn = gitSpawn,
}) {
  const fetched = spawn(
    cwd,
    'fetch',
    '--no-tags',
    '--quiet',
    'origin',
    base,
    `refs/pull/${number}/head`,
  );
  if (fetched.status !== 0) return null;
  const merged = spawn(
    cwd,
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    `origin/${base}`,
    headSha,
  );
  if (merged.status === 0) return { clean: true, paths: [] };
  if (merged.status !== 1) return null;
  const paths = [
    ...new Set(
      merged.stdout
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  if (paths.length === 0) return null;
  const attrs = spawn(cwd, 'check-attr', 'merge', '--', ...paths);
  if (attrs.status !== 0) return null;
  const values = parseCheckAttr(attrs.stdout);
  return {
    clean: false,
    paths: paths.map((p) => ({
      path: p,
      driver: isCustomDriver(values.get(p)),
    })),
  };
}

function isCustomDriver(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !BUILTIN_MERGE_VALUES.has(value)
  );
}

/**
 * `conflicted-driver-only` when the local merge is clean or every conflicted
 * path is driver-merged; otherwise `conflicted-real` with the other paths.
 * An unreadable local merge is `conflicted-real` with `paths: null`.
 *
 * @param {{ clean: boolean, paths: Array<{ path: string, driver: boolean }> }|null} conflict
 * @returns {{ state: string, paths: string[]|null }}
 */
export function conflictState(conflict) {
  if (!conflict) return { state: 'conflicted-real', paths: null };
  const real = conflict.paths.filter((p) => !p.driver).map((p) => p.path);
  if (conflict.clean || real.length === 0) {
    return { state: 'conflicted-driver-only', paths: [] };
  }
  return { state: 'conflicted-real', paths: real };
}
