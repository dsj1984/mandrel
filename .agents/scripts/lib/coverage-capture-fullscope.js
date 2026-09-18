/** Full-scope (default) capture path for `coverage-capture.js`. */
import path from 'node:path';
import { resolveChangedFilesRef } from './changed-files.js';
import {
  anyChangedUnderTargets,
  describeFreshness,
  reportCaptureFailure,
  stampCapturedTree,
} from './coverage-capture.js';

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
  logger,
}) {
  if (args.skipWhenNoCrapFiles) {
    let changed;
    try {
      changed = getChangedFilesImpl({
        ref: resolveChangedFilesRef({ crap, ref: args.ref }),
        cwd: args.cwd,
      });
    } catch (err) {
      // A bad ref must not relax the gate; fall through to freshness.
      logger.warn(
        `[coverage-capture] ⚠ ${err?.message ?? err} — falling back to freshness check.`,
      );
      changed = null;
    }
    if (changed && !anyChangedUnderTargets(changed, crap.targetDirs)) {
      logger.info(
        `[coverage-capture] No changed files under [${crap.targetDirs.join(', ')}] — skipping capture.`,
      );
      return 0;
    }
  }

  const freshness = isCoverageFreshImpl({
    coveragePath: crap.coveragePath,
    targetDirs: crap.targetDirs,
    cwd: args.cwd,
  });
  if (freshness.fresh) {
    logger.info(
      `[coverage-capture] Coverage at ${path.resolve(args.cwd, crap.coveragePath)} is ${freshness.reason} — skipping capture.`,
    );
    return 0;
  }

  logger.info(
    `[coverage-capture] Coverage at ${crap.coveragePath} is ${describeFreshness(freshness, crap.targetDirs)}; running npm run test:coverage…`,
  );
  // Pre-spawn digest; see `stampCapturedTree`.
  const preDigest = computeContentDigestImpl(args.cwd, crap.targetDirs);
  const code = await runCaptureImpl({
    cwd: args.cwd,
    timeoutMs: coverage?.timeoutMs,
    log: (m) => logger.info(m),
    // After queueing behind another suite, which may have stamped this tree.
    recheckFresh: () =>
      isCoverageFreshImpl({
        coveragePath: crap.coveragePath,
        targetDirs: crap.targetDirs,
        cwd: args.cwd,
      }).fresh === true,
  });
  if (code !== 0) return reportCaptureFailure(code, logger);

  stampCapturedTree({
    preDigest,
    cwd: args.cwd,
    targetDirs: crap.targetDirs,
    coveragePath: crap.coveragePath,
    computeContentDigestImpl,
    writeCaptureStampImpl,
    logger,
  });
  return code;
}
