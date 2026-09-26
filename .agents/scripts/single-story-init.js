#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * single-story-init.js — initialize a Story for `/mandrel-deliver`: validate,
 * take the lease, flip to `agent::executing` (before provisioning, so the
 * claim is visible during the install window; a later failure rolls it back),
 * seed `story-<id>` from the base branch locally, and materialise the
 * worktree when isolation is on.
 *
 * @see .agents/workflows/helpers/deliver-story.md
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseSprintArgs } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  resolveRuntime,
} from './lib/config-resolver.js';
import { cachedGitFetch } from './lib/git/cached-fetch.js';
import {
  branchExistsLocally,
  branchExistsViaTrackingRef,
  classifyBranchSeed,
  seedStoryBranchRef,
} from './lib/git-branch-lifecycle.js';
import { getStoryBranch, gitSpawn, gitSync } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { emitTerseResult } from './lib/observability/terse-result.js';
import { rollUpEpicForStory } from './lib/orchestration/epic-rollup.js';
import {
  executeFastForward,
  planFastForward,
} from './lib/orchestration/git-cleanup/phases/fast-forward.js';
import { verifyRemote } from './lib/orchestration/remote-verifier.js';
import { pinRunScopedConfig } from './lib/orchestration/run-scoped-config.js';
import {
  acquireStoryLease,
  releaseStoryLease,
} from './lib/orchestration/single-story-lease-guard.js';
import { handleRemoteVerificationFailure } from './lib/orchestration/story-init-remote.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { buildProtectionCtx } from './lib/single-story-sweep/protection-ctx.js';
import { resolveSweepLockPath } from './lib/single-story-sweep/sweep-lock.js';
// `sweepMergedStoryBranches` is imported dynamically: its graph reaches
// `picomatch`, which would crash before `assertDepsInstalled()` can report.
import { WorktreeManager } from './lib/worktree-manager.js';

export { handleRemoteVerificationFailure } from './lib/orchestration/story-init-remote.js';
export { makeGhRunner } from './lib/single-story-sweep/protection-ctx.js';

/**
 * Fail fast with an actionable message when deps are missing, instead of an
 * opaque `ERR_MODULE_NOT_FOUND` from deep in the sweep graph. Builtins only.
 */
function assertDepsInstalled(projectRoot) {
  const probe = path.join(projectRoot, 'node_modules', 'picomatch');
  if (!existsSync(probe)) {
    throw new Error(
      [
        'Project dependencies are not installed (missing node_modules/picomatch).',
        `Run \`npm install\` from ${projectRoot} before invoking this script.`,
      ].join(' '),
    );
  }
}

const progress = Logger.createProgress('single-story-init', { stderr: true });

/**
 * @param {{ labels: string[], state: string }} story
 * @param {number} storyId
 */
export function assertDeliverableStory(story, storyId) {
  if (!story.labels.includes(TYPE_LABELS.STORY)) {
    throw new Error(
      `Issue #${storyId} is not a Story (labels: ${story.labels.join(', ')}). ` +
        'v2 /mandrel-deliver accepts type::story tickets only.',
    );
  }
  if (story.state === 'closed') {
    throw new Error(`Story #${storyId} is already closed.`);
  }
  const body = typeof story.body === 'string' ? story.body : '';
  if (/\b(?:Epic|Parent):\s*#\d+/i.test(body)) {
    throw new Error(
      `Story #${storyId} still declares an Epic/Parent footer. ` +
        'v2 delivery is Story-only — re-plan as a standalone Story before /mandrel-deliver.',
    );
  }
}

/**
 * Refuse a Story labelled `agent::executing` that this run does not hold:
 * label and assignee can drift (a run that crashed after the flip), so the
 * lease alone misses it. Runs after the acquire, before any git mutation, and
 * releases the just-taken lease on refusal so the ticket is left as found.
 *
 * @param {object} args
 * @param {{ labels?: string[] }} args.story
 * @param {{ reason: string, previousOwner: string|null }} args.lease
 * @param {boolean} args.stealRequested
 * @param {number} args.storyId
 * @param {object} args.provider
 * @param {object} args.config
 */
