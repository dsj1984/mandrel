/**
 * Capture passes, the refusal, and the registration predicate close, the
 * handoff and `verify[]` credit share. An own CRAP source gets a second,
 * full-scope pass after the coverage gate's.
 */
import { COVERAGE_CAPTURE_DEFAULTS } from './config/gates/coverage.schema.js';
import { runFullScopeCapture } from './coverage-capture-fullscope.js';
import { hasNpmScript } from './npm-scripts.js';

const COVERAGE_PATH_KEY = 'delivery.quality.gates.coverage.coveragePath';
const COVERAGE_SCRIPT_KEY = 'delivery.quality.gates.coverage.captureScript';
const CRAP_PATH_KEY = 'delivery.quality.gates.crap.coveragePath';
const CRAP_SCRIPT_KEY = 'delivery.quality.gates.crap.captureScript';

/**
 * The resolved `{ crap, coverage }` pair a `getQuality` seam returns, with the
 * coverage gate's capture fields always present: a shared source's artifact
 * is the CRAP one, and the script defaults to the coverage gate default.
 *
 * @param {{ crap: object, coverage?: object }} quality
 * @returns {{ crap: object, coverage: object }}
 */
export function captureGates({ crap, coverage }) {
  const sharedPath = crap.ownCoverageSource ? undefined : crap.coveragePath;
  return {
    crap,
    coverage: {
      ...coverage,
      coveragePath:
        coverage?.coveragePath ??
        sharedPath ??
        COVERAGE_CAPTURE_DEFAULTS.coveragePath,
      captureScript:
        coverage?.captureScript ?? COVERAGE_CAPTURE_DEFAULTS.captureScript,
    },
  };
}

/** @param {{ crap: object, coverage: object }} gates */
export function isCaptureGateEnabled({ crap, coverage }) {
  return crap.enabled !== false || coverage.enabled !== false;
}

/** @param {object} crap */
function crapOwnsSource(crap) {
  return crap.enabled !== false && crap.ownCoverageSource === true;
}

/** An enabled CRAP gate's own source, else the coverage gate's. @param {{ crap: object, coverage: object }} gates */
export function primaryCaptureSource({ crap, coverage }) {
  return crapOwnsSource(crap)
    ? {
        coveragePath: crap.coveragePath,
        captureScript: crap.captureScript,
        scriptKey: CRAP_SCRIPT_KEY,
      }
    : {
        coveragePath: coverage.coveragePath,
        captureScript: coverage.captureScript,
        scriptKey: COVERAGE_SCRIPT_KEY,
      };
}

/** @param {{ crap: object, coverage: object, scripts: object|null|undefined, hasNpmScriptImpl?: Function }} opts */
export function isCaptureActive({
  crap,
  coverage,
  scripts,
  hasNpmScriptImpl = hasNpmScript,
}) {
  return (
    isCaptureGateEnabled({ crap, coverage }) &&
    hasNpmScriptImpl(
      scripts,
      primaryCaptureSource({ crap, coverage }).captureScript,
    )
  );
}

/**
 * 0 when both gates are off, 1 (naming the fix) when the script is missing.
 *
 * @param {{ crap: object, coverage: object, scripts: object, hasNpmScriptImpl: Function, logger: object }} opts
 */
export function captureRefusal({
  crap,
  coverage,
  scripts,
  hasNpmScriptImpl,
  logger,
}) {
  if (!isCaptureGateEnabled({ crap, coverage })) {
    logger.info(
      '[coverage-capture] CRAP and coverage gates disabled — skipping capture.',
    );
    return 0;
  }
  const { captureScript: script, scriptKey } = primaryCaptureSource({
    crap,
    coverage,
  });
  if (hasNpmScriptImpl(scripts, script)) return null;
  // Name the fix rather than propagate the package manager's opaque exit.
  logger.error(
    `[coverage-capture] ✖ No "${script}" script in package.json (the capture script, set by ${scriptKey}). ` +
      `Add one (e.g. "${script}": "node --test --experimental-test-coverage"), ` +
      `point ${scriptKey} at an existing script, ` +
      'or disable the coverage and CRAP gates via delivery.quality.gates.{coverage,crap}.enabled=false.',
  );
  return 1;
}

/**
 * @param {{ crap: object, coverage: object, scripts: object, hasNpmScriptImpl: Function, logger: object }} opts
 * @returns {Array<{ crap: object, configKey: string, own: boolean }>}
 */
function planPasses({ crap, coverage, scripts, hasNpmScriptImpl, logger }) {
  const gateCrap = {
    ...crap,
    coveragePath: coverage.coveragePath,
    captureScript: coverage.captureScript,
  };
  const gatePass = { crap: gateCrap, configKey: COVERAGE_PATH_KEY, own: false };
  if (!crapOwnsSource(crap)) return [gatePass];
  const ownPass = { crap, configKey: CRAP_PATH_KEY, own: true };
  if (!hasNpmScriptImpl(scripts, coverage.captureScript)) {
    logger.info(
      `[coverage-capture] No "${coverage.captureScript}" script — skipping the coverage gate's capture; only the CRAP source at ${crap.coveragePath} is refreshed.`,
    );
    return [ownPass];
  }
  return [gatePass, ownPass];
}

/**
 * A capture runner that defaults `script` to the pass's capture script; an
 * explicit `script` (the affected scope's) still wins.
 *
 * @param {Function} capture
 * @param {string|undefined} script
 * @returns {Function}
 */
function withDefaultScript(capture, script) {
  return script ? (opts) => capture({ script, ...opts }) : capture;
}

/**
 * Run each planned pass; the first non-zero pass wins and no later pass runs.
 *
 * @param {{
 *   crap: object,
 *   coverage: object,
 *   args: object,
 *   scripts: object,
 *   hasNpmScriptImpl: Function,
 *   makeCapture: (source: { coveragePath: string, script?: string, configKey: string }) => Function,
 *   runShared: (opts: object) => Promise<number>,
 *   deps: object,
 * }} opts
 * @returns {Promise<number>}
 */
export async function runCapturePasses({
  crap,
  coverage,
  args,
  scripts,
  hasNpmScriptImpl,
  makeCapture,
  runShared,
  deps,
}) {
  const { logger } = deps;
  const passes = planPasses({
    crap,
    coverage,
    scripts,
    hasNpmScriptImpl,
    logger,
  });
  for (const pass of passes) {
    const capture = withDefaultScript(
      makeCapture({
        coveragePath: pass.crap.coveragePath,
        script: pass.crap.captureScript,
        configKey: pass.configKey,
      }),
      pass.crap.captureScript,
    );
    const code = pass.own
      ? await runOwnSource({ crap: pass.crap, coverage, args, capture, deps })
      : await runShared({ crap: pass.crap, coverage, args, capture, deps });
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * @param {{ crap: object, coverage: object, args: object, capture: Function, deps: object }} opts
 * @returns {Promise<number>}
 */
function runOwnSource({ crap, coverage, args, capture, deps }) {
  deps.logger.info(
    `[coverage-capture] CRAP gate has its own coverage source (${CRAP_PATH_KEY}=${crap.coveragePath}, capture script ${crap.captureScript}).`,
  );
  return runFullScopeCapture({
    ...deps,
    crap,
    coverage,
    args,
    runCaptureImpl: capture,
  });
}
