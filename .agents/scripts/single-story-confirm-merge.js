#!/usr/bin/env node

/**
 * single-story-confirm-merge.js — confirm a standalone Story's PR merged
 * and flip `agent::closing → agent::done` (closing the issue).
 *
 * Story #3385 — the post-merge half of the standalone close path.
 * `single-story-close.js` rests the Story at `agent::closing` with its
 * GitHub issue OPEN while the PR is open with auto-merge armed. GitHub
 * auto-merge completes *asynchronously* after the close script exits, so
 * the `agent::done` flip (which closes the issue) is deferred to this
 * confirmation step, invoked by the CI-watch loop in
 * `helpers/deliver-story.md` once `pr-watch-with-update.js` exits.
 *
 * The script:
 *   1. Resolves the PR number (`--pr <n>`, or probes
 *      `gh pr list --head story-<id> --state all`).
 *   2. Reads the live PR state via `gh pr view --json state,mergedAt`.
 *   3. When the PR is MERGED → flips `agent::closing → agent::done`
 *      (issue closes via the canonical mutator) and fires the
 *      `story-merged` notify.
 *   4. When the PR is still open / closed-without-merge → leaves the Story
 *      at `agent::closing` and exits cleanly (recoverable; re-run after
 *      the merge lands).
 *
 * Idempotent: re-running on an already-done / already-closed Story
 * short-circuits to a `noop` envelope.
 *
 * Usage:
 *   node single-story-confirm-merge.js --story <STORY_ID> [--pr <n>]
 *                                      [--cwd <main-repo>]
 *
 * Exit codes: 0 ok (merged, pending, or noop), 1 error.
 *
 * @see .agents/workflows/helpers/deliver-story.md
 */

import { parseArgs } from 'node:util';
import { parseSprintArgs } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { formatCliError } from './lib/error-redactor.js';
import { gh as defaultGh } from './lib/gh-exec.js';
import { getStoryBranch } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { emitTerminalFriction } from './lib/observability/runtime-friction.js';
import { MERGED_FLIP_FAILED_BLOCK_CLASS } from './lib/orchestration/lifecycle/emit-merge-flip-failed.js';
import { parsePrNumber } from './lib/orchestration/single-story-close/phases/code-review.js';
import { runConfirmMergePhase as defaultRunConfirmMergePhase } from './lib/orchestration/single-story-close/phases/confirm-merge.js';
import { parseCloseOptions } from './lib/orchestration/single-story-close/phases/options.js';
import { runPostLandTail } from './lib/orchestration/single-story-close/phases/post-land.js';
import {
  buildTerminalEnvelope,
  emitTerminalEnvelope,
  exitCodeForTerminal,
  NEXT_COMMANDS,
  terminalFromWaitOutcome,
} from './lib/orchestration/story-deliver-terminal.js';
import { createProvider } from './lib/provider-factory.js';
import { confirmStoryMerged } from './lib/single-story/confirm-merge.js';

const progress = Logger.createProgress('single-story-confirm-merge', {
  stderr: true,
});

/**
 * Read the `--pr <n>` flag from `process.argv` for the direct-CLI path.
 * Injection callers pass `pr` directly and never reach this. Returns the
 * raw string value or `undefined` when the flag is absent.
 *
 * @returns {string|undefined}
 */
function readPrFlag() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { pr: { type: 'string' } },
      strict: false,
    });
    return values.pr;
  } catch {
    return undefined;
  }
}

/**
 * `--wait`: resume the bounded merge wait rather than probing once.
 *
 * This CLI serves two callers behind one command string. `confirmMerge` wants
 * a fast idempotent flip for a merge that ALREADY happened (an operator-merge
 * flow, or a `merged-flip-failed` retry) and must not stall. `resumeLand`
 * wants to pick up a merge wait the close handed off at its per-invocation
 * bound — that one must actually wait, and must be able to give up.
 */
function readWaitFlag() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { wait: { type: 'boolean', default: false } },
      strict: false,
    });
    return values.wait === true;
  } catch {
    return false;
  }
}

