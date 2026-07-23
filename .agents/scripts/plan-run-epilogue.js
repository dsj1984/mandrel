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
  warnOnUnresolvedBase(result);
  warnOnEmptyRollup(result);
  Logger.info(JSON.stringify(result));
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
 * would look complete while covering nothing. Not fatal — with no diff the
 * selector degrades to keyword-only lens selection, so the rest of the
 * roster is still useful.
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

/**
 * Surface a zero-signal roll-up over a multi-Story run as a loud operator
 * warning (Story #4578).
 *
 * The failure this exists to prevent is a *reassuring* one. The roll-up read
 * "No friction signals — nothing to follow up" for a 7-Story run that
 * contained a mid-run git outage, a parked worker needing an operator
 * resume, and an acceptance critic that needed four rounds. Nothing was
 * broken in the roll-up — the stream really was empty — but the report was
 * indistinguishable from a clean run, so the retro loop that exists to learn
 * from a run was silently blind to that run's pain.
 *
 * Not fatal: a genuinely friction-free multi-Story run is possible, and this
 * cannot tell the two apart — which is precisely why it asks the operator
 * rather than asserting either reading.
 *
 * @param {object} result - `runPlanRunEpilogue` envelope.
 * @returns {void}
 */
function warnOnEmptyRollup(result) {
  const rollup = (result?.results ?? []).find(
    (r) => r?.kind === 'follow-up-rollup',
  );
  if (!rollup?.emptyRollupSuspect) return;
  Logger.warn(
    `⚠️  0 friction signals across ${rollup.storyCount} Stories — telemetry may not ` +
      `have fired.\n` +
      `    An empty roll-up is NOT evidence of a clean run: it is the same output a ` +
      `run with\n` +
      `    heavy friction produces when nothing recorded it. The runtime emits ` +
      `friction from its\n` +
      `    own observables (agent::blocked transitions, failed closes, exhausted ` +
      `merge waits), so\n` +
      `    zero here also means none of those fired. If this run had friction you ` +
      `can name, that\n` +
      `    telemetry gap is itself worth filing.`,
  );
}

await runAsCli(import.meta.url, main);
