#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * single-story-init.js — Initialize a standalone Story (no parent Epic).
 *
 * Counterpart to `story-init.js` for the `/single-story-deliver` workflow.
 * The framework's main `story-init.js` requires an `Epic: #N` reference in
 * the Story body to trace hierarchy, seed the Story branch from
 * `epic/<id>`, and gate execution on the epic's dispatch manifest. None of
 * that applies to a standalone Story — a top-level work unit that branches
 * directly from `main` and opens its PR straight to `main`.
 *
 * What this script does:
 *   1. Validate the Story (type::story, not closed).
 *   2. Fetch origin.
 *   3. Create the Story branch from `project.baseBranch` (default
 *      `main`) — local-only, no remote push at this stage.
 *   4. Materialise a worktree at `.worktrees/story-<id>/` when worktree
 *      isolation is enabled; otherwise check out the branch in-place.
 *   5. Upsert a `story-init` structured comment carrying
 *      `standalone: true`.
 *   6. Flip the Story to `agent::executing`.
 *
 * What this script does NOT do (and why):
 *   - Skips `validateBlockers` against the body's `Blocked by:` markers —
 *     pre-flight is still the operator's responsibility, but the Epic-scope
 *     blocker chain doesn't fit.
 *   - Skips child-Task transitions — a standalone Story is treated as
 *     atomic (one branch, one commit-set, one PR).
 *
 * Usage: `node single-story-init.js --story <STORY_ID> [--dry-run]`
 * Exit codes: 0 ok, 1 error.
 *
 * @see .agents/workflows/helpers/single-story-deliver.md
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
import { setActiveStoryEnv } from './lib/observability/active-story-env.js';
import {
  executeFastForward,
  planFastForward,
} from './lib/orchestration/git-cleanup/phases/fast-forward.js';
import { acquireStoryLease } from './lib/orchestration/single-story-lease-guard.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { buildProtectionCtx } from './lib/single-story-sweep/protection-ctx.js';
// `sweepMergedStoryBranches` is imported dynamically below — its transitive
// graph reaches `picomatch` (via `git-cleanup.js`). Loading it statically
// would crash module resolution before `assertDepsInstalled()` can emit a
// friendly "run npm install" message.
import { WorktreeManager } from './lib/worktree-manager.js';

// `makeGhRunner` moved to the shared `single-story-sweep/protection-ctx.js`
// module (Story #4373) so the three boot callers build an identical
// protection ctx. Re-exported here to preserve its existing import path.
export { makeGhRunner } from './lib/single-story-sweep/protection-ctx.js';

/**
 * Fail fast with a clear, actionable message when project deps are missing.
 * Uses only Node builtins so it stays loadable when `node_modules/` is empty.
 *
 * Why: a wiped `node_modules/` previously surfaced as
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'picomatch'` from deep inside
 * the sweep graph — opaque for operators. This guard probes a representative
 * runtime dep (declared in `.agents/runtime-deps.json`) and tells the operator
 * exactly what to run.
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
 * Validate that the fetched ticket is a standalone Story this script can
 * deliver. Throws with the canonical operator-facing message otherwise.
 * Exported for testing.
 *
 * @param {{ labels: string[], state: string }} story Fetched ticket.
 * @param {number} storyId Story number (for error messages).
 */
export function assertDeliverableStory(story, storyId) {
  if (!story.labels.includes(TYPE_LABELS.STORY)) {
    throw new Error(
      `Issue #${storyId} is not a Story (labels: ${story.labels.join(', ')}). Use /deliver or /deliver for Epic-attached work.`,
    );
  }
  if (story.state === 'closed') {
    throw new Error(`Story #${storyId} is already closed.`);
  }
}

