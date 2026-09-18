#!/usr/bin/env node

/**
 * Read-only: probes a stranded Story's live state and prints the ONE command
 * that resumes it — never a menu, and never a re-dispatch, which would re-run
 * init under live work and put a second close on one PR. Covers the
 * merged-but-label-stale Story that `/mandrel-deliver` refuses outright.
 *
 * Exit codes: 0 a shape resolved (including nothing-to-recover), 1 the probe
 * itself could not run.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  recoverStory,
  renderRecovery,
} from './lib/orchestration/deliver-recover.js';
import { PROJECT_ROOT } from './lib/project-root.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/deliver-recover.js --story <id> [--cwd <main-repo>] [--json] [--no-reprobe]

Probes a Story's live delivery state — labels, lease, branch, worktree, PR
state and checks — and prints the single next command that resumes it, with
the evidence it was derived from. Read-only: mutates nothing.

The command always resumes the existing worker or close (or closes an already
pushed branch); it never re-dispatches the Story, which would re-run init
underneath live work. A worker that returned no terminal envelope is expected —
the orchestrator owns the close-and-land tail.

Mid-flight shapes (executing-*/closing-*) get a stability re-probe after a
short settle window: matching shapes return the fresher verdict; diverging
shapes report \`in-transition\` (a live delivery process is mutating the
state) instead of a confidently wrong command.

Flags:
  --story       GitHub issue number of the Story (required).
  --cwd         Main-repo checkout to probe (default: project root).
  --json        Emit the full recovery envelope as JSON instead of prose.
  --no-reprobe  Skip the stability re-probe (single-probe verdict).
  --help        Show this message.
`;

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      cwd: { type: 'string' },
      json: { type: 'boolean', default: false },
      'no-reprobe': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: false,
  });
  return {
    storyId: Number.parseInt(String(values.story ?? ''), 10),
    cwd: values.cwd ?? null,
    json: Boolean(values.json),
    reprobe: !values['no-reprobe'],
    help: Boolean(values.help),
  };
}

/**
 * @param {object} [args]
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   createProviderImpl?: typeof createProvider,
 *   recoverStoryImpl?: typeof recoverStory,
 *   renderRecoveryImpl?: typeof renderRecovery,
 *   logger?: { info: Function },
 * }} [deps]
 */
export async function runDeliverRecover(
  {
    storyId: storyIdParam,
    cwd: cwdParam,
    json: jsonParam,
    reprobe: reprobeParam,
    argv,
    injectedProvider,
    injectedConfig,
    injectedGh,
    injectedGitSpawn,
    injectedSleepFn,
  } = {},
  {
    resolveConfigImpl = resolveConfig,
    createProviderImpl = createProvider,
    recoverStoryImpl = recoverStory,
    renderRecoveryImpl = renderRecovery,
    logger = Logger,
  } = {},
) {
  const parsed =
    storyIdParam !== undefined
      ? {
          storyId: storyIdParam,
          cwd: cwdParam ?? null,
          json: !!jsonParam,
          reprobe: reprobeParam ?? true,
        }
      : parseArgv(argv ?? process.argv.slice(2));

  if (parsed.help) {
    logger.info(HELP);
    return { success: true, result: null };
  }
  if (!Number.isInteger(parsed.storyId) || parsed.storyId <= 0) {
    throw new Error(
      'Usage: node deliver-recover.js --story <STORY_ID> [--cwd <main-repo>] [--json]',
    );
  }

  const cwd = parsed.cwd ?? PROJECT_ROOT;
  const config = injectedConfig || resolveConfigImpl({ cwd });
  const provider = injectedProvider || createProviderImpl(config);

  const recovery = await recoverStoryImpl({
    storyId: parsed.storyId,
    cwd,
    provider,
    config,
    gh: injectedGh,
    gitSpawnFn: injectedGitSpawn,
    reprobe: parsed.reprobe,
    ...(injectedSleepFn ? { sleepFn: injectedSleepFn } : {}),
  });

  logger.info(
    parsed.json
      ? JSON.stringify(recovery, null, 2)
      : renderRecoveryImpl(recovery),
  );
  return { success: true, result: recovery };
}

runAsCli(import.meta.url, runDeliverRecover, {
  source: 'deliver-recover',
  usage: HELP,
});
