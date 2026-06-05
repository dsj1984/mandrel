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
import { parseNameOnlyStdout } from '../changed-files.js';

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
  return new Set(parseNameOnlyStdout(res.stdout));
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
 * Read + parse the prior baseline at `absBaselinePath` and return the
 * canonical `rows[]` array (per-kind row shape with `path:` keys, as
 * expected by the per-kind `mergeRows` / `applyEpsilon` helpers from
 * Story #1974). Returns `null` when the file is absent, malformed, or
 * missing a `rows[]` envelope; the caller treats `null` as "skip the
 * merge" (regression-fail-safe — equivalent to a fresh write).
 *
 * Pure-by-design (file I/O through the injected `fsImpl` seam).
 *
 * @param {{ kind: 'maintainability' | 'crap', absBaselinePath: string, fsImpl?: typeof fs }} args
 * @returns {Array<object> | null}
 */
// Read + JSON-parse a baseline file. Returns `null` on any I/O or parse
// failure (the caller treats "no prior" the same as "unreadable prior").
function readBaselineJson(absBaselinePath, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(absBaselinePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// CRAP path: envelope `rows[]` only; rows already carry canonical `path:`.
function readCrapPriorRows(parsed) {
  if (!Array.isArray(parsed.rows)) return null;
  return parsed.rows;
}

// Maintainability path: envelope `rows[]` only; rows already carry
// canonical `path:` + `mi:`.
function readMaintainabilityPriorRows(parsed) {
  if (!Array.isArray(parsed.rows)) return null;
  return parsed.rows.filter(
    (r) => r && typeof r.path === 'string' && typeof r.mi === 'number',
  );
}

export function readPriorBaselineRows({ kind, absBaselinePath, fsImpl = fs }) {
  const parsed = readBaselineJson(absBaselinePath, fsImpl);
  if (!parsed) return null;
  if (kind === 'crap') return readCrapPriorRows(parsed);
  return readMaintainabilityPriorRows(parsed);
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
