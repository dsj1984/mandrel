import { createGitInterface } from './git-utils.js';

/**
 * `main` → `origin/main`; already-qualified input passes through.
 *
 * @param {unknown} baseBranch
 * @returns {string|null} the remote-tracking ref, or `null` when unnameable.
 */
export function remoteBaseRef(baseBranch) {
  const base = trimmedName(baseBranch);
  return base ? base.replace(/^(?!origin\/)/, 'origin/') : null;
}

function trimmedName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The single rule for the ref a pre-push step diffs against: a named ref
 * wins, then `crap.incrementalCoverage.baseRef`, then `origin/<baseBranch>`
 * (never the bare local base, which may trail the remote and widen the set).
 * Pure: no git call. Every consumer routes through here.
 *
 * @param {{ crap: object, ref: string | null | undefined, baseBranch?: string }} opts
 * @returns {string}
 */
export function resolveChangedFilesRef({ crap, ref, baseBranch }) {
  return (
    ref ??
    crap?.incrementalCoverage?.baseRef ??
    remoteBaseRef(baseBranch) ??
    'origin/main'
  );
}

/**
 * {@link resolveChangedFilesRef} plus a probe of the default only. An
 * unresolvable `origin/<base>` falls back to the local base: its three-dot
 * diff is never narrower than the Story's, so no gate is lost.
 *
 * @param {{ crap: object, ref?: string | null, baseBranch?: string, cwd?: string, gitSpawnFn?: Function }} opts
 * @returns {{ ref: string, source: 'flag' | 'config' | 'remote' | 'local-fallback', unresolved?: string }}
 */
export function resolveCaptureBaseRef({
  crap,
  ref,
  baseBranch,
  cwd = process.cwd(),
  gitSpawnFn = createGitInterface({}).gitSpawn,
}) {
  const named = namedRef(crap, ref);
  if (named) return named;
  const remote = resolveChangedFilesRef({ crap: null, ref: null, baseBranch });
  return refResolves(gitSpawnFn, cwd, remote)
    ? { ref: remote, source: 'remote' }
    : localFallback(remote);
}

function localFallback(remote) {
  const ref = remote.slice('origin/'.length);
  return { ref, source: 'local-fallback', unresolved: remote };
}

function namedRef(crap, ref) {
  if (ref != null) return { ref, source: 'flag' };
  const configured = crap?.incrementalCoverage?.baseRef;
  return configured == null ? null : { ref: configured, source: 'config' };
}

/** A spawn failure means the same as a missing ref. */
function refResolves(spawnFn, cwd, ref) {
  try {
    const args = ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`];
    return spawnFn(cwd, ...args)?.status === 0;
  } catch {
    return false;
  }
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
