/**
 * Delta refresh for `captureScope: "affected"`: after a base-sync merges main
 * commits that share no file with the Story, re-measure only those commits'
 * tests instead of re-running the Story's whole affected scope. Every
 * uncertainty fails closed to an ordinary capture.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { captureStampPath, computeContentDigest } from './coverage-capture.js';

/**
 * Files whose change can move coverage for sources the delta does not name,
 * matched on basename: manifests, lockfiles, TypeScript and test-runner config.
 */
const COVERAGE_CONFIG_RE =
  /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|tsconfig.*\.json|(vitest|vite|jest|nyc)\.(config|workspace)\.[cm]?[jt]s|\.c8rc.*|\.nycrc.*)$/;

/** @param {string} file @returns {boolean} */
export function isCoverageConfigFile(file) {
  return COVERAGE_CONFIG_RE.test(path.posix.basename(String(file)));
}

/**
 * `null` on any git failure — the caller treats it as "unknown".
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {typeof spawnSync} spawn
 * @returns {{ status: number, stdout: string } | null}
 */
function git(cwd, args, spawn) {
  const res = spawn('git', args, { cwd, encoding: 'utf8' });
  if (res?.error || typeof res?.status !== 'number') return null;
  return { status: res.status, stdout: res.stdout ?? '' };
}

/**
 * The HEAD sha a capture is about to measure, or `null` when unavailable.
 *
 * @param {string} cwd
 * @param {{ spawnSync?: typeof spawnSync }} [io]
 * @returns {string | null}
 */
export function readHeadCommit(cwd, io = {}) {
  const res = git(cwd, ['rev-parse', 'HEAD'], io.spawnSync ?? spawnSync);
  const sha = res?.status === 0 ? res.stdout.trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * The parsed capture stamp, or `null` when absent or unreadable.
 *
 * @param {string} cwd
 * @param {string} coveragePath
 * @param {{ readFileSync?: typeof fs.readFileSync }} [io]
 * @returns {Record<string, unknown> | null}
 */
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

/**
 * A stamp without `scope` is full-scope; no stamp at all is `none`.
 *
 * @param {Record<string, unknown> | null} stamp
 * @returns {string}
 */
function stampScopeOf(stamp) {
  if (!stamp) return 'none';
  return typeof stamp.scope === 'string' ? stamp.scope : 'full';
}

/**
 * The diagnostic suffix every freshness log line carries, so a stamp going
 * stale is explainable from the log alone.
 *
 * @param {{
 *   stamp: Record<string, unknown> | null,
 *   requiredScope: string,
 *   verdict: string,
 *   deltaFiles?: number,
 * }} opts
 * @returns {string}
 */
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

/**
 * Read the stamp and render its freshness detail in one step.
 *
 * @param {{ cwd: string, coveragePath: string, requiredScope: string, verdict: string }} opts
 * @returns {string}
 */
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

/**
 * Tree-level preconditions: a clean worktree (a dirty file is in no git
 * delta) and a stamped commit that is an ancestor of HEAD.
 *
 * @returns {string | null} The failing condition, or `null` when all hold.
 */
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

/**
 * The delta's own disqualifiers: empty, overlapping the Story's change set,
 * or touching coverage-determining config.
 *
 * @returns {string | null}
 */
function deltaIneligibility({ delta, storyFiles }) {
  if (delta.length === 0) return 'no committed delta since the stamp';
  const story = new Set(storyFiles);
  const shared = delta.find((f) => story.has(f));
  if (shared) return `delta shares ${shared} with the Story's change set`;
  const config = delta.find(isCoverageConfigFile);
  if (config) return `delta touches coverage-determining config ${config}`;
  return null;
}

/**
 * @param {string} stdout
 * @returns {string[]}
 */
function parseNames(stdout) {
  return stdout
    .split('\n')
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter((l) => l.length > 0);
}

/**
 * Is a stale affected-scope capture eligible for a delta refresh? Every
 * input the rule needs is checked here; any git error or unresolvable input
 * is ineligible, so the caller runs today's capture.
 *
 * @param {{
 *   cwd: string,
 *   crap: { coveragePath: string, targetDirs: string[] },
 *   storyFiles: string[] | null,
 *   prior: object | null,
 *   spawnSync?: typeof spawnSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   computeContentDigestImpl?: typeof computeContentDigest,
 * }} opts `storyFiles` is the Story's change set; `prior` the artifact the
 *   refresh would merge over.
 * @returns {{ eligible: true, commit: string, delta: string[], stamp: object }
 *   | { eligible: false, reason: string, stamp: object | null }}
 */
function classifyDeltaRefresh({
  cwd,
  crap,
  storyFiles,
  prior,
  spawnSync: spawn = spawnSync,
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
 * A stale stamp whose staleness is wholly main's delta (a base-sync) runs
 * the affected script keyed on the stamped commit; `null` means ineligible
 * and the caller captures the Story's affected scope as usual.
 *
 * @param {{
 *   freshness: { reason: string },
 *   crap: { coveragePath: string, targetDirs: string[] },
 *   args: { cwd: string },
 *   changed: string[] | null,
 *   prior: object | null,
 *   classifyDeltaRefreshImpl?: typeof classifyDeltaRefresh,
 *   logger: { info: Function },
 * }} opts
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
