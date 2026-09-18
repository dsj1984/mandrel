#!/usr/bin/env node
/**
 * plan-run-epilogue.js — execute the real per-run closeout for a
 * multi-Story `/mandrel-deliver`.
 *
 * Usage:
 *   node .agents/scripts/plan-run-epilogue.js --stories 1,2,3
 *   node .agents/scripts/plan-run-epilogue.js --stories 101-104   # inclusive range
 *
 * Keyed on the delivered id set via a synthesized `adhoc-<sorted-ids>` run id.
 */

import './lib/runtime-deps/ensure-installed.js';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { runPlanRunEpilogue } from './lib/orchestration/run-epilogue.js';
import { createProvider } from './lib/provider-factory.js';
import { expandIdList } from './lib/util/parse-id-list.js';

const CLI_OPTIONS = {
  stories: { type: 'string' },
  cwd: { type: 'string' },
  /** Opt-in; see `run-epilogue.js` RUN_EPILOGUE_STEP_KINDS. */
  'audit-roster': { type: 'boolean', default: false },
};

/**
 * @param {string[]} [argv]
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   createProviderImpl?: typeof createProvider,
 *   runPlanRunEpilogueImpl?: typeof runPlanRunEpilogue,
 *   logger?: { info: Function, warn: Function },
 * }} [deps]
 * @returns {Promise<object>}
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    resolveConfigImpl = resolveConfig,
    createProviderImpl = createProvider,
    runPlanRunEpilogueImpl = runPlanRunEpilogue,
    logger = Logger,
  } = deps;
  const { values } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    strict: false,
  });
  if (typeof values.stories !== 'string' || !values.stories.trim()) {
    throw new Error('Usage: node plan-run-epilogue.js --stories 1,2,3');
  }
  const cwd = values.cwd?.trim() || process.cwd();
  const config = resolveConfigImpl({ cwd });
  const provider = createProviderImpl(config);

  // Ranges expand as at the operator surface; a bad token throws rather than
  // silently producing an empty, wrongly-keyed rollup.
  const { ids: stories, error: storiesError } = expandIdList(values.stories, {
    flag: '--stories',
    prefix: '[plan-run-epilogue] ',
  });
  if (storiesError) {
    throw new Error(storiesError);
  }

  const planRunId = `adhoc-${[...stories].sort((a, b) => a - b).join('-')}`;

  const result = await runPlanRunEpilogueImpl({
    planRunId,
    stories,
    provider,
    config,
    cwd,
    auditRoster: values['audit-roster'] === true,
  });
  warnOnUnresolvedBase(result, logger);
  warnOnEmptyRollup(result, logger);
  logger.info(JSON.stringify(result));
  if (result.errors?.length) {
    process.exitCode = 1;
  }
  return result;
}

/**
 * Warn (not fatal) when the combined landed diff is unresolvable under
 * `--audit-roster`: silence would read as "nothing changed" and the lens walk
 * would look complete while covering nothing.
 *
 * @param {object} result - `runPlanRunEpilogue` envelope.
 * @param {{ warn: Function }} [logger]
 * @returns {void}
 */
function warnOnUnresolvedBase(result, logger = Logger) {
  const roster = (result?.results ?? []).find(
    (r) => r?.kind === 'audit-roster',
  );
  const base = roster?.baseResolution;
  if (base?.resolved !== false) return;
  logger.warn(
    `⚠️  Combined landed diff unavailable — the pre-run base sha could not be ` +
      `resolved against \`${base.baseRef}\`: ${base.reason}\n` +
      `    changedFiles is null (NOT an empty set). Determine the run diff by ` +
      `hand before walking the selected lenses.`,
  );
}

/**
 * Warn on a zero-signal roll-up over a multi-Story run: it is
 * indistinguishable from a run whose friction went unrecorded, so the
 * operator decides which it was.
 *
 * @param {object} result - `runPlanRunEpilogue` envelope.
 * @param {{ warn: Function }} [logger]
 * @returns {void}
 */
function warnOnEmptyRollup(result, logger = Logger) {
  const rollup = (result?.results ?? []).find(
    (r) => r?.kind === 'follow-up-rollup',
  );
  if (!rollup?.emptyRollupSuspect) return;
  logger.warn(
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

await runAsCli(import.meta.url, main, {
  usage: {
    invocation:
      'node .agents/scripts/plan-run-epilogue.js --stories <id,id,...> [--cwd <path>] [--audit-roster]',
    summary:
      'Close out a delivery run: roll up the delivered Stories’ signals and report the run’s loop health.',
    flags: [
      [
        '--stories <ids>',
        'Comma-separated delivered Story ids, singles or A-B ranges (required).',
      ],
      ['--cwd <path>', 'Repository root (default: process cwd).'],
      [
        '--audit-roster',
        'Also select the cross-Story audit lens roster and post plan-run-audit-roster (off by default; the host then walks every listed lens).',
      ],
    ],
  },
});