export async function assertNotForeignExecuting({
  story,
  lease,
  stealRequested,
  storyId,
  provider,
  config,
}) {
  const labelled =
    Array.isArray(story?.labels) &&
    story.labels.includes(STATE_LABELS.EXECUTING);
  if (!labelled || stealRequested || lease.reason === 'already-held') return;

  try {
    await releaseStoryLease({ provider, storyId, config });
  } catch (err) {
    Logger.error(
      `[single-story-init] ⚠️ Failed to release lease during executing-refusal: ${err?.message ?? err}`,
    );
  }
  throw new Error(
    `Story #${storyId} is already labelled agent::executing` +
      (lease.previousOwner
        ? ` (assignee @${lease.previousOwner})`
        : ' with no assignee') +
      '. Another /mandrel-deliver run may already own it. Confirm that run is dead, ' +
      'then re-run with --steal to take it.',
  );
}

/**
 * Best-effort: the lease is the real guard, so a failed flip only logs.
 *
 * @param {object} provider
 * @param {number} storyId
 * @param {object} story Prefetched snapshot.
 * @returns {Promise<void>}
 */
async function flipStoryToExecuting(provider, storyId, story) {
  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.EXECUTING, {
      ticketSnapshot: story,
      cascade: false,
    });
    progress('LABELS', `🏷️  Story #${storyId} → agent::executing`);
  } catch (err) {
    Logger.error(
      `[single-story-init] ⚠️ Failed to flip Story labels: ${err?.message ?? err}`,
    );
  }
}

/**
 * Roll a container Epic's status up from its children (it carries no
 * `agent::*` label of its own). Never throws.
 *
 * @param {object} provider
 * @param {number} storyId
 * @param {object} config
 * @returns {Promise<void>}
 */
async function rollUpContainerEpic(provider, storyId, config) {
  const outcome = await rollUpEpicForStory({ storyId, provider, config });
  for (const epic of outcome.epics) {
    if (!epic.column) continue;
    progress(
      'EPIC',
      `🗃️  Epic #${epic.epicId} → ${epic.column}` +
        (epic.assigned ? ' (assigned)' : ''),
    );
  }
}

/**
 * Best-effort revert of label and lease after a provisioning failure, so the
 * Story is not stranded as phantom-executing (withheld by every probe).
 *
 * @param {object} provider
 * @param {number} storyId
 * @param {object} config
 * @returns {Promise<void>}
 */
async function rollbackClaimOnInitFailure(provider, storyId, config) {
  try {
    await transitionTicketState(provider, storyId, STATE_LABELS.READY, {
      cascade: false,
    });
    progress(
      'ROLLBACK',
      `↩️  Reverted Story #${storyId} → agent::ready after init failure`,
    );
  } catch (err) {
    Logger.error(
      `[single-story-init] ⚠️ Failed to revert label after init failure: ${err?.message ?? err}`,
    );
  }
  try {
    await releaseStoryLease({ provider, storyId, config });
  } catch (err) {
    Logger.error(
      `[single-story-init] ⚠️ Failed to release lease after init failure: ${err?.message ?? err}`,
    );
  }
}

/**
 * An existing local ref must be reused, never re-created (`git branch` throws).
 *
 * @param {{ localHas: boolean, remoteHas: boolean }} presence
 * @returns {'reuse'|'fetch'|'create'}
 */
export function decideStoryBranchSeed({ localHas, remoteHas }) {
  const action = classifyBranchSeed({ localHas, remoteHas });
  return action === 'local' ? 'reuse' : action;
}

/**
 * Remove closed-Story `.worktrees/story-<id>` trees through the boot sweep's
 * own seam (`runWorktreeSweep`: same lock, same invariants). The Story being
 * initialized is always kept, whatever its ticket state. Never throws: a
 * failure lands in the returned outcome, which rides the init envelope.
 *
 * @returns {Promise<object>} `{ ok, reaped, skipped, reason?, error? }`.
 */
