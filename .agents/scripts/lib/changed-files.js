import { createGitInterface } from './git-utils.js';

/**
 * Resolve the ONE git ref a step of the pre-push chain computes its
 * changed-file set against — the whole rule, stated once (Story #5365).
 *
 * **A ref the caller named wins; `crap.incrementalCoverage.baseRef` is the
 * default for a caller that named none, and `main` the default for neither.**
 * `.husky/pre-push` captures coverage at `--ref origin/main` and then previews
 * CRAP at `--changed-since origin/main`, and the preview only reads its own
 * tree when the artifact under it was captured over the same change set.
 * Letting the configured value outrank the named ref meant a consumer that set
 * `baseRef` captured one scope while the preview scored another — precisely
 * the stale-artifact read the capture-before-preview ordering (Story #5356)
 * closed. This repository sets no `baseRef`, so that divergence was invisible
 * locally and only a consumer who configured one would have paid for it.
 *
 * Callers that name no ref — the close-validation gate, whose argv carries no
 * `--ref` — still get the configured value, so the key keeps the meaning it
 * was added with.
 *
 * Every step that derives that change set calls this: both `coverage-capture`
 * paths and the preview's CRAP baseline join. A new consumer routes through it
 * rather than reading `baseRef` itself.
 *
 * @param {{ crap: object, ref: string | null | undefined }} opts
 * @returns {string}
 */
export function resolveChangedFilesRef({ crap, ref }) {
  return ref ?? crap?.incrementalCoverage?.baseRef ?? 'main';
}

/**
 * Parse the stdout from `git diff --name-only` into a normalized file list.
 * Trims whitespace, drops blank lines, and converts backslash separators to
 * forward slashes so set-membership checks line up with the paths produced by
 * `scanAndScore` and `calculateAll` on Windows checkouts.
 *
 * Pure; no I/O.
 *
 * Module-private since Story #4944. It was exported for
 * `diff-scope-cli.js#resolveDiffScopeFiles`, which the duplication-CLI
 * migration deleted; the three remaining callers all live in this file, so
 * exporting it now would ship a seam only the tests reach. Its behaviour is
 * covered through `diffNameOnly`, which returns this function's output
 * verbatim.
 *
 * @param {string | null | undefined} stdout
 * @returns {string[]}
 */
function parseNameOnlyStdout(stdout) {
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
 * A full-length hex object id, as `git rev-parse` prints it. Used to reject
 * anything that is not a resolved commit — a stubbed git interface in a test
 * answers every `gitSpawn` with the same canned stdout, and a file list must
 * never be mistaken for a merge head.
 */
const OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Resolve the commit an in-progress merge is merging **in**, or `null` when no
 * merge is in progress.
 *
 * Story #5131. `git diff --cached` with no commit argument diffs the index
 * against `HEAD`, and during a merge `HEAD` is still the pre-merge tip — so a
 * base-sync merge commit (`git merge --no-edit origin/<base>`, which
 * `single-story-close`'s base-sync phase tells the operator to run by hand)
 * put every file the base branch had landed into the staged scope. The
 * pre-commit MI/CRAP gate then blocked the resolution commit for deltas
 * belonging to already-landed, already-gated work, with no remedy: the preview
 * is a delta against the baseline, not a baseline comparison, so no baseline
 * refresh could silence it.
 *
 * Two details are load-bearing:
 *
 *   - **Ask git, never the filesystem.** `.git` is a *file*, not a directory,
 *     in the linked worktrees this repo delivers from, so an
 *     `existsSync('.git/MERGE_HEAD')` probe would be silently inert exactly
 *     where deliveries happen. `rev-parse --verify` resolves the ref through
 *     git's own worktree-aware lookup.
 *   - **`--verify` fails closed on an octopus merge.** It refuses a
 *     `MERGE_HEAD` naming more than one head, which lands here as `null` — the
 *     pre-#5131 behaviour. Narrowing the scope wrongly would hide a real
 *     regression; widening it only restores the status quo.
 *
 * Never throws: a merge is either detectable or it is not, and an
 * undetectable one must degrade to the plain cached diff rather than fail the
 * gate.
 *
 * @param {object} [params]
 * @param {string} [params.cwd=process.cwd()]
 * @param {ReturnType<typeof createGitInterface>} [params.git]
 * @returns {string | null} The merge head's object id, or `null`.
 */
export function resolveMergeHead({ cwd = process.cwd(), git } = {}) {
  const gitIface = git ?? createGitInterface({});
  let res;
  try {
    res = gitIface.gitSpawn(cwd, 'rev-parse', '-q', '--verify', 'MERGE_HEAD');
  } catch {
    return null;
  }
  if (res?.status !== 0) return null;
  const sha = (res.stdout ?? '').trim();
  return OBJECT_ID_RE.test(sha) ? sha : null;
}

/**
 * Read the index file list against an explicit base, shared by
 * `getStagedFiles` and `resolvePreviewScope` so the merge head is resolved
 * once per scope resolution rather than once per caller.
 *
 * @param {object} params
 * @param {string} params.cwd
 * @param {ReturnType<typeof createGitInterface>} params.git
 * @param {string | null} params.mergeHead
 * @returns {string[]}
 */
function stagedFilesAgainst({ cwd, git, mergeHead }) {
  const args = ['diff', '--name-only', '--cached'];
  if (mergeHead) args.push(mergeHead);
  const res = git.gitSpawn(cwd, ...args);
  if (res.status !== 0) {
    const detail = res.stderr || res.stdout || `exit ${res.status}`;
    throw new Error(`[staged] unable to read cached diff: ${detail}`);
  }
  return parseNameOnlyStdout(res.stdout);
}

/**
 * Resolve paths in the index (staged for commit). Used by `quality-preview
 * --staged` so pre-commit gates score only the commit payload, not unstaged
 * working-tree edits.
 *
 * Semantics:
 *   - Runs `git diff --name-only --cached`, which diffs the index against
 *     `HEAD`.
 *   - **During a merge**, diffs the index against `MERGE_HEAD` instead
 *     (Story #5131), so the scope is the merging branch's own contribution
 *     plus its conflict resolutions — not the base branch's incoming work.
 *     `git merge-base HEAD MERGE_HEAD` would *not* do: diffing the index
 *     against the fork point re-admits everything the base branch landed since
 *     it, which is the whole defect.
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
  return stagedFilesAgainst({
    cwd,
    git: gitIface,
    mergeHead: resolveMergeHead({ cwd, git: gitIface }),
  });
}

/**
 * Resolve the file set for quality-preview runners.
 *
 * When `staged` is true, only index paths are returned and `changedSinceRef`
 * is ignored. Otherwise a `changedSinceRef` limits to that three-dot diff;
 * when both are absent the caller runs in full-repo mode (`scopeSet: null`).
 *
 * In `staged` scope, `diffRef` carries the in-progress merge head when there
 * is one (Story #5131) and `null` otherwise, so a caller can tell the operator
 * *why* the scope narrowed. `scope` stays `'staged'` either way — the merge is
 * a property of the base the index is read against, not a different mode.
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
    const gitIface = git ?? createGitInterface({});
    const mergeHead = resolveMergeHead({ cwd, git: gitIface });
    const files = stagedFilesAgainst({ cwd, git: gitIface, mergeHead });
    return { scopeSet: new Set(files), scope: 'staged', diffRef: mergeHead };
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
