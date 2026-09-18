#!/usr/bin/env node

/**
 * single-story-confirm-merge.js — the post-merge half of close: auto-merge
 * lands asynchronously after close exits, so this confirms the PR merged and
 * flips `agent::closing → agent::done`. An unmerged PR leaves the Story at
 * `agent::closing` (re-run later). Idempotent.
 *
 * Usage:
 *   node single-story-confirm-merge.js --story <STORY_ID> [--pr <n>] [--wait]
 *                                      [--max-wait-seconds <n>]
 *                                      [--cwd <main-repo>]
 *
 * Exit codes: 0 ok (merged, pending, or noop), 1 error.
 *
 * @see .agents/workflows/helpers/deliver-story.md
 */

import { parseArgs } from 'node:util';
import { parseSprintArgsTolerant } from './lib/cli-args.js';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { formatCliError } from './lib/error-redactor.js';
import { createGh } from './lib/gh-exec.js';
import { getStoryBranch } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { emitTerminalFriction } from './lib/observability/runtime-friction.js';
import { emitTerseResult } from './lib/observability/terse-result.js';
import { MERGED_FLIP_FAILED_BLOCK_CLASS } from './lib/orchestration/lifecycle/emit-merge-flip-failed.js';
import { MERGE_WAIT_GH_TIMEOUT_MS } from './lib/orchestration/merge-poll.js';
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
 * Pass as `tool` on every friction emit: `emitTerminalFriction` defaults to
 * the close CLI's name and would misattribute the record.
 */
const CLI_SOURCE = 'single-story-confirm-merge';

/**
 * Time-boxed: this is a background resume surface with no host tool ceiling,
 * so a hung `gh` call would strand the resume.
 */
const defaultGh = createGh(undefined, { timeoutMs: MERGE_WAIT_GH_TIMEOUT_MS });

const USAGE =
  'Usage: node single-story-confirm-merge.js --story <STORY_ID> [--pr <n>] [--wait] ' +
  '[--max-wait-seconds <n>] [--cwd <main-repo>]\n\n' +
  '  --wait              resume the bounded merge wait instead of probing once\n' +
  '  --max-wait-seconds  per-invocation wait bound override, threaded to\n' +
  '                      resolveMergeWaitConfig exactly as the close does (wins\n' +
  '                      over delivery.mergeWatch.maxWaitSeconds and the async\n' +
  '                      probe-window cap; only meaningful with --wait)';

/**
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
 * `--wait` resumes the bounded merge wait (`resumeLand`); without it the CLI
 * probes once, a fast flip for a merge that already happened.
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
 * Per-run wait bound for `--wait`; `undefined` unless a positive integer.
 *
 * @returns {number|undefined}
 */
