#!/usr/bin/env node
/**
 * Ensures `coverage/coverage-final.json` is fresh before the CRAP gate: skip
 * when the gate is off, no changed file is under `crap.targetDirs`, or the
 * content-digest stamp matches; otherwise run `test:coverage` behind the
 * host-level full-suite lock and stamp on success.
 *
 * `--require-credited` must stay an argument, never a config read: as policy
 * it also refused the depositing run, leaving no path that could deposit.
 *
 * Exit codes: 0 fresh/skipped/captured; 1 capture failed or refused (callers
 * MUST surface it); 75 lock wait expired and deferred (only under
 * `MANDREL_FULL_SUITE_LOCK_ON_EXPIRY=defer`); 124 suite timed out.
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
 * A `null` ref defers the fallback to `resolveChangedFilesRef`.
 * @param {string[]} argv
 * @returns {{ skipWhenNoCrapFiles: boolean, requireCredited: boolean, ref: string | null, cwd: string }}
 */
export function parseArgs(argv) {
  const out = {
    skipWhenNoCrapFiles: false,
    requireCredited: false,
    ref: null,
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
 * @param {string[]} [argv]
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
 * @returns {Promise<number>}
 */
export async function runCoverageCapture(argv = process.argv, deps = {}) {
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

  // Name the fix rather than propagate npm's opaque "Missing script" exit.
  if (!hasNpmScriptImpl(readPackageScriptsImpl(args.cwd), 'test:coverage')) {
    logger.error(
      '[coverage-capture] ✖ No "test:coverage" script in package.json. ' +
        'Add one (e.g. "test:coverage": "node --test --experimental-test-coverage") ' +
        'or disable the CRAP gate via delivery.quality.gates.crap.enabled=false.',
    );
    return 1;
  }

  // Outermost first: the credit probe announces or refuses the run, and only
  // a surviving run reaches the host-level full-suite lock.
  const capture = creditedCapture(lockedCapture(runCaptureImpl, config), {
    requireCredited: args.requireCredited,
    logger,
  });

  // Shared so a new seam cannot reach one capture path and miss the other.
  // An incremental `null` means not applicable: fall through to full scope.
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

  const incrementalResult = await tryIncrementalCapture({
    ...shared,
    filterFilesUnderTargetsImpl,
  });
  if (incrementalResult !== null) return incrementalResult;

  return await runFullScopeCapture(shared);
}

// cli-opt-out: main resolves an exit code that is forwarded via process.exit(code); runAsCli's async-main signature does not preserve the result code.
if (isDirectInvocation(import.meta.url)) {
  // `--help` must not reach the core, which would spawn the whole suite.
  (handleCoverageCaptureHelp(process.argv)
    ? Promise.resolve(0)
    : runCoverageCapture()
  ).then(
    (code) => process.exit(code),
    (err) => {
      Logger.error('[coverage-capture] unexpected error:', err);
      process.exit(1);
    },
  );
}
