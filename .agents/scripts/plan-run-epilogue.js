#!/usr/bin/env node
/**
 * plan-run-epilogue.js — execute the real per-run closeout for
 * `/deliver --run <planRunId>` and positional multi-Story delivers.
 *
 * Usage:
 *   node .agents/scripts/plan-run-epilogue.js --run <planRunId>
 *   node .agents/scripts/plan-run-epilogue.js --run <planRunId> --stories 1,2,3
 *   node .agents/scripts/plan-run-epilogue.js --stories 1,2,3
 *
 * When `--stories` is omitted, `--run` is required and the set is resolved
 * via plan-run labels (`state=all` so landed Stories are included).
 * When `--stories` is supplied without `--run`, an adhoc planRunId is
 * synthesized from the sorted Story ids.
 */

import './lib/runtime-deps/ensure-installed.js';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  fetchPlanRunIssues,
  normalizePlanRunLabel,
  resolvePlanRunFromIssues,
} from './lib/orchestration/resolve-plan-run.js';
import { runPlanRunEpilogue } from './lib/orchestration/run-epilogue.js';
import { createProvider } from './lib/provider-factory.js';

const CLI_OPTIONS = {
  run: { type: 'string' },
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
  const runFlag = typeof values.run === 'string' ? values.run.trim() : '';
  const hasStoriesFlag =
    typeof values.stories === 'string' && values.stories.trim().length > 0;
  if (!runFlag && !hasStoriesFlag) {
    throw new Error(
      'Usage: node plan-run-epilogue.js (--run <planRunId> | --stories 1,2,3) [--stories 1,2,3]',
    );
  }
  const cwd =
    typeof values.cwd === 'string' && values.cwd.trim()
      ? values.cwd.trim()
      : process.cwd();
  const config = resolveConfig({ cwd });
  const provider = createProvider(config);

  let stories = [];
  if (hasStoriesFlag) {
    stories = values.stories
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } else {
    const planRunLabel = normalizePlanRunLabel(runFlag);
    const issues = await fetchPlanRunIssues(provider, {
      planRunLabel,
      state: 'all',
    });
    const envelope = resolvePlanRunFromIssues({ run: runFlag, issues });
    stories = (envelope.stories ?? [])
      .map((s) => Number(s?.id ?? s))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  const planRunId =
    runFlag || `adhoc-${[...stories].sort((a, b) => a - b).join('-')}`;

  const result = await runPlanRunEpilogue({
    planRunId,
    stories,
    provider,
    config,
    cwd,
  });
  warnOnUnresolvedBase(result);
  Logger.info(JSON.stringify(result, null, 2));
  if (result.errors?.length) {
    process.exitCode = 1;
  }
  return result;
}

/**
 * Surface an unresolvable combined landed diff as a loud operator warning.
 *
 * The roster's changed-file set is the input the host walks its audit lenses
 * against; a silent absence would read as "nothing changed" and the lens walk
 * would look complete while covering nothing. Not fatal — lens selection is
 * independent of the diff, so the rest of the roster is still useful.
 *
 * @param {object} result - `runPlanRunEpilogue` envelope.
 * @returns {void}
 */
function warnOnUnresolvedBase(result) {
  const roster = (result?.results ?? []).find(
    (r) => r?.kind === 'audit-roster',
  );
  const base = roster?.baseResolution;
  if (base?.resolved !== false) return;
  Logger.warn(
    `⚠️  Combined landed diff unavailable — the pre-run base sha could not be ` +
      `resolved against \`${base.baseRef}\`: ${base.reason}\n` +
      `    changedFiles is null (NOT an empty set). Determine the run diff by ` +
      `hand before walking the selected lenses.`,
  );
}

await runAsCli(import.meta.url, main);
