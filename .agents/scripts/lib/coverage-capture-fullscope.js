/** Full-scope (default) capture path for `coverage-capture.js`. */
import path from 'node:path';
import { resolveChangedFilesRef } from './changed-files.js';
import {
  anyChangedUnderTargets,
  describeFreshness,
  reportCaptureFailure,
  stampCapturedTree,
} from './coverage-capture.js';
import {
  describeStampFreshness,
  readHeadCommit,
} from './coverage-capture-delta.js';

/**
 * `--skip-when-no-crap-files`: true when no changed file is under
 * `crap.targetDirs`. A bad ref must not relax the gate, so it answers false.
 *
 * @returns {boolean}
 */
function noCrapFilesChanged({ crap, args, getChangedFilesImpl, logger }) {
  let changed = null;
  try {
    changed = getChangedFilesImpl({
      ref: resolveChangedFilesRef({ crap, ref: args.ref }),
      cwd: args.cwd,
    });
  } catch (err) {
    logger.warn(
      `[coverage-capture] ⚠ ${err?.message ?? err} — falling back to freshness check.`,
    );
  }
  return Boolean(changed) && !anyChangedUnderTargets(changed, crap.targetDirs);
}

/**
 * Optional no-CRAP-files skip, freshness probe, then capture and stamp. The
 * skip uses the same ref incremental mode resolves, so a fall-through from
 * it cannot change scope mid-run.
 *
 * @param {{
 *   crap: object,
 *   coverage: object,
 *   args: { skipWhenNoCrapFiles: boolean, ref: string | null, cwd: string },
 *   getChangedFilesImpl: Function,
 *   isCoverageFreshImpl: Function,
 *   runCaptureImpl: Function,
 *   computeContentDigestImpl: Function,
 *   writeCaptureStampImpl: Function,
 *   readHeadCommitImpl?: typeof readHeadCommit,
 *   logger: { info: Function, warn: Function, error: Function },
 * }} opts
 * @returns {Promise<number>} process exit code
 */
export async function runFullScopeCapture({
  crap,
  coverage,
  args,
  getChangedFilesImpl,
  isCoverageFreshImpl,
  runCaptureImpl,
  computeContentDigestImpl,
  writeCaptureStampImpl,
  readHeadCommitImpl = readHeadCommit,
  logger,
}) {
  if (
    args.skipWhenNoCrapFiles &&
    noCrapFilesChanged({ crap, args, getChangedFilesImpl, logger })
  ) {
    logger.info(
      `[coverage-capture] No changed files under [${crap.targetDirs.join(', ')}] — skipping capture.`,
    );
    return 0;
  }

  const probe = () =>
    isCoverageFreshImpl({
      coveragePath: crap.coveragePath,
      targetDirs: crap.targetDirs,
      cwd: args.cwd,
    });
  const freshness = probe();
  const detail = describeStampFreshness({
    cwd: args.cwd,
    coveragePath: crap.coveragePath,
    requiredScope: 'full',
    verdict: freshness.reason,
  });
  if (freshness.fresh) {
    logger.info(
      `[coverage-capture] Coverage at ${path.resolve(args.cwd, crap.coveragePath)} is ${freshness.reason} — skipping capture. ${detail}`,
    );
    return 0;
  }

  logger.info(
    `[coverage-capture] Coverage at ${crap.coveragePath} is ${describeFreshness(freshness, crap.targetDirs)}; running npm run test:coverage… ${detail}`,
  );
  // Pre-spawn digest and commit; see `stampCapturedTree`.
  const preDigest = computeContentDigestImpl(args.cwd, crap.targetDirs);
  const commit = readHeadCommitImpl(args.cwd);
  const code = await runCaptureImpl({
    cwd: args.cwd,
    coveragePath: crap.coveragePath,
    timeoutMs: coverage?.timeoutMs,
    log: (m) => logger.info(m),
    // After queueing behind another suite, which may have stamped this tree.
    recheckFresh: () => probe().fresh === true,
  });
  if (code !== 0) return reportCaptureFailure(code, logger);

  stampCapturedTree({
    preDigest,
    cwd: args.cwd,
    targetDirs: crap.targetDirs,
    coveragePath: crap.coveragePath,
    commit,
    computeContentDigestImpl,
    writeCaptureStampImpl,
    logger,
  });
  return code;
}
