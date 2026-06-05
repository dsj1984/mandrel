import { createGitInterface } from './git-utils.js';

/**
 * Parse the stdout from `git diff --name-only` into a normalized file list.
 * Trims whitespace, drops blank lines, and converts backslash separators to
 * forward slashes so set-membership checks line up with the paths produced by
 * `scanAndScore` and `calculateAll` on Windows checkouts.
 *
 * Pure; no I/O.
 *
 * @param {string | null | undefined} stdout
 * @returns {string[]}
 */
export function parseNameOnlyStdout(stdout) {
  if (!stdout) return [];
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\\/g, '/'));
}

/**
 * Low-level helper: run `git diff --name-only <range>` and return the
 * forward-slash-normalised file list. Throws on non-zero git exit so callers
 * that must fail-closed can propagate the error; callers that prefer
 * best-effort behaviour wrap this in a try/catch.
 *
 * Accepts either a pre-built `range` string **or** `baseRef`+`headRef`
 * (assembled into `<baseRef>...<headRef>` when `threeDot` is true, or
 * `<baseRef>..<headRef>` otherwise). When both `range` and
 * `baseRef`/`headRef` are supplied, `range` takes precedence.
 *
 * The `gitSpawn` injection matches the signature used by `createGitInterface`:
 * `(cwd: string, ...gitArgs: string[]) => { status: number, stdout: string, stderr: string }`.
 * Production callers omit it (the default uses `createGitInterface({})`);
 * tests pass a stub.
 *
 * @param {object} params
 * @param {string} [params.range]         Pre-built range string (e.g. `"epic/3599...story-3636"`).
 * @param {string} [params.baseRef]       Left-hand ref — used when `range` is absent.
 * @param {string} [params.headRef='HEAD'] Right-hand ref — used when `range` is absent.
 * @param {boolean} [params.threeDot=true] Use three-dot (`...`) merge-base semantics
 *   when `range` is absent. Set to `false` for a two-dot direct diff.
 * @param {string} [params.cwd=process.cwd()]
 * @param {((cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string }) | null} [params.gitSpawn]
 * @returns {string[]} Forward-slash-normalised repo-relative paths.
 * @throws {Error} When git exits non-zero.
 */
export function diffNameOnly({
  range,
  baseRef,
  headRef = 'HEAD',
  threeDot = true,
  cwd = process.cwd(),
  gitSpawn,
} = {}) {
  const resolvedRange =
    range ?? `${baseRef}${threeDot ? '...' : '..'}${headRef}`;
  const spawnFn = gitSpawn ?? createGitInterface({}).gitSpawn;
  const res = spawnFn(cwd, 'diff', '--name-only', resolvedRange);
  if (res.status !== 0) {
    const detail = res.stderr || res.stdout || `exit ${res.status}`;
    throw new Error(
      `[diff-name-only] git diff --name-only ${resolvedRange} failed: ${detail}`,
    );
  }
  return parseNameOnlyStdout(res.stdout);
}

/**
 * Resolve the list of files changed since `ref` relative to the current HEAD.
 *
 * Used by `check-crap.js` and `check-maintainability.js` to implement the
 * `--changed-since <ref>` diff-scoped mode — the quality gates limit both
 * scoring and comparison to this file set so the pre-push / PR CI feedback
 * loop stays fast on large consumer repos.
 *
 * Semantics:
 *   - Runs `git diff --name-only <ref>...HEAD` so the comparison is against
 *     the merge-base (three-dot range). This matches how GitHub computes the
 *     "files changed" view for a PR and deliberately excludes anything that
 *     was merged into the base branch after the PR branched off.
 *   - Returns relative paths with forward-slash separators so set-membership
 *     checks line up with the normalized paths produced by `scanAndScore` and
 *     `calculateAll` on Windows checkouts.
 *   - A non-zero git exit is surfaced as a thrown Error — `--changed-since`
 *     must **never** silently degrade to "no regressions found"; that is the
 *     entire reason the CLIs fail closed on a bad ref.
 *
 * @param {object} [params]
 * @param {string} [params.ref='main']         The ref to diff against.
 * @param {string} [params.cwd=process.cwd()]  Repo working directory.
 * @param {ReturnType<typeof createGitInterface>} [params.git] Injected git
 *   interface — production callers omit this; tests pass a mock.
 * @returns {string[]} Relative, forward-slash-normalized file paths. Order is
 *   whatever `git diff --name-only` produces (stable per invocation).
 * @throws {Error} When git exits non-zero (unresolvable ref, corrupt repo,
 *   etc.). The error message names the ref so the operator can react without
 *   re-reading the CLI flags.
 */
export function getChangedFiles({
  ref = 'main',
  cwd = process.cwd(),
  git,
} = {}) {
  const gitIface = git ?? createGitInterface({});
  const res = gitIface.gitSpawn(cwd, 'diff', '--name-only', `${ref}...HEAD`);
  if (res.status !== 0) {
    const detail = res.stderr || res.stdout || `exit ${res.status}`;
    throw new Error(
      `[changed-since] unable to resolve ref "${ref}": ${detail}`,
    );
  }
  return parseNameOnlyStdout(res.stdout);
}

/**
 * Resolve paths in the index (staged for commit). Used by `quality-preview
 * --staged` so pre-commit gates score only the commit payload, not unstaged
 * working-tree edits.
 *
 * Semantics:
 *   - Runs `git diff --name-only --cached`.
 *   - Returns forward-slash-normalized repo-relative paths.
 *   - Non-zero git exit throws — staged mode must not silently widen scope.
 *
 * @param {object} [params]
 * @param {string} [params.cwd=process.cwd()]
 * @param {ReturnType<typeof createGitInterface>} [params.git]
 * @returns {string[]}
 */
export function getStagedFiles({ cwd = process.cwd(), git } = {}) {
  const gitIface = git ?? createGitInterface({});
  const res = gitIface.gitSpawn(cwd, 'diff', '--name-only', '--cached');
  if (res.status !== 0) {
    const detail = res.stderr || res.stdout || `exit ${res.status}`;
    throw new Error(`[staged] unable to read cached diff: ${detail}`);
  }
  return parseNameOnlyStdout(res.stdout);
}

/**
 * Resolve the file set for quality-preview runners.
 *
 * When `staged` is true, only index paths are returned and `changedSinceRef`
 * is ignored. Otherwise a `changedSinceRef` limits to that three-dot diff;
 * when both are absent the caller runs in full-repo mode (`scopeSet: null`).
 *
 * @param {object} [params]
 * @param {boolean} [params.staged=false]
 * @param {string | null} [params.changedSinceRef=null]
 * @param {string} [params.cwd=process.cwd()]
 * @param {ReturnType<typeof createGitInterface>} [params.git]
 * @returns {{
 *   scopeSet: Set<string> | null,
 *   scope: 'staged' | 'diff' | 'full',
 *   diffRef: string | null,
 * }}
 */
export function resolvePreviewScope({
  staged = false,
  changedSinceRef = null,
  cwd = process.cwd(),
  git,
} = {}) {
  if (staged) {
    const files = getStagedFiles({ cwd, git });
    return { scopeSet: new Set(files), scope: 'staged', diffRef: null };
  }
  if (changedSinceRef) {
    try {
      const files = getChangedFiles({ ref: changedSinceRef, cwd, git });
      return {
        scopeSet: new Set(files),
        scope: 'diff',
        diffRef: changedSinceRef,
      };
    } catch {
      return { scopeSet: new Set(), scope: 'diff', diffRef: changedSinceRef };
    }
  }
  return { scopeSet: null, scope: 'full', diffRef: null };
}