/**
 * Decide how to seed the Story branch given local / remote presence. Pure and
 * exported for testing (Story #3483 AC3: an existing `story-<id>` branch must
 * be **reused**, never re-created — re-creating throws `branch already exists`).
 *
 * Delegates the (local, remote) decision to the shared `classifyBranchSeed`
 * classifier (Story #3513) so this path and the Epic-attached
 * `branch-initializer.js#planStoryBranchSeed` share one decision tree. The
 * shared classifier returns `'local'` for the local-present case; this path
 * names that outcome `'reuse'`.
 *
 * @param {{ localHas: boolean, remoteHas: boolean }} presence
 * @returns {'reuse'|'fetch'|'create'}
 *   - `reuse`  — a local ref already exists; the caller must not run
 *                `git branch` (which would throw on the existing ref).
 *   - `fetch`  — only the remote ref exists; materialise the local ref.
 *   - `create` — neither exists; branch from baseBranch.
 */
export function decideStoryBranchSeed({ localHas, remoteHas }) {
  const action = classifyBranchSeed({ localHas, remoteHas });
  return action === 'local' ? 'reuse' : action;
}

/**
 * Reap previously-merged `story-*` branches before starting a new one, so
 * stale local + origin refs do not accumulate across runs. The sweep
 * excludes the current run's `storyBranch` and never blocks init: any
 * sweep failure is logged but does not throw.
 *
 * Story #2011 hardens this surface in two ways:
 *   - Per-candidate protection: branches with unpushed work, dirty
 *     worktrees, or still-open Story tickets are skipped (and listed
 *     in `sweep.protected` for the operator).
 *   - Cross-session lock: a single lockfile under `tempRoot` prevents
 *     two concurrent `/single-story-deliver` invocations from racing.
 *
 * Exported for testing.
 */