function readMaxWaitSecondsFlag() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { 'max-wait-seconds': { type: 'string' } },
      strict: false,
    });
    const parsed = Number.parseInt(String(values['max-wait-seconds']), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `--state all` because a merged PR is no longer open.
 *
 * @param {{ storyBranch: string, gh: object }} args
 * @returns {Promise<number|null>}
 */
export async function resolvePrNumber({ storyBranch, gh }) {
  try {
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
 * The friction emit is awaited because `runAsCli` exits via `process.exit`
 * as soon as `main` resolves.
 */
async function logConfirmResult(result, terminal, config) {
  emitTerseResult({
    label: 'CONFIRM MERGE RESULT',
    result,
    scope: result?.storyId,
    summary: {
      storyId: result?.storyId,
      action: result?.action,
      reason: result?.reason,
      status: terminal?.status,
    },
  });
  emitTerminalEnvelope(terminal, { config });
  await emitTerminalFriction({ envelope: terminal, tool: CLI_SOURCE, config });
  return { success: terminal.status !== 'failed', result, terminal };
}

/**
 * Map a confirmation onto the shared terminal envelope: done/noop → landed;
 * flip-failed → blocked (re-run this command); pr-not-merged → blocked (needs
 * a human); otherwise pending.
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

async function resolveConfirmPrNumber({ prParam, storyBranch, gh }) {
  const rawPr = prParam ?? readPrFlag();
  let prNumber = Number.parseInt(String(rawPr ?? ''), 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    prNumber = await resolvePrNumber({ storyBranch, gh });
  }
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}

export async function runConfirmMerge({
  storyId: storyIdParam,
  cwd: cwdParam,
  pr: prParam,
  wait: waitParam,
  maxWaitSeconds: maxWaitSecondsParam,
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
    throw new Error(USAGE);
  }
  const wait = waitParam ?? readWaitFlag();
  const maxWaitSeconds = maxWaitSecondsParam ?? readMaxWaitSecondsFlag();

  const startedAtMs = Date.now();
  const config = injectedConfig || resolveConfig({ cwd });
  const provider = injectedProvider || createProvider(config);
  const gh = injectedGh ?? defaultGh;
  const storyBranch = getStoryBranch(storyId);
  const baseBranch = config.project?.baseBranch ?? 'main';

  progress('INIT', `Confirming merge for standalone Story #${storyId}...`);

  const prNumber = await resolveConfirmPrNumber({
    prParam,
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

  // `--wait` runs the SAME phase as close so the cumulative budget give-up
  // (the only path to `merge.unlanded` / `agent::blocked`) is reachable from a
  // resume. The budget is anchored at the PR's `createdAt`, so resuming does
  // not restart the clock.
  if (wait) {
    const waitOutcome = await runConfirmMergePhaseFn({
      cwd,
      storyId,
      storyBranch,
      baseBranch,
      prNumber,
      prUrl: `${storyBranch} PR #${prNumber}`,
      // The close already armed it.
      autoMergeEnabled: true,
      maxWaitSeconds,
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
      // This CLI runs no close gates.
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

  // The same shared land tail close runs. Gated on `merged`, not
  // `action === 'done'`: an already-done Story (`noop`, merged) still needs
  // the belated backfill. Every tail step is idempotent.
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
 * Exit code comes from the terminal envelope's status. A throw (e.g. a
 * transient `gh` error) still emits a `failed` envelope: the envelope is the
 * landing surface's contract.
 */
async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const outcome = await runConfirmMerge();
    return exitCodeForTerminal(outcome?.terminal ?? { status: 'failed' });
  } catch (err) {
    // Tolerant parse: a strict one would re-throw an argv rejection here.
    const { args, error: argvError } = parseSprintArgsTolerant();
    const storyId = Number(args.storyId);
    // No story id: nothing to report an envelope about.
    if (!Number.isInteger(storyId) || storyId <= 0) throw err;
    const terminal = buildTerminalEnvelope({
      storyId,
      status: 'failed',
      // An argv rejection precedes every phase.
      phase: argvError ? 'init' : 'confirm-merge',
      failure: { reason: String(err?.message ?? err) },
      nextCommand: NEXT_COMMANDS.recover(storyId),
      elapsedSeconds: 0,
    });
    Logger.error(
      `[single-story-confirm-merge] Fatal error: ${formatCliError(err)}`,
    );
    emitTerminalEnvelope(terminal);
    await emitTerminalFriction({ envelope: terminal, tool: CLI_SOURCE });
    return exitCodeForTerminal(terminal);
  }
}

runAsCli(import.meta.url, main, {
  source: CLI_SOURCE,
  propagateExitCode: true,
  usage: {
    invocation:
      'node .agents/scripts/single-story-confirm-merge.js --story <id> [--pr <n>] [--wait] [--max-wait-seconds <n>] [--cwd <main-repo>]',
    summary:
      'Confirm a Story PR merged and flip the Story to agent::done. With --wait, resumes the bounded merge wait a close handed off.',
    flags: [
      ['--story <id>', 'GitHub issue number of the Story (required).'],
      ['--pr <n>', 'PR number (default: resolved from the Story branch).'],
      ['--wait', 'Resume the bounded merge wait instead of probing once.'],
      ['--max-wait-seconds <n>', 'Per-invocation bound for the --wait path.'],
      [
        '--cwd <main-repo>',
        'Main-repo checkout to run from (default: project root).',
      ],
    ],
  },
});
