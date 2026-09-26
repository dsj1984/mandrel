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

import path from 'node:path';
import { parseStandardCliArgs } from './lib/cli/standard-args.js';
import { parseSprintArgs, parseSprintArgsTolerant } from './lib/cli-args.js';
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
import { assertNoRetiredFlags } from './lib/orchestration/single-story-close/phases/options.js';
import { runPostLandTail } from './lib/orchestration/single-story-close/phases/post-land.js';
import {
  buildTerminalEnvelope,
  emitTerminalEnvelope,
  exitCodeForTerminal,
  NEXT_COMMANDS,
  terminalFromWaitOutcome,
} from './lib/orchestration/story-deliver-terminal.js';
import { PROJECT_ROOT } from './lib/project-root.js';
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

/** This CLI's flags beyond the standard `--story`, for `parseStandardCliArgs`. */
const CONFIRM_MERGE_FLAGS = Object.freeze({
  pr: { type: 'string' },
  // `--wait` resumes the bounded merge wait (`resumeLand`); without it the
  // CLI probes once, a fast flip for a merge that already happened.
  wait: { type: 'boolean' },
  'max-wait-seconds': { type: 'string' },
  cwd: { type: 'string' },
});

/**
 * @param {unknown} value
 * @returns {number|undefined} a positive integer, else `undefined`.
 */
