/**
 * `captureScope: "affected"` capture path for `coverage-capture.js`. The
 * consumer owns how its suite is scoped; mandrel only names the base ref and
 * keeps the artifact complete-looking for every per-file reader.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveChangedFilesRef } from './changed-files.js';
import { reportCaptureFailure, stampCapturedTree } from './coverage-capture.js';
import {
  describeStampFreshness,
  planDeltaRefresh,
  readHeadCommit,
} from './coverage-capture-delta.js';
import { tryIncrementalCapture } from './coverage-capture-incremental.js';

const AFFECTED_CAPTURE_SCRIPT = 'test:coverage:affected';
const COVERAGE_BASE_REF_ENV = 'MANDREL_COVERAGE_BASE_REF';

/** A configured scope with no script warns, and the caller runs full scope. */
function shouldCaptureAffected({
  coverage,
  scripts,
  hasNpmScriptImpl,
  logger,
}) {
  if (coverage?.captureScope !== 'affected') return false;
  if (hasNpmScriptImpl(scripts, AFFECTED_CAPTURE_SCRIPT)) return true;
  logger.warn(
    `[coverage-capture] ⚠ captureScope is "affected" but package.json has no "${AFFECTED_CAPTURE_SCRIPT}" script — running the full npm run test:coverage instead.`,
  );
  return false;
}

/**
 * Affected capture when it applies, else incremental mode; `null` means
 * neither applies and the caller runs full scope.
 *
 * @returns {Promise<number | null>}
 */
export async function tryScopedCapture({
  readPackageScriptsImpl,
  hasNpmScriptImpl,
  ...opts
}) {
  const applies = shouldCaptureAffected({
    coverage: opts.coverage,
    scripts: readPackageScriptsImpl(opts.args.cwd),
    hasNpmScriptImpl,
    logger: opts.logger,
  });
  return applies
    ? await runAffectedCapture(opts)
    : await tryIncrementalCapture(opts);
}

/**
 * Scoped rows win; a prior row of a changed file is dropped, so a changed
 * file the scoped run skipped stays absent and fails closed downstream.
 */
function mergeCoverageArtifacts({ prior, scoped, cwd, dropFiles }) {
  const drop = new Set(dropFiles.map((f) => path.resolve(cwd, f)));
  const merged = {};
  for (const [abs, entry] of Object.entries(prior ?? {})) {
    if (!drop.has(path.resolve(abs))) merged[abs] = entry;
  }
  return Object.assign(merged, scoped);
}

