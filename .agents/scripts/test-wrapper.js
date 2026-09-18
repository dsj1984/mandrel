#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * `pretest` preflight: runs the self-healing checks (scope `npm-test`) so the
 * suite refuses to start in a known-bad state; a surviving blocker exits 2,
 * which aborts the npm lifecycle. `SKIP_PREFLIGHT=1` bypasses it.
 */

import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import {
  PREFLIGHT_REFUSED_EXIT_CODE,
  runPreflight,
} from './lib/preflight-runner.js';

const DEFAULT_LOGGER = {
  info: (msg) => Logger.info(msg),
  warn: (msg) => Logger.warn(msg),
  error: (msg) => Logger.error(msg),
};

/**
 * @param {object} [opts]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]   Test-only.
 * @param {object} [opts.registry] Test-only.
 * @param {string} [opts.dir]      Test-only.
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
    if (process.env.SKIP_PREFLIGHT === '1') {
      Logger.warn(
        '[npm-test] SKIP_PREFLIGHT=1 — bypassing preflight checks (debugging mode).',
      );
      return;
    }
    const result = await runTestWrapperPreflight();
    if (result.status === 'blocked') {
      process.exit(PREFLIGHT_REFUSED_EXIT_CODE);
    }
  },
  { source: 'test-wrapper' },
);
