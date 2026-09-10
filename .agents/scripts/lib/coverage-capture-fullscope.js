/**
 * coverage-capture-fullscope.js — the full-scope (pre-#4981, and still the
 * default) capture path for `coverage-capture.js`.
 *
 * Hoisted out of the CLI shell's `runCoverageCapture` verbatim (Story
 * #4981) so that function's cyclomatic complexity does not grow with the
 * incremental-mode branch alongside it — this is a relocation, not new
 * logic; behaviour is byte-for-byte the pre-#4981 body.
 */
import path from 'node:path';
import {
  anyChangedUnderTargets,
  describeFreshness,
  stampCapturedTree,
} from './coverage-capture.js';

/**
 * Run the `--skip-when-no-crap-files` check (when requested), the
 * content-digest freshness probe, and — when stale — the full-repo
 * `npm run test:coverage` capture + stamp write.
 *
 * @param {{
 *   crap: object,
 *   coverage: object,
 *   args: { skipWhenNoCrapFiles: boolean, ref: string, cwd: string },
 *   getChangedFilesImpl: Function,
 *   isCoverageFreshImpl: Function,
 *   runCaptureImpl: Function,
 *   computeContentDigestImpl: Function,
 *   writeCaptureStampImpl: Function,
 *   logger: { info: Function, warn: Function, error: Function },
 * }} opts
 * @returns {number} process exit code
 */
export function runFullScopeCapture({
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
      changed = getChangedFilesImpl({ ref: args.ref, cwd: args.cwd });
    } catch (err) {
      // A bad ref must not silently relax the gate. Fall through to the
      // freshness check so coverage still gets captured if needed.
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
  // Story #5278 — the digest of the tree the suite is about to measure, taken
  // BEFORE the spawn. That is the value the stamp claims; see
  // `stampCapturedTree`.
  const preDigest = computeContentDigestImpl(args.cwd, crap.targetDirs);
  const code = runCaptureImpl({
    cwd: args.cwd,
    timeoutMs: coverage?.timeoutMs,
    log: (m) => logger.info(m),
    // Story #5278 — consulted only if this capture had to queue behind
    // another full suite on this host. Whoever we waited for may have just
    // stamped this exact tree.
    recheckFresh: () =>
      isCoverageFreshImpl({
        coveragePath: crap.coveragePath,
        targetDirs: crap.targetDirs,
        cwd: args.cwd,
      }).fresh === true,
  });
  if (code !== 0) {
    logger.error(
      `[coverage-capture] ✖ npm run test:coverage exited ${code}. Fix failing tests or coverage-threshold breaches before re-running the CRAP gate.`,
    );
    return code;
  }

  // Persist the content digest next to the fresh artifact so subsequent
  // freshness checks are content-aware (mtime churn from branch switches no
  // longer invalidates). Best-effort — a missing stamp just means the next
  // check falls back to the mtime heuristic.
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
