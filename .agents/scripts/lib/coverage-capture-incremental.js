/** Incremental-mode capture path for `coverage-capture.js`. */
import path from 'node:path';
import { resolveChangedFilesRef } from './changed-files.js';
import { reportCaptureFailure, stampCapturedTree } from './coverage-capture.js';
import {
  describeStampFreshness,
  readHeadCommit,
} from './coverage-capture-delta.js';

/**
 * The changed-file set; `null` when incremental mode is off, or (warned)
 * when the ref cannot be resolved.
 *
 * @returns {{ changed: string[] } | null}
 */
function readChanged({ crap, getChangedFilesImpl, ref, args, logger }) {
  if (crap.incrementalCoverage?.skipWhenUnchanged !== true) return null;
  try {
    return { changed: getChangedFilesImpl({ ref, cwd: args.cwd }) };
  } catch (err) {
    logger.warn(
      `[coverage-capture] ⚠ incremental mode: ${err?.message ?? err} — falling back to full-scope capture.`,
    );
    return null;
  }
}

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
 *   readHeadCommitImpl?: typeof readHeadCommit,
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
  readHeadCommitImpl = readHeadCommit,
  logger,
}) {
  const ref = resolveChangedFilesRef({ crap, ref: args.ref });
  const read = readChanged({ crap, getChangedFilesImpl, ref, args, logger });
  if (read === null) return null;

  const scopedFiles = filterFilesUnderTargetsImpl(
    read.changed,
    crap.targetDirs,
  );
  if (scopedFiles.length === 0) {
    logger.info(
      `[coverage-capture] Incremental mode: no changed files under [${crap.targetDirs.join(', ')}] vs ${ref} — skipping capture.`,
    );
    return 0;
  }

  const probe = () =>
    isCoverageFreshImpl({
      coveragePath: crap.coveragePath,
      targetDirs: crap.targetDirs,
      cwd: args.cwd,
      requireScope: 'incremental',
    });
  const freshness = probe();
  const detail = describeStampFreshness({
    cwd: args.cwd,
    coveragePath: crap.coveragePath,
    requiredScope: 'incremental',
    verdict: freshness.reason,
  });
  if (freshness.fresh) {
    logger.info(
      `[coverage-capture] Coverage at ${path.resolve(args.cwd, crap.coveragePath)} is ${freshness.reason} (incremental) — skipping capture. ${detail}`,
    );
    return 0;
  }

  logger.info(
    `[coverage-capture] Incremental mode: ${scopedFiles.length} changed file(s) under [${crap.targetDirs.join(', ')}] — capturing… ${detail}`,
  );
  // Pre-spawn digest and commit; see `stampCapturedTree`.
  const preDigest = computeContentDigestImpl(args.cwd, crap.targetDirs);
  const commit = readHeadCommitImpl(args.cwd);
  const code = await runCaptureImpl({
    cwd: args.cwd,
    coveragePath: crap.coveragePath,
    timeoutMs: coverage?.timeoutMs,
    log: (m) => logger.info(m),
    recheckFresh: () => probe().fresh === true,
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
    commit,
    computeContentDigestImpl,
    writeCaptureStampImpl,
    logger,
  });
  return code;
}
