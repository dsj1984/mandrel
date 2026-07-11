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
 *   7. label flip + notify — Story → `agent::closing` (Story #3385; the
 *                          `agent::done` flip + issue-close is deferred to
 *                          the post-merge confirmation step,
 *                          `single-story-confirm-merge.js`)
 *   8. worktree-reap     — drop the per-Story worktree
 *   9. confirm-merge      — Story #4428, headless-only (`--wait-merge`):
 *                          poll the just-armed PR to merge confirmation
 *                          (reusing `confirmStoryMerged`) or terminate
 *                          `agent::blocked` with a classified
 *                          `merge.unlanded` lifecycle event. Attended runs
 *                          (the default, no `--wait-merge`) skip this
 *                          phase entirely and keep resting at
 *                          `agent::closing`, exactly as before.
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
 *                              [--wait-merge | --no-wait-merge]
 *
 * `--wait-merge` is the headless must-land signal (Story #4428, Epic
 * #4425): the invoking surface (a headless `/single-story-deliver` run, a
 * CI-driven wrapper, or `/deliver`'s standalone multi-Story fan-out) opts
 * in explicitly — attended runs never pass it, so the default exit shape
 * (rest at `agent::closing`, issue OPEN) is unchanged. `--no-wait-merge` is
 * the explicit opt-out that always wins over `--wait-merge`, for a caller
 * that wants to manage merge confirmation externally even in an otherwise
 * headless context.
 *
 * Exit codes: 0 ok, 1 error (including a headless `--wait-merge` run that
 * gave up without a confirmed merge — see phase 9 above).
 *
 * @see .agents/workflows/helpers/single-story-deliver.md
 */

import { runAsCli } from './lib/cli-utils.js';
import { enableAutoMergeWith } from './lib/orchestration/single-story-close/phases/auto-merge.js';
import {
  buildSyncFailureCommentBody,
  handleSyncFailure,
} from './lib/orchestration/single-story-close/phases/base-sync.js';
import {
  buildStoryReviewCrossRefBody,
  parsePrNumber,
  runStoryScopeReview,
} from './lib/orchestration/single-story-close/phases/code-review.js';
import { ensurePullRequestWith } from './lib/orchestration/single-story-close/phases/pull-request.js';

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

export async function runSingleStoryClose(opts) {
  const { search } = new URL(import.meta.url);
  const mod = await import(
    `./lib/orchestration/single-story-close/runner.js${search}`
  );
  return mod.runSingleStoryClose(opts);
}

runAsCli(import.meta.url, runSingleStoryClose, {
  source: 'single-story-close',
});
