#!/usr/bin/env node

/**
 * single-story-close.js — Close a Story against `main` (v2 `/deliver` path).
 *
 * Thin CLI entry for `/deliver` / `helpers/deliver-story`. Opens a PR from
 * `story-<id>` to `project.baseBranch`, runs Story-scope review, and arms
 * auto-merge. There is no Epic parent, epic-merge-lock, or wave merge.
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
 *   9. confirm-merge      — close-and-land (Story #4428; the DEFAULT for
 *                          every run since `delivery.routing.closeAndLand`):
 *                          poll the just-armed PR to merge confirmation
 *                          (reusing `confirmStoryMerged`), capture the
 *                          Story follow-ups, or terminate `agent::blocked`
 *                          with a classified `merge.unlanded` event — or
 *                          `merge.flip-failed` when the merge landed and
 *                          only the label write failed. Skipped when the
 *                          operator owns the merge (`--no-wait-merge`,
 *                          `--no-auto-merge`, or `autoMerge: "strict"`),
 *                          which rests at `agent::closing` for the human.
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
 * Close-and-land is the DEFAULT for every run (Story #4428 introduced it as
 * `--wait-merge`; `delivery.routing.closeAndLand` — default `true` — made it
 * the default, and Story #4539 made that knob actually readable). Resolution
 * order, highest first: `--no-wait-merge` (explicit opt-out, always wins);
 * operator-owns-the-merge (`--no-auto-merge` or `delivery.ci.autoMerge:
 * "strict"` — the PR was deliberately left un-armed, so there is nothing to
 * land and the Story rests at `agent::closing`); explicit `--wait-merge`;
 * then the config. A genuine arm FAILURE is not an opt-out — it still waits
 * and therefore still blocks, which is what keeps the must-land contract
 * intact.
 *
 * Exit codes: 0 ok, 1 error (including a headless `--wait-merge` run that
 * gave up without a confirmed merge — see phase 9 above).
 *
 * @see .agents/workflows/helpers/deliver-story.md
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
