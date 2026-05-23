#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * wave-tick.js — thin CLI shim around `lib/wave-runner/tick.js`.
 *
 * Reads the `epic-run-state` checkpoint plus fresh Story labels and
 * prints one `WaveTickResult` envelope. The slash-command operator
 * (`/epic-deliver`) consumes the envelope to decide whether to dispatch
 * the next wave, observe in-flight stories, or finalize the Epic.
 *
 * Usage:
 *   node .agents/scripts/wave-tick.js --epic <epicId> [--once]
 *
 * `--once` is the default and currently the only mode — the function is
 * stateless, so "loop until terminal" is the caller's job (today: the
 * markdown's wave loop). The flag is reserved for forward compatibility
 * with an internal polling mode.
 *
 * Output: one JSON object on stdout. Schema in `lib/wave-runner/tick.js`.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { createProvider } from './lib/provider-factory.js';
import { tick } from './lib/wave-runner/tick.js';

const HELP = `Usage: node .agents/scripts/wave-tick.js --epic <epicId> [--once]

Stateless wave-loop planner. Reads the epic-run-state checkpoint on
Epic #<id>, evaluates the live story-label state, and prints one
WaveTickResult envelope describing the next dispatchable action.
`;

export async function runWaveTickCli({
  epicId,
  cwd,
  injectedProvider,
  injectedConfig,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runWaveTickCli: --epic must be a positive integer');
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  const provider = injectedProvider ?? createProvider(config);

  const result = await tick({
    epic: epicId,
    collaborators: { provider },
    ctx: { config },
  });

  return result;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      epic: { type: 'string' },
      once: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const epicId = Number.parseInt(
    String(values.epic ?? '').replace(/^#/, ''),
    10,
  );
  if (!Number.isInteger(epicId) || epicId <= 0) {
    Logger.error('wave-tick: --epic <id> is required (positive integer)');
    process.exitCode = 2;
    return;
  }

  const result = await runWaveTickCli({ epicId });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

runAsCli(import.meta.url, () => main(process.argv.slice(2)), {
  source: 'wave-tick',
});
