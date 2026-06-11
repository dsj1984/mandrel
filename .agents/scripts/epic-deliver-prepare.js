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
import { currentBranch as gitCurrentBranch } from './lib/git-branch-lifecycle.js';
import { getEpicBranch, gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import {
  resolveOperator,
  runPrepareGuards,
} from './lib/orchestration/epic-deliver-lease-guard.js';
import {
  initialize as initializeEpicRunState,
  reconcileResumePointer,
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

  // Preflight guards (Story #3482): fail closed on a dirty/foreign-branch
  // checkout and on a live foreign Epic lease, BEFORE any snapshot or git
  // mutation runs. The guards are injectable so the unit suite exercises them
  // without a real repo. They are skipped when an explicit `skipPreflightGuards`
  // is set, OR — implicitly — when a caller injects a provider but no git seam:
  // that combination is the signature of the pre-existing prepare-runner unit
  // tests that assert the DAG/checkpoint behaviour against an in-memory
  // provider and never stand up a working tree. The real CLI path passes
  // neither `injectedProvider` nor `injectedGit`, so the guards always run for
  // an operator-driven invocation.
  const guardsSuppressed =
    skipPreflightGuards || (Boolean(injectedProvider) && !injectedGit);
  if (!guardsSuppressed) {
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
    // guard is inert — `heartbeatAt` defaults to null, `isClaimLive(null)` is
    // false, and every foreign claim looks stale and gets silently reclaimed
    // (audit #3513). Read the Epic's current assignee (the claim owner) and
    // resolve that owner's latest heartbeat from the Epic lifecycle ledger
    // (`temp/epic-<id>/lifecycle.ndjson`) via the shared resolver, so a LIVE
    // foreign claim actually refuses and only a genuinely stale/absent one is
    // reclaimed. Tests may inject `leaseHeartbeatAt` directly (any value,
    // including null) to bypass the ledger read; the CLI passes nothing.
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

  // Story #3027: try the preflight cache first so we don't re-walk Epic
  // → Feature → Story when `epic-deliver-preflight.js` already did. The
  // cache key is a deterministic fingerprint of the Epic ticket plus the
  // cached Story snapshots (Story #4019): the Epic re-fetch plus one
  // getTicket per cached Story is still far cheaper than the full
  // hierarchy BFS, and a Story-dependency edit now invalidates the cache.
  // Cache miss or baseSha mismatch → fall back to a fresh pass.
  const ctx = { epicId, provider };
  let state = {};
  let cacheStatus = 'miss';
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
      state = {
        epic: cached.epic,
        stories: cached.stories,
        waves: cached.waves,
      };
      cacheStatus = 'hit';
    } else {
      cacheStatus = 'stale';
    }
  }
  if (cacheStatus !== 'hit') {
    state = await runSnapshotPhase(ctx, {}, state);
    state = await runBuildWaveDagPhase(ctx, {}, state);
  }

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

  // Story #3358 — reconcile the resume pointer against the recomputed
  // plan. On a resumed Epic, `build-wave-dag.js` drops the already-merged
  // (closed) Stories, so the recomputed plan is shorter and re-indexed
  // from 0. The preserved `currentWave`/`waves[]` reference the *old*
  // index space; left untouched, `wave-tick.js` would index
  // `plan[currentWave]` into the new plan and dispatch the wrong wave.
  // Prepare owns the `plan` field, so it owns the pointer that indexes
  // into it. When the plan changed, reset the pointer to 0 and drop the
  // stale history; when it is byte-identical (idempotent re-prepare),
  // preserve in-flight progress verbatim.
  const { currentWave, waves } = reconcileResumePointer(
    checkpointState,
    checkpointState.plan,
    tickPlan,
  );

  // Persist the `--ignore-concurrency-hazards` flag on the checkpoint
  // so retro tooling can flag a run that shipped despite an outstanding
  // hazard (the warning above is one-shot; the checkpoint is durable).
  const checkpointPayload = {
    ...checkpointState,
    plan: tickPlan,
    currentWave,
    waves,
  };
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
