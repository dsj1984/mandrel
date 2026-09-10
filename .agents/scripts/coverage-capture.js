#!/usr/bin/env node
/**
 * CLI: ensure `coverage/coverage-final.json` is present and fresh before the
 * CRAP gate fires. Wired into close-validation (always) and pre-push (with
 * `--skip-when-no-crap-files` so untouched-source pushes stay fast).
 *
 * Behaviour:
 *   1. Resolve `delivery.quality.crap`. If `enabled === false`, exit 0.
 *   2. With `--skip-when-no-crap-files`: read `git diff --name-only <ref>...HEAD`
 *      (default ref `main`) and exit 0 if no changed file lives under
 *      `crap.targetDirs`.
 *   3. Test freshness: content digest of `crap.targetDirs` vs. the persisted
 *      capture stamp (`coverage/.capture-stamp.json`), falling back to the
 *      artifact-mtime heuristic when no stamp exists. Exit 0 when fresh.
 *   4. Otherwise announce the uncredited full-suite run — naming the
 *      invocation that would have deposited credit — and then spawn
 *      `npm run test:coverage`, serialized behind the host-level full-suite
 *      lock (Story #5173) so two concurrent runs on one checkout do not race;
 *      write a fresh capture stamp on success and propagate the exit code.
 *      With `--require-credited`, step 4 refuses instead of spawning, so the
 *      cost is never paid unannounced.
 *
 * **`--require-credited` is an argument, not a config read (Story #5278).**
 * `delivery.execution.requireCreditedCapture` is a policy about *close*: the
 * close gate must not silently pay for a suite the worker was supposed to
 * have deposited. Reading it here applied the refusal to every invocation
 * including the worker's depositing one, so turning the policy on left no
 * path that could ever deposit and bricked the CRAP gate outright. The policy
 * now lives where it is enforced — `close-validation/gates.js` passes this
 * flag when the consumer sets it — and a bare invocation always runs.
 *
 * Step 3 is preceded by the changed-file skip when
 * `delivery.quality.gates.crap.incrementalCoverage.skipWhenUnchanged` is on
 * (the default): no changed file under `crap.targetDirs` versus `baseRef`
 * means no capture at all.
 *
 * Exit codes:
 *   0 — coverage is fresh (or capture skipped/succeeded).
 *   1 — capture run failed (broken tests or coverage-threshold breach), or
 *       the run was refused because it carried no credit and
 *       `--require-credited` was passed. The caller MUST
 *       surface this — silently passing here would defeat the CRAP gate's
 *       `requireCoverage: true` policy.
 */
import { getChangedFiles } from './lib/changed-files.js';
import { isDirectInvocation } from './lib/cli-utils.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import {
  computeContentDigest,
  creditedCapture,
  filterFilesUnderTargets,
  isCoverageFresh,
  runCapture,
  writeCaptureStamp,
} from './lib/coverage-capture.js';
import { runFullScopeCapture } from './lib/coverage-capture-fullscope.js';
import { tryIncrementalCapture } from './lib/coverage-capture-incremental.js';
import { handleCoverageCaptureHelp } from './lib/coverage-capture-usage.js';
import { lockedCapture } from './lib/full-suite-lock.js';

import { Logger } from './lib/Logger.js';
import { hasNpmScript, readPackageScripts } from './lib/npm-scripts.js';

/**
 * Parse the full `process.argv` (index 2 onward) into the capture options.
 *
 * @param {string[]} argv
 * @returns {{ skipWhenNoCrapFiles: boolean, requireCredited: boolean, ref: string, cwd: string }}
 */
export function parseArgs(argv) {
  const out = {
    skipWhenNoCrapFiles: false,
    // Story #5278 — an ARGUMENT, never a config read. See `runCoverageCapture`.
    requireCredited: false,
    ref: 'main',
    cwd: process.cwd(),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--skip-when-no-crap-files') out.skipWhenNoCrapFiles = true;
    else if (a === '--require-credited') out.requireCredited = true;
    else if (a === '--ref') out.ref = argv[++i] ?? out.ref;
    else if (a === '--cwd') out.cwd = argv[++i] ?? out.cwd;
  }
  return out;
}

/**
 * The capture decision core, extracted from the CLI shell so the whole
 * decision table (disabled gate, missing npm script, changed-file skip,
 * freshness skip, capture + stamp) is reachable without spawning
 * `npm run test:coverage` or touching the real filesystem.
 *
 * Every seam on the optional final `deps` parameter defaults to the real
 * implementation (`.agents/rules/test-seams.md` rules 1-2, 4), so the CLI
 * shell below and any production caller are unchanged.
 *
 * @param {string[]} [argv] Full `process.argv`-shaped array.
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   getQualityImpl?: typeof getQuality,
 *   getChangedFilesImpl?: typeof getChangedFiles,
 *   readPackageScriptsImpl?: typeof readPackageScripts,
 *   hasNpmScriptImpl?: typeof hasNpmScript,
 *   isCoverageFreshImpl?: typeof isCoverageFresh,
 *   runCaptureImpl?: typeof runCapture,
 *   computeContentDigestImpl?: typeof computeContentDigest,
 *   writeCaptureStampImpl?: typeof writeCaptureStamp,
 *   filterFilesUnderTargetsImpl?: typeof filterFilesUnderTargets,
 *   logger?: { info: Function, warn: Function, error: Function },
 * }} [deps]
 * @returns {number} process exit code
 */
