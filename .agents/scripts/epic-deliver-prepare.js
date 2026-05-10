#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-prepare.js — Step 0/1 of the operator-driven `/epic-deliver`.
 *
 * Composes the existing engine phases that the in-process epic-runner used to
 * call sequentially, but does NOT dispatch any waves. The CLI is the single
 * point at which the slash-command captures:
 *
 *   1. The Epic ticket snapshot (`runSnapshotPhase`).
 *   2. The wave DAG (`runBuildWaveDagPhase`) computed from every child Story.
 *   3. The seeded `epic-run-state` checkpoint (`Checkpointer.initialize`) —
 *      idempotent, so re-running prepare against a partially-driven Epic
 *      preserves the original `startedAt`.
 *   4. The per-wave dispatch plan (`StoryLauncher.planWave`) — a deterministic
 *      list of `{ storyId, worktree }` entries that the slash command feeds
 *      into N parallel `Agent` tool calls per wave.
 *
 * Stdout is a single JSON envelope so the slash command can parse without
 * re-reading any tickets.
 *
 * Usage:
 *   node .agents/scripts/epic-deliver-prepare.js --epic <epicId>
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { getRunners, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { Checkpointer } from './lib/orchestration/epic-runner/checkpointer.js';
import { runBuildWaveDagPhase } from './lib/orchestration/epic-runner/phases/build-wave-dag.js';
import { runSnapshotPhase } from './lib/orchestration/epic-runner/phases/snapshot.js';
import { StoryLauncher } from './lib/orchestration/epic-runner/story-launcher.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-prepare.js --epic <epicId>

Snapshots Epic #<id>, builds the wave DAG, initializes the epic-run-state
checkpoint, and prints the per-wave dispatch plan as JSON.
`;

/**
 * End-to-end prepare. DI-friendly: tests pass `injectedProvider` and skip the
 * real GitHub round-trips.
 *
 * @param {{
 *   epicId: number,
 *   cwd?: string,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   totalWaves: number,
 *   concurrencyCap: number,
 *   plan: Array<{ wave: number, stories: Array<{ storyId: number, title: string, worktree?: string }> }>,
 *   checkpointInitializedAt: string,
 * }>}
 */
export async function runEpicDeliverPrepare({
  epicId,
  cwd,
  injectedProvider,
  injectedConfig,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverPrepare: --epic must be a positive integer',
    );
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  if (!config.orchestration) {
    throw new Error(
      'runEpicDeliverPrepare: no orchestration block in .agentrc.json',
    );
  }
  const provider = injectedProvider ?? createProvider(config.orchestration);
  const { deliverRunner } = getRunners(config.orchestration);
  const concurrencyCap = deliverRunner.concurrencyCap;

  const ctx = { epicId, provider };
  let state = {};
  state = await runSnapshotPhase(ctx, {}, state);
  state = await runBuildWaveDagPhase(ctx, {}, state);

  const totalWaves = state.waves.length;
  const checkpointer = new Checkpointer({ provider, epicId });
  const checkpointState = await checkpointer.initialize({
    totalWaves,
    concurrencyCap,
  });

  const launcher = new StoryLauncher({ concurrencyCap });
  const plan = state.waves.map((stories, index) => ({
    wave: index,
    stories: launcher.planWave(stories).map((entry, i) => ({
      ...entry,
      title: stories[i]?.title ?? '',
    })),
  }));

  return {
    epicId,
    totalWaves,
    concurrencyCap,
    plan,
    checkpointInitializedAt:
      checkpointState.startedAt ??
      checkpointState.lastUpdatedAt ??
      new Date().toISOString(),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });

  if (values.help) {
    Logger.info(HELP);
    return;
  }
  const epicId = Number.parseInt(values.epic ?? '', 10);
  if (Number.isNaN(epicId) || epicId <= 0) {
    Logger.error('[epic-deliver-prepare] ERROR: --epic <epicId> is required.');
    Logger.error(HELP);
    process.exit(2);
  }

  const result = await runEpicDeliverPrepare({ epicId });
  Logger.info(JSON.stringify(result, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-prepare' });
