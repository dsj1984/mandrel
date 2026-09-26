/** Incremental-mode capture path for `coverage-capture.js`. */
import path from 'node:path';
import { resolveChangedFilesRef } from './changed-files.js';
import { reportCaptureFailure, stampCapturedTree } from './coverage-capture.js';

/**
 * Under `skipWhenUnchanged`: the changed-file set decides whether to capture,
 * never what runs (a capture is always the full suite). Must not read
 * `baselineJoin` — that loosens the gate, while the skip is a pure saving.
 * Returns `null` to fall through to full scope, including when the ref
 * cannot be resolved (never silently relax the gate).
 *
 * @param {{
 *   crap: object,
 *   coverage: object,
 *   args: { ref: string | null, cwd: string },
 *   getChangedFilesImpl: Function,
 *   filterFilesUnderTargetsImpl: Function,
 *   isCoverageFreshImpl: Function,
 *   runCaptureImpl: Function,
 *   computeContentDigestImpl: Function,
 *   writeCaptureStampImpl: Function,
 *   logger: { info: Function, warn: Function, error: Function },
 * }} opts
 * @returns {Promise<number | null>}
 */
export async function tryIncrementalCapture({
  crap,
  coverage,
  args,
  getChangedFilesImpl,
  filterFilesUnderTargetsImpl,
  isCoverageFreshImpl,
  runCaptureImpl,
  computeContentDigestImpl,
  writeCaptureStampImpl,
  logger,
}) {
  if (crap.incrementalCoverage?.skipWhenUnchanged !== true) return null;

  const ref = resolveChangedFilesRef({ crap, ref: args.ref });
  let changed = null;
  try {
    changed = getChangedFilesImpl({ ref, cwd: args.cwd });
  } catch (err) {
    logger.warn(
      `[coverage-capture] ⚠ incremental mode: ${err?.message ?? err} — falling back to full-scope capture.`,
    );
    return null;
  }

  const scopedFiles = filterFilesUnderTargetsImpl(changed, crap.targetDirs);
  if (scopedFiles.length === 0) {
    logger.info(
      `[coverage-capture] Incremental mode: no changed files under [${crap.targetDirs.join(', ')}] vs ${ref} — skipping capture.`,
    );
    return 0;
  }

  const freshness = isCoverageFreshImpl({
    coveragePath: crap.coveragePath,
    targetDirs: crap.targetDirs,
    cwd: args.cwd,
    requireScope: 'incremental',
  });
  if (freshness.fresh) {
    logger.info(
      `[coverage-capture] Coverage at ${path.resolve(args.cwd, crap.coveragePath)} is ${freshness.reason} (incremental) — skipping capture.`,
    );
    return 0;
  }

  logger.info(
    `[coverage-capture] Incremental mode: ${scopedFiles.length} changed file(s) under [${crap.targetDirs.join(', ')}] — capturing…`,
  );
  // Pre-spawn digest; see `stampCapturedTree`.
  const preDigest = computeContentDigestImpl(args.cwd, crap.targetDirs);
  const code = await runCaptureImpl({
    cwd: args.cwd,
    coveragePath: crap.coveragePath,
    timeoutMs: coverage?.timeoutMs,
    log: (m) => logger.info(m),
    recheckFresh: () =>
      isCoverageFreshImpl({
        coveragePath: crap.coveragePath,
        targetDirs: crap.targetDirs,
        cwd: args.cwd,
        requireScope: 'incremental',
      }).fresh === true,
  });
  if (code !== 0) return reportCaptureFailure(code, logger);

  stampCapturedTree({
    preDigest,
    cwd: args.cwd,
    targetDirs: crap.targetDirs,
    coveragePath: crap.coveragePath,
    scope: 'incremental',
    files: scopedFiles,
    ref,
    computeContentDigestImpl,
    writeCaptureStampImpl,
    logger,
  });
  return code;
}