export function runCoverageCapture(argv = process.argv, deps = {}) {
  const {
    resolveConfigImpl = resolveConfig,
    getQualityImpl = getQuality,
    getChangedFilesImpl = getChangedFiles,
    readPackageScriptsImpl = readPackageScripts,
    hasNpmScriptImpl = hasNpmScript,
    isCoverageFreshImpl = isCoverageFresh,
    runCaptureImpl = runCapture,
    computeContentDigestImpl = computeContentDigest,
    writeCaptureStampImpl = writeCaptureStamp,
    filterFilesUnderTargetsImpl = filterFilesUnderTargets,
    logger = Logger,
  } = deps;
  const args = parseArgs(argv);
  const config = resolveConfigImpl({ cwd: args.cwd });
  const { crap, coverage } = getQualityImpl(config);

  if (crap.enabled === false) {
    logger.info('[coverage-capture] CRAP gate disabled — skipping capture.');
    return 0;
  }

  // Story #4473 — detect the "missing npm script" misconfiguration
  // distinctly. `close-validation/gates.js` already declines to register
  // this gate when `test:coverage` is absent, so reaching here without the
  // script means a direct/pre-push invocation in a consumer that never
  // defined it. Surface a one-line, fix-naming diagnostic instead of
  // spawning `npm run test:coverage` only to propagate npm's opaque
  // "Missing script" exit code.
  if (!hasNpmScriptImpl(readPackageScriptsImpl(args.cwd), 'test:coverage')) {
    logger.error(
      '[coverage-capture] ✖ No "test:coverage" script in package.json. ' +
        'Add one (e.g. "test:coverage": "node --test --experimental-test-coverage") ' +
        'or disable the CRAP gate via delivery.quality.gates.crap.enabled=false.',
    );
    return 1;
  }

  // Story #5173 — the host-level full-suite lock. Resolved once here, where
  // the config is already in scope, and composed over the capture runner so
  // whichever path reaches the spawn is serialized without either of them
  // knowing about it. `delivery.execution.fullSuiteLock: false` and
  // `MANDREL_FULL_SUITE_LOCK=0` each disable it; both hatches live in
  // `isFullSuiteLockEnabled`.
  // Two wrappers, composed outermost-first: the credit probe announces (or
  // refuses) the run, and only a run that survives it reaches the host lock.
  // Whichever capture path gets here spawns through both without knowing
  // about either.
  const capture = creditedCapture(lockedCapture(runCaptureImpl, config), {
    requireCredited: args.requireCredited,
    logger,
  });

  // Story #4981/#5173 — the capture skip, gated by
  // `delivery.quality.gates.crap.incrementalCoverage.skipWhenUnchanged` (on
  // by default). `null` means "not applicable" (switched off, or a
  // ref-resolution error) — fall through to the full-scope path below rather
  // than silently skipping capture.
  // The two capture paths take the same collaborators bar one; naming that
  // set once keeps a new seam from being threaded into one and forgotten on
  // the other.
  const shared = {
    crap,
    coverage,
    args,
    getChangedFilesImpl,
    isCoverageFreshImpl,
    runCaptureImpl: capture,
    computeContentDigestImpl,
    writeCaptureStampImpl,
    logger,
  };

  const incrementalResult = tryIncrementalCapture({
    ...shared,
    filterFilesUnderTargetsImpl,
  });
  if (incrementalResult !== null) return incrementalResult;

  return runFullScopeCapture(shared);
}

// cli-opt-out: synchronous main returns an exit code that is forwarded via process.exit(code); runAsCli's async-main signature does not preserve the result code.
// The direct-invocation guard keeps `import`ing this module (from the unit
// tests that drive `runCoverageCapture` with injected seams) side-effect free;
// invoked as a CLI the behaviour — exit code and log lines — is unchanged.
if (isDirectInvocation(import.meta.url)) {
  try {
    // `--help` is answered before the decision core runs: it used to fall
    // through to the capture path, so asking this script to describe itself
    // spawned the whole coverage suite.
    process.exit(
      handleCoverageCaptureHelp(process.argv) ? 0 : runCoverageCapture(),
    );
  } catch (err) {
    Logger.error('[coverage-capture] unexpected error:', err);
    process.exit(1);
  }
}
