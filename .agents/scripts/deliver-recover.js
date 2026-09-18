#!/usr/bin/env node

/**
 * deliver-recover.js — probe a stranded Story's live state and print the ONE
 * command that resumes it (Story #4543).
 *
 * Read-only by construction. This CLI mutates nothing: it reads the ticket's
 * labels and lease, the Story branch locally and via its tracking ref, the
 * worktree, and the PR (state + checks), then walks a fixed decision table
 * and prints one command with the evidence it was derived from. It never
 * prints a menu — a menu of options is what the operator already has, and it
 * is the thing they cannot act on.
 *
 * The strand this exists for above all others is the **merged-but-label-stale**
 * Story: a `/mandrel-deliver` re-run refuses it outright, because
 * `single-story-init.js` hard-errors on an already-closed Story. Before this
 * surface, that Story had no automated way back.
 *
 * Every command it prints **resumes** — it re-enters the in-flight worker or
 * close, or closes the branch that is already pushed. None of them re-dispatch
 * the Story, and that is deliberate: since Story #4876 the close-and-land tail
 * belongs to the dispatching orchestrator, so a worker returning without a
 * terminal envelope is the expected shape rather than evidence the Story never
 * ran. Answering it with a fresh dispatch re-runs `single-story-init.js`
 * underneath live work and puts a second close on one PR.
 *
 * Usage:
 *   node .agents/scripts/deliver-recover.js --story <STORY_ID> [--cwd <main-repo>]
 *                                           [--json]
 *
 * Exit codes:
 *   0 — a recovery shape was resolved and its next command printed (including
 *       the "nothing to recover" shapes). Reading state is not a failure.
 *   1 — the probe itself could not run (unreadable ticket, bad input).
 *
 * @see .agents/scripts/lib/orchestration/deliver-recover.js
 * @see .agents/schemas/story-deliver-terminal.schema.json
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
 * Probe and report. Exported for testing.
 *
 * The optional final `deps` parameter is the module's injectable seam
 * (`docs/contributing/test-seams.md` rules 1-2): config resolution, provider
 * construction, the probe itself, the renderer, and the log sink each default
 * to the real implementation, so the CLI path and every production caller are
 * unchanged. The pre-existing `injected*` fields on the first argument stay
 * supported for callers already threading a resolved provider/config.
 *
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