function positiveIntOrUndefined(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The one argv read, called only by `main()`; the library entry point takes
 * the values it returns. The close's shared vocabulary is validated first so
 * a malformed close flag (`--merge-watch-mode bogus`) fails `init` with the
 * close's own message (Story #4959), exactly as the close CLI does.
 *
 * @param {string[]} fullArgv `process.argv`.
 * @returns {{ storyId: number|null, cwd: string|null, pr: string|null,
 *   wait: boolean, maxWaitSeconds: number|undefined }}
 */
function parseConfirmMergeArgv(fullArgv) {
  const argv = fullArgv.slice(2);
  assertNoRetiredFlags(argv);
  parseSprintArgs(fullArgv);
  const { values } = parseStandardCliArgs({
    argv,
    extras: CONFIRM_MERGE_FLAGS,
  });
  return {
    storyId: values.storyId,
    cwd: values.cwd,
    pr: values.pr,
    wait: values.wait,
    maxWaitSeconds: positiveIntOrUndefined(values.maxWaitSeconds),
  };
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
 * @param {{ merged?: boolean, reason?: string }} confirmation
 * @returns {'MERGED'|'CLOSED'|'OPEN'}
 */
function confirmPrState(confirmation) {
  if (confirmation.merged) return 'MERGED';
  return confirmation.reason === 'pr-not-merged' ? 'CLOSED' : 'OPEN';
}

/**
 * @param {number|null} prNumber
 * @param {object} confirmation
 * @returns {{ number: number, state: string }|null}
 */
function confirmPr(prNumber, confirmation) {
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  return { number: prNumber, state: confirmPrState(confirmation) };
}

/**
 * A `blocked` envelope's fields at the confirm-merge phase.
 *
 * @param {string} blockClass
 * @param {string} reason
 * @param {string} nextCommand
 */
function confirmBlocked(blockClass, reason, nextCommand) {
  return {
    status: 'blocked',
    phase: 'confirm-merge',
    blocked: { blockClass, reason, frictionCommentId: null },
    nextCommand,
  };
}

/**
 * The status-bearing envelope fields for a confirmation: done/noop → landed;
 * flip-failed → blocked (re-run this command); pr-not-merged → blocked (needs
 * a human); otherwise pending.
 *
 * @param {{ storyId: number, confirmation: object, tail: object|null }} args
 * @returns {object}
 */
function confirmOutcomeFields({ storyId, confirmation, tail }) {
  if (confirmation.action === 'done' || confirmation.action === 'noop') {
    return {
      status: 'landed',
      phase: tail ? 'post-land' : 'done',
      tail,
      nextCommand: null,
    };
  }
  if (confirmation.action === 'flip-failed') {
    return confirmBlocked(
      MERGED_FLIP_FAILED_BLOCK_CLASS,
      'merge confirmed but the agent::closing → agent::done label write failed',
      NEXT_COMMANDS.confirmMerge(storyId),
    );
  }
  if (confirmation.reason === 'pr-not-merged') {
    return confirmBlocked(
      'api-race-other',
      'the PR was closed without merging (state=CLOSED)',
      NEXT_COMMANDS.recover(storyId),
    );
  }
  return {
    status: 'pending',
    phase: 'confirm-merge',
    nextCommand:
      confirmation.reason === 'no-pr'
        ? NEXT_COMMANDS.recover(storyId)
        : NEXT_COMMANDS.confirmMerge(storyId),
  };
}

/** Map a confirmation onto the shared terminal envelope. */
function buildConfirmTerminal({
  storyId,
  storyBranch,
  baseBranch,
  prNumber,
  confirmation,
  tail,
  elapsedSeconds,
}) {
  return buildTerminalEnvelope({
    storyId,
    storyBranch,
    baseBranch,
    pr: confirmPr(prNumber, confirmation),
    elapsedSeconds,
    ...confirmOutcomeFields({ storyId, confirmation, tail }),
  });
}

async function resolveConfirmPrNumber({ pr, storyBranch, gh }) {
  let prNumber = Number.parseInt(String(pr ?? ''), 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    prNumber = await resolvePrNumber({ storyBranch, gh });
  }
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
}

/** @param {{ startedAtMs: number }} ctx */
function elapsedSeconds(ctx) {
  return Math.round((Date.now() - ctx.startedAtMs) / 1000);
}

/** No PR for the branch: the Story stays at `agent::closing`. */
async function confirmWithoutPr(ctx) {
  progress(
    'CONFIRM',
    `⚠️ No PR found for ${ctx.storyBranch}; cannot confirm merge. Story stays at agent::closing.`,
  );
  const noPr = {
    storyId: ctx.storyId,
    standalone: true,
    action: 'pending',
    reason: 'no-pr',
    merged: false,
  };
  return await logConfirmResult(
    noPr,
    buildConfirmTerminal({
      storyId: ctx.storyId,
      storyBranch: ctx.storyBranch,
      baseBranch: ctx.baseBranch,
      prNumber: null,
      confirmation: noPr,
      tail: null,
      elapsedSeconds: elapsedSeconds(ctx),
    }),
    ctx.config,
  );
}

/**
 * `--wait` runs the SAME phase as close so the cumulative budget give-up
 * (the only path to `merge.unlanded` / `agent::blocked`) is reachable from a
 * resume. The budget is anchored at the PR's `createdAt`, so resuming does
 * not restart the clock.
 */
async function resumeMergeWait(ctx) {
  const { storyId, storyBranch, baseBranch, prNumber } = ctx;
  const waitOutcome = await ctx.runConfirmMergePhaseFn({
    cwd: ctx.cwd,
    storyId,
    storyBranch,
    baseBranch,
    prNumber,
    prUrl: `${storyBranch} PR #${prNumber}`,
    // The close already armed it.
    autoMergeEnabled: true,
    maxWaitSeconds: ctx.maxWaitSeconds,
    provider: ctx.provider,
    config: ctx.config,
    progress,
    injectedGh: ctx.gh,
    injectedNotify: ctx.injectedNotify,
    readPrMergeStateFn: ctx.injectedReadPrMergeState,
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
    elapsedSeconds: elapsedSeconds(ctx),
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
    ctx.config,
  );
}

/** Probe once and flip; the fast path for a merge that already happened. */
async function probeMergeOnce(ctx) {
  const { storyId, storyBranch, baseBranch, prNumber, cwd, provider, config } =
    ctx;
  const confirmation = await confirmStoryMerged({
    provider,
    storyId,
    prNumber,
    prUrl: `${storyBranch} PR #${prNumber}`,
    cwd,
    config,
    progress,
    injectedGh: ctx.gh,
    injectedNotify: ctx.injectedNotify,
    readPrMergeStateFn: ctx.injectedReadPrMergeState,
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
    elapsedSeconds: elapsedSeconds(ctx),
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
 * Library entry point. Reads no argv: `main()` parses it once and passes the
 * values in.
 *
 * @param {{ storyId?: number|null, cwd?: string|null, pr?: string|number|null,
 *   wait?: boolean, maxWaitSeconds?: number, injectedProvider?: object,
 *   injectedConfig?: object, injectedGh?: object, injectedNotify?: Function,
 *   injectedReadPrMergeState?: Function, runConfirmMergePhaseFn?: Function }} [args]
 */
export async function runConfirmMerge({
  storyId,
  cwd,
  pr,
  wait = false,
  maxWaitSeconds,
  injectedProvider,
  injectedConfig,
  injectedGh,
  injectedNotify,
  injectedReadPrMergeState,
  runConfirmMergePhaseFn = defaultRunConfirmMergePhase,
} = {}) {
  if (!storyId) {
    throw new Error(USAGE);
  }
  const startedAtMs = Date.now();
  const resolvedCwd = path.resolve(cwd ?? PROJECT_ROOT);
  const config = injectedConfig || resolveConfig({ cwd: resolvedCwd });
  const storyBranch = getStoryBranch(storyId);
  const ctx = {
    storyId,
    cwd: resolvedCwd,
    startedAtMs,
    config,
    provider: injectedProvider || createProvider(config),
    gh: injectedGh ?? defaultGh,
    storyBranch,
    baseBranch: config.project?.baseBranch ?? 'main',
    maxWaitSeconds,
    injectedNotify,
    injectedReadPrMergeState,
    runConfirmMergePhaseFn,
  };

  progress('INIT', `Confirming merge for standalone Story #${storyId}...`);

  const prNumber = await resolveConfirmPrNumber({
    pr,
    storyBranch,
    gh: ctx.gh,
  });
  if (prNumber == null) return await confirmWithoutPr(ctx);
  const withPr = { ...ctx, prNumber };
  return wait ? await resumeMergeWait(withPr) : await probeMergeOnce(withPr);
}

/**
 * A throw (e.g. a transient `gh` error) still emits a `failed` envelope: the
 * envelope is the landing surface's contract.
 *
 * @param {unknown} err
 * @param {'init'|'confirm-merge'} phase
 * @param {string[]} fullArgv `process.argv`, for the story id only.
 * @returns {Promise<number>}
 */
async function failWithEnvelope(err, phase, fullArgv) {
  // Tolerant parse: a strict one would re-throw an argv rejection here.
  const { args, error: argvError } = parseSprintArgsTolerant(fullArgv);
  const storyId = Number(args.storyId);
  // No story id: nothing to report an envelope about.
  if (!Number.isInteger(storyId) || storyId <= 0) throw err;
  const terminal = buildTerminalEnvelope({
    storyId,
    status: 'failed',
    // An argv rejection precedes every phase.
    phase: argvError ? 'init' : phase,
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

/**
 * The only argv reader. Exit code comes from the terminal envelope's status;
 * `--help` is answered by `runAsCli` before this runs.
 */
async function main() {
  let options;
  try {
    options = parseConfirmMergeArgv(process.argv);
  } catch (err) {
    return await failWithEnvelope(err, 'init', process.argv);
  }
  try {
    const outcome = await runConfirmMerge(options);
    return exitCodeForTerminal(outcome?.terminal ?? { status: 'failed' });
  } catch (err) {
    return await failWithEnvelope(err, 'confirm-merge', process.argv);
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
