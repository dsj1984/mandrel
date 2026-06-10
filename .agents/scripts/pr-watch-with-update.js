#!/usr/bin/env node
/**
 * pr-watch-with-update.js — Phase 8 "watch until green" CLI.
 *
 * Polls the PR's required checks to a terminal state and auto-recovers
 * from `mergeStateStatus: BEHIND` (via bounded `gh pr update-branch`
 * calls) by delegating to the shared `watchPrToTerminal` primitive in
 * the lifecycle `Watcher` — the SAME loop the listener runs, so the CLI
 * and the bus path are byte-for-byte equivalent. No lifecycle bus is
 * created; this is a direct, synchronous watch with a real exit code.
 *
 * Contract (Story #3902):
 *   - Blocks until every required check is terminal (or the poll cap
 *     fires).
 *   - Prints the final `{ checkName: outcome }` map to stdout as JSON.
 *   - Exits 0 only when every required check is green
 *     (success / neutral / skipped); exits non-zero otherwise (red
 *     check, timed-out poll cap, or an unresolvable `gh pr checks`
 *     failure) so the calling workflow can gate on the exit code.
 *
 * Usage:
 *   node .agents/scripts/pr-watch-with-update.js --pr <n> [--repo owner/repo]
 *     [--max-updates N] [--poll-interval-ms MS] [--max-polls N]
 */
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import { watchPrToTerminal } from './lib/orchestration/lifecycle/listeners/watcher.js';

function parsePositiveInt(raw, fallback) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Run the watch loop and resolve to the exit code (0 = all green,
 * 1 = not green / failed). Exported for tests so the green / red /
 * BEHIND paths can be exercised with injected `gh` spawns and no
 * `process.exit`.
 *
 * @param {object} opts
 * @param {number} opts.prNumber
 * @param {string|null} [opts.repo]
 * @param {number} [opts.maxUpdates]
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.maxPolls]
 * @param {Function} [opts.ghPrChecksFn]   inject for tests
 * @param {Function} [opts.ghPrViewFn]     inject for tests
 * @param {Function} [opts.ghPrUpdateBranchFn] inject for tests
 * @param {Function} [opts.sleepFn]        inject for tests
 * @param {object} [opts.logger]
 * @param {(line: string) => void} [opts.print] stdout sink (default console.log)
 * @returns {Promise<number>} process exit code.
 */
export async function runPrWatch({
  prNumber,
  repo = null,
  maxUpdates,
  pollIntervalMs,
  maxPolls,
  ghPrChecksFn,
  ghPrViewFn,
  ghPrUpdateBranchFn,
  sleepFn,
  logger = Logger,
  print = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (!Number.isInteger(prNumber) || prNumber < 1)
    throw new TypeError('runPrWatch: --pr requires a positive integer');

  // `gh` accepts a bare PR number or a URL; passing `<repo>#<n>` lets
  // `gh` resolve the right repository without a URL. When `--repo` is
  // omitted, `gh` infers the repo from the cwd's remote.
  const prRef = repo ? `${repo}#${prNumber}` : String(prNumber);

  const result = await watchPrToTerminal({
    prUrl: prRef,
    cwd: process.cwd(),
    maxPolls: parsePositiveInt(maxPolls, 180),
    maxUpdates: parsePositiveInt(maxUpdates, 3),
    pollIntervalMs: parsePositiveInt(pollIntervalMs, 10_000),
    ...(ghPrChecksFn ? { ghPrChecksFn } : {}),
    ...(ghPrViewFn ? { ghPrViewFn } : {}),
    ...(ghPrUpdateBranchFn ? { ghPrUpdateBranchFn } : {}),
    ...(sleepFn ? { sleepFn } : {}),
    logger,
  });

  // Always print the final outcomes map so the operator (and the
  // workflow log) can see exactly which check blocked.
  print(
    JSON.stringify({
      prNumber,
      checkOutcomes: result.outcomes,
      requiredChecks: result.requiredChecks,
      polls: result.polls,
      updatesApplied: result.updatesApplied,
      terminal: result.terminal,
      green: result.green,
      ...(result.error ? { error: result.error } : {}),
    }),
  );

  if (result.error) {
    logger.error?.(
      `[pr-watch] could not resolve required checks: ${result.error}`,
    );
    return 1;
  }
  if (!result.terminal) {
    logger.error?.(
      `[pr-watch] poll cap reached before every required check went terminal (polls=${result.polls}).`,
    );
    return 1;
  }
  if (!result.green) {
    const red = Object.entries(result.outcomes)
      .filter(([, v]) => v !== 'success' && v !== 'neutral' && v !== 'skipped')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    logger.error?.(`[pr-watch] required check(s) not green: ${red}`);
    return 1;
  }
  logger.info?.('[pr-watch] all required checks green.');
  return 0;
}

async function main() {
  const { values } = parseArgs({
    options: {
      pr: { type: 'string' },
      repo: { type: 'string' },
      'max-updates': { type: 'string' },
      'poll-interval-ms': { type: 'string' },
      'max-polls': { type: 'string' },
    },
    strict: false,
  });
  return runPrWatch({
    prNumber: Number.parseInt(values.pr ?? '', 10),
    repo: values.repo ?? null,
    maxUpdates: values['max-updates'],
    pollIntervalMs: values['poll-interval-ms'],
    maxPolls: values['max-polls'],
  });
}

runAsCli(import.meta.url, main, {
  source: 'pr-watch-with-update',
  propagateExitCode: true,
});
