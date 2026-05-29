#!/usr/bin/env node

/**
 * single-story-close.js — Close a standalone Story (no parent Epic).
 *
 * Thin CLI entry for the `/single-story-deliver` workflow. Counterpart to
 * `story-close.js`, but skips the Epic-attached machinery (epic-merge-lock,
 * dispatchRecovery, auto-refresh, post-merge pipeline) because a standalone
 * Story has no parent to cascade to and reaches `main` via a human-approved
 * PR rather than an in-script merge.
 *
 * Pipeline (each step is a phase under
 * `./lib/orchestration/single-story-close/phases/`):
 *
 *   1. close-validation  — canonical gate chain against `baseBranch`
 *   2. base-sync         — `origin/<baseBranch>` → Story branch (Story #2580)
 *   3. push              — `git push -u` the Story branch
 *   4. pull-request      — `gh pr list` probe + `gh pr create`
 *   5. code-review       — Story-scope review (Epic #2815 / Story #2839)
 *   6. auto-merge        — `gh pr merge --auto --squash --delete-branch`
 *   7. label flip + notify — Story → `agent::done`
 *   8. worktree-reap     — drop the per-Story worktree
 *
 * Existing tests import the re-exported helpers
 * (`runSingleStoryClose`, `ensurePullRequest`, `parsePrNumber`,
 * `enableAutoMerge`, `handleSyncFailure`, `buildSyncFailureCommentBody`,
 * `runStoryScopeReview`, `buildStoryReviewCrossRefBody`) from this file.
 *
 * Usage:
 *   node single-story-close.js --story <STORY_ID> [--cwd <main-repo>]
 *                              [--skip-validation] [--skip-sync]
 *                              [--no-auto-merge] [--no-full-scope-crap]
 *
 * Exit codes: 0 ok, 1 error.
 *
 * @see .agents/workflows/single-story-deliver.md
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { runAsCli } from './lib/cli-utils.js';
import { runCloseValidation } from './lib/close-validation.js';
import { resolveConfig } from './lib/config-resolver.js';
import { getStoryBranch, gitSync } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { runCodeReview as runCodeReviewDefault } from './lib/orchestration/code-review.js';
import {
  enableAutoMergeWith,
  runAutoMergePhase,
} from './lib/orchestration/single-story-close/phases/auto-merge.js';
import {
  buildSyncFailureCommentBody,
  handleSyncFailure,
  runBaseSyncPhase,
} from './lib/orchestration/single-story-close/phases/base-sync.js';
import { runCloseValidationPhase } from './lib/orchestration/single-story-close/phases/close-validation.js';
import {
  buildStoryReviewCrossRefBody,
  parsePrNumber,
  runStoryScopeReview,
} from './lib/orchestration/single-story-close/phases/code-review.js';
import { runDriftDetectionPhase } from './lib/orchestration/single-story-close/phases/drift-detection.js';
import { parseCloseOptions } from './lib/orchestration/single-story-close/phases/options.js';
import { ensurePullRequestWith } from './lib/orchestration/single-story-close/phases/pull-request.js';
import { pushStoryBranch } from './lib/orchestration/single-story-close/phases/push.js';
import { reapWorktreePhase } from './lib/orchestration/single-story-close/phases/worktree-reap.js';
import { runWrongTreeGuardPhase } from './lib/orchestration/single-story-close/phases/wrong-tree-guard.js';
import { buildGatesFromConfig } from './lib/orchestration/story-close/legacy-settings-bag.js';
import { createProvider } from './lib/provider-factory.js';
import { flipLabelAndNotify } from './lib/single-story/story-merged-notify.js';
import { WorktreeManager } from './lib/worktree-manager.js';

// Story #2990 moved the `gh`-spawn boundary into the `lib/gh-exec.js`
// facade (the same shim the `providers/github/` gateways use). The
// re-exports below preserve the SUT's public surface so tests and the
// orchestration body keep importing `ensurePullRequest` /
// `enableAutoMerge` from this file unchanged.
export const ensurePullRequest = ensurePullRequestWith;
export const enableAutoMerge = enableAutoMergeWith;

// Re-export pure helpers verbatim — they don't touch `execFileSync`
// or any URL-mocked module, so the phase exports work unmodified.
export {
  buildStoryReviewCrossRefBody,
  buildSyncFailureCommentBody,
  handleSyncFailure,
  parsePrNumber,
  runStoryScopeReview,
};

const progress = Logger.createProgress('single-story-close', { stderr: true });

/**
 * Close a standalone Story. Exported for testing.
 */
