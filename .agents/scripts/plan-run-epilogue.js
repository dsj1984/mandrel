#!/usr/bin/env node
/**
 * plan-run-epilogue.js — execute the real per-run closeout for a
 * multi-Story `/deliver`.
 *
 * Usage:
 *   node .agents/scripts/plan-run-epilogue.js --stories 1,2,3
 *
 * Keyed on the delivered id set: an `adhoc-<sorted-ids>` run id is
 * synthesized from `--stories`. Story #4540 retired the `--run <planRunId>`
 * label-resolution branch along with the `plan-run::<id>` label itself.
 */

import './lib/runtime-deps/ensure-installed.js';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { runPlanRunEpilogue } from './lib/orchestration/run-epilogue.js';
import { createProvider } from './lib/provider-factory.js';

const CLI_OPTIONS = {
  stories: { type: 'string' },
  cwd: { type: 'string' },
};

/**
 * @param {string[]} [argv]
 * @returns {Promise<object>}
 */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    strict: false,
  });
  const hasStoriesFlag =
    typeof values.stories === 'string' && values.stories.trim().length > 0;
  if (!hasStoriesFlag) {
    throw new Error('Usage: node plan-run-epilogue.js --stories 1,2,3');
  }
  const cwd =
    typeof values.cwd === 'string' && values.cwd.trim()
      ? values.cwd.trim()
      : process.cwd();
  const config = resolveConfig({ cwd });
  const provider = createProvider(config);

  // Story #4540 retired the `--run <planRunId>` label-resolution branch
  // along with the label itself. The epilogue is keyed on the delivered id
  // set, and the synthesized `adhoc-<ids>` id it already used for positional
  // runs is now the only id it needs.
  const stories = values.stories
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  const planRunId = `adhoc-${[...stories].sort((a, b) => a - b).join('-')}`;

  const result = await runPlanRunEpilogue({
    planRunId,
    stories,
    provider,
    config,
    cwd,
  });
  Logger.info(JSON.stringify(result, null, 2));
  if (result.errors?.length) {
    process.exitCode = 1;
  }
  return result;
}

await runAsCli(import.meta.url, main);