export async function reapClosedStoryWorktrees({
  cwd,
  storyBranch,
  provider,
  lockPath,
  lockTimeoutMs,
  worktreeSweepFn,
  acquireLockFn,
}) {
  const logger = {
    info: (m) => progress('CLEANUP', m),
    warn: (m) => progress('CLEANUP', `⚠️ ${m}`),
  };
  try {
    const { runWorktreeSweep } = await import('./boot-sweep.js');
    const outcome = await runWorktreeSweep({
      root: cwd,
      provider,
      lockPath,
      lockTimeoutMs,
      ...(worktreeSweepFn ? { sweepFn: worktreeSweepFn } : {}),
      ...(acquireLockFn ? { acquireLockFn } : {}),
      logger,
      logTag: '[worktree-sweep]',
      keepPaths: [path.join(cwd, '.worktrees', storyBranch)],
    });
    if (outcome.reaped?.length > 0) {
      progress(
        'CLEANUP',
        `🧹 removed ${outcome.reaped.length} closed-Story worktree(s).`,
      );
    }
    return outcome;
  } catch (err) {
    const msg = err?.message ?? String(err);
    logger.warn(`worktree sweep threw (init continues): ${msg}`);
    return { ok: false, error: msg, reaped: [], skipped: [] };
  }
}

/**
 * Reap merged `story-*` branches (excluding the current one), then the
 * closed-Story worktrees. Never blocks init. Protected candidates (unpushed
 * work, dirty worktree, open Story) are skipped; the lockfile is shared with
 * `boot-sweep.js` via `resolveSweepLockPath` so concurrent reaps cannot race.
 *
 * @returns {Promise<{ worktreeSweep: object }>}
 */
export async function reapMergedStoryBranches({
  cwd,
  baseBranch,
  storyBranch,
  config,
  provider,
  injectedSweep,
  worktreeSweepFn,
  acquireLockFn,
}) {
  const sweepFn =
    injectedSweep ??
    (await import('./lib/single-story-sweep.js')).sweepMergedStoryBranches;
  const tempRoot = config?.project?.paths?.tempRoot ?? 'temp';
  const lockPath = resolveSweepLockPath({ cwd, tempRoot });
  const lockTimeoutMs =
    config?.delivery?.worktreeIsolation?.sweepLockMs ?? 60_000;
  await reapMergedBranches({
    cwd,
    baseBranch,
    storyBranch,
    provider,
    sweepFn,
    lockPath,
    lockTimeoutMs,
  });
  const worktreeSweep = await reapClosedStoryWorktrees({
    cwd,
    storyBranch,
    provider,
    lockPath,
    lockTimeoutMs,
    worktreeSweepFn,
    acquireLockFn,
  });
  return { worktreeSweep };
}

async function reapMergedBranches({
  cwd,
  baseBranch,
  storyBranch,
  provider,
  sweepFn,
  lockPath,
  lockTimeoutMs,
}) {
  try {
    const sweep = await sweepFn({
      cwd,
      baseBranch,
      currentStoryBranch: storyBranch,
      logger: {
        info: (m) => progress('CLEANUP', m),
        warn: (m) => progress('CLEANUP', `⚠️ ${m}`),
      },
      protectionCtx: buildProtectionCtx({ cwd, provider }),
      lockPath,
      lockTimeoutMs,
    });
    if (sweep.error) {
      progress(
        'CLEANUP',
        `⚠️ sweep returned error (init continues): ${sweep.error}`,
      );
    } else if (sweep.skipped && sweep.reason) {
      progress('CLEANUP', `⏭ sweep skipped (${sweep.reason}); init continues.`);
    } else if (sweep.candidates > 0) {
      const protectedNote =
        sweep.protected && sweep.protected.length > 0
          ? `; protected ${sweep.protected.length} (${sweep.protected
              .map((p) => `${p.branch}:${p.reason}`)
              .join(', ')})`
          : '';
      progress(
        'CLEANUP',
        `🧹 reaped ${sweep.localDeleted} local + ${sweep.remoteDeleted} remote story branch(es)${protectedNote}.`,
      );
    }
  } catch (err) {
    progress(
      'CLEANUP',
      `⚠️ sweep threw (init continues): ${err?.message ?? err}`,
    );
  }
}

