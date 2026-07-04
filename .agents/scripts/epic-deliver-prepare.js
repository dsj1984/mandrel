#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-deliver-prepare.js — Step 0/1 of the operator-driven `/deliver`.
 *
 * Composes the existing engine phases that the in-process epic-runner used to
 * call sequentially, but does NOT dispatch any Stories. The CLI is the single
 * point at which the slash-command captures:
 *
 *   1. The Epic ticket snapshot (`runSnapshotPhase`).
 *   2. The story DAG (`runBuildWaveDagPhase`) computed from every child Story —
 *      used here only to enumerate the open Story set and run the
 *      concurrency-hazard gate; the ready-set runtime re-derives readiness
 *      from live labels on every `tick`, so the prepare no longer persists a
 *      wave grouping.
 *   3. The seeded `epic-run-state` checkpoint (`epic-run-state-store.initialize`)
 *      in the per-Story-status shape (Story #4155): a flat
 *      `stories: { [storyId]: { status: 'pending' } }` map plus the GLOBAL
 *      in-flight `concurrencyCap`. Idempotent — re-running prepare against a
 *      partially-driven Epic preserves the original `startedAt` and every
 *      already-recorded Story status (it never resets recorded progress).
 *   4. The dispatch hint (`StoryLauncher.planWave`) — a deterministic list of
 *      `{ storyId, worktree }` entries the slash command uses to resolve
 *      per-Story worktree paths. The ready-set `tick` selects which of these
 *      to dispatch on each beat; the prepare only enumerates the set.
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
import { currentBranch as gitCurrentBranch } from './lib/git-branch-lifecycle.js';
import { getEpicBranch, gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import {
  resolveOperator,
  runPrepareGuards,
} from './lib/orchestration/epic-deliver-lease-guard.js';
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
import {
  computeBaseSha,
  readPreflightCache,
} from './lib/orchestration/preflight-cache.js';
import {
  latestHeartbeatForOwner,
  currentOwner as leaseCurrentOwner,
} from './lib/orchestration/ticket-lease.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-deliver-prepare.js --epic <epicId> [--ignore-concurrency-hazards] [--steal] [--as <handle>]

Snapshots Epic #<id>, builds the wave DAG, initializes the epic-run-state
checkpoint, and prints the per-wave dispatch plan as JSON. Before any of that,
runs two fail-closed preflight guards (Story #3482): a checkout-safety check
(refuse on a dirty tree or an unexpected branch) and an Epic-lease acquisition
(refuse on a live foreign claim).

Options:
  --ignore-concurrency-hazards   Bypass the cross-Story concurrency-hazard
                                 gate (Story #2297). The flag's use is
                                 recorded on the Epic checkpoint so retro
                                 tooling can flag a run that shipped
                                 despite an outstanding hazard.
  --steal                        Forcibly transfer a live foreign Epic lease
                                 to this operator instead of refusing. The
                                 takeover is logged for auditability.
  --as <handle>                  Operator identity to claim the Epic lease as.
                                 Defaults to github.operatorHandle, then the
                                 local git config user.email.
`;

/**
 * Build the production git shim the checkout-safety guard reads through. Pure
 * `git` subprocess wrappers over `cwd`; injected as a seam so the unit suite
 * can substitute an in-memory shim.
 *
 * @param {string} cwd
 * @returns {{ statusPorcelain: () => { dirty: boolean, entries: string }, currentBranch: () => string|null }}
 */
function createGitShim(cwd) {
  return {
    statusPorcelain() {
      const res = gitSpawn(cwd, 'status', '--porcelain');
      if (res.status !== 0) {
        throw new Error(
          `[epic-deliver] Failed to read git status: ${res.stderr || '(no stderr)'}`,
        );
      }
      const entries = res.stdout ?? '';
      return { dirty: entries.length > 0, entries };
    },
    currentBranch() {
      return gitCurrentBranch(cwd);
    },
  };
}

/**
 * Resolve the local `git config user.email` as the last-resort operator
 * identity. Returns null when git is unavailable or the value is unset.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveGitUserEmail(cwd) {
  const res = gitSpawn(cwd, 'config', 'user.email');
  if (res.status !== 0) return null;
  const value = (res.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}

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
 *   storyCount: number,
 *   concurrencyCap: number,
 *   stories: Array<{ storyId: number, title: string, worktree?: string }>,
 *   checkpointInitializedAt: string,
 * }>}
 */
/**
 * Run the fail-closed preflight guards (Story #3482): refuse on a
 * dirty/foreign-branch checkout and on a live foreign Epic lease, BEFORE any
 * snapshot or git mutation. No-op when guards are suppressed. The guards are
 * skipped when `skipPreflightGuards` is set, OR — implicitly — when a caller
 * injects a provider but no git seam (the signature of the prepare-runner
 * unit tests that drive an in-memory provider and never stand up a tree). The
 * real CLI path injects neither, so the guards always run for an
 * operator-driven invocation. Story #4075 — extracted from
 * `runEpicDeliverPrepare`.
 */
async function runPreflightGuardsForPrepare({
  epicId,
  cwd,
  config,
  provider,
  injectedProvider,
  injectedGit,
  asOperator,
  steal,
  leaseHeartbeatAt,
  leaseNow,
  skipPreflightGuards,
}) {
  const guardsSuppressed =
    skipPreflightGuards || (Boolean(injectedProvider) && !injectedGit);
  if (guardsSuppressed) return;

  const guardCwd = cwd ?? process.cwd();
  const git = injectedGit ?? createGitShim(guardCwd);
  const baseBranch = config.project?.baseBranch ?? 'main';
  const expectedBranch = [getEpicBranch(epicId), baseBranch];
  const operator =
    resolveOperator({
      asFlag: asOperator,
      config,
      gitUserEmail: injectedGit ? undefined : resolveGitUserEmail(guardCwd),
    }) ?? null;

  // Liveness seam: a foreign claim is only "live" (and so refuses) when the
  // claim *owner* has a recent `story.heartbeat`. Without this the lease
  // guard is inert — every foreign claim looks stale and gets silently
  // reclaimed (audit #3513). Read the Epic's current assignee (the claim
  // owner) and resolve that owner's latest heartbeat from the Epic lifecycle
  // ledger via the shared resolver. Tests may inject `leaseHeartbeatAt`
  // directly (any value, including null) to bypass the ledger read.
  let heartbeatAt = leaseHeartbeatAt;
  if (heartbeatAt === undefined) {
    const epicTicket = await provider.getTicket(epicId);
    const claimOwner = leaseCurrentOwner(epicTicket?.assignees);
    heartbeatAt = claimOwner
      ? latestHeartbeatForOwner({ epicId, owner: claimOwner, config })
      : null;
  }

  await runPrepareGuards({
    epicId,
    expectedBranch,
    git,
    provider,
    operator,
    heartbeatAt,
    steal,
    config,
    now: leaseNow,
    logger: Logger,
  });
}

/**
 * Resolve the Epic state, preferring the preflight cache (Story #3027) and
 * falling back to a fresh snapshot + wave-DAG pass on miss or baseSha
 * mismatch. Returns `{ state, cacheStatus }`. Story #4075 — extracted from
 * `runEpicDeliverPrepare`.
 */
async function resolvePrepareState({ epicId, cwd, provider }) {
  const cached = await readPreflightCache({ epicId, cwd });
  if (cached) {
    const freshEpic = await provider.getTicket(epicId);
    const cachedStoryIds = cached.stories
      .map((s) => Number(s?.id ?? s?.number))
      .filter((id) => Number.isInteger(id) && id > 0);
    const freshStories = await Promise.all(
      cachedStoryIds.map((id) => provider.getTicket(id)),
    );
    const freshBaseSha = computeBaseSha(freshEpic, freshStories);
    if (freshBaseSha === cached.baseSha) {
      return {
        state: {
          epic: cached.epic,
          stories: cached.stories,
          waves: cached.waves,
        },
        cacheStatus: 'hit',
      };
    }
  }
  const ctx = { epicId, provider };
  let state = await runSnapshotPhase(ctx, {}, {});
  state = await runBuildWaveDagPhase(ctx, {}, state);
  return { state, cacheStatus: cached ? 'stale' : 'miss' };
}

/**
 * Evaluate the cross-Story concurrency-hazard gate (Story #2297). Throws on a
 * tripped, non-bypassed gate; warns (and returns `gate`) on a bypassed trip.
 * Story #4075 — extracted from `runEpicDeliverPrepare`.
 */
function evaluatePrepareConcurrencyGate({
  config,
  waves,
  injectedFindings,
  ignoreConcurrencyHazards,
}) {
  const findings = Array.isArray(injectedFindings) ? injectedFindings : [];
  const pendingKeys = collectPendingStoryKeys(waves);
  const pendingFindings = filterFindingsToPending(findings, pendingKeys);
  const gate = evaluateConcurrencyGate({
    findings: pendingFindings,
    policy: {
      failOnConcurrencyHazards:
        config?.delivery?.failOnConcurrencyHazards === true,
    },
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
  return gate;
}

export async function runEpicDeliverPrepare({
  epicId,
  cwd,
  injectedProvider,
  injectedConfig,
  injectedFindings,
  ignoreConcurrencyHazards = false,
  steal = false,
  asOperator,
  injectedGit,
  leaseHeartbeatAt,
  leaseNow,
  skipPreflightGuards = false,
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

  await runPreflightGuardsForPrepare({
    epicId,
    cwd,
    config,
    provider,
    injectedProvider,
    injectedGit,
    asOperator,
    steal,
    leaseHeartbeatAt,
    leaseNow,
    skipPreflightGuards,
  });

  const { state, cacheStatus } = await resolvePrepareState({
    epicId,
    cwd,
    provider,
  });

  const gate = evaluatePrepareConcurrencyGate({
    config,
    waves: state.waves,
    injectedFindings,
    ignoreConcurrencyHazards,
  });

  // Flatten the wave-DAG into the open Story set. The ready-set runtime
  // re-derives readiness from live labels on every tick, so the checkpoint
  // stores only the Story set in scope (seeded at `pending`) and the global
  // in-flight cap — no wave grouping, no `currentWave`, no `totalWaves`.
  const openStories = state.waves.flat();
  const checkpointState = await initializeEpicRunState({
    provider,
    epicId,
    storyIds: openStories,
    concurrencyCap,
  });

  // Resolve per-Story worktree paths via the launcher so the slash command
  // has a deterministic `{ storyId, worktree, title }` list to seed Agent
  // dispatch from. This is a dispatch *hint* — the ready-set tick decides
  // which Stories to dispatch on each beat; the prepare only enumerates them.
  const launcher = new StoryLauncher({ concurrencyCap });
  const stories = launcher.planWave(openStories).map((entry, i) => ({
    ...entry,
    title: openStories[i]?.title ?? '',
  }));

  // Persist the `--ignore-concurrency-hazards` flag on the checkpoint so
  // retro tooling can flag a run that shipped despite an outstanding hazard
  // (the warning above is one-shot; the checkpoint is durable).
  if (gate.bypassed) {
    await writeEpicRunState({
      provider,
      epicId,
      state: { ...checkpointState, ignoreConcurrencyHazards: true },
    });
  }

  return {
    epicId,
    storyCount: openStories.length,
    concurrencyCap,
    stories,
    checkpointInitializedAt:
      checkpointState.startedAt ??
      checkpointState.lastUpdatedAt ??
      new Date().toISOString(),
    concurrencyHazardsBypassed: gate.bypassed,
    preflightCache: cacheStatus,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'ignore-concurrency-hazards': { type: 'boolean', default: false },
      steal: { type: 'boolean', default: false },
      as: { type: 'string' },
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
    steal: values.steal === true,
    asOperator: typeof values.as === 'string' ? values.as : undefined,
  });
  Logger.info(JSON.stringify(result, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-deliver-prepare' });
