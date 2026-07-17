#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * single-story-init.js — Initialize a Story for v2 `/deliver`.
 *
 * Seeds `story-<id>` from `project.baseBranch` (default `main`), materialises
 * the per-Story worktree when isolation is enabled, upserts a `story-init`
 * structured comment, and flips the Story to `agent::executing`. There is no
 * Epic parent, epic branch, or dispatch-manifest gate.
 *
 * What this script does:
 *   1. Validate the Story (type::story, not closed).
 *   2. Acquire the assignee lease, then refuse a Story already labelled
 *      `agent::executing` this run does not hold (unless `--steal`).
 *   3. Flip the Story to `agent::executing` — BEFORE provisioning, so the
 *      claim is label-visible to concurrent operators' probes during the
 *      multi-minute install window (Story #4620). A provisioning failure after
 *      this reverts the label and releases the lease.
 *   4. Fetch origin.
 *   5. Create the Story branch from `project.baseBranch` (default
 *      `main`) — local-only, no remote push at this stage.
 *   6. Materialise a worktree at `.worktrees/story-<id>/` when worktree
 *      isolation is enabled; otherwise check out the branch in-place.
 *   7. Upsert a `story-init` structured comment carrying
 *      `standalone: true`.
 *
 * What this script does NOT do:
 *   - Child-Task transitions — a Story is atomic (one branch, one
 *     commit-set, one PR to `main`).
 *
 * Usage: `node single-story-init.js --story <STORY_ID> [--dry-run]`
 * Exit codes: 0 ok, 1 error.
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
import { setActiveStoryEnv } from './lib/observability/active-story-env.js';
import {
  executeFastForward,
  planFastForward,
} from './lib/orchestration/git-cleanup/phases/fast-forward.js';
import { verifyRemote } from './lib/orchestration/remote-verifier.js';
import {
  acquireStoryLease,
  releaseStoryLease,
} from './lib/orchestration/single-story-lease-guard.js';
import { handleRemoteVerificationFailure } from './lib/orchestration/story-init-remote.js';
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

export { handleRemoteVerificationFailure } from './lib/orchestration/story-init-remote.js';
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
      `Issue #${storyId} is not a Story (labels: ${story.labels.join(', ')}). ` +
        'v2 /deliver accepts type::story tickets only.',
    );
  }
  if (story.state === 'closed') {
    throw new Error(`Story #${storyId} is already closed.`);
  }
  const body = typeof story.body === 'string' ? story.body : '';
  if (/\b(?:Epic|Parent):\s*#\d+/i.test(body)) {
    throw new Error(
      `Story #${storyId} still declares an Epic/Parent footer. ` +
        'v2 delivery is Story-only — re-plan as a standalone Story before /deliver.',
    );
  }
}

