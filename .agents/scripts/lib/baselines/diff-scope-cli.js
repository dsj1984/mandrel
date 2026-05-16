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
import fs from 'node:fs';

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

/**
 * Read + parse the prior baseline at `absBaselinePath` and project the
 * result into the per-row shape expected by the per-kind `mergeRows` /
 * `applyEpsilon` helpers (Story #1974). Returns `null` when the file is
 * absent or malformed; the caller treats `null` as "skip the merge"
 * (regression-fail-safe — equivalent to a fresh write).
 *
 * `kind` decides how to interpret the on-disk shape:
 *
 *   - `'maintainability'`: handles both the v2 envelope (`rows[]`) and
 *     the legacy flat `{ "<path>": <mi> }` map.
 *   - `'crap'`: envelope `rows[]` only; adapts the legacy `file:` field
 *     to canonical `path:` so the per-kind module's matchers line up.
 *
 * Pure-by-design (file I/O through the injected `fsImpl` seam).
 *
 * @param {{ kind: 'maintainability' | 'crap', absBaselinePath: string, fsImpl?: typeof fs }} args
 * @returns {Array<object> | null}
 */
export function readPriorBaselineRows({ kind, absBaselinePath, fsImpl = fs }) {
  let raw;
  try {
    raw = fsImpl.readFileSync(absBaselinePath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (kind === 'crap') {
    if (!Array.isArray(parsed.rows)) return null;
    return parsed.rows.map((row) => ({ ...row, path: row.path ?? row.file }));
  }
  // maintainability — envelope first, then legacy flat-map fallback.
  if (Array.isArray(parsed.rows)) {
    return parsed.rows.filter(
      (r) => r && typeof r.path === 'string' && typeof r.mi === 'number',
    );
  }
  const rows = [];
  for (const [p, mi] of Object.entries(parsed)) {
    if (p === '$schema') continue;
    if (typeof mi === 'number') rows.push({ path: p, mi });
  }
  return rows;
}

/**
 * Compose the full Story #1974 write-side payload for a manual baseline
 * CLI: read prior rows, resolve `--diff-scope`, log the scope decision,
 * and return the four params (`prior`, `epsilon`, `scope`, plus the
 * resolved `diffScope` for caller-side logging) that the CLI feeds into
 * `writer.write({ ..., prior, epsilon, scope })`.
 *
 * Returns a flat record so each CLI can spread it into the writer call.
 *
 * @param {{
 *   kind: 'maintainability' | 'crap',
 *   absBaselinePath: string,
 *   epsilon: number,
 *   argv?: string[],
 *   cwd?: string,
 *   logger?: { info?: (msg: string) => void },
 *   logTag: string,
 * }} args
 * @returns {{
 *   prior: Array<object> | undefined,
 *   epsilon: number | undefined,
 *   scope: {mode: 'diff', files: Set<string>} | undefined,
 *   diffScope: {ref: string, files: Set<string>, scope: object} | null,
 * }}
 */
export function buildWriterScopeArgs({
  kind,
  absBaselinePath,
  epsilon,
  argv = process.argv.slice(2),
  cwd,
  logger,
  logTag,
}) {
  const prior = readPriorBaselineRows({ kind, absBaselinePath });
  const diffScope = resolveDiffScope({ argv, cwd });
  if (diffScope && logger?.info) {
    logger.info(
      `${logTag} --diff-scope ${diffScope.ref}: ${diffScope.files.size} file(s) in scope; out-of-scope rows preserved verbatim.`,
    );
  }
  return {
    prior: prior ?? undefined,
    epsilon: prior ? epsilon : undefined,
    scope: diffScope?.scope,
    diffScope,
  };
}
