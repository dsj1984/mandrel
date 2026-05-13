#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * test-wrapper.js — npm-test preflight gate.
 *
 * Story #1289 wires the self-healing checks registry in front of
 * `npm test` so the suite refuses to start in a known-bad state (e.g.
 * core.bare flipped on the main checkout, missing `.env` / `.mcp.json`
 * bootstrap files, etc.). The wrapper runs
 * `runChecks({ scope: 'npm-test', autoFix: true })` against the assembled
 * state probe; on any surviving blocker it prints a `id · summary ·
 * fixCommand` table and exits with code 2 (the project-wide "preflight
 * refused" reservation).
 *
 * On a clean preflight npm continues to `.agents/scripts/run-tests.js`, which
 * execs the underlying Node test runner and cleans test-reserved temp
 * artefacts afterward. This wrapper itself adds no top-level npm dependencies.
 *
 * Wiring: `package.json` points `pretest` at this script. The `test`
 * script remains the node --test invocation so `npm test` still picks up
 * `pretest` automatically per npm lifecycle rules. A failed pretest aborts
 * the lifecycle without invoking the test runner — exit code 2 propagates
 * out through npm.
 *
 * Bypass: set `SKIP_PREFLIGHT=1` to skip the gate entirely (used by the
 * `coverage` script which manages its own preflight separately, and by
 * any debugging session that needs the suite to run despite a known
 * blocker the operator is iterating on).
 *
 * Usage:
 *   node .agents/scripts/test-wrapper.js              # full preflight + test
 *   SKIP_PREFLIGHT=1 node .agents/scripts/test-wrapper.js  # skip gate
 */

import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import {
  PREFLIGHT_REFUSED_EXIT_CODE,
  runPreflight,
} from './lib/preflight-runner.js';

/** Default Logger adapter — same shape preflight-runner uses. */
const DEFAULT_LOGGER = {
  info: (msg) => Logger.info(msg),
  warn: (msg) => Logger.warn(msg),
  error: (msg) => Logger.error(msg),
};

/**
 * Run the npm-test preflight gate. Exported so unit tests can drive it
 * directly with an inline registry, without actually spawning the test
 * runner. Returns `{ status: 'ok' | 'blocked' }` plus the findings/fixed
 * arrays from the runner.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]   Test-only probe injection.
 * @param {object} [opts.registry] Test-only inline registry — bypasses
 *   `loadRegistry()`.
 * @param {string} [opts.dir]      Test-only fixture directory.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [opts.logger]
 * @returns {Promise<{ status: 'ok' | 'blocked', findings: Array, fixed: Array }>}
 */
export async function runTestWrapperPreflight({
  cwd = process.cwd(),
  probes,
  registry,
  dir,
  logger = DEFAULT_LOGGER,
} = {}) {
  logger.info('[npm-test] Running preflight checks (scope=npm-test)...');
  const preflight = await runPreflight({
    scope: 'npm-test',
    autoFix: true,
    cwd,
    probes,
    registry,
    dir,
    logger,
  });
  return {
    status: preflight.blocked ? 'blocked' : 'ok',
    findings: preflight.findings,
    fixed: preflight.fixed,
  };
}

runAsCli(
  import.meta.url,
  async () => {
    // Operator bypass for iterative debugging — see the file header.
    if (process.env.SKIP_PREFLIGHT === '1') {
      Logger.warn(
        '[npm-test] SKIP_PREFLIGHT=1 — bypassing preflight checks (debugging mode).',
      );
      return;
    }
    const result = await runTestWrapperPreflight();
    if (result.status === 'blocked') {
      // The wrapper never spawns the test runner on a blocked preflight.
      // Exit code 2 propagates out through `npm run pretest` and short-
      // circuits the `npm test` lifecycle before the test command runs.
      process.exit(PREFLIGHT_REFUSED_EXIT_CODE);
    }
  },
  { source: 'test-wrapper' },
);