/**
 * Defense-in-depth refusal for a Story already labelled `agent::executing`
 * that this run does not already hold.
 *
 * The assignee lease is the primary cross-run guard, but the label and the
 * assignee can drift apart: a prior run that crashed *after* the early
 * `agent::executing` flip but *before* (or without) taking/holding the lease
 * leaves the Story labelled executing with no live foreign lease to trip the
 * lease preflight. Left unchecked, a fresh run would seed the branch and
 * worktree straight over that drift. Refuse unless the caller already holds the
 * lease (`reason === 'already-held'`, i.e. a legitimate idempotent re-init) or
 * passed `--steal`.
 *
 * Runs *after* the lease acquire (so it can read the acquire's reason) but
 * *before* any git mutation. On refusal it releases the lease this run just
 * took so the ticket is left exactly as found — a clean state for the operator
 * to inspect before re-running with `--steal`.
 *
 * @param {object} args
 * @param {{ labels?: string[] }} args.story        Fetched Story ticket.
 * @param {{ reason: string, previousOwner: string|null }} args.lease  Acquire result.
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

  // Back out the lease we just took so the refusal leaves the ticket unchanged.
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
      '. Another /deliver run may already own it. Confirm that run is dead, ' +
      'then re-run with --steal to take it.',
  );
}

/**
 * Publish this run's claim as the `agent::executing` label **before** the
 * multi-minute worktree install, so a concurrent operator's probe sees the
 * claim during the install window instead of reading `agent::ready` and
 * dispatching the Story a second time.
 *
 * Best-effort: the assignee lease is the real guard, so a failed flip logs and
 * proceeds rather than aborting init. Routes through `transitionTicketState`
 * so the Projects v2 Status column follows the label (Story #2548).
 *
 * @param {object} provider
 * @param {number} storyId
 * @param {object} story  Prefetched snapshot (round-trip elimination).
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
 * Undo this run's claim when provisioning fails after the early
 * `agent::executing` flip: revert the label to `agent::ready` and release the
 * lease, both best-effort. Without this a crashed init would strand the Story
 * as phantom-executing — claimed and labelled in-flight but with no live run —
 * which every other operator's probe would then withhold indefinitely.
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
 * testing (owns the fast-forward cascade).
 *
 * Routes the `origin` fetch through `cachedGitFetch` so concurrent Story
 * waves share a per-process fetch-coalescing window. Pass `fetchFn` to
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
    // v2 Stories are standalone — no parent Epic. The helper omits
    // CC_EPIC_ID from env + file; the trace hook keys its standalone-trace
    // branch on CC_EPIC_ID being absent.
    setActiveStoryEnv({
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
  injectedVerifyRemote,
  // Story #4620: swap the git-touching provisioning steps so the
  // early-flip-then-rollback ordering is unit-testable without a real worktree.
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
  const storyBranch = getStoryBranch(storyId);

  const runtime = resolveRuntime({ config });
  progress(
    'ENV',
    `worktreeIsolation=${runtime.worktreeEnabled ? 'on' : 'off'} (${runtime.worktreeEnabledSource})`,
  );
  progress('INIT', `Initializing standalone Story #${storyId}...`);

  // Issue #4483 — deterministic remote evidence at the v2 `/deliver` entry
  // seam (`single-story-init.js`). The
  // probe is read-only, so it runs under --dry-run too. The CLI records
  // the fact; the workflow owns the `agent::blocked` transition on
  // `remoteVerified: false` — inline delivery to local `main` is never a
  // sanctioned fallback.
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

  // Story #3483 — lease preflight. Take an exclusive, time-bounded claim on
  // the Story ticket before any git mutation so two concurrent standalone
  // runs cannot both drive the same Story. The standalone path has no Epic
  // heartbeat ledger, so the guard fails closed (audit #3513): a foreign
  // assignee is treated as a live claim and aborts init (naming the current
  // owner) unless --steal forcibly transfers it. Unclaimed / self-held claims
  // proceed. Skipped under --dry-run (no assignee mutation).
  let workCwd = cwd;
  let worktreeCreated = false;
  let installStatus = { status: 'skipped', reason: 'dry-run' };

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

    // Defense in depth: refuse a Story already labelled agent::executing that
    // this run does not hold (label/assignee drift the lease alone misses).
    // Runs before any git mutation; releases the just-taken lease on refusal.
    await assertNotForeignExecuting({
      story,
      lease,
      stealRequested,
      storyId,
      provider,
      config,
    });

    // Publish the claim as agent::executing BEFORE the multi-minute worktree
    // install (not after), so a concurrent operator's probe sees it during the
    // install window instead of reading agent::ready and double-dispatching.
    await flipStoryToExecuting(provider, storyId, story);

    // Any failure from here on leaves a claimed, executing-labelled Story with
    // no live run behind it — revert the label and release the lease so the
    // Story is not stranded as phantom-executing.
    try {
      await injectedMaterialize({
        cwd,
        baseBranch,
        storyBranch,
        config,
        provider,
        injectedSweep,
        progress,
      });
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
    storyTitle: story.title,
    worktreeEnabled: runtime.worktreeEnabled,
    workCwd,
    worktreeCreated,
    installStatus,
    dependenciesInstalled,
    installFailed: installStatus.status === 'failed',
    dryRun,
    // Issue #4483 — verified remote evidence for the orchestrating agent.
    remoteVerified: remote.remoteVerified,
    remoteProbe: { remoteUrl: remote.remoteUrl, detail: remote.detail },
  };

  // Upsert the `story-init` structured comment (no-op under --dry-run). The
  // `agent::executing` flip already happened above, before provisioning, so the
  // claim is label-visible during the install window (see `flipStoryToExecuting`).
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
    remoteVerified: result.remoteVerified,
    remoteProbe: result.remoteProbe,
  };
  return [
    '## Story init (standalone)',
    '',
    `- **standalone:** \`true\``,
    `- **storyBranch:** \`${result.storyBranch}\``,
    `- **baseBranch:** \`${result.baseBranch}\``,
    `- **workCwd:** \`${result.workCwd}\``,
    `- **worktreeEnabled:** \`${result.worktreeEnabled}\``,
    `- **remoteVerified:** \`${result.remoteVerified}\``,
    `- **dependenciesInstalled:** \`${result.dependenciesInstalled}\``,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
  ].join('\n');
}

runAsCli(import.meta.url, runSingleStoryInit, { source: 'single-story-init' });
