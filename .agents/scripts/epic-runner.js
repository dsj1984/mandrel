#!/usr/bin/env node
/* node:coverage ignore file */
/**
 * Epic Runner — thin CLI wrapper around `lib/orchestration/epic-runner.js`.
 *
 * Usage:
 *   node .agents/scripts/epic-runner.js --epic <epicId> [--dry-run]
 *
 * The engine no longer fans out via `child_process.spawn`. Story dispatch is
 * performed in-session by the `/epic-execute` slash command using the Agent
 * tool, so this CLI is dry-run-only — it computes the per-wave dispatch list
 * the skill would consume and prints it without touching ticket state.
 * Operators driving an Epic to completion should use `/epic-execute <epicId>`
 * from their Claude session.
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
    const dispatchPlan = await buildDispatchPlan({
      epicId: args.epicId,
      orchestration: config.orchestration,
      concurrencyCap: epicRunner.concurrencyCap,
    });
    console.log(
      JSON.stringify(
        {
          epicId: args.epicId,
          dryRun: true,
          epicRunner,
          waves: dispatchPlan,
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
      '  re-run with `--dry-run` to print the per-wave dispatch plan.',
  );
  process.exit(2);
}

/**
 * Build the per-wave dispatch list the `/epic-execute` skill consumes.
 * Reuses the engine's snapshot + build-wave-dag phases so the dry-run output
 * matches what the skill will dispatch at runtime.
 *
 * @returns {Promise<Array<{ wave: number, stories: Array<{ storyId: number, title?: string, modelTier: string, worktree?: string }> }>>}
 */
async function buildDispatchPlan({ epicId, orchestration, concurrencyCap }) {
  const [
    { createProvider },
    { runSnapshotPhase },
    { runBuildWaveDagPhase },
    { StoryLauncher },
  ] = await Promise.all([
    import('./lib/provider-factory.js'),
    import('./lib/orchestration/epic-runner/phases/snapshot.js'),
    import('./lib/orchestration/epic-runner/phases/build-wave-dag.js'),
    import('./lib/orchestration/epic-runner/story-launcher.js'),
  ]);

  const provider = createProvider(orchestration);
  const ctx = { epicId, provider };

  let state = {};
  state = await runSnapshotPhase(ctx, {}, state);
  state = await runBuildWaveDagPhase(ctx, {}, state);

  const launcher = new StoryLauncher({ concurrencyCap });
  return state.waves.map((stories, index) => ({
    wave: index,
    stories: launcher.planWave(stories).map((entry, i) => ({
      ...entry,
      title: stories[i]?.title,
    })),
  }));
}

runAsCli(import.meta.url, main, { source: 'EpicRunner' });
