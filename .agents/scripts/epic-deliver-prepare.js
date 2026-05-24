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
 *   3. The seeded `epic-run-state` checkpoint (`epic-run-state-store.initialize`)
 *      — idempotent, so re-running prepare against a partially-driven Epic
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
import {
  initialize as initializeEpicRunState,
  write as writeEpicRunState,
} from './lib/orchestration/epic-run-state-store.js';
import {
  collectPendingStoryKeys,
  evaluateConcurrencyGate,
  filterFindingsToPending,
  renderGateErrorMessage,
} from './lib/orchestration/epic-runner/concurrency-gate.js';
import { runBuildWaveDagPhase } from './lib/orchestration/epic-runner/phases/build-wave-dag.js';
import { runSnapshotPhase } from './lib/orchestration/epic-runner/phases/snapshot.js';
import { StoryLauncher } from './lib/orchestration/epic-runner/story-launcher.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-prepare.js --epic <epicId> [--ignore-concurrency-hazards]

Snapshots Epic #<id>, builds the wave DAG, initializes the epic-run-state
checkpoint, and prints the per-wave dispatch plan as JSON.

Options:
  --ignore-concurrency-hazards   Bypass the cross-Story concurrency-hazard
                                 gate (Story #2297). The flag's use is
                                 recorded on the Epic checkpoint so retro
                                 tooling can flag a run that shipped
                                 despite an outstanding hazard.
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
  injectedFindings,
  ignoreConcurrencyHazards = false,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'runEpicDeliverPrepare: --epic must be a positive integer',
    );
  }

  const config = injectedConfig ?? resolveConfig({ cwd });
  if (!config.github) {
    throw new Error('runEpicDeliverPrepare: no github block in .agentrc.json');
  }
  const provider = injectedProvider ?? createProvider(config);
  const { deliverRunner } = getRunners(config);
  const concurrencyCap = deliverRunner.concurrencyCap;

  const ctx = { epicId, provider };
  let state = {};
  state = await runSnapshotPhase(ctx, {}, state);
  state = await runBuildWaveDagPhase(ctx, {}, state);

  // Cross-Story concurrency-hazard gate (Story #2297). Findings come in
  // via DI; no default loader is wired yet — production callers will
  // either pass findings derived from the persisted manifest or rely on
  // the empty default (gate trivially passes).
  const findings = Array.isArray(injectedFindings) ? injectedFindings : [];
  const pendingKeys = collectPendingStoryKeys(state.waves);
  const pendingFindings = filterFindingsToPending(findings, pendingKeys);
  const concurrencyPolicy = {
    failOnConcurrencyHazards:
      config?.delivery?.failOnConcurrencyHazards === true,
  };
  const gate = evaluateConcurrencyGate({
    findings: pendingFindings,
    policy: concurrencyPolicy,
    ignore: ignoreConcurrencyHazards === true,
  });
  if (gate.tripped && !gate.bypassed) {
    const ownerRepo =
      config?.github?.owner && config?.github?.repo
        ? `${config.github.owner}/${config.github.repo}`
        : undefined;
    throw new Error(renderGateErrorMessage(gate.findings, ownerRepo));
  }
  if (gate.tripped && gate.bypassed) {
    Logger.warn(
      `[epic-deliver-prepare] ⚠️  Concurrency-hazard gate bypassed via --ignore-concurrency-hazards (reason=${gate.reason}, count=${gate.findings.length}).`,
    );
  }

  const totalWaves = state.waves.length;
  const checkpointState = await initializeEpicRunState({
    provider,
    epicId,
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

  // Persist the plan onto the checkpoint so `wave-tick.js` (which reads
  // state.plan as `Array<Array<{ id|storyId, title?, worktree? }>>`) can
  // resolve the next wave's stories. Without this write the tick reports
  // every wave as `wave-complete: empty` and the delivery stalls.
  const tickPlan = plan.map((wave) => wave.stories);
  // Persist the `--ignore-concurrency-hazards` flag on the checkpoint
  // so retro tooling can flag a run that shipped despite an outstanding
  // hazard (the warning above is one-shot; the checkpoint is durable).
  const checkpointPayload = { ...checkpointState, plan: tickPlan };
  if (gate.bypassed) {
    checkpointPayload.ignoreConcurrencyHazards = true;
  }
  await writeEpicRunState({ provider, epicId, state: checkpointPayload });

  return {
    epicId,
    totalWaves,
    concurrencyCap,
    plan,
    checkpointInitializedAt:
      checkpointState.startedAt ??
      checkpointState.lastUpdatedAt ??
      new Date().toISOString(),
    concurrencyHazardsBypassed: gate.bypassed,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'ignore-concurrency-hazards': { type: 'boolean', default: false },
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

  const result = await runEpicDeliverPrepare({
    epicId,
    ignoreConcurrencyHazards: values['ignore-concurrency-hazards'] === true,
  });
  Logger.info(JSON.stringify(result, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-prepare' });