export async function reapMergedStoryBranches({
  cwd,
  baseBranch,
  storyBranch,
  config,
  provider,
  injectedSweep,
}) {
  const sweepFn =
    injectedSweep ??
    (await import('./lib/single-story-sweep.js')).sweepMergedStoryBranches;
  const tempRoot = config?.project?.paths?.tempRoot ?? 'temp';
  const lockPath = path.resolve(cwd, tempRoot, 'single-story-sweep.lock');
  const lockTimeoutMs =
    config.delivery?.worktreeIsolation?.sweepLockMs ?? 60_000;
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
 * Fetch remote refs, reap merged story branches, and fast-forward the local
 * base branch so new story branches seed from origin's tip. Exported for
 * testing (owns the fast-forward cascade; mirrors `fetchMainRefs` +
 * `ensureEpicBranch` in `branch-initializer.js`).
 *
 * Routes the `origin` fetch through `cachedGitFetch` so concurrent standalone
 * Story waves share the same per-process coalescing window that Epic-attached
 * stories get via `branch-initializer.js#fetchMainRefs`. Pass `fetchFn` to
 * inject a stub in tests without touching real git.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.baseBranch
 * @param {string} opts.storyBranch
 * @param {object} opts.config
 * @param {object} opts.provider
 * @param {Function|undefined} opts.injectedSweep
 * @param {Function} opts.progress
 * @param {import('./lib/git/cached-fetch.js').FetchCache} [opts.fetchCache]
 *   Override the module-level cache — used by tests that need a fresh, isolated
 *   cache. Production callers omit this so all Stories in a wave share the
 *   module singleton.
 */
export async function materializeBaseBranch({
  cwd,
  baseBranch,
  storyBranch,
  config,
  provider,
  injectedSweep,
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

  await reapMergedStoryBranches({
    cwd,
    baseBranch,
    storyBranch,
    config,
    provider,
    injectedSweep,
  });

  // Ensure baseBranch exists locally so we can branch from it. If only
  // remote-tracking is present, materialize the local ref.
  if (!branchExistsLocally(baseBranch, cwd)) {
    const r = gitSpawn(cwd, 'fetch', 'origin', `${baseBranch}:${baseBranch}`);
    if (r.status !== 0) {
      throw new Error(
        `Failed to fetch base branch ${baseBranch}: ${r.stderr || '(no stderr)'}`,
      );
    }
    return;
  }

  // `git fetch origin` updates remote-tracking refs only; local `main` stays
  // at the pre-merge tip until fast-forwarded. Use the same helper as
  // `/git-cleanup --fast-forward-main` (checkout base + `merge --ff-only`) so
  // new `story-*` branches seed from origin's tip when the main checkout is
  // clean (Story #2744).
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
 * Seed the Story branch from the base branch. Three cases, idempotent in all:
 *   - already local → reuse (do NOT re-create an existing ref)
 *   - remote only   → fetch
 *   - neither       → create from baseBranch
 *
 * `cachedGitFetch(cwd, 'origin')` is assumed to have run before this call
 * (via `materializeBaseBranch`), so remote-tracking refs are authoritative.
 * Uses a local tracking-ref check rather than a network `ls-remote` round-trip.
 * Exported for testing (owns the seedAction switch + throws).
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.storyBranch
 * @param {string} opts.baseBranch
 * @param {Function} opts.progress
 */
export function seedStoryBranch({ cwd, storyBranch, baseBranch, progress }) {
  // Standalone path: no concurrent creator to race, so create failures are
  // fatal (`swallowCreateRace: false`) and a failed fetch throws. The
  // seed-action switch shell is single-homed in `seedStoryBranchRef`
  // (Story #4255); this caller only supplies its `baseRef`, its git seams
  // bound to `cwd`, and its own log/error vocabulary.
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
 * Provision a worktree (or check out the branch in single-tree mode), then
 * record the active-story environment markers. Returns the resolved
 * `workCwd`, `worktreeCreated`, and `installStatus`. Exported for testing
 * (owns the worktree/single-tree routing + setActiveStoryEnv call).
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
    // Single-tree mode: check out the branch on the main checkout.
    gitSync(cwd, 'checkout', storyBranch);
  }

  try {
    // Story #2874 — standalone Stories have no parent Epic; pass
    // `epicId: null` so the helper omits CC_EPIC_ID from env + file
    // instead of throwing on a 0 sentinel. The trace hook keys its
    // standalone-trace branch on CC_EPIC_ID being absent.
    setActiveStoryEnv({
      epicId: null,
      storyId,
      workCwd,
      logger: {
        warn: (m) => progress('ENV', `⚠️ ${m}`),
      },
    });
  } catch (err) {
    Logger.error(
      `[single-story-init] ⚠️ Failed to set active-Story env: ${err?.message ?? err}`,
    );
  }

  return { workCwd, worktreeCreated, installStatus };
}

/**
 * Initialize a standalone Story. Exported for testing.
 */
export async function runSingleStoryInit({
  storyId: storyIdParam,
  dryRun: dryRunParam,
  cwd: cwdParam,
  injectedProvider,
  injectedConfig,
  injectedSweep,
  // Story #3483: lets tests drive the lease preflight deterministically.
  // `injectedAcquireLease` swaps the guard; `leaseNow` injects the clock the
  // fail-closed liveness check evaluates against (audit #3513). `steal`
  // forcibly transfers a foreign claim — the standalone path has no Epic
  // heartbeat ledger, so a foreign assignee blocks unless stolen.
  injectedAcquireLease,
  steal = false,
  leaseNow,
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
  // `--steal` is not part of the shared parseSprintArgs surface; read it from
  // argv on the CLI path (the explicit `steal` param wins for programmatic /
  // test callers). The standalone lease fails closed on a foreign assignee
  // (audit #3513), so `--steal` is the operator's forcible-transfer override.
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
  // The first arg is unused (legacy epicId slot); pass 0 to satisfy the
  // numeric-validation guard.
  const storyBranch = getStoryBranch(0, storyId);

  const runtime = resolveRuntime({ config });
  progress(
    'ENV',
    `worktreeIsolation=${runtime.worktreeEnabled ? 'on' : 'off'} (${runtime.worktreeEnabledSource})`,
  );
  progress('INIT', `Initializing standalone Story #${storyId}...`);

  const story = await provider.getTicket(storyId);
  assertDeliverableStory(story, storyId);

  progress(
    'CONTEXT',
    `Standalone Story: "${story.title}" → branch ${storyBranch} from ${baseBranch}.`,
  );

  // Story #3483 — lease preflight. Take an exclusive, time-bounded claim on
  // the Story ticket before any git mutation so two concurrent standalone
  // runs cannot both drive the same Story. The standalone path has no Epic
  // heartbeat ledger, so the guard fails closed (audit #3513): a foreign
  // assignee is treated as a live claim and aborts init (naming the current
  // owner) unless --steal forcibly transfers it. Unclaimed / self-held claims
  // proceed. Skipped under --dry-run (no assignee mutation).
  if (!dryRun) {
    const acquire = injectedAcquireLease ?? acquireStoryLease;
    const lease = await acquire({
      provider,
      storyId,
      config,
      steal: stealRequested,
      now: leaseNow,
    });
    progress(
      'LEASE',
      `🔒 Story #${storyId} lease ${lease.reason} (owner=@${lease.owner}).`,
    );
  }

  let workCwd = cwd;
  let worktreeCreated = false;
  let installStatus = { status: 'skipped', reason: 'dry-run' };

  if (!dryRun) {
    await materializeBaseBranch({
      cwd,
      baseBranch,
      storyBranch,
      config,
      provider,
      injectedSweep,
      progress,
    });
    seedStoryBranch({ cwd, storyBranch, baseBranch, progress });
    ({ workCwd, worktreeCreated, installStatus } = await provisionWorktree({
      runtime,
      cwd,
      storyId,
      storyBranch,
      config,
      progress,
    }));
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
    storyTitle: story.title,
    worktreeEnabled: runtime.worktreeEnabled,
    workCwd,
    worktreeCreated,
    installStatus,
    dependenciesInstalled,
    installFailed: installStatus.status === 'failed',
    dryRun,
  };

  // Upsert the `story-init` structured comment + flip Story to executing.
  // Both are no-ops under --dry-run.
  if (!dryRun) {
    try {
      await upsertStructuredComment(
        provider,
        storyId,
        'story-init',
        renderSingleStoryInitComment(result),
      );
      progress(
        'COMMENT',
        `📝 Upserted story-init structured comment on #${storyId}.`,
      );
    } catch (err) {
      Logger.error(
        `[single-story-init] ⚠️ Failed to upsert story-init structured comment: ${err?.message ?? err}`,
      );
    }

    try {
      // Route through the canonical state mutator so the Projects v2
      // Status column mirrors the label flip (Story #2548 wires column-
      // sync inside `transitionTicketState`). A direct
      // `provider.updateTicket({ labels })` would skip the board update
      // and leave the Story on its prior status column for the entire
      // run. `cascade: false` is correct — a standalone Story has no
      // parent chain — and threading the prefetched `story` as
      // `ticketSnapshot` preserves the round-trip elimination from
      // Story #1795.
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

  Logger.info('\n--- STORY INIT RESULT ---');
  Logger.info(JSON.stringify(result, null, 2));
  Logger.info('--- END RESULT ---\n');
  progress(
    'DONE',
    dryRun
      ? '✅ Dry-run complete. No git or ticket changes made.'
      : `✅ Standalone Story #${storyId} initialized on ${storyBranch}.`,
  );

  return { success: true, result };
}

export function renderSingleStoryInitComment(result) {
  const payload = {
    storyId: result.storyId,
    epicId: null,
    standalone: true,
    storyBranch: result.storyBranch,
    baseBranch: result.baseBranch,
    worktreeEnabled: result.worktreeEnabled,
    workCwd: result.workCwd,
    worktreeCreated: result.worktreeCreated,
    dependenciesInstalled: result.dependenciesInstalled,
    installStatus: result.installStatus,
  };
  return [
    '## Story init (standalone)',
    '',
    `- **standalone:** \`true\``,
    `- **storyBranch:** \`${result.storyBranch}\``,
    `- **baseBranch:** \`${result.baseBranch}\``,
    `- **workCwd:** \`${result.workCwd}\``,
    `- **worktreeEnabled:** \`${result.worktreeEnabled}\``,
    `- **dependenciesInstalled:** \`${result.dependenciesInstalled}\``,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
  ].join('\n');
}

runAsCli(import.meta.url, runSingleStoryInit, { source: 'single-story-init' });