/**
 * Fetch, reap, and fast-forward the local base branch so new Story branches
 * seed from origin's tip.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.baseBranch
 * @param {string} opts.storyBranch
 * @param {object} opts.config
 * @param {object} opts.provider
 * @param {Function|undefined} opts.injectedSweep
 * @param {Function} [opts.worktreeSweepFn] Test override for the
 *   closed-Story worktree sweep.
 * @param {Function} opts.progress
 * @param {import('./lib/git/cached-fetch.js').FetchCache} [opts.fetchCache]
 *   Test override; production shares the module singleton.
 * @returns {Promise<{ worktreeSweep: object }>}
 */
export async function materializeBaseBranch({
  cwd,
  baseBranch,
  storyBranch,
  config,
  provider,
  injectedSweep,
  worktreeSweepFn,
  progress,
  fetchCache,
}) {
  progress('GIT', 'Fetching remote refs...');
  const fetchOpts = fetchCache ? { cache: fetchCache } : {};
  const fetchResult = await cachedGitFetch(cwd, 'origin', fetchOpts);
  if (fetchResult.cached) {
    progress('GIT', 'Fetch served from (cwd, ref) cache — skipped network.');
  } else if (fetchResult.attempts > 1) {
    progress(
      'GIT',
      `Fetch completed after ${fetchResult.attempts} attempt(s) — packed-refs contention.`,
    );
  }

  const { worktreeSweep } = await reapMergedStoryBranches({
    cwd,
    baseBranch,
    storyBranch,
    config,
    provider,
    injectedSweep,
    worktreeSweepFn,
  });

  if (!branchExistsLocally(baseBranch, cwd)) {
    const r = gitSpawn(cwd, 'fetch', 'origin', `${baseBranch}:${baseBranch}`);
    if (r.status !== 0) {
      throw new Error(
        `Failed to fetch base branch ${baseBranch}: ${r.stderr || '(no stderr)'}`,
      );
    }
    return { worktreeSweep };
  }

  fastForwardBase({ cwd, baseBranch, progress });
  return { worktreeSweep };
}

/**
 * `git fetch` leaves local base at the old tip until fast-forwarded.
 *
 * @param {{ cwd: string, baseBranch: string, progress: Function }} opts
 */
function fastForwardBase({ cwd, baseBranch, progress }) {
  const ffPlan = planFastForward({ cwd, baseBranch });
  const ff = executeFastForward({
    cwd,
    baseBranch,
    plan: ffPlan,
    logger: {
      info: (m) => progress('GIT', m.replace(/^\[git-cleanup\]\s*/, '')),
      warn: (m) => progress('GIT', `⚠️ ${m.replace(/^\[git-cleanup\]\s*/, '')}`),
    },
  });
  if (ff.applied) {
    progress(
      'GIT',
      `Fast-forwarded local ${baseBranch} by ${ff.behind} commit(s).`,
    );
  } else if (ff.reason === 'not-fast-forward') {
    progress(
      'GIT',
      `⚠️ local ${baseBranch} is not a fast-forward behind origin/${baseBranch}; seeding from local tip.`,
    );
  } else if (ff.reason === 'dirty-tree') {
    progress(
      'GIT',
      `⚠️ working tree dirty; skipped fast-forward of ${baseBranch}.`,
    );
  }
}

/**
 * Idempotent seed. Assumes `materializeBaseBranch` already fetched, so
 * tracking refs are authoritative (no `ls-remote`).
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.storyBranch
 * @param {string} opts.baseBranch
 * @param {Function} opts.progress
 */
export function seedStoryBranch({ cwd, storyBranch, baseBranch, progress }) {
  // No concurrent creator to race here, so create failures are fatal.
  seedStoryBranchRef({
    storyBranch,
    baseRef: baseBranch,
    swallowCreateRace: false,
    spawn: (args) => gitSpawn(cwd, ...args),
    existsLocally: (b) => branchExistsLocally(b, cwd),
    existsRemotely: (b) => branchExistsViaTrackingRef(b, cwd),
    progress,
    messages: {
      reuse: (b) => `Reusing existing local story branch: ${b}`,
      fetch: (b) => `Fetching remote story branch: ${b}`,
      create: (b, ref) => `Creating story branch ref: ${b} from ${ref}`,
      createError: (b, _ref, stderr) =>
        `Failed to create story branch ${b}: ${stderr || '(no stderr)'}`,
      fetchError: (b, stderr) => `Failed to fetch story branch ${b}: ${stderr}`,
    },
  });
}

