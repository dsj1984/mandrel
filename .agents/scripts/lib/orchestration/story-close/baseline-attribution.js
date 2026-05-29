/**
 * baseline-attribution.js — diff-based attribution of baseline regressions.
 *
 * Story #1124 (Tech Spec #902, "s-baseline-refresh-discipline") closes a
 * subtle race in the post-#1120 worktree-local close path: when a Story's
 * close run trips a baseline gate (maintainability, crap, etc.) the failing
 * regression rows may include paths the Story never touched — drift carried
 * in from a sibling Story that already merged into `epic/<id>` between this
 * Story's branch cut and its close attempt. Auto-refreshing those baselines
 * here would silently absorb the sibling's debt onto this Story's PR and
 * destroy the audit trail. Doing nothing locks the close behind drift the
 * operator did not cause.
 *
 * The split this module computes is:
 *
 *   - `attributable`    — regressions on paths intersecting the Story's diff
 *                         vs `epic/<id>`. Safe to auto-refresh on the Story
 *                         branch as `baseline-refresh: ...`.
 *   - `nonAttributable` — regressions on paths the Story never touched. Each
 *                         row is annotated with the most recent commit on
 *                         `epic/<id>` that touched the path (`suspectSha`)
 *                         and the `(resolves #N)` token parsed out of that
 *                         commit subject (`suspectStoryNumber`, may be null).
 *                         The caller surfaces these as friction so the
 *                         operator can route the refresh back to the sibling
 *                         that caused the drift.
 *
 * The classifier itself does no IO when every regression is attributable —
 * the `git log` lookup runs only on non-attributable rows so the hot path
 * (the common case where the operator's Story is the sole writer) costs
 * one `Set` membership check per row.
 */

import { gitSpawn as defaultGitSpawn } from '../../git-utils.js';
import { parseResolvesStoryId } from '../resolves-token.js';

/**
 * Normalize a path for set-based intersection. `git diff --name-only`
 * returns POSIX paths on every OS, but a caller passing
 * `storyDiffPaths` from a Windows tooling boundary may have `\` in the
 * path. Round both sides through `/` so the intersection is honest.
 */
function normalize(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

/**
 * Look up the most recent commit on `epicRef` that touched `path` and
 * extract the `(resolves #N)` trailer if present. Returns
 * `{ suspectSha, suspectStoryNumber }`; either field may be `null` when
 * the lookup yields no commit (e.g. file added on this branch but
 * still flagged as a regression by the gate against a stale baseline)
 * or the most recent commit subject does not carry the trailer.
 *
 * Failure of the spawn is treated as "no information" — the caller
 * still surfaces the row as non-attributable, just without a suspect.
 */
function lookupSuspect({ gitRunner, cwd, epicRef, path }) {
  const res = gitRunner.gitSpawn(
    cwd,
    'log',
    '--oneline',
    '-n',
    '1',
    epicRef,
    '--',
    path,
  );
  if (res.status !== 0) {
    return { suspectSha: null, suspectStoryNumber: null };
  }
  const line = (res.stdout || '').split('\n')[0]?.trim() ?? '';
  if (!line) return { suspectSha: null, suspectStoryNumber: null };

  // `--oneline` format is `<short-sha> <subject…>`; split on the first
  // run of whitespace so multi-space subjects survive.
  const sepIdx = line.search(/\s/);
  const suspectSha = sepIdx === -1 ? line : line.slice(0, sepIdx);
  const subject = sepIdx === -1 ? '' : line.slice(sepIdx + 1);
  const suspectStoryNumber = parseResolvesStoryId(subject);
  return { suspectSha: suspectSha || null, suspectStoryNumber };
}

/**
 * Classify the supplied baseline regressions into rows the running Story
 * should auto-refresh vs rows it should surface as friction.
 *
 * @param {object} opts
 * @param {Array<{ path?: string, file?: string }>} opts.regressions
 *   Regression rows from a baseline gate. Either `path` or `file` is read
 *   for the file key — different gate emitters use different names and
 *   normalizing them here keeps the wiring at the call site trivial.
 * @param {Iterable<string>} opts.storyDiffPaths
 *   Repo-relative paths the Story branch changed vs `epic/<id>` (typically
 *   the output of `git diff --name-only origin/<epicBranch>...storyBranch`).
 * @param {string} opts.epicRef Git ref the suspect lookup walks (e.g.
 *   `origin/epic/1114` or `epic/1114`).
 * @param {string} [opts.cwd] CWD for `git log`. Defaults to `process.cwd()`.
 * @param {{ gitSpawn: typeof defaultGitSpawn }} [opts.gitRunner]
 *   Injected git seam. Tests pass a fake recorder.
 * @returns {{
 *   attributable: Array<{ path: string }>,
 *   nonAttributable: Array<{
 *     path: string,
 *     suspectSha: string|null,
 *     suspectStoryNumber: number|null,
 *   }>,
 * }}
 */
export function classifyBaselineDrift({
  regressions,
  storyDiffPaths,
  epicRef,
  cwd,
  gitRunner,
} = {}) {
  const rows = Array.isArray(regressions) ? regressions : [];
  const touched = new Set(
    Array.from(storyDiffPaths ?? [], normalize).filter(Boolean),
  );

  const attributable = [];
  const nonAttributable = [];

  // Defer git seam construction until at least one non-attributable row
  // appears — the all-attributable hot path costs zero spawns.
  let runner = null;
  const ensureRunner = () => {
    if (runner) return runner;
    runner = gitRunner ?? { gitSpawn: defaultGitSpawn };
    return runner;
  };
  const lookupCwd =
    cwd ?? (typeof process !== 'undefined' ? process.cwd() : '.');

  for (const row of rows) {
    const rawPath = row?.path ?? row?.file;
    if (typeof rawPath !== 'string' || rawPath.length === 0) continue;
    const p = normalize(rawPath);
    if (touched.has(p)) {
      attributable.push({ ...row, path: p });
      continue;
    }
    const suspect = epicRef
      ? lookupSuspect({
          gitRunner: ensureRunner(),
          cwd: lookupCwd,
          epicRef,
          path: p,
        })
      : { suspectSha: null, suspectStoryNumber: null };
    nonAttributable.push({
      ...row,
      path: p,
      suspectSha: suspect.suspectSha,
      suspectStoryNumber: suspect.suspectStoryNumber,
    });
  }

  return { attributable, nonAttributable };
}
