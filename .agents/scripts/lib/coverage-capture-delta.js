/**
 * Delta refresh for `captureScope: "affected"`: after a base-sync merges main
 * commits that share no file with the Story, re-measure only those commits'
 * tests instead of re-running the Story's whole affected scope. Every
 * uncertainty fails closed to an ordinary capture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { captureStampPath, computeContentDigest } from './coverage-capture.js';
import { gitSpawn } from './git-utils.js';

/** Basenames whose change moves coverage beyond the files it names. */
const COVERAGE_CONFIG_RE =
  /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|tsconfig.*\.json|(vitest|vite|jest|nyc)\.(config|workspace)\.[cm]?[jt]s|\.c8rc.*|\.nycrc.*)$/;

/** @param {string} file @returns {boolean} */
export function isCoverageConfigFile(file) {
  return COVERAGE_CONFIG_RE.test(path.posix.basename(String(file)));
}

/** A spawn failure reads as a non-zero status, which callers treat as "unknown". */
function git(cwd, args, spawn) {
  const res = spawn(cwd, ...args);
  return { status: res?.status ?? 1, stdout: res?.stdout ?? '' };
}

/** @returns {string | null} The HEAD sha, or `null` when unavailable. */
export function readHeadCommit(cwd, io = {}) {
  const res = git(cwd, ['rev-parse', 'HEAD'], io.gitSpawn ?? gitSpawn);
  const sha = res?.status === 0 ? res.stdout.trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** @returns {Record<string, unknown> | null} */
function readCaptureStamp(cwd, coveragePath, io = {}) {
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  try {
    const stamp = JSON.parse(
      readFileSync(captureStampPath(cwd, coveragePath), 'utf8'),
    );
    return stamp && typeof stamp === 'object' ? stamp : null;
  } catch {
    return null;
  }
}

/** A stamp without `scope` is full-scope; no stamp at all is `none`. */
function stampScopeOf(stamp) {
  if (!stamp) return 'none';
  return typeof stamp.scope === 'string' ? stamp.scope : 'full';
}

/** The suffix every freshness log line carries, so staleness is explainable from the log. */
export function formatFreshnessDetail({
  stamp,
  requiredScope,
  verdict,
  deltaFiles,
}) {
  const delta =
    typeof deltaFiles === 'number' ? `, delta: ${deltaFiles} file(s)` : '';
  return `(stamp scope: ${stampScopeOf(stamp)}, required scope: ${requiredScope}, verdict: ${verdict}${delta})`;
}

/** {@link formatFreshnessDetail} for the stamp on disk. */
export function describeStampFreshness({
  cwd,
  coveragePath,
  requiredScope,
  verdict,
}) {
  return formatFreshnessDetail({
    stamp: readCaptureStamp(cwd, coveragePath),
    requiredScope,
    verdict,
  });
}

/** A dirty file is in no git delta, so a dirty tree is ineligible. */
function treeIneligibility({ cwd, commit, spawn }) {
  if (typeof commit !== 'string' || commit.length === 0) {
    return 'stamp records no commit';
  }
  const status = git(cwd, ['status', '--porcelain'], spawn);
  if (status?.status !== 0) return 'git status failed';
  if (status.stdout.trim().length > 0) return 'worktree is dirty';
  const ancestor = git(
    cwd,
    ['merge-base', '--is-ancestor', commit, 'HEAD'],
    spawn,
  );
  if (ancestor?.status !== 0)
    return 'stamped commit is not an ancestor of HEAD';
  return null;
}

function deltaIneligibility({ delta, storyFiles }) {
  if (delta.length === 0) return 'no committed delta since the stamp';
  const story = new Set(storyFiles);
  const shared = delta.find((f) => story.has(f));
  if (shared) return `delta shares ${shared} with the Story's change set`;
  const config = delta.find(isCoverageConfigFile);
  if (config) return `delta touches coverage-determining config ${config}`;
  return null;
}

function parseNames(stdout) {
  return stdout
    .split('\n')
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter((l) => l.length > 0);
}

/** Any git error or unresolvable input is ineligible. */
function classifyDeltaRefresh({
  cwd,
  crap,
  storyFiles,
  prior,
  gitSpawnImpl: spawn = gitSpawn,
  readFileSync = fs.readFileSync,
  computeContentDigestImpl = computeContentDigest,
}) {
  const stamp = readCaptureStamp(cwd, crap.coveragePath, { readFileSync });
  const no = (reason) => ({ eligible: false, reason, stamp });
  if (typeof stamp?.digest !== 'string') return no('no digest stamp');
  const current = computeContentDigestImpl(cwd, crap.targetDirs);
  if (!current || current === stamp.digest) return no('not stale by digest');
  if (!Array.isArray(storyFiles)) return no('Story change set unreadable');
  if (!prior) return no('no prior artifact to merge over');
  const commit = stamp.commit;
  const treeReason = treeIneligibility({ cwd, commit, spawn });
  if (treeReason) return no(treeReason);
  const diff = git(cwd, ['diff', '--name-only', commit, 'HEAD'], spawn);
  if (diff?.status !== 0) return no('git diff failed');
  const delta = parseNames(diff.stdout);
  const deltaReason = deltaIneligibility({ delta, storyFiles });
  if (deltaReason) return no(deltaReason);
  return { eligible: true, commit, delta, stamp };
}

/**
 * A stale stamp whose staleness is wholly main's delta is re-measured keyed
 * on the stamped commit; `null` means capture the Story's scope as usual.
 *
 * @returns {{ baseRef: string, dropFiles: string[] } | null}
 */
export function planDeltaRefresh({
  freshness,
  crap,
  args,
  changed,
  prior,
  classifyDeltaRefreshImpl = classifyDeltaRefresh,
  logger,
}) {
  if (freshness.reason !== 'stale') return null;
  const plan = classifyDeltaRefreshImpl({
    cwd: args.cwd,
    crap,
    storyFiles: changed,
    prior,
  });
  if (!plan.eligible) {
    logger.info(
      `[coverage-capture] Affected mode: delta refresh not eligible (${plan.reason}) — capturing the Story's affected scope.`,
    );
    return null;
  }
  const detail = formatFreshnessDetail({
    stamp: plan.stamp,
    requiredScope: 'affected',
    verdict: 'delta-refresh',
    deltaFiles: plan.delta.length,
  });
  logger.info(
    `[coverage-capture] Coverage at ${crap.coveragePath} needs a delta refresh — re-measuring ${plan.delta.length} file(s) changed since ${plan.commit.slice(0, 12)}. ${detail}`,
  );
  return { baseRef: plan.commit, dropFiles: plan.delta };
}
