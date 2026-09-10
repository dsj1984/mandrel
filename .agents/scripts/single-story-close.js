#!/usr/bin/env node

/**
 * single-story-close.js — Close a Story against `main` (v2 `/mandrel-deliver` path).
 *
 * Thin CLI entry for `/mandrel-deliver` / `helpers/deliver-story`. Opens a PR from
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
 *                              [--no-auto-merge]
 *                              [--wait-merge | --no-wait-merge]
 *                              [--merge-watch-mode <sync|async>]
 *                              [--rerun-advisory <n>]
 *                              [--override-review-block <reason>]
 *
 * `--override-review-block <reason>` is the one sanctioned way
 * past a code-review CRITICAL blocker. A critical finding halts this script
 * before auto-merge, and until this flag existed there was no override at all —
 * so an operator who had read a finding and judged it wrong could only land by
 * running `gh pr merge` themselves, bypassing the gate with nothing written
 * down. The flag does not weaken the gate; it moves that escape hatch into a
 * mandatory-reason audit trail (Story comment + PR comment + a
 * `review-block-overridden` friction signal) and reports
 * `gates.codeReview: "overridden"` on the terminal envelope. A bare or
 * too-short reason fails during option parsing, before any phase runs.
 *
 * `--merge-watch-mode` (Story #4949) overrides `delivery.mergeWatch.mode` for
 * one invocation, on the same explicit-wins-over-config precedence
 * `--max-wait-seconds` uses, and the two compose. It exists because run
 * topology is invisible from inside close: a solo delivery is cheapest waiting
 * in the foreground, while the Nth close of a wave pays that wait as
 * serialized dead time. The config default therefore stays `sync` and the
 * orchestrator — the only party that knows N — passes `async` per close. An
 * unrecognized value fails during option parsing, before any phase runs.
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
 * Every invocation emits ONE schema-validated terminal envelope
 * (`.agents/schemas/story-deliver-terminal.schema.json`, Story #4543) on
 * stdout between `--- STORY DELIVER TERMINAL ---` markers. Its `status` is
 * the contract; the exit code mirrors it:
 *
 *   0 — `landed`:  the PR merged, the Story is `agent::done`, and the
 *                  post-land tail ran (follow-ups, status resync, local ref
 *                  cleanup, base fast-forward).
 *   3 — `pending`: RESUMABLE, not a failure. Either the per-invocation merge
 *                  wait (`delivery.mergeWatch.maxWaitSeconds`, default 300s
 *                  to fit a single host tool invocation) expired with the PR
 *                  still healthy and in flight, or the operator owns the
 *                  merge (`--no-wait-merge` / `--no-auto-merge` /
 *                  `autoMerge: "strict"`). NO label was mutated and no
 *                  `merge.unlanded` event was emitted. The envelope's
 *                  `nextCommand` names the single command that resumes it,
 *                  and the cumulative budget is anchored at the PR's
 *                  createdAt so the resume does not restart the clock.
 *   1 — `blocked` or `failed`: a classified hard block (the Story carries
 *                  `agent::blocked` and a friction comment) or a phase crash.
 *
 * The distinct `pending` code is the point: before it, a close-and-land whose
 * CI outlived the host's tool-invocation ceiling was killed mid-poll with no
 * terminal path taken at all, and merely shrinking the budget instead would
 * have misfiled every slow-CI run as a hard block.
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
import {
  emitTerminalEnvelope,
  exitCodeForTerminal,
} from './lib/orchestration/story-deliver-terminal.js';

// Story #2990 moved the `gh`-spawn boundary into the `lib/gh-exec.js`
// facade (the same shim the `providers/github/` gateways use). The
// re-exports below preserve the SUT's public surface so tests and the
// orchestration body keep importing `ensurePullRequest` /
// `enableAutoMerge` from this file unchanged.
export const ensurePullRequest = ensurePullRequestWith;
export const enableAutoMerge = enableAutoMergeWith;

// Re-export pure helpers verbatim — they don't touch `execFileSync`
// or any URL-mocked module, so the phase exports work unmodified.
// `gatesForFailedPhase` now lives beside the envelope it feeds
// (`single-story-close/failed-terminal.js`); it is re-exported here so the
// CLI's public surface is unchanged by that move.
// `resolveRunScopedConfig` (Story #4891) is the run-scoped config pin the
// pipeline reads before its first phase; it is part of this CLI's surface for
// the same reason the sync helpers are — the runner reaches it only through a
// dynamic import, so this file is where it is statically visible.
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
 * CLI entry — resolves the process exit code from the terminal envelope's
 * status rather than from a thrown/not-thrown distinction, so `pending`
 * (resumable) is distinguishable from `blocked` (come look) without parsing
 * stdout.
 *
 * The catch parses argv through the **non-throwing** wrapper (Story #4959).
 * It used to call `parseSprintArgs()` — re-invoking the very parser that had
 * just thrown, since `parseMergeWatchMode` made argv parsing fallible. The
 * second throw escaped the handler, so an unparseable argv produced a bare
 * stack trace with no envelope and no friction signal, on the surface whose
 * whole contract is that every invocation emits exactly one envelope. An
 * error handler may not depend on an operation already known to fail.
 *
 * A parse rejection carries no `closePhase`, so the envelope reports `init` —
 * accurate: the runner rejected the flag before any phase ran, and nothing
 * was mutated.
 */
async function main() {
  try {
    const outcome = await runSingleStoryClose();
    return exitCodeForTerminal(outcome?.terminal ?? { status: 'failed' });
  } catch (err) {
    const terminal = failedTerminalFor(err, parseSprintArgsTolerant().args);
    if (!terminal) throw err;
    // Mirror runAsCli's default error line (which this catch pre-empts) so the
    // human-facing failure text is unchanged, then emit the envelope.
    Logger.error(`[single-story-close] Fatal error: ${formatCliError(err)}`);
    emitTerminalEnvelope(terminal);
    // Story #4578 — a close that died before the runner could report its own
    // terminal is exactly the friction the retro must see, so the crash path
    // gets the same emit the happy path does. Best-effort; cannot throw.
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
        // Deliberately does not spell the merge CLI invocation: the
        // merge-lockout rule in `check-lifecycle-lint.js` forbids that literal
        // in any string outside `phases/auto-merge.js`, and it is right to —
        // the point of this flag is that arming stays on the one code path.
        'Land despite a Story-scope code-review CRITICAL blocker you have reviewed and judged wrong. The reason is mandatory (≥12 chars) and is recorded on the Story, on the PR, and as a `review-block-overridden` friction signal; the terminal envelope reports `gates.codeReview: "overridden"`. Use this instead of merging the PR by hand with the GitHub CLI — a hand-merge bypasses the gate with no record at all.',
      ],
    ],
    notes: [
      'Exit codes:\n  0  landed\n  1  blocked or failed\n  3  pending (resumable — run the envelope’s nextCommand)',
    ],
  },
});