/**
 * Provision a worktree, or check out the branch in single-tree mode.
 *
 * @param {object} opts
 * @param {object} opts.runtime
 * @param {string} opts.cwd
 * @param {number} opts.storyId
 * @param {string} opts.storyBranch
 * @param {object} opts.config
 * @param {Function} opts.progress
 * @returns {Promise<{ workCwd: string, worktreeCreated: boolean, installStatus: object }>}
 */
export async function provisionWorktree({
  runtime,
  cwd,
  storyId,
  storyBranch,
  config,
  progress,
}) {
  let workCwd = cwd;
  let worktreeCreated = false;
  let installStatus = { status: 'skipped', reason: 'single-tree-mode' };

  if (runtime.worktreeEnabled) {
    const wm = new WorktreeManager({
      repoRoot: cwd,
      config: config.delivery?.worktreeIsolation,
      logger: {
        info: (m) => progress('WORKTREE', m),
        warn: (m) => progress('WORKTREE', `⚠️ ${m}`),
        error: (m) => Logger.error(`[single-story-init] ${m}`),
      },
    });
    const ensured = await wm.ensure(storyId, storyBranch);
    workCwd = ensured.path;
    worktreeCreated = ensured.created;
    installStatus = ensured.installStatus ?? installStatus;
    progress(
      'WORKTREE',
      `${ensured.created ? '✨ Created' : '♻️  Reusing'} worktree: ${ensured.path}`,
    );
  } else {
    gitSync(cwd, 'checkout', storyBranch);
  }

  return { workCwd, worktreeCreated, installStatus };
}

