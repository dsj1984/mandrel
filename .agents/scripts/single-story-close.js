#!/usr/bin/env node

/**
 * single-story-close.js — close a Story against the base branch: gates,
 * base-sync, push, PR, Story-scope review, arm auto-merge, flip to
 * `agent::closing`, reap the worktree, then (by default) wait for the merge.
 * The wait is skipped when the operator owns the merge (`--no-wait-merge`,
 * `--no-auto-merge`, `autoMerge: "strict"`); an arm FAILURE still waits and
 * blocks, keeping the must-land contract.
 *
 * Usage:
 *   node single-story-close.js --story <STORY_ID> [--cwd <main-repo>]
 *                              [--skip-validation] [--skip-sync]
 *                              [--no-auto-merge]
 *                              [--wait-merge | --no-wait-merge]
 *                              [--merge-watch-mode <sync|async>]
 *                              [--rerun-advisory <n>]
 *                              [--override-review-block <reason>]
 *
 * `--override-review-block <reason>` is the audited escape past a code-review
 * CRITICAL blocker (instead of a hand-merge with no record).
 * `--merge-watch-mode async` is passed per close by the orchestrator, the only
 * party that knows the run has N Stories and a foreground wait is dead time.
 *
 * Every invocation emits ONE terminal envelope; the exit code mirrors its
 * status: 0 `landed`; 3 `pending` (resumable — the per-invocation wait
 * expired with the PR healthy, or the operator owns the merge; nothing
 * mutated, run `nextCommand`); 1 `blocked` or `failed`.
 *
 * @see .agents/workflows/helpers/deliver-story.md
 * @see .agents/schemas/story-deliver-terminal.schema.json
 */

import { parseSprintArgsTolerant } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { formatCliError } from './lib/error-redactor.js';
import { Logger } from './lib/Logger.js';
import { emitTerminalFriction } from './lib/observability/runtime-friction.js';
import { resolveRunScopedConfig } from './lib/orchestration/run-scoped-config.js';
import {
  failedTerminalFor,
  gatesForFailedPhase,
} from './lib/orchestration/single-story-close/failed-terminal.js';
import {
  buildSyncFailureCommentBody,
  handleSyncFailure,
} from './lib/orchestration/single-story-close/phases/base-sync.js';
import {
  buildStoryReviewCrossRefBody,
  parsePrNumber,
  runStoryScopeReview,
} from './lib/orchestration/single-story-close/phases/code-review.js';
import {
  emitTerminalEnvelope,
  exitCodeForTerminal,
} from './lib/orchestration/story-deliver-terminal.js';

// Pure helpers re-exported as this CLI's public surface; the runner is
// reached only via dynamic import, so this is where they are statically
// visible.
export {
  buildStoryReviewCrossRefBody,
  buildSyncFailureCommentBody,
  gatesForFailedPhase,
  handleSyncFailure,
  parsePrNumber,
  resolveRunScopedConfig,
  runStoryScopeReview,
};

export async function runSingleStoryClose(opts) {
  const { search } = new URL(import.meta.url);
  const mod = await import(
    `./lib/orchestration/single-story-close/runner.js${search}`
  );
  return mod.runSingleStoryClose(opts);
}

/**
 * Exit code comes from the envelope's status. The catch parses argv with the
 * non-throwing wrapper: the strict parser may be what just threw, and every
 * invocation must still emit exactly one envelope.
 */
async function main() {
  try {
    const outcome = await runSingleStoryClose();
    return exitCodeForTerminal(outcome?.terminal ?? { status: 'failed' });
  } catch (err) {
    const terminal = failedTerminalFor(err, parseSprintArgsTolerant().args);
    if (!terminal) throw err;
    // Mirrors runAsCli's default error line, which this catch pre-empts.
    Logger.error(`[single-story-close] Fatal error: ${formatCliError(err)}`);
    emitTerminalEnvelope(terminal);
    await emitTerminalFriction({ envelope: terminal });
    return exitCodeForTerminal(terminal);
  }
}

runAsCli(import.meta.url, main, {
  source: 'single-story-close',
  propagateExitCode: true,
  usage: {
    invocation:
      'node .agents/scripts/single-story-close.js --story <id> [--cwd <main-repo>] [options]',
    summary:
      'Run the whole delivery tail for one Story — close gates, base sync, push, PR to the base branch, merge wait, agent::done flip — and emit the terminal envelope.',
    flags: [
      ['--story <id>', 'GitHub issue number of the Story (required).'],
      [
        '--cwd <main-repo>',
        'Main-repo checkout to run from (default: project root).',
      ],
      ['--skip-validation', 'Skip the close-validation gate chain.'],
      ['--skip-sync', 'Skip the base-branch sync phase.'],
      ['--no-auto-merge', 'Open the PR without arming native auto-merge.'],
      ['--wait-merge', 'Force the in-close merge wait.'],
      ['--no-wait-merge', 'Return as soon as the PR is open; do not wait.'],
      ['--max-wait-seconds <n>', 'Per-invocation merge-wait bound.'],
      [
        '--rerun-advisory <n>',
        'How many times this close may re-run a failed ADVISORY (non-required) workflow run before blocking on it. Overrides `delivery.ci.rerunAdvisory` for one invocation; BOTH default to 0, so close spends no CI minutes and issues no GitHub mutation on an advisory red unless you ask. At n > 0 the failed run(s) are re-run within that allowance and the merge wait keeps polling inside its existing budget, landing or blocking on the re-run verdict.',
      ],
      [
        '--merge-watch-mode <sync|async>',
        'Override delivery.mergeWatch.mode for this invocation only. `async` caps the merge wait to a short probe window and returns the resumable `pending` terminal instead of holding the foreground slot — pass it on every close of a multi-Story run. An invalid value exits non-zero before any phase runs.',
      ],
      [
        '--override-review-block <reason>',
        // Must not spell the merge CLI invocation: `check-lifecycle-lint.js`
        // forbids that literal outside `phases/auto-merge.js`.
        'Land despite a Story-scope code-review CRITICAL blocker you have reviewed and judged wrong. The reason is mandatory (≥12 chars) and is recorded on the Story, on the PR, and as a `review-block-overridden` friction signal; the terminal envelope reports `gates.codeReview: "overridden"`. Use this instead of merging the PR by hand with the GitHub CLI — a hand-merge bypasses the gate with no record at all.',
      ],
    ],
    notes: [
      'Exit codes:\n  0  landed\n  1  blocked or failed\n  3  pending (resumable — run the envelope’s nextCommand)',
    ],
  },
});
