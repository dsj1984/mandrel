/**
 * Delta refresh for `captureScope: "affected"`: after a base-sync merges main
 * commits that share no file with the Story, re-measure only those commits'
 * tests instead of re-running the Story's whole affected scope. Every
 * uncertainty fails closed to an ordinary capture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getQuality } from './config/quality.js';
import {
  captureStampPath,
  computeContentDigest,
  computeTreeDigest,
  filterSuiteInputPaths,
  stampIsStale,
} from './coverage-capture.js';
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

/**
 * The tree a capture is about to measure, taken before the spawn: what
 * `stampCapturedTree` records — both digests and the HEAD commit.
 *
 * @param {{ cwd: string, crap: { targetDirs: string[], coveragePath: string }, computeContentDigestImpl: typeof computeContentDigest, readHeadCommitImpl?: typeof readHeadCommit }} opts
 * @returns {{ preDigest: string | null, preTreeDigest: string | null, commit: string | null }}
 */
export function snapshotCapturedTree({
  cwd,
  crap,
  computeContentDigestImpl,
  readHeadCommitImpl = readHeadCommit,
}) {
  return {
    preDigest: computeContentDigestImpl(cwd, crap.targetDirs),
    preTreeDigest: computeTreeDigest(cwd, crap.coveragePath),
    commit: readHeadCommitImpl(cwd),
  };
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

function overlapReason(suite, storyFiles, coveragePath) {
  const story = new Set(filterSuiteInputPaths(storyFiles, coveragePath));
  const shared = suite.find((f) => story.has(f));
  if (shared) return `delta shares ${shared} with the Story's change set`;
  const config = suite.find(isCoverageConfigFile);
  return config ? `delta touches coverage-determining config ${config}` : null;
}

function emptinessReason(delta, suite) {
  if (delta.length === 0) return 'no committed delta since the stamp';
  return suite.length === 0 ? 'delta has no suite-input path' : null;
}

/**
 * Shared with close's `test` delta re-credit. Only suite inputs count, so
 * baseline and coverage-directory paths never overlap.
 *
 * @returns {{ reason: string | null, delta: string[], dropped: number }}
 */
export function deltaIneligibility({ delta, storyFiles, coveragePath }) {
  const suite = filterSuiteInputPaths(delta, coveragePath);
  const reason =
    emptinessReason(delta, suite) ??
    overlapReason(suite, storyFiles, coveragePath);
  return { reason, delta: suite, dropped: delta.length - suite.length };
}

/** The rule's reason for close, on the configured coverage path. */
export function closeDeltaIneligibility({ delta, storyFiles, config }) {
  const coveragePath = getQuality(config)?.crap?.coveragePath;
  return deltaIneligibility({ delta, storyFiles, coveragePath }).reason;
}

function droppedSuffix(dropped) {
  return dropped > 0 ? `, ${dropped} non-suite-input path(s) dropped` : '';
}

function parseNames(stdout) {
  return stdout
    .split('\n')
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter((l) => l.length > 0);
}

/** Stale by the freshness probe's own predicate; no digest is never stale. */
function stampStale({ stamp, cwd, crap, computeContentDigestImpl }) {
  const current = computeContentDigestImpl(cwd, crap.targetDirs);
  if (!current) return false;
  return stampIsStale({ stamp, current, cwd, coveragePath: crap.coveragePath });
}

/** Main's committed delta since the stamp, judged by the shared rule. */
function classifyCommittedDelta({ cwd, crap, storyFiles, stamp, spawn }) {
  const { commit } = stamp;
  const no = (reason, rule) => ({ eligible: false, reason, stamp, rule });
  const diff = git(cwd, ['diff', '--name-only', commit, 'HEAD'], spawn);
  if (diff?.status !== 0) return no('git diff failed');
  const rule = deltaIneligibility({
    delta: parseNames(diff.stdout),
    storyFiles,
    coveragePath: crap.coveragePath,
  });
  const restamp = rule.delta.length === 0 && rule.dropped > 0;
  if (rule.reason && !restamp) return no(rule.reason, rule);
  return { eligible: true, restamp, commit, rule, stamp };
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
  if (!stampStale({ stamp, cwd, crap, computeContentDigestImpl }))
    return no('not stale by digest');
  if (!Array.isArray(storyFiles)) return no('Story change set unreadable');
  if (!prior) return no('no prior artifact to merge over');
  const treeReason = treeIneligibility({ cwd, commit: stamp.commit, spawn });
  if (treeReason) return no(treeReason);
  return classifyCommittedDelta({ cwd, crap, storyFiles, stamp, spawn });
}

function deltaCounts(rule) {
  if (!rule) return '';
  return `; delta: ${rule.delta.length} file(s)${droppedSuffix(rule.dropped)}`;
}

const skipRun = async () => 0;

function reportPlan(plan, crap, logger) {
  const at = `[coverage-capture] Coverage at ${crap.coveragePath}`;
  const since = plan.commit.slice(0, 12);
  const dropped = droppedSuffix(plan.rule.dropped);
  if (plan.restamp) {
    logger.info(
      `${at} needs only a restamp — every path changed since ${since} is a non-suite input (delta: 0 file(s)${dropped}).`,
    );
    // A no-op run over the prior artifact only rewrites the stamp.
    return { baseRef: plan.commit, dropFiles: [], runCaptureImpl: skipRun };
  }
  const files = plan.rule.delta;
  const detail = formatFreshnessDetail({
    stamp: plan.stamp,
    requiredScope: 'affected',
    verdict: 'delta-refresh',
    deltaFiles: files.length,
  });
  logger.info(
    `${at} needs a delta refresh — re-measuring ${files.length} file(s) changed since ${since}${dropped}. ${detail}`,
  );
  return { baseRef: plan.commit, dropFiles: files };
}

/**
 * A stale stamp whose staleness is wholly main's delta is re-measured keyed
 * on the stamped commit, or only restamped when that delta holds no suite
 * input; `null` means capture the Story's scope as usual.
 *
 * @returns {{ baseRef: string, dropFiles: string[], runCaptureImpl?: () => Promise<number> } | null}
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
  if (plan.eligible) return reportPlan(plan, crap, logger);
  logger.info(
    `[coverage-capture] Affected mode: delta refresh not eligible (${plan.reason}${deltaCounts(plan.rule)}) — capturing the Story's affected scope.`,
  );
  return null;
}
