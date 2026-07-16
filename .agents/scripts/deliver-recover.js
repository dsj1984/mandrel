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
 * Story: a `/deliver` re-run refuses it outright, because
 * `single-story-init.js` hard-errors on an already-closed Story. Before this
 * surface, that Story had no automated way back.
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

const HELP = `Usage: node .agents/scripts/deliver-recover.js --story <id> [--cwd <main-repo>] [--json]

Probes a Story's live delivery state — labels, lease, branch, worktree, PR
state and checks — and prints the single next command that resumes it, with
the evidence it was derived from. Read-only: mutates nothing.

Flags:
  --story   GitHub issue number of the Story (required).
  --cwd     Main-repo checkout to probe (default: project root).
  --json    Emit the full recovery envelope as JSON instead of prose.
  --help    Show this message.
`;

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      cwd: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: false,
  });
  return {
    storyId: Number.parseInt(String(values.story ?? ''), 10),
    cwd: values.cwd ?? null,
    json: Boolean(values.json),
    help: Boolean(values.help),
  };
}

/**
 * Probe and report. Exported for testing.
 */
export async function runDeliverRecover({
  storyId: storyIdParam,
  cwd: cwdParam,
  json: jsonParam,
  argv,
  injectedProvider,
  injectedConfig,
  injectedGh,
  injectedGitSpawn,
} = {}) {
  const parsed =
    storyIdParam !== undefined
      ? { storyId: storyIdParam, cwd: cwdParam ?? null, json: !!jsonParam }
      : parseArgv(argv ?? process.argv.slice(2));

  if (parsed.help) {
    Logger.info(HELP);
    return { success: true, result: null };
  }
  if (!Number.isInteger(parsed.storyId) || parsed.storyId <= 0) {
    throw new Error(
      'Usage: node deliver-recover.js --story <STORY_ID> [--cwd <main-repo>] [--json]',
    );
  }

  const cwd = parsed.cwd ?? PROJECT_ROOT;
  const config = injectedConfig || resolveConfig({ cwd });
  const provider = injectedProvider || createProvider(config);

  const recovery = await recoverStory({
    storyId: parsed.storyId,
    cwd,
    provider,
    config,
    gh: injectedGh,
    gitSpawnFn: injectedGitSpawn,
  });

  Logger.info(
    parsed.json ? JSON.stringify(recovery, null, 2) : renderRecovery(recovery),
  );
  return { success: true, result: recovery };
}

runAsCli(import.meta.url, runDeliverRecover, { source: 'deliver-recover' });
