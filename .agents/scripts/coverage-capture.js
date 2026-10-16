#!/usr/bin/env node
/**
 * Ensures `coverage/coverage-final.json` is fresh before the CRAP gate: skip
 * when the gate is off, no changed file is under `crap.targetDirs`, or the
 * content-digest stamp matches; otherwise run `test:coverage` (or, under
 * `coverage.captureScope: "affected"`, the consumer's `test:coverage:affected`)
 * behind the host-level full-suite lock and stamp on success. A green run that
 * leaves no artifact at `coveragePath` fails (exit 1) and is never stamped.
 * An own CRAP source gets a second, always full-scope pass via
 * `crap.captureScript` (`lib/coverage-capture-passes.js`).
 *
 * `--require-credited` must stay an argument, never a config read: as policy
 * it also refused the depositing run, leaving no path that could deposit.
 *
 * Exit codes: 0 fresh/skipped/captured; 1 capture failed or refused (callers
 * MUST surface it); 75 lock wait expired, nothing spawned; 124 suite timed out.
 */
import { getChangedFiles } from './lib/changed-files.js';
import { isDirectInvocation } from './lib/cli-utils.js';
import { claimLockEventSink, lockEventHooks } from './lib/close-lock-events.js';
import { getQuality, resolveConfig } from './lib/config-resolver.js';
import {
  computeContentDigest,
  creditedCapture,
  filterFilesUnderTargets,
  isCoverageFresh,
  requireCaptureArtifact,
  runCapture,
  writeCaptureStamp,
} from './lib/coverage-capture.js';
import { tryScopedCapture } from './lib/coverage-capture-affected.js';
import { runFullScopeCapture } from './lib/coverage-capture-fullscope.js';
import {
  captureRefusal,
  runCapturePasses,
} from './lib/coverage-capture-passes.js';
import { handleCoverageCaptureHelp } from './lib/coverage-capture-usage.js';
import { lockedCapture } from './lib/full-suite-lock.js';
import { Logger } from './lib/Logger.js';
import { hasNpmScript, readPackageScripts } from './lib/npm-scripts.js';
import { formatSuiteTimings } from './lib/supervised-suite.js';

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
 *   coverageArtifactExistsImpl?: (absPath: string) => boolean,
 *   logger?: { info: Function, warn: Function, error: Function },
 *   lockOptions?: object,
 *   env?: Record<string, string|undefined>,
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
    coverageArtifactExistsImpl,
    logger = Logger,
    lockOptions = {},
    env = process.env,
  } = deps;
  const lockHooks = lockEventHooks(claimLockEventSink(env));
  const args = parseArgs(argv);
  const config = resolveConfigImpl({ cwd: args.cwd });
  const { crap, coverage } = getQualityImpl(config);
  const scripts = readPackageScriptsImpl(args.cwd);
  const refused = captureRefusal({ crap, scripts, hasNpmScriptImpl, logger });
  if (refused !== null) return refused;

  // Outermost first: the credit probe announces or refuses the run, and only
  // a surviving run reaches the host-level full-suite lock.
  const locked = lockedCapture(runCaptureImpl, config, env, {
    rerunCommand: rerunCommandFor(argv),
    onLockOutcome: lockHooks.onLockOutcome,
    onLockProgress: lockHooks.onLockProgress,
    ...lockOptions,
  });
  let timings = null;
  const makeCapture = (source) => {
    const credited = artifactCheckedCapture(locked, {
      args,
      source,
      existsSync: coverageArtifactExistsImpl,
      logger,
    });
    return (captureOpts) =>
      credited({
        ...captureOpts,
        onTimings: (t) => {
          timings = t;
        },
      });
  };
  const code = await runCapturePasses({
    crap,
    coverage,
    args,
    scripts,
    hasNpmScriptImpl,
    makeCapture,
    runShared: runCaptureScopes,
    deps: {
      getChangedFilesImpl,
      isCoverageFreshImpl,
      computeContentDigestImpl,
      writeCaptureStampImpl,
      filterFilesUnderTargetsImpl,
      readPackageScriptsImpl,
      hasNpmScriptImpl,
      logger,
    },
  });
  if (timings) reportTimings(timings, logger, lockHooks);
  return code;
}

/**
 * The credited runner, failing a green run that wrote no artifact at the
 * pass's source.
 *
 * @param {Function} locked
 * @param {{ args: object, source: { coveragePath: string, script?: string, configKey?: string }, existsSync?: Function, logger: object }} opts
 * @returns {(opts: object) => Promise<number>}
 */
function artifactCheckedCapture(locked, { args, source, existsSync, logger }) {
  return requireCaptureArtifact(
    creditedCapture(locked, { requireCredited: args.requireCredited, logger }),
    { ...source, cwd: args.cwd, existsSync, logger },
  );
}

function reportTimings(timings, logger, lockHooks) {
  logger.info(`[coverage-capture] ${formatSuiteTimings(timings)}`);
  lockHooks.onTimings(timings);
}

/** @param {string[]} argv */
function rerunCommandFor(argv) {
  return ['node', ...argv.slice(1)].join(' ');
}

/**
 * @param {{ crap: object, coverage: object, args: object, capture: Function, deps: object }} opts
 * @returns {Promise<number>}
 */
async function runCaptureScopes({ crap, coverage, args, capture, deps }) {
  const {
    getChangedFilesImpl,
    isCoverageFreshImpl,
    computeContentDigestImpl,
    writeCaptureStampImpl,
    filterFilesUnderTargetsImpl,
    readPackageScriptsImpl,
    hasNpmScriptImpl,
    logger,
  } = deps;

  // Shared so a new seam cannot reach one capture path and miss the other.
  // A scoped `null` means not applicable: fall through to full scope.
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

  const incrementalResult = await tryScopedCapture({
    ...shared,
    filterFilesUnderTargetsImpl,
    readPackageScriptsImpl,
    hasNpmScriptImpl,
  });
  if (incrementalResult !== null) return incrementalResult;

  return await runFullScopeCapture(shared);
}

// Module-level so coverage sees them even when no test spawns the CLI.
function exitWith(code) {
  process.exit(code);
}

function exitOnUnexpectedError(err) {
  Logger.error('[coverage-capture] unexpected error:', err);
  process.exit(1);
}

// cli-opt-out: main resolves an exit code that is forwarded via process.exit(code); runAsCli's async-main signature does not preserve the result code.
if (isDirectInvocation(import.meta.url)) {
  // `--help` must not reach the core, which would spawn the whole suite.
  (handleCoverageCaptureHelp(process.argv)
    ? Promise.resolve(0)
    : runCoverageCapture()
  ).then(exitWith, exitOnUnexpectedError);
}
