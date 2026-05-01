#!/usr/bin/env node
/* node:coverage ignore file */
/**
 * Epic Runner — thin CLI wrapper around `lib/orchestration/epic-runner.js`.
 *
 * Usage:
 *   node .agents/scripts/epic-runner.js --epic <epicId> [--dry-run]
 *
 * The engine no longer fans out via `child_process.spawn`. Story dispatch is
 * performed by the `/epic-execute` slash command using the in-session Agent
 * tool, so this CLI is dry-run-only — it computes the wave plan and prints
 * the engine config without dispatching any Story. Operators driving an Epic
 * to completion should use `/epic-execute <epicId>` from their Claude session.
 */

import { runAsCli } from './lib/cli-utils.js';

function parseArgs(argv) {
  const args = { epicId: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--epic') {
      args.epicId = Number(argv[++i]);
    } else if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag === '--help' || flag === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printUsage() {
  console.log(
    'Usage: node .agents/scripts/epic-runner.js --epic <epicId> [--dry-run]',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (!args.epicId || Number.isNaN(args.epicId)) {
    console.error('[epic-runner] ERROR: --epic <epicId> is required.');
    printUsage();
    process.exit(2);
  }

  const { getRunners, resolveConfig, validateOrchestrationConfig } =
    await import('./lib/config-resolver.js');

  let config;
  try {
    config = resolveConfig();
    validateOrchestrationConfig(config.orchestration);
  } catch (err) {
    console.error(
      `[epic-runner] ERROR: orchestration config schema validation failed:\n${err.message}`,
    );
    process.exit(2);
  }

  if (!config.orchestration) {
    console.error(
      '[epic-runner] ERROR: no orchestration block in .agentrc.json.',
    );
    process.exit(1);
  }

  const { epicRunner } = getRunners(config.orchestration);

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          epicId: args.epicId,
          dryRun: true,
          epicRunner,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error(
    '[epic-runner] ERROR: this CLI no longer dispatches Stories on its own.\n' +
      '  Story fan-out runs in-session via the Agent tool — invoke the\n' +
      '  `/epic-execute <epicId>` slash command from a Claude session, or\n' +
      '  re-run with `--dry-run` to print the wave plan + config.',
  );
  process.exit(2);
}

runAsCli(import.meta.url, main, { source: 'EpicRunner' });