export async function runSingleStoryClose({
  storyId: storyIdParam,
  cwd: cwdParam,
  skipValidation: skipValidationParam,
  skipSync: skipSyncParam,
  noAutoMerge: noAutoMergeParam,
  noFullScopeCrap: noFullScopeCrapParam,
  injectedProvider,
  injectedConfig,
  injectedNotify,
  injectedSync,
  injectedRunCodeReview,
  // Story #2990: lets orchestration tests pass a fake `lib/gh-exec.js`
  // facade through to the PR open / auto-merge phases without touching
  // module mocks. Defaults to the real `gh` import on each phase.
  injectedGh,
  // Story #3260: lets tests inject fakes for plan-vs-actual drift detection.
  injectedFindStructuredComment,
  injectedGitSync,
  // Story #3364: lets tests inject a fake `gitSpawn` for the wrong-tree guard.
  injectedGitSpawn,
} = {}) {
  const {
    storyId,
    cwd,
    skipValidation,
    skipSync,
    noAutoMerge,
    noFullScopeCrap,
  } = parseCloseOptions({
    storyIdParam,
    cwdParam,
    skipValidationParam,
    skipSyncParam,
    noAutoMergeParam,
    noFullScopeCrapParam,
  });

  if (!storyId) {
    throw new Error(
      'Usage: node single-story-close.js --story <STORY_ID> [--cwd <main-repo>] [--skip-validation] [--skip-sync] [--no-auto-merge] [--no-full-scope-crap]',
    );
  }

  const config = injectedConfig || resolveConfig({ cwd });
  const provider = injectedProvider || createProvider(config);

  const baseBranch = config.project?.baseBranch ?? 'main';
  const storyBranch = getStoryBranch(0, storyId);

  progress('INIT', `Closing standalone Story #${storyId}...`);

  const story = await provider.getTicket(storyId);
  if (story.state === 'closed') {
    progress('NOOP', `Story #${storyId} is already closed. Nothing to do.`);
    return {
      success: true,
      result: {
        storyId,
        standalone: true,
        action: 'noop',
        reason: 'already-closed',
      },
    };
  }

  // Resolve worktree path (read-only check — does the dir exist on disk?).
  const worktreeRoot = config.delivery?.worktreeIsolation?.root ?? '.worktrees';
  const worktreePathCandidate = path.resolve(
    cwd,
    worktreeRoot,
    `story-${storyId}`,
  );
  const worktreePath = nodeFs.existsSync(worktreePathCandidate)
    ? worktreePathCandidate
    : null;

  // Step 0.4: wrong-tree guard (Story #3364). When the worktree is the active
  // work tree, abort if stray tracked-path edits are sitting in the main
  // checkout — they signal that path-based Edit/Write tools wrote to the wrong
  // tree (the Bash `cd` only steers the shell). Runs before any gate so a
  // false-clean worktree never reaches commit. Throws on a confirmed positive.
  await runWrongTreeGuardPhase({
    cwd,
    worktreePath,
    storyId,
    provider,
    progress,
    gitSpawn: injectedGitSpawn,
  });

  // Step 0.5: plan-vs-actual drift detection (non-blocking soft findings).
  await runDriftDetectionPhase({
    cwd,
    baseBranch,
    storyId,
    provider,
    progress,
    injectedFindStructuredComment,
    injectedGitSync,
  });

  // Step 1: gates.
  if (!skipValidation) {
    await runCloseValidationPhase({
      cwd,
      worktreePath,
      config,
      baseBranch,
      noFullScopeCrap,
      storyId,
      progress,
      runCloseValidation,
      buildGatesFromConfig,
    });
  } else {
    progress('VALIDATE', '⏭ Skipped (--skip-validation).');
  }

  // Step 1a: pre-push base-sync.
  if (!skipSync) {
    await runBaseSyncPhase({
      cwd,
      worktreePath,
      baseBranch,
      storyBranch,
      storyId,
      provider,
      injectedSync,
      progress,
    });
  } else {
    progress('SYNC', '⏭ Skipped (--skip-sync).');
  }

  // Step 2: push the Story branch.
  pushStoryBranch({ cwd, storyBranch, gitSync, progress });

  // Step 3: open (or reuse) a PR to `baseBranch`.
  const prUrl = await ensurePullRequest({
    cwd,
    storyId,
    storyTitle: story.title,
    storyBranch,
    baseBranch,
    gh: injectedGh,
    progress,
  });

  // Step 3.5: Story-scope code review.
  const prNumber = parsePrNumber(prUrl);
  const reviewOutcome = await runStoryScopeReview({
    cwd,
    storyId,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    provider,
    runCodeReviewFn: injectedRunCodeReview ?? runCodeReviewDefault,
    progress,
  });
  if (reviewOutcome.halted) {
    throw new Error(
      `[single-story-close] Story-scope review reported ${reviewOutcome.severity?.critical ?? 0} critical blocker(s) on PR ${prUrl}. ` +
        'Auto-merge was not enabled. Remediate the findings posted to the PR and re-run `/single-story-deliver`.',
    );
  }

  // Step 3a: enable native auto-merge unless --no-auto-merge.
  const { autoMergeEnabled, autoMergeReason } = await runAutoMergePhase({
    cwd,
    prNumber,
    prUrl,
    noAutoMerge,
    gh: injectedGh,
    progress,
  });

  // Step 4: flip Story label to agent::done and fire story-merged notify.
  await flipLabelAndNotify({
    provider,
    notifyFn: injectedNotify,
    storyId,
    story,
    prUrl,
    autoMergeEnabled,
    autoMergeReason,
    config,
    progress,
  });

  // Step 5: reap worktree + clear trace-hook env vars.
  const worktreeReaped = await reapWorktreePhase({
    cwd,
    storyId,
    worktreePath,
    wtIsolation: config.delivery?.worktreeIsolation,
    progress,
    WorktreeManager,
  });

  const result = {
    storyId,
    standalone: true,
    storyBranch,
    baseBranch,
    prUrl,
    prNumber,
    pushed: true,
    autoMergeEnabled,
    autoMergeReason,
    worktreeReaped,
    note: autoMergeEnabled
      ? 'PR open against baseBranch with auto-merge enabled. GitHub will squash-merge when required checks pass; the Closes #<id> footer auto-closes the issue.'
      : 'PR open against baseBranch. Operator merges via GitHub UI to close the issue (Closes #<id> auto-close).',
  };

  Logger.info(
    `\n--- STORY CLOSE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  progress('DONE', `✅ Standalone Story #${storyId}: PR ready → ${prUrl}`);
  return { success: true, result };
}

runAsCli(import.meta.url, runSingleStoryClose, {
  source: 'single-story-close',
});
