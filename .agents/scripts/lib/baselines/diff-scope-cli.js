/**
 * lib/baselines/diff-scope-cli.js — shared `--diff-scope <ref>` parser for
 * the manual baseline-update CLIs (Story #1974 / Task #1986, Epic #1943).
 *
 * `update-coverage-baseline.js`, `update-crap-baseline.js`,
 * `update-maintainability-baseline.js`, and `update-mutation-baseline.js`
 * all accept an opt-in `--diff-scope <ref>` flag. When supplied, the
 * baseline write narrows to files changed since `<ref>` (resolved via
 * `git diff --name-only <ref>...HEAD`). Out-of-scope rows are preserved
 * verbatim from the prior on-disk baseline via the per-kind `mergeRows`.
 *
 * When the flag is absent, the CLIs behave exactly as they did before
 * #1974 — full regenerate + write — preserving operator workflows that
 * intentionally rewrite the whole baseline.
 *
 * The helper is shared to keep the flag's contract identical across the
 * four scripts: same argv parser, same git invocation, same forward-slash
 * path normalisation. The four CLIs differ only in how they pipe the
 * resolved scope through to their writer.
 */

import { spawnSync } from 'node:child_process';

/**
 * Parse `--diff-scope <ref>` (and the legacy `--diff-scope=<ref>` form)
 * from an argv slice. Returns `null` when the flag is absent. Throws a
 * TypeError when the flag is supplied without a value.
 *
 * Pure; no I/O.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
export function parseDiffScopeFlag(argv = []) {
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--diff-scope') {
      const next = argv[i + 1];
      if (typeof next !== 'string' || next.length === 0) {
        throw new TypeError(
          '[diff-scope-cli] --diff-scope requires a non-empty <ref> argument',
        );
      }
      return next;
    }
    if (typeof tok === 'string' && tok.startsWith('--diff-scope=')) {
      const ref = tok.slice('--diff-scope='.length);
      if (ref.length === 0) {
        throw new TypeError(
          '[diff-scope-cli] --diff-scope= requires a non-empty <ref> value',
        );
      }
      return ref;
    }
  }
  return null;
}

/**
 * Resolve the file footprint of `git diff --name-only <ref>...HEAD`.
 * Returns a `Set<string>` of repo-relative paths with forward-slash
 * normalisation. Returns an empty Set when the diff is empty or git
 * exits non-zero (best-effort; a missing-ref or corrupt repo is the
 * operator's signal to inspect the working tree).
 *
 * The `spawnImpl` seam exists for unit tests — production callers omit it.
 *
 * @param {{ ref: string, cwd?: string, spawnImpl?: typeof spawnSync }} args
 * @returns {Set<string>}
 */
export function resolveDiffScopeFiles({
  ref,
  cwd = process.cwd(),
  spawnImpl = spawnSync,
} = {}) {
  if (typeof ref !== 'string' || ref.length === 0) return new Set();
  const res = spawnImpl('git', ['diff', '--name-only', `${ref}...HEAD`], {
    cwd,
    encoding: 'utf8',
  });
  if (!res || res.status !== 0) return new Set();
  return new Set(
    (res.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/\\/g, '/')),
  );
}

/**
 * Convenience: parse `--diff-scope` and resolve files in one call.
 * Returns `null` when the flag is absent (so the caller can branch on
 * "scope was opted in?"); otherwise returns
 * `{ ref, files: Set<string>, scope: { mode: 'diff', files } }` ready to
 * pass into `writer.write({ scope })`.
 *
 * @param {{ argv: string[], cwd?: string, spawnImpl?: typeof spawnSync }} args
 * @returns {{ ref: string, files: Set<string>, scope: {mode: 'diff', files: Set<string>} } | null}
 */
export function resolveDiffScope({ argv, cwd, spawnImpl } = {}) {
  const ref = parseDiffScopeFlag(argv);
  if (ref === null) return null;
  const files = resolveDiffScopeFiles({ ref, cwd, spawnImpl });
  return { ref, files, scope: { mode: 'diff', files } };
}