export async function runSingleStoryInit({
  storyId: storyIdParam,
  dryRun: dryRunParam,
  cwd: cwdParam,
  injectedProvider,
  injectedConfig,
  injectedSweep,
  injectedWorktreeSweep,
  injectedAcquireLease,
  steal = false,
  injectedVerifyRemote,
  injectedMaterialize = materializeBaseBranch,
  injectedSeedBranch = seedStoryBranch,
  injectedProvisionWorktree = provisionWorktree,
} = {}) {
  const parsed =
    storyIdParam !== undefined
      ? {
          storyId: storyIdParam,
          dryRun: !!dryRunParam,
          cwd: cwdParam ?? null,
        }
      : parseSprintArgs();
  const { storyId, dryRun } = parsed;
  const cwd = path.resolve(cwdParam ?? parsed.cwd ?? PROJECT_ROOT);
  // `--steal` is outside parseSprintArgs; the lease fails closed on a foreign
  // assignee, so this is the operator's forcible-transfer override.
  const stealRequested =
    steal || (storyIdParam === undefined && process.argv.includes('--steal'));

  if (!storyId) {
    throw new Error(
      'Usage: node single-story-init.js --story <STORY_ID> [--dry-run]',
    );
  }

  assertDepsInstalled(cwd);

  const config = injectedConfig || resolveConfig({ cwd });
  const provider = injectedProvider || createProvider(config);

  const baseBranch = config.project?.baseBranch ?? 'main';
  const storyBranch = getStoryBranch(storyId);

  const runtime = resolveRuntime({ config });
  progress(
    'ENV',
    `worktreeIsolation=${runtime.worktreeEnabled ? 'on' : 'off'} (${runtime.worktreeEnabledSource})`,
  );
  progress('INIT', `Initializing standalone Story #${storyId}...`);

  // Read-only, so it runs under --dry-run too. The workflow owns the
  // `agent::blocked` transition on `remoteVerified: false`; inline delivery to
  // local `main` is never a fallback.
  const remote = (injectedVerifyRemote ?? verifyRemote)({ cwd });
  progress(
    'REMOTE',
    remote.remoteVerified
      ? `✅ remoteVerified=true — ${remote.detail}`
      : `⛔ remoteVerified=false — ${remote.detail}`,
  );

  const story = await provider.getTicket(storyId);
  assertDeliverableStory(story, storyId);
  await handleRemoteVerificationFailure({
    provider,
    storyId,
    remote,
    dryRun,
  });

  progress(
    'CONTEXT',
    `Standalone Story: "${story.title}" → branch ${storyBranch} from ${baseBranch}.`,
  );

  // Lease before any git mutation so two runs cannot drive one Story.
  let workCwd = cwd;
  let worktreeCreated = false;
  let installStatus = { status: 'skipped', reason: 'dry-run' };
  let worktreeSweep = null;

  if (!dryRun) {
    const acquire = injectedAcquireLease ?? acquireStoryLease;
    const lease = await acquire({
      provider,
      storyId,
      config,
      steal: stealRequested,
    });
    progress(
      'LEASE',
      `🔒 Story #${storyId} lease ${lease.reason} (owner=@${lease.owner}).`,
    );

    await assertNotForeignExecuting({
      story,
      lease,
      stealRequested,
      storyId,
      provider,
      config,
    });

    // Before the install, so a concurrent probe cannot double-dispatch.
    await flipStoryToExecuting(provider, storyId, story);

    // After the flip (the rollup reads it), before the install window.
    await rollUpContainerEpic(provider, storyId, config);

    try {
      ({ worktreeSweep } =
        (await injectedMaterialize({
          cwd,
          baseBranch,
          storyBranch,
          config,
          provider,
          injectedSweep,
          worktreeSweepFn: injectedWorktreeSweep,
          progress,
        })) ?? {});
      injectedSeedBranch({ cwd, storyBranch, baseBranch, progress });
      ({ workCwd, worktreeCreated, installStatus } =
        await injectedProvisionWorktree({
          runtime,
          cwd,
          storyId,
          storyBranch,
          config,
          progress,
        }));
    } catch (err) {
      await rollbackClaimOnInitFailure(provider, storyId, config);
      throw err;
    }
  }

  const dependenciesInstalled =
    installStatus.status === 'installed'
      ? 'true'
      : installStatus.status === 'failed'
        ? 'false'
        : 'skipped';

  const result = {
    storyId,
    epicId: null,
    standalone: true,
    storyBranch,
    baseBranch,
    // Write half of the run-scoped config pin; `baseBranch` is close's fallback.
    runScopedConfig: pinRunScopedConfig(config),
    storyTitle: story.title,
    worktreeEnabled: runtime.worktreeEnabled,
    workCwd,
    worktreeCreated,
    installStatus,
    dependenciesInstalled,
    installFailed: installStatus.status === 'failed',
    // Closed-Story worktree sweep outcome; a failure degrades here, never
    // into an init failure. `null` under --dry-run.
    worktreeSweep: worktreeSweep ?? null,
    dryRun,
    remoteVerified: remote.remoteVerified,
    remoteProbe: { remoteUrl: remote.remoteUrl, detail: remote.detail },
  };

  // The envelope (stdout + disk) is the only record; no ticket comment. Full
  // result goes to a temp log, stdout gets the fields the caller acts on.
  emitTerseResult({
    label: 'STORY INIT RESULT',
    result,
    scope: storyId,
    config,
    summary: {
      storyId,
      storyBranch,
      workCwd,
      worktreeCreated,
      dependenciesInstalled,
      remoteVerified: result.remoteVerified,
      dryRun,
    },
  });
  progress(
    'DONE',
    dryRun
      ? '✅ Dry-run complete. No git or ticket changes made.'
      : `✅ Standalone Story #${storyId} initialized on ${storyBranch}.`,
  );

  return { success: true, result };
}

runAsCli(import.meta.url, runSingleStoryInit, {
  source: 'single-story-init',
  usage: {
    invocation:
      'node .agents/scripts/single-story-init.js --story <id> [--dry-run] [--steal] [--cwd <main-repo>]',
    summary:
      'Initialize a Story for delivery: acquire the lease, seed story-<id> from the base branch, materialize the worktree, and flip the Story to agent::executing.',
    flags: [
      ['--story <id>', 'GitHub issue number of the Story (required).'],
      [
        '--dry-run',
        'Report what would happen; no mutations, no lease, no sweep.',
      ],
      ['--steal', 'Forcibly transfer a lease held by another assignee.'],
      [
        '--cwd <main-repo>',
        'Main-repo checkout to run from (default: project root).',
      ],
    ],
  },
});