function readArtifact(abs, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function readChangedFiles({ getChangedFilesImpl, ref, cwd, logger }) {
  try {
    return getChangedFilesImpl({ ref, cwd });
  } catch (err) {
    logger.warn(
      `[coverage-capture] ⚠ affected mode: ${err?.message ?? err} — capturing without a prior-artifact merge.`,
    );
    return null;
  }
}

/** The tree a run is about to measure: its source digest and HEAD commit. */
function snapshotTree({
  args,
  crap,
  computeContentDigestImpl,
  readHeadCommitImpl,
}) {
  return {
    preDigest: computeContentDigestImpl(args.cwd, crap.targetDirs),
    commit: readHeadCommitImpl(args.cwd),
  };
}

/**
 * Run the affected script against `baseRef`. The pre-spawn digest and
 * commit are what the stamp records; see `stampCapturedTree`.
 *
 * @returns {Promise<{ code: number, preDigest: string | null, commit: string | null }>}
 */
async function runScoped({
  crap,
  coverage,
  args,
  baseRef,
  probe,
  runCaptureImpl,
  computeContentDigestImpl,
  readHeadCommitImpl,
  logger,
}) {
  const tree = snapshotTree({
    args,
    crap,
    computeContentDigestImpl,
    readHeadCommitImpl,
  });
  const code = await runCaptureImpl({
    cwd: args.cwd,
    timeoutMs: coverage?.timeoutMs,
    script: AFFECTED_CAPTURE_SCRIPT,
    env: { [COVERAGE_BASE_REF_ENV]: baseRef },
    log: (m) => logger.info(m),
    recheckFresh: () => probe().fresh === true,
  });
  return { code, ...tree };
}

/**
 * Merge the scoped rows over `prior`, dropping `dropFiles`' prior rows.
 *
 * @returns {boolean} False when the run wrote no readable artifact.
 */
function writeMerged({ crap, args, prior, dropFiles, logger, fsImpl }) {
  const artifactAbs = path.resolve(args.cwd, crap.coveragePath);
  const scoped = readArtifact(artifactAbs, fsImpl);
  if (scoped === null) {
    logger.error(
      `[coverage-capture] ✖ npm run ${AFFECTED_CAPTURE_SCRIPT} exited 0 but wrote no readable artifact at ${crap.coveragePath} — point its coverage output there.`,
    );
    return false;
  }
  const merged = mergeCoverageArtifacts({
    prior,
    scoped,
    cwd: args.cwd,
    dropFiles,
  });
  fsImpl.writeFileSync(artifactAbs, JSON.stringify(merged));
  return true;
}

/**
 * Run, merge and stamp. A non-zero run is a red capture — never a fallback.
 *
 * @returns {Promise<number>}
 */
async function captureAndMerge(opts) {
  const run = await runScoped(opts);
  if (run.code !== 0) return reportCaptureFailure(run.code, opts.logger);
  if (!writeMerged(opts)) return 1;
  stampCapturedTree({
    ...opts,
    targetDirs: opts.crap.targetDirs,
    coveragePath: opts.crap.coveragePath,
    cwd: opts.args.cwd,
    scope: 'affected',
    preDigest: run.preDigest,
    commit: run.commit,
    ...opts.stamp,
  });
  return 0;
}

/** The affected-scope freshness probe, reused as the post-lock recheck. */
function affectedProbe({ isCoverageFreshImpl, crap, args }) {
  return () =>
    isCoverageFreshImpl({
      coveragePath: crap.coveragePath,
      targetDirs: crap.targetDirs,
      cwd: args.cwd,
      requireScope: 'affected',
    });
}

/**
 * Probe at affected scope and log the verdict with its stamp detail.
 *
 * @returns {{ fresh: boolean, reason: string }}
 */
function probeAndReport({ probe, crap, args, logger }) {
  const freshness = probe();
  const detail = describeStampFreshness({
    cwd: args.cwd,
    coveragePath: crap.coveragePath,
    requiredScope: 'affected',
    verdict: freshness.reason,
  });
  const action = freshness.fresh ? ' — skipping capture.' : '.';
  logger.info(
    `[coverage-capture] Coverage at ${crap.coveragePath} is ${freshness.reason} (affected)${action} ${detail}`,
  );
  return freshness;
}

/** Under `skipWhenUnchanged`, a readable change set with nothing in scope skips. */
function skipsUnchanged({ crap, changed, scopedFiles, ref, logger }) {
  const skip =
    crap.incrementalCoverage?.skipWhenUnchanged === true &&
    Boolean(changed) &&
    scopedFiles.length === 0;
  if (skip) {
    logger.info(
      `[coverage-capture] Affected mode: no changed files under [${crap.targetDirs.join(', ')}] vs ${ref} — skipping capture.`,
    );
  }
  return skip;
}

/**
 * What the run merges over and is keyed on: the stamped commit and main's
 * delta for an eligible delta refresh, else `ref` and the Story change set.
 *
 * @returns {{ prior: object | null, baseRef: string, dropFiles: string[] }}
 */
function resolveRunBase({
  freshness,
  crap,
  args,
  changed,
  ref,
  fsImpl,
  ...rest
}) {
  const artifactAbs = path.resolve(args.cwd, crap.coveragePath);
  const prior = changed ? readArtifact(artifactAbs, fsImpl) : null;
  const delta = planDeltaRefresh({
    ...rest,
    freshness,
    crap,
    args,
    changed,
    prior,
  });
  return {
    prior,
    baseRef: delta?.baseRef ?? ref,
    dropFiles: delta?.dropFiles ?? changed ?? [],
  };
}

/**
 * Honours `skipWhenUnchanged` as incremental mode does. With an unreadable
 * change set nothing prior is merged: a stale row for a changed file must
 * never read as fresh.
 */
async function runAffectedCapture({
  crap,
  args,
  getChangedFilesImpl,
  filterFilesUnderTargetsImpl,
  isCoverageFreshImpl,
  classifyDeltaRefreshImpl,
  readHeadCommitImpl = readHeadCommit,
  logger,
  fsImpl = fs,
  ...rest
}) {
  const ref = resolveChangedFilesRef({ crap, ref: args.ref });
  const changed = readChangedFiles({
    getChangedFilesImpl,
    ref,
    cwd: args.cwd,
    logger,
  });
  const scopedFiles = filterFilesUnderTargetsImpl(changed, crap.targetDirs);
  if (skipsUnchanged({ crap, changed, scopedFiles, ref, logger })) return 0;

  const probe = affectedProbe({ isCoverageFreshImpl, crap, args });
  const freshness = probeAndReport({ probe, crap, args, logger });
  if (freshness.fresh) return 0;

  const base = resolveRunBase({
    freshness,
    crap,
    args,
    changed,
    ref,
    fsImpl,
    classifyDeltaRefreshImpl,
    logger,
  });
  return captureAndMerge({
    ...rest,
    ...base,
    crap,
    args,
    stamp: { files: scopedFiles, ref },
    probe,
    readHeadCommitImpl,
    logger,
    fsImpl,
  });
}
