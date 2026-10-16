/**
 * The ordered capture passes for `coverage-capture.js` and the capture-script
 * refusal. A shared source is one pass: the existing pipeline, scoped modes
 * included. An own CRAP source (`crap.ownCoverageSource`) first refreshes the
 * coverage gate's artifact exactly as before, then gives the CRAP artifact
 * its own full-scope pass via `crap.captureScript`, stamped in its own
 * directory. Scoped capture modes never apply to the own source.
 */
import { runFullScopeCapture } from './coverage-capture-fullscope.js';

const COVERAGE_GATE_SCRIPT = 'test:coverage';
const COVERAGE_PATH_KEY = 'delivery.quality.gates.coverage.coveragePath';
const CRAP_PATH_KEY = 'delivery.quality.gates.crap.coveragePath';
const CRAP_SCRIPT_KEY = 'delivery.quality.gates.crap.captureScript';

/**
 * The exit code when no capture may run: the CRAP gate is off (0), or its
 * capture script is missing from `package.json` (1, naming the fix).
 *
 * @param {{ crap: object, scripts: object, hasNpmScriptImpl: Function, logger: object }} opts
 * @returns {number|null}
 */
export function captureRefusal({ crap, scripts, hasNpmScriptImpl, logger }) {
  if (crap.enabled === false) {
    logger.info('[coverage-capture] CRAP gate disabled — skipping capture.');
    return 0;
  }
  const script = crap.captureScript ?? COVERAGE_GATE_SCRIPT;
  if (hasNpmScriptImpl(scripts, script)) return null;
  // Name the fix rather than propagate npm's opaque "Missing script" exit.
  logger.error(
    `[coverage-capture] ✖ No "${script}" script in package.json (the CRAP capture script, set by ${CRAP_SCRIPT_KEY}). ` +
      `Add one (e.g. "${script}": "node --test --experimental-test-coverage"), ` +
      `point ${CRAP_SCRIPT_KEY} at an existing script, ` +
      'or disable the CRAP gate via delivery.quality.gates.crap.enabled=false.',
  );
  return 1;
}

/**
 * @param {{ crap: object, coverage: object, scripts: object, hasNpmScriptImpl: Function, logger: object }} opts
 * @returns {Array<{ crap: object, configKey: string, own: boolean }>}
 */
function planPasses({ crap, coverage, scripts, hasNpmScriptImpl, logger }) {
  if (crap.ownCoverageSource !== true) {
    return [{ crap, configKey: COVERAGE_PATH_KEY, own: false }];
  }
  const ownPass = { crap, configKey: CRAP_PATH_KEY, own: true };
  if (!hasNpmScriptImpl(scripts, COVERAGE_GATE_SCRIPT)) {
    logger.info(
      `[coverage-capture] No "${COVERAGE_GATE_SCRIPT}" script — skipping the coverage gate's capture; only the CRAP source at ${crap.coveragePath} is refreshed.`,
    );
    return [ownPass];
  }
  const gateCrap = {
    ...crap,
    coveragePath: coverage.coveragePath,
    captureScript: COVERAGE_GATE_SCRIPT,
  };
  return [
    { crap: gateCrap, configKey: COVERAGE_PATH_KEY, own: false },
    ownPass,
  ];
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
    `[coverage-capture] CRAP gate has its own coverage source (${CRAP_PATH_KEY}=${crap.coveragePath}, npm run ${crap.captureScript}).`,
  );
  return runFullScopeCapture({
    ...deps,
    crap,
    coverage,
    args,
    runCaptureImpl: capture,
  });
}
