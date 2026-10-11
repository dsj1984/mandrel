// .agents/scripts/lib/orchestration/pr-watch.js
/**
 * pr-watch.js — the required-check poll loop for an open PR. Check names come
 * from `gh pr checks --required` at runtime, never config, so drift cannot
 * skip or wait forever on a check. Returns a verdict; no side effects.
 */

import { spawnSync } from 'node:child_process';

import { applyBehindUpdate } from './behind-recovery.js';
import { createCancelledRunDiscount } from './cancelled-run-discount.js';
import { checkVerdict } from './check-state.js';
import {
  allTerminal,
  hasFailingCheck,
  parseGhPrChecks,
  pollUntilTerminal,
  promotePendingToStillRunning,
  reduceOutcomes,
} from './pr-watch-poll.js';

/**
 * `gh` has no `<owner/repo>#<number>` form (it parses one as a branch), so
 * every port builds `--repo` here.
 *
 * @param {string|null|undefined} repo `owner/repo`, or nullish to infer.
 * @returns {string[]}
 */
function ghRepoFlag(repo) {
  const trimmed = String(repo ?? '').trim();
  return trimmed.length > 0 ? ['--repo', trimmed] : [];
}

function runGh(args, { cwd, repo, spawnFn = spawnSync }) {
  const result = spawnFn('gh', [...args, ...ghRepoFlag(repo)], {
    cwd,
    encoding: 'utf-8',
    shell: false,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** `--required` makes the returned set authoritative for protection gating. */
function ghPrChecks({ prUrl, ...port }) {
  return runGh(
    [
      'pr',
      'checks',
      prUrl,
      '--required',
      '--json',
      'name,state,bucket,workflow,link',
    ],
    port,
  );
}

function ghPrView({ prUrl, ...port }) {
  return runGh(['pr', 'view', prUrl, '--json', 'mergeStateStatus'], port);
}

/** Malformed input → `''`, which callers treat as "not BEHIND". */
function parseMergeStateStatus(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) return '';
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed?.mergeStateStatus === 'string'
      ? parsed.mergeStateStatus
      : '';
  } catch {
    return '';
  }
}

function ghPrUpdateBranch({ prUrl, ...port }) {
  return runGh(['pr', 'update-branch', prUrl], port);
}

/** Gate for BEHIND recovery: never auto-update into a failing PR. */
function allGreen(outcomes) {
  const values = Object.values(outcomes);
  if (values.length === 0) return false;
  return values.every((v) => checkVerdict(v) === 'pass');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Never poll an empty name set: `allTerminal({})` is vacuously true and would
 * report a red verdict with no failing check. `gh` overloads non-zero for
 * "none attached yet" and a real fault, so classification is the caller's.
 */
function emptyRequiredChecksResult(first, logger) {
  // `gh` exits 8 while checks are pending — expected, not a failure.
  const ghFaulted = first.status !== 0 && first.status !== 8;
  if (ghFaulted) {
    logger.warn?.(
      `[Watcher] gh pr checks failed (status=${first.status}): ${first.stderr}`,
    );
  }
  return {
    outcomes: {},
    requiredChecks: [],
    polls: 0,
    updatesApplied: 0,
    resumesApplied: 0,
    terminal: false,
    green: false,
    stillRunning: false,
    requiredChecksEmpty: true,
    error: `gh-checks-${ghFaulted ? 'failed' : 'empty'}:status=${first.status}`,
  };
}

function updateBranchPort(ctx) {
  return async () => {
    const update = ctx.ghPrUpdateBranchFn(ctx.target);
    return update.status === 0
      ? { ok: true }
      : { ok: false, detail: `status=${update.status}: ${update.stderr}` };
  };
}

/** One BEHIND-recovery attempt; true only when the branch head moved. */
async function recoverBehind(ctx, updatesUsed) {
  const view = ctx.ghPrViewFn(ctx.target);
  if (view.status !== 0) {
    ctx.logger.warn?.(
      `[Watcher] gh pr view failed (status=${view.status}): ${view.stderr}`,
    );
    return false;
  }
  const recovery = await applyBehindUpdate({
    mergeStateStatus: parseMergeStateStatus(view.stdout),
    updatesUsed,
    maxUpdates: ctx.maxUpdates,
    updateBranch: updateBranchPort(ctx),
    onUpdateFailed: (detail) =>
      ctx.logger.warn?.(`[Watcher] gh pr update-branch failed (${detail})`),
  });
  return recovery.updated;
}

/** BEHIND recovery only when all green; `maxUpdates` stops a base race. */
function canRecoverBehind(ctx, state) {
  return (
    allTerminal(state.outcomes) &&
    allGreen(state.outcomes) &&
    state.updatesApplied < ctx.maxUpdates
  );
}

/** One poll-to-cap + BEHIND-recovery arm; mutates `state`. */
async function runPollArm(ctx, state) {
  while (state.polls < ctx.maxPolls) {
    const polled = await pollUntilTerminal({
      ...ctx.target,
      outcomes: state.outcomes,
      polls: state.polls,
      maxPolls: ctx.maxPolls,
      ghPrChecksFn: ctx.ghPrChecksFn,
      pollIntervalMs: ctx.pollIntervalMs,
      sleepFn: ctx.sleepFn,
      discountFn: ctx.discountFn,
      logger: ctx.logger,
    });
    state.outcomes = polled.outcomes;
    state.polls = polled.polls;
    if (!canRecoverBehind(ctx, state)) return;
    // A failed update must not re-poll as though the head moved.
    if (!(await recoverBehind(ctx, state.updatesApplied))) return;
    state.updatesApplied += 1;
    ctx.logger.info?.(
      `[Watcher] PR BEHIND base — issued gh pr update-branch (#${state.updatesApplied}/${ctx.maxUpdates}); re-polling required checks.`,
    );
    await ctx.sleepFn(ctx.pollIntervalMs);
    // The new head invalidates the previous terminal outcomes.
    state.outcomes = Object.fromEntries(
      ctx.requiredChecks.map((name) => [name, 'pending']),
    );
  }
}

/** Re-arm only when pending-but-not-failed with resume budget left. */
function shouldResume(ctx, state) {
  return (
    !allTerminal(state.outcomes) &&
    !hasFailingCheck(state.outcomes) &&
    state.resumesApplied < ctx.maxResumes
  );
}

function finalVerdict(ctx, state) {
  const terminal = allTerminal(state.outcomes);
  // Never `'timed_out'` — the auto-merge predicate would read it as failure.
  const stillRunning = !terminal && !hasFailingCheck(state.outcomes);
  const outcomes = terminal
    ? state.outcomes
    : promotePendingToStillRunning(state.outcomes);
  return {
    outcomes,
    requiredChecks: ctx.requiredChecks,
    polls: state.polls,
    updatesApplied: state.updatesApplied,
    resumesApplied: state.resumesApplied,
    terminal,
    green: terminal && allGreen(outcomes),
    stillRunning,
  };
}

/**
 * Watch required checks to terminal; when green and BEHIND, update the
 * branch (≤ `maxUpdates`) and re-poll the new head.
 *
 * @param {object} opts
 * @param {string} opts.prUrl              PR URL or number (passed to `gh` verbatim).
 * @param {string} opts.cwd
 * @param {string|null} [opts.repo]        `owner/repo`, threaded to every port
 *   as `--repo`; nullish infers from the cwd's remote.
 * @param {number} opts.maxPolls           Hard cap on total poll iterations per arm.
 * @param {number} opts.maxUpdates         Cap on `gh pr update-branch` recovery calls.
 * @param {number} [opts.maxResumes]       Re-arms after the poll cap fires with
 *   checks pending and none failed, before a `still-running` verdict.
 * @param {number} opts.pollIntervalMs     Delay between poll ticks.
 * @param {Function} [opts.ghPrChecksFn]
 * @param {Function} [opts.ghPrViewFn]
 * @param {Function} [opts.ghPrUpdateBranchFn]
 * @param {Function} [opts.sleepFn]
 * @param {Function} [opts.ghApiFn]
 * @param {{ info?: Function, warn?: Function, debug?: Function }} opts.logger
 * @param {{status:number,stdout:string,stderr:string}} [opts.firstProbe]
 *   An already-issued `gh pr checks` result, so the first call is not
 *   double-spent.
 * @returns {Promise<{
 *   outcomes: object,
 *   requiredChecks: string[],
 *   polls: number,
 *   updatesApplied: number,
 *   resumesApplied: number,
 *   terminal: boolean,
 *   green: boolean,
 *   stillRunning: boolean,
 *   requiredChecksEmpty?: boolean,
 *   error?: string,
 * }>}
 *   `outcomes` never contains `'pending'`. `requiredChecksEmpty` / `error`
 *   are set only when the first probe resolved no required-check names.
 */
export async function watchPrToTerminal({
  prUrl,
  cwd,
  repo = null,
  maxPolls,
  maxUpdates,
  maxResumes = 0,
  pollIntervalMs,
  ghPrChecksFn = ghPrChecks,
  ghPrViewFn = ghPrView,
  ghPrUpdateBranchFn = ghPrUpdateBranch,
  sleepFn = defaultSleep,
  ghApiFn,
  logger,
  firstProbe,
}) {
  const target = { prUrl, cwd, repo };
  const first = firstProbe ?? ghPrChecksFn(target);
  const firstEntries = parseGhPrChecks(first.stdout);
  if (firstEntries.length === 0) {
    return emptyRequiredChecksResult(first, logger);
  }
  const discountFn = createCancelledRunDiscount({ repo, ghApiFn, logger });
  const ctx = {
    target,
    requiredChecks: firstEntries.map((e) => e.name),
    maxPolls,
    maxUpdates,
    maxResumes,
    pollIntervalMs,
    ghPrChecksFn,
    ghPrViewFn,
    ghPrUpdateBranchFn,
    sleepFn,
    discountFn,
    logger,
  };
  const state = {
    outcomes: await discountFn(firstEntries, reduceOutcomes(firstEntries)),
    polls: 0,
    updatesApplied: 0,
    resumesApplied: 0,
  };
  for (;;) {
    await runPollArm(ctx, state);
    if (!shouldResume(ctx, state)) break;
    state.resumesApplied += 1;
    state.polls = 0;
    logger.info?.(
      `[Watcher] poll cap reached with checks still pending; re-arming watch (resume #${state.resumesApplied}/${maxResumes}).`,
    );
  }
  return finalVerdict(ctx, state);
}
