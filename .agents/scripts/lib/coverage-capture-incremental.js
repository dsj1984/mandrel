/**
 * coverage-capture-incremental.js — the incremental-mode capture path for
 * `coverage-capture.js` (Story #4981).
 *
 * Split into its own module (rather than added inline to the CLI shell) so
 * the Story's opt-in branch lands as new code, not a same-file expansion of
 * `runCoverageCapture`. Every collaborator is injected — no seam differs
 * from the ones `coverage-capture.js` already exposes on its `deps`
 * parameter (`.agents/rules/test-seams.md` rules 1-2, 4).
 */
import path from 'node:path';
import { stampCapturedTree } from './coverage-capture.js';

/**
 * Resolve the ONE git ref a single `coverage-capture.js` invocation computes
 * its changed-file set against — the whole rule, stated once (Story #5365).
 *
 * **A ref the caller named wins (`args.ref`); `incrementalCoverage.baseRef` is
 * the default for a caller that named none, and `main` the default for
 * neither.** `.husky/pre-push` runs capture and then
 * `quality-preview.js --changed-since <ref>`, and the preview has no config
 * ref to consult — it scores exactly the ref it was handed. Letting the
 * configured value outrank the hook's `--ref` therefore captured against one
 * ref while the preview scored CRAP against another, so the preview could
 * read an artifact whose scope was not its own: precisely the stale-artifact
 * hole the capture-before-preview ordering (Story #5356) closed. This
 * repository sets no `baseRef`, so that divergence was invisible locally and
 * only a consumer that configured one would have paid for it.
 *
 * Callers that name no ref — the close-validation gate
 * (`close-validation/gates.js` builds its argv without `--ref`) — still get
 * the configured value, so the key keeps the meaning it was added with.
 *
 * Both capture paths of one invocation call this one function —
 * `runFullScopeCapture` imports it from here — so they cannot resolve two
 * refs, and a new consumer of the change set routes through it rather than
 * reading `baseRef` directly.
 *
 * @param {{ crap: object, args: { ref: string | null } }} opts
 * @returns {string}
 */
export function resolveCaptureRef({ crap, args }) {
  return args.ref ?? crap?.incrementalCoverage?.baseRef ?? 'main';
}

/**
 * Run the skip-aware capture path when
 * `delivery.quality.gates.crap.incrementalCoverage.skipWhenUnchanged` is true
 * (the default since Story #5173).
 *
 * **This does not shorten the capture run.** The changed-file set decides
 * *whether* to capture, never *what* the capture executes: when nothing under
 * `crap.targetDirs` changed there is no capture at all, and otherwise the
 * ordinary full `npm run test:coverage` runs. The saving that makes the mode
 * worth having is the skip.
 *
 * Gated by `skipWhenUnchanged` alone (Story #5173). It MUST NOT consult
 * `baselineJoin`: that switch governs the CRAP join
 * (`crap-baseline-join.js`), which resolves methods in untouched files from
 * the committed baseline row instead of demanding fresh coverage for them —
 * a gate loosening, where the skip is a pure saving. The two are defaulted
 * differently for exactly that reason, so neither may read the other.
 *
 * Returns the process exit code when incremental mode handled the run
 * (skip, capture, or a capture failure), or `null` when the caller should
 * fall through to the full-scope path — either incremental mode is
 * disabled, or the changed-files ref could not be resolved (a
 * misconfiguration must not silently relax the gate).
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
 * @returns {number | null}
 */
export function tryIncrementalCapture({
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

  const ref = resolveCaptureRef({ crap, args });
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
  // Story #5278 — pre-spawn digest; see `stampCapturedTree`.
  const preDigest = computeContentDigestImpl(args.cwd, crap.targetDirs);
  const code = runCaptureImpl({
    cwd: args.cwd,
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
  if (code !== 0) {
    logger.error(
      `[coverage-capture] ✖ npm run test:coverage exited ${code}. Fix failing tests or coverage-threshold breaches before re-running the CRAP gate.`,
    );
    return code;
  }

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
