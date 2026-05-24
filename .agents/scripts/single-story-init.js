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
 *   - Skips `traceHierarchy` — no Epic → no PRD/Tech-Spec.
 *   - Skips `runDispatchManifestGuard` — no dispatch manifest exists for a
 *     standalone Story.
 *   - Skips `validateBlockers` against the body's `Blocked by:` markers —
 *     pre-flight is still the operator's responsibility, but the Epic-scope
 *     blocker chain doesn't fit.
 *   - Skips child-Task transitions — a standalone Story is treated as
 *     atomic (one branch, one commit-set, one PR).
 *
 * Usage: `node single-story-init.js --story <STORY_ID> [--dry-run]`
 * Exit codes: 0 ok, 1 error.
 *
 * @see .agents/workflows/single-story-deliver.md
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseSprintArgs } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  resolveRuntime,
} from './lib/config-resolver.js';
import {
  branchExistsLocally,
  branchExistsRemotely,
} from './lib/git-branch-lifecycle.js';
import {
  getStoryBranch,
  gitFetchWithRetry,
  gitSpawn,
  gitSync,
} from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { setActiveStoryEnv } from './lib/observability/active-story-env.js';
import {
  executeFastForward,
  planFastForward,
} from './lib/orchestration/git-cleanup/phases/fast-forward.js';
import {
  STATE_LABELS,
  transitionTicketState,
  upsertStructuredComment,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
// `sweepMergedStoryBranches` is imported dynamically below — its transitive
// graph reaches `picomatch` (via `git-cleanup.js`). Loading it statically
// would crash module resolution before `assertDepsInstalled()` can emit a
// friendly "run npm install" message.
import { WorktreeManager } from './lib/worktree-manager.js';

/**
 * Fail fast with a clear, actionable message when project deps are missing.
 * Uses only Node builtins so it stays loadable when `node_modules/` is empty.
 *
 * Why: a wiped `node_modules/` previously surfaced as
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'picomatch'` from deep inside
 * the sweep graph — opaque for operators. This guard probes a representative
 * runtime dep (declared in `REQUIRED_RUNTIME_DEPS`) and tells the operator
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
 * Initialize a standalone Story. Exported for testing.
 */
export async function runSingleStoryInit({
  storyId: storyIdParam,
  dryRun: dryRunParam,
  cwd: cwdParam,
  injectedProvider,
  injectedConfig,
  injectedSweep,
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
  if (!story.labels.includes(TYPE_LABELS.STORY)) {
    throw new Error(
      `Issue #${storyId} is not a Story (labels: ${story.labels.join(', ')}). Use /story-deliver or /epic-deliver for Epic-attached work.`,
    );
  }
  if (story.state === 'closed') {
    throw new Error(`Story #${storyId} is already closed.`);
  }

  progress(
    'CONTEXT',
    `Standalone Story: "${story.title}" → branch ${storyBranch} from ${baseBranch}.`,
  );

  let workCwd = cwd;
  let worktreeCreated = false;
  let installStatus = { status: 'skipped', reason: 'dry-run' };

  if (!dryRun) {
    progress('GIT', 'Fetching remote refs...');
    const fetchResult = await gitFetchWithRetry(cwd, 'origin');
    if (fetchResult.attempts > 1) {
      progress(
        'GIT',
        `Fetch completed after ${fetchResult.attempts} attempt(s) — packed-refs contention.`,
      );
    }

    // Reap previously-merged `story-*` branches before we start a new one,
    // so stale local + origin refs do not accumulate across runs. The sweep
    // excludes the current run's `storyBranch` and never blocks init: any
    // sweep failure is logged but does not throw.
    //
    // Story #2011 hardens this surface in two ways:
    //   - Per-candidate protection: branches with unpushed work, dirty
    //     worktrees, or still-open Story tickets are skipped (and listed
    //     in `sweep.protected` for the operator).
    //   - Cross-session lock: a single lockfile under `tempRoot` prevents
    //     two concurrent `/single-story-deliver` invocations from racing.
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
        protectionCtx: {
          repoRoot: cwd,
          gitSpawn,
          ghRunner: (args, opts) => {
            const result = spawnSync('gh', args, {
              cwd: opts?.cwd ?? cwd,
              encoding: 'utf-8',
              shell: false,
            });
            if (result.status !== 0) {
              throw new Error(
                `gh ${args.join(' ')} exit ${result.status}: ${result.stderr ?? ''}`,
              );
            }
            return result.stdout ?? '';
          },
          getTicket: (id) => provider.getTicket(id),
        },
        lockPath,
        lockTimeoutMs,
      });
      if (sweep.error) {
        progress(
          'CLEANUP',
          `⚠️ sweep returned error (init continues): ${sweep.error}`,
        );
      } else if (sweep.skipped && sweep.reason) {
        progress(
          'CLEANUP',
          `⏭ sweep skipped (${sweep.reason}); init continues.`,
        );
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

    // Ensure baseBranch exists locally so we can branch from it. If only
    // remote-tracking is present, materialize the local ref.
    if (!branchExistsLocally(baseBranch, cwd)) {
      const r = gitSpawn(cwd, 'fetch', 'origin', `${baseBranch}:${baseBranch}`);
      if (r.status !== 0) {
        throw new Error(
          `Failed to fetch base branch ${baseBranch}: ${r.stderr || '(no stderr)'}`,
        );
      }
    } else {
      // `git fetch origin` updates remote-tracking refs only; local
      // `main` stays at the pre-merge tip until fast-forwarded. Use the
      // same helper as `/git-cleanup --fast-forward-main` (checkout base +
      // `merge --ff-only`) so new `story-*` branches seed from origin's
      // tip when the main checkout is clean (Story #2744).
      const ffPlan = planFastForward({ cwd, baseBranch });
      const ff = executeFastForward({
        cwd,
        baseBranch,
        plan: ffPlan,
        logger: {
          info: (m) => progress('GIT', m.replace(/^\[git-cleanup\]\s*/, '')),
          warn: (m) =>
            progress('GIT', `⚠️ ${m.replace(/^\[git-cleanup\]\s*/, '')}`),
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

    // Seed the Story branch. Three cases, idempotent in all of them:
    //   - already local → noop
    //   - remote only   → fetch
    //   - neither       → create from baseBranch
    const localHas = branchExistsLocally(storyBranch, cwd);
    const remoteHas = branchExistsRemotely(storyBranch, cwd);
    if (!localHas && remoteHas) {
      progress('GIT', `Fetching remote story branch: ${storyBranch}`);
      const r = gitSpawn(
        cwd,
        'fetch',
        'origin',
        `${storyBranch}:${storyBranch}`,
      );
      if (r.status !== 0) {
        throw new Error(
          `Failed to fetch story branch ${storyBranch}: ${r.stderr || '(no stderr)'}`,
        );
      }
    } else if (!localHas && !remoteHas) {
      progress(
        'GIT',
        `Creating story branch ref: ${storyBranch} from ${baseBranch}`,
      );
      const r = gitSpawn(cwd, 'branch', storyBranch, baseBranch);
      if (r.status !== 0) {
        throw new Error(
          `Failed to create story branch ${storyBranch}: ${r.stderr || '(no stderr)'}`,
        );
      }
    } else {
      progress('GIT', `Reusing existing local story branch: ${storyBranch}`);
    }

    // Worktree (or single-tree fallback).
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
      installStatus = { status: 'skipped', reason: 'single-tree-mode' };
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