/**
 * Resolve the PR number for the Story branch when one was not passed on
 * the CLI. Probes `gh pr list --head <branch> --state all` (the merged PR
 * is no longer `open`, so `--state all` is required). Returns `null` when
 * no PR is found.
 *
 * @param {{ cwd: string, storyBranch: string, gh: object }} args
 * @returns {Promise<number|null>}
 */
async function resolvePrNumber({ cwd, storyBranch, gh }) {
  try {
    void cwd;
    const rows = await gh.pr.list(
      ['--head', storyBranch, '--state', 'all'],
      ['number', 'url'],
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (Number.isInteger(row?.number) && row.number > 0) return row.number;
    return parsePrNumber(String(row?.url ?? ''));
  } catch (err) {
    Logger.warn(
      `[single-story-confirm-merge] ⚠️ \`gh pr list\` probe failed: ${err?.message ?? err}`,
    );
    return null;
  }
}

/**
 * Story #4578 — async so the runtime-derived friction emit can be awaited.
 * This CLI is the resume path for a parked worker (`--wait`), so a `pending`
 * terminal here means a bounded wait expired again with the PR still in
 * flight: the exact observable the retro was blind to. The emit is
 * best-effort and cannot throw; awaiting it matters because `runAsCli`
 * exits via `process.exit` the moment `main` resolves.
 */
async function logConfirmResult(result, terminal, config) {
  // Human-facing dump stays level-gated; the envelope is the machine
  // contract and must survive AGENT_LOG_LEVEL=silent.
  Logger.info(
    `\n--- CONFIRM MERGE RESULT ---\n${JSON.stringify(result, null, 2)}\n--- END RESULT ---\n`,
  );
  emitTerminalEnvelope(terminal);
  await emitTerminalFriction({ envelope: terminal, config });
  return { success: terminal.status !== 'failed', result, terminal };
}

/**
 * Map a `confirmStoryMerged` envelope onto the shared terminal envelope
 * (Story #4543) so this CLI and the in-close land path report one shape.
 *
 * The three confirm outcomes map cleanly:
 *   - `done` / `noop` (already-done) → `landed`. Both mean the merge is on
 *     the base branch and the Story is `agent::done`.
 *   - `pending` (`pr-open` / `no-pr`) → `pending`. Re-run once the merge
 *     lands; nothing is wrong.
 *   - `flip-failed` → `blocked` with the shared `merged-flip-failed` class:
 *     the merge landed, so this is a label-write fault, and the remedy is
 *     re-running this very command (it is idempotent).
 *   - `pr-not-merged` (closed without merging) → `blocked`. The PR is gone;
 *     a re-run cannot fix it, so it needs a human.
 */
function buildConfirmTerminal({
  storyId,
  storyBranch,
  baseBranch,
  prNumber,
  confirmation,
  tail,
  elapsedSeconds,
}) {
  // `pr-not-merged` means the PR is CLOSED — reporting it as OPEN put a
  // fact in the envelope that the blocked reason directly contradicts.
  const prState = confirmation.merged
    ? 'MERGED'
    : confirmation.reason === 'pr-not-merged'
      ? 'CLOSED'
      : 'OPEN';
  const pr =
    Number.isInteger(prNumber) && prNumber > 0
      ? { number: prNumber, state: prState }
      : null;
  const common = { storyId, storyBranch, baseBranch, pr, elapsedSeconds };

  if (confirmation.action === 'done' || confirmation.action === 'noop') {
    return buildTerminalEnvelope({
      ...common,
      status: 'landed',
      phase: tail ? 'post-land' : 'done',
      tail,
      nextCommand: null,
    });
  }
  if (confirmation.action === 'flip-failed') {
    return buildTerminalEnvelope({
      ...common,
      status: 'blocked',
      phase: 'confirm-merge',
      blocked: {
        blockClass: MERGED_FLIP_FAILED_BLOCK_CLASS,
        reason:
          'merge confirmed but the agent::closing → agent::done label write failed',
        frictionCommentId: null,
      },
      nextCommand: NEXT_COMMANDS.confirmMerge(storyId),
    });
  }
  if (confirmation.reason === 'pr-not-merged') {
    return buildTerminalEnvelope({
      ...common,
      status: 'blocked',
      phase: 'confirm-merge',
      blocked: {
        blockClass: 'api-race-other',
        reason: 'the PR was closed without merging (state=CLOSED)',
        frictionCommentId: null,
      },
      nextCommand: NEXT_COMMANDS.recover(storyId),
    });
  }
  return buildTerminalEnvelope({
    ...common,
    status: 'pending',
    phase: 'confirm-merge',
    nextCommand:
      confirmation.reason === 'no-pr'
        ? NEXT_COMMANDS.recover(storyId)
        : NEXT_COMMANDS.confirmMerge(storyId),
  });
}

async function resolveConfirmPrNumber({ prParam, cwd, storyBranch, gh }) {
  const rawPr = prParam ?? readPrFlag();
  let prNumber = Number.parseInt(String(rawPr ?? ''), 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    prNumber = await resolvePrNumber({ cwd, storyBranch, gh });
  }
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}

/**
 * Confirm a standalone Story's merge. Exported for testing.
 */
export async function runConfirmMerge({
  storyId: storyIdParam,
  cwd: cwdParam,
  pr: prParam,
  wait: waitParam,
  injectedProvider,
  injectedConfig,
  injectedGh,
  injectedNotify,
  injectedReadPrMergeState,
  runConfirmMergePhaseFn = defaultRunConfirmMergePhase,
} = {}) {
  const { storyId, cwd } = parseCloseOptions({
    storyIdParam,
    cwdParam,
  });

  if (!storyId) {
    throw new Error(
      'Usage: node single-story-confirm-merge.js --story <STORY_ID> [--pr <n>] [--wait] [--cwd <main-repo>]',
    );
  }
  const wait = waitParam ?? readWaitFlag();

  const startedAtMs = Date.now();
  const config = injectedConfig || resolveConfig({ cwd });
  const provider = injectedProvider || createProvider(config);
  const gh = injectedGh ?? defaultGh;
  const storyBranch = getStoryBranch(storyId);
  const baseBranch = config.project?.baseBranch ?? 'main';

  progress('INIT', `Confirming merge for standalone Story #${storyId}...`);

  const prNumber = await resolveConfirmPrNumber({
    prParam,
    cwd,
    storyBranch,
    gh,
  });
  if (prNumber == null) {
    progress(
      'CONFIRM',
      `⚠️ No PR found for ${storyBranch}; cannot confirm merge. Story stays at agent::closing.`,
    );
    const noPr = {
      storyId,
      standalone: true,
      action: 'pending',
      reason: 'no-pr',
      merged: false,
    };
    return await logConfirmResult(
      noPr,
      buildConfirmTerminal({
        storyId,
        storyBranch,
        baseBranch,
        prNumber: null,
        confirmation: noPr,
        tail: null,
        elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
      }),
      config,
    );
  }

  // `--wait` (what `NEXT_COMMANDS.resumeLand` passes): resume the merge wait
  // the close handed off at its per-invocation bound, by running the SAME
  // phase the in-close path runs. Without this the resume was a single probe
  // that reported `pending` and exited, so the cumulative `maxBudgetSeconds`
  // give-up — the only thing that ever emits `merge.unlanded` and flips a
  // wedged Story to `agent::blocked` — was reachable ONLY inside the original
  // close invocation. A PR that wedged after the close returned could be
  // resumed forever, always answering `pending`, never escalating to anyone.
  //
  // The phase anchors its cumulative budget at the PR's `createdAt`, so the
  // resume does not restart the clock — exactly what the envelope's
  // `waitBudget` contract already promised.
  if (wait) {
    const waitOutcome = await runConfirmMergePhaseFn({
      cwd,
      storyId,
      storyBranch,
      baseBranch,
      prNumber,
      prUrl: `${storyBranch} PR #${prNumber}`,
      // The close already armed it; this CLI is resuming that wait, not
      // deciding whether to arm.
      autoMergeEnabled: true,
      provider,
      config,
      progress,
      injectedGh: gh,
      injectedNotify,
      readPrMergeStateFn: injectedReadPrMergeState,
    });
    const terminal = terminalFromWaitOutcome({
      waitOutcome,
      storyId,
      storyBranch,
      baseBranch,
      prNumber,
      prUrl: null,
      autoMergeEnabled: true,
      // This CLI runs no close gates, so it reports none — `gates` is
      // "each gate this invocation was responsible for".
      gates: undefined,
      elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
    });
    return await logConfirmResult(
      {
        storyId,
        standalone: true,
        action: waitOutcome.terminal,
        resumed: true,
        tail: waitOutcome.tail ?? null,
      },
      terminal,
      config,
    );
  }

  const confirmation = await confirmStoryMerged({
    provider,
    storyId,
    prNumber,
    prUrl: `${storyBranch} PR #${prNumber}`,
    cwd,
    config,
    progress,
    injectedGh: gh,
    injectedNotify,
    readPrMergeStateFn: injectedReadPrMergeState,
  });

  // Story #4543 — reach the SAME shared land tail the in-close path reaches
  // (`phases/post-land.js`), rather than this CLI's own follow-ups-only
  // wrapper. That wrapper was the whole reason the two landing surfaces
  // diverged: it captured follow-ups and nothing else, while the resync and
  // cleanup steps lived in prose the caller had to remember to run.
  //
  // Gated on `merged`, NOT on `action === 'done'`. `done` means "this run
  // flipped the label"; a Story already at `agent::done` returns
  // `action: 'noop', merged: true`, and gating on `done` skipped the tail for
  // exactly that case — the belated-manual-confirm backfill this tail exists
  // to make possible (see `story-follow-ups.js`, which documents the gap).
  // Re-running is safe: every step is idempotent (the follow-ups comment is
  // an upsert, ref cleanup and base fast-forward no-op when already done).
  const tail =
    confirmation.merged === true
      ? await runPostLandTail({
          storyId,
          storyBranch,
          baseBranch,
          cwd,
          provider,
          config,
          progress,
        })
      : null;

  const terminal = buildConfirmTerminal({
    storyId,
    storyBranch,
    baseBranch,
    prNumber,
    confirmation,
    tail,
    elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
  });
  if (confirmation.action === 'done') {
    progress('DONE', `✅ Story #${storyId} → agent::done (merged).`);
  }
  return await logConfirmResult(
    { ...confirmation, standalone: true, tail },
    terminal,
    config,
  );
}

/**
 * CLI entry — mirrors `single-story-close.js`: the exit code comes from the
 * terminal envelope's status, so a caller can tell `pending` (the PR has not
 * merged yet; re-run me) from `landed` without parsing stdout.
 *
 * The catch mirrors close's for the same reason: `confirmStoryMerged`'s PR
 * read is a live `gh` call that throws on a transient API error, and this CLI
 * is a *landing surface* — the one `pending` tells the operator to re-run. If
 * a flaked read exited 1 with no envelope, the surface would be silent exactly
 * where the envelope is the contract. Both landing surfaces emit one envelope
 * or none at all; "none at all" is what Story #4543 removes.
 */
async function main() {
  try {
    const outcome = await runConfirmMerge();
    return exitCodeForTerminal(outcome?.terminal ?? { status: 'failed' });
  } catch (err) {
    const storyId = Number(parseSprintArgs().storyId);
    // No story id → a usage error; there is nothing to report an envelope
    // about, so let runAsCli surface it as a plain fatal.
    if (!Number.isInteger(storyId) || storyId <= 0) throw err;
    const terminal = buildTerminalEnvelope({
      storyId,
      status: 'failed',
      phase: 'confirm-merge',
      failure: { reason: String(err?.message ?? err) },
      nextCommand: NEXT_COMMANDS.recover(storyId),
      elapsedSeconds: 0,
    });
    Logger.error(
      `[single-story-confirm-merge] Fatal error: ${formatCliError(err)}`,
    );
    emitTerminalEnvelope(terminal);
    await emitTerminalFriction({ envelope: terminal });
    return exitCodeForTerminal(terminal);
  }
}

runAsCli(import.meta.url, main, {
  source: 'single-story-confirm-merge',
  propagateExitCode: true,
});
