#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * single-story-init.js — Initialize a standalone Story (no parent Epic).
 *
 * Counterpart to `story-init.js` for the `/single-story-execute` workflow.
 * The framework's main `story-init.js` requires an `Epic: #N` reference in
 * the Story body to trace hierarchy, seed the Story branch from
 * `epic/<id>`, and gate execution on the epic's dispatch manifest. None of
 * that applies to a standalone Story — a top-level work unit that branches
 * directly from `main` and opens its PR straight to `main`.
 *
 * What this script does:
 *   1. Validate the Story (type::story, not closed).
 *   2. Fetch origin.
 *   3. Create the Story branch from `agentSettings.baseBranch` (default
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
 * @see .agents/workflows/single-story-execute.md
 */

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
import { upsertStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { WorktreeManager } from './lib/worktree-manager.js';

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
    Logger.fatal(
      'Usage: node single-story-init.js --story <STORY_ID> [--dry-run]',
    );
  }

  const config = injectedConfig || resolveConfig({ cwd });
  const { agentSettings, orchestration } = config;
  const provider = injectedProvider || createProvider(orchestration);

  const baseBranch = agentSettings.baseBranch ?? 'main';
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
      `Issue #${storyId} is not a Story (labels: ${story.labels.join(', ')}). Use /story-execute or /epic-deliver for Epic-attached work.`,
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

    // Ensure baseBranch exists locally so we can branch from it. If only
    // remote-tracking is present, materialize the local ref.
    if (!branchExistsLocally(baseBranch, cwd)) {
      const r = gitSpawn(cwd, 'fetch', 'origin', `${baseBranch}:${baseBranch}`);
      if (r.status !== 0) {
        throw new Error(
          `Failed to fetch base branch ${baseBranch}: ${r.stderr || '(no stderr)'}`,
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
        config: orchestration?.worktreeIsolation,
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
      setActiveStoryEnv({
        epicId: 0,
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
      const labels = (story.labels || [])
        .filter((l) => !l.startsWith('agent::'))
        .concat('agent::executing');
      await provider.updateTicket(storyId, { labels });
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
