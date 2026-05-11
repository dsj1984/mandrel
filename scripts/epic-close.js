#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-close.js — Epic-level close entry point with preflight guard.
 *
 * Wires the self-healing checks registry into the front of any Epic-close
 * flow. Runs `runChecks({ scope: 'epic-close', autoFix: true })` against
 * the assembled state probe; if any `blocker` finding survives, prints a
 * `id · summary · fixCommand` table and exits with code 2 (the project's
 * reserved "preflight refused" exit code, mirrored by `story-close.js`
 * and the npm test wrapper).
 *
 * On a clean preflight (no blockers, possibly some auto-corrected
 * findings), the script logs the auto-fix summary and delegates to the
 * existing close-tail logic. The close-tail is intentionally a no-op
 * placeholder today — epic-close is currently a thin front-door that
 * exists so future work can pipe Epic-level integration tasks (PR merge,
 * branch reap, retro hook) through a single preflight-guarded entry.
 *
 * Usage:
 *   node .agents/scripts/epic-close.js [--epic <epicId>]
 *
 * Exit codes:
 *   0 → preflight clean, delegated close-tail succeeded
 *   1 → unexpected error (anything other than preflight refusal)
 *   2 → preflight refused (blocker findings)
 *
 * @see .agents/scripts/lib/preflight-runner.js
 * @see .agents/scripts/lib/checks/README.md
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
 * Run the epic-close entry point. Exported for testing — the unit test
 * harness drives this directly with injected probes / fixture registry
 * rather than spawning a subprocess.
 *
 * @param {object} [opts]
 * @param {string} [opts.epicId]
 * @param {string} [opts.cwd=process.cwd()]
 * @param {object} [opts.probes]   Test-only — forwarded to assembleState.
 * @param {object} [opts.registry] Test-only — bypass loadRegistry.
 * @param {string} [opts.dir]      Test-only fixture directory.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [opts.logger]
 * @returns {Promise<{ status: 'ok' | 'blocked', findings: Array, fixed: Array }>}
 */
export async function runEpicClose({
  epicId,
  cwd = process.cwd(),
  probes,
  registry,
  dir,
  logger = DEFAULT_LOGGER,
} = {}) {
  logger.info(
    `[epic-close] Running preflight checks (scope=epic-close) for Epic #${epicId ?? '?'}...`,
  );
  const preflight = await runPreflight({
    scope: 'epic-close',
    autoFix: true,
    cwd,
    probes,
    registry,
    dir,
    logger,
  });
  if (preflight.blocked) {
    return {
      status: 'blocked',
      findings: preflight.findings,
      fixed: preflight.fixed,
    };
  }
  // Close-tail placeholder. Today epic-close.js exists as the preflight
  // front door; subsequent Stories under Epic #1143 may add PR merge, retro
  // hook, and branch reap here. The placeholder logs that the front door
  // is clear so operators can distinguish "preflight passed; nothing to
  // do" from "preflight passed; close-tail ran" in audit logs.
  logger.info(
    '[epic-close] preflight clean — close-tail is currently a no-op.',
  );
  return {
    status: 'ok',
    findings: preflight.findings,
    fixed: preflight.fixed,
  };
}

runAsCli(
  import.meta.url,
  async () => {
    const epicIdArg = process.argv.find((a) => a.startsWith('--epic='));
    const epicId = epicIdArg
      ? epicIdArg.slice('--epic='.length)
      : (() => {
          const i = process.argv.indexOf('--epic');
          return i >= 0 ? process.argv[i + 1] : undefined;
        })();
    const result = await runEpicClose({ epicId });
    if (result.status === 'blocked') {
      process.exit(PREFLIGHT_REFUSED_EXIT_CODE);
    }
  },
  { source: 'epic-close' },
);
