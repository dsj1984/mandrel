import { createGitInterface } from './git-utils.js';

/**
 * The single rule for the ref a pre-push step diffs against: a named ref
 * wins, then `crap.incrementalCoverage.baseRef`, then `main`. The named ref
 * must win so coverage capture and the CRAP preview score the same change
 * set. Every consumer routes through here rather than reading `baseRef`.
 *
 * @param {{ crap: object, ref: string | null | undefined }} opts
 * @returns {string}
 */
export function resolveChangedFilesRef({ crap, ref }) {
  return ref ?? crap?.incrementalCoverage?.baseRef ?? 'main';
}

/**
 * Forward-slash separators so set membership matches scorer paths on Windows.
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
 * `git diff --name-only`; `range` wins over `baseRef`/`headRef`.
 *
 * @param {object} params
 * @param {string} [params.range]
 * @param {string} [params.baseRef]
 * @param {string} [params.headRef='HEAD']
 * @param {boolean} [params.threeDot=true] Merge-base (`...`) semantics.
 * @param {string} [params.cwd=process.cwd()]
 * @param {((cwd: string, ...args: string[]) => { status: number, stdout: string, stderr: string }) | null} [params.gitSpawn]
 * @returns {string[]}
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
 * Files changed on `ref...HEAD` (merge-base, like a PR's "files changed").
 * Throws on a bad ref: `--changed-since` must never degrade to "no
 * regressions found".
 *
 * @param {object} [params]
 * @param {string} [params.ref='main']
 * @param {string} [params.cwd=process.cwd()]
 * @param {ReturnType<typeof createGitInterface>} [params.git]
 * @returns {string[]}
 * @throws {Error} When git exits non-zero.
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

/** A full object id; rejects canned stub output posing as a merge head. */
const OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The commit an in-progress merge is merging in, or `null`. During a merge
 * `HEAD` is the pre-merge tip, so a plain `--cached` diff would pull the base
 * branch's landed work into the staged scope.
 *
 * Ask git, never the filesystem: in a linked worktree `.git` is a file. An
 * octopus `MERGE_HEAD` fails `--verify` and yields `null` (wider scope is
 * safe; wrongly narrower would hide a regression). Never throws.
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
 * Staged paths. During a merge the index is diffed against `MERGE_HEAD`, not
 * the merge-base (which would re-admit everything the base landed since the
 * fork). Throws on git failure rather than widen scope.
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
 * `staged` wins over `changedSinceRef`; neither means full scope. In staged
 * scope `diffRef` is the merge head, if any.
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
