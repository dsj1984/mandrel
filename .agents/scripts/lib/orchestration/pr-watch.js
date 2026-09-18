// .agents/scripts/lib/orchestration/pr-watch.js
/**
 * pr-watch.js — the required-check poll loop for an open PR. Check names come
 * from `gh pr checks --required` at runtime, never config, so drift cannot
 * skip or wait forever on a check. Returns a verdict; no side effects.
 */

import { spawnSync } from 'node:child_process';

import { applyBehindUpdate } from './behind-recovery.js';
import { checkVerdict, classifyRequiredCheck } from './check-state.js';

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

/** `--required` makes the returned set authoritative for protection gating. */
function ghPrChecks({ prUrl, cwd, repo, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    [
      'pr',
      'checks',
      prUrl,
      '--required',
      '--json',
      'name,state,bucket,workflow',
      ...ghRepoFlag(repo),
    ],
    { cwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function ghPrView({ prUrl, cwd, repo, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'view', prUrl, '--json', 'mergeStateStatus', ...ghRepoFlag(repo)],
    { cwd, encoding: 'utf-8', shell: false },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
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

function ghPrUpdateBranch({ prUrl, cwd, repo, spawnFn = spawnSync }) {
  const result = spawnFn(
    'gh',
    ['pr', 'update-branch', prUrl, ...ghRepoFlag(repo)],
    {
      cwd,
      encoding: 'utf-8',
      shell: false,
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Gate for BEHIND recovery: never auto-update into a failing PR. */
function allGreen(outcomes) {
  const values = Object.values(outcomes);
  if (values.length === 0) return false;
  return values.every((v) => checkVerdict(v) === 'pass');
}

/** Entries with a string `name`; `[]` for malformed input. */
export function parseGhPrChecks(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) => e && typeof e === 'object' && typeof e.name === 'string',
    );
  } catch {
    return [];
  }
}

/** `{ checkName: outcome }`; a repeated name (matrix, retry) — last wins. */
export function reduceOutcomes(entries) {
  const out = {};
  for (const e of entries) {
    out[e.name] = classifyRequiredCheck(e);
  }
  return out;
}

/** Only `'pending'` is non-terminal (the classifier collapses running states). */
export function allTerminal(outcomes) {
  for (const v of Object.values(outcomes)) {
    if (v === 'pending') return false;
  }
  return true;
}

/** Slow CI, not red: "re-arm the watch", never "the change is broken". */
const STILL_RUNNING = 'still-running';

/** Leftover `'pending'` → `'still-running'` (the schema forbids pending). */
export function promotePendingToStillRunning(outcomes) {
  const out = {};
  for (const [k, v] of Object.entries(outcomes)) {
    out[k] = v === 'pending' ? STILL_RUNNING : v;
  }
  return out;
}

/** A genuinely red check: the hard stop that consumes no resume budget. */
export function hasFailingCheck(outcomes) {
  return Object.values(outcomes).some((v) => checkVerdict(v) === 'fail');
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A transient `gh` failure is skipped; `maxPolls` bounds a broken `gh`.
 *
 * @param {object} opts
 * @param {string} opts.prUrl
 * @param {string} opts.cwd
 * @param {string|null} [opts.repo] `owner/repo` passed to `gh` as `--repo`.
 * @param {object} opts.outcomes  Initial `{ checkName: outcome }` map.
 * @param {number} opts.polls     Current poll counter.
 * @param {number} opts.maxPolls  Hard cap on total poll iterations.
 * @param {Function} opts.ghPrChecksFn
 * @param {number} opts.pollIntervalMs
 * @param {Function} opts.sleepFn
 * @param {{ warn?: Function }} opts.logger
 * @returns {Promise<{ outcomes: object, polls: number }>}
 */
export async function pollUntilTerminal({
  prUrl,
  cwd,
  repo = null,
  outcomes,
  polls,
  maxPolls,
  ghPrChecksFn,
  pollIntervalMs,
  sleepFn,
  logger,
}) {
  let currentOutcomes = outcomes;
  let currentPolls = polls;
  while (!allTerminal(currentOutcomes) && currentPolls < maxPolls) {
    await sleepFn(pollIntervalMs);
    currentPolls += 1;
    const probe = ghPrChecksFn({ prUrl, cwd, repo });
    const entries = parseGhPrChecks(probe.stdout);
    if (entries.length === 0 && probe.status !== 0 && probe.status !== 8) {
      logger.warn?.(
        `[Watcher] gh pr checks transient failure (status=${probe.status}): ${probe.stderr}`,
      );
      continue;
    }
    currentOutcomes = reduceOutcomes(entries);
  }
  return { outcomes: currentOutcomes, polls: currentPolls };
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
  logger,
  firstProbe,
}) {
  const first = firstProbe ?? ghPrChecksFn({ prUrl, cwd, repo });
  // `gh` exits 8 while checks are pending — expected, not a failure.
  const firstEntries = parseGhPrChecks(first.stdout);
  if (firstEntries.length === 0) {
    // Never poll an empty name set: `allTerminal({})` is vacuously true and
    // would report a red verdict with no failing check. Names resolve once
    // per call, so the caller's attach window re-resolves by calling again.
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
      // `gh` overloads non-zero for "none attached yet" and a real fault, and
      // stderr is not a contract, so classification is left to the caller.
      error: `gh-checks-${ghFaulted ? 'failed' : 'empty'}:status=${first.status}`,
    };
  }

  const requiredChecks = firstEntries.map((e) => e.name);

  let outcomes = reduceOutcomes(firstEntries);
  let polls = 0;
  let updatesApplied = 0;
  let resumesApplied = 0;
  // Each outer iteration is one poll-to-cap + BEHIND-recovery arm.
  for (;;) {
    while (polls < maxPolls) {
      ({ outcomes, polls } = await pollUntilTerminal({
        prUrl,
        cwd,
        repo,
        outcomes,
        polls,
        maxPolls,
        ghPrChecksFn,
        pollIntervalMs,
        sleepFn,
        logger,
      }));
      // BEHIND recovery only when all green; `maxUpdates` stops a racing
      // base from ping-ponging forever.
      if (!allTerminal(outcomes) || !allGreen(outcomes)) break;
      // Checked before the `gh pr view` spawn to save the round-trip.
      if (updatesApplied >= maxUpdates) break;
      const view = ghPrViewFn({ prUrl, cwd, repo });
      if (view.status !== 0) {
        logger.warn?.(
          `[Watcher] gh pr view failed (status=${view.status}): ${view.stderr}`,
        );
        break;
      }
      const recovery = await applyBehindUpdate({
        mergeStateStatus: parseMergeStateStatus(view.stdout),
        updatesUsed: updatesApplied,
        maxUpdates,
        updateBranch: async () => {
          const update = ghPrUpdateBranchFn({ prUrl, cwd, repo });
          return update.status === 0
            ? { ok: true }
            : {
                ok: false,
                detail: `status=${update.status}: ${update.stderr}`,
              };
        },
        onUpdateFailed: (detail) =>
          logger.warn?.(`[Watcher] gh pr update-branch failed (${detail})`),
      });
      // A failed update must not re-poll as though the head moved.
      if (!recovery.updated) break;
      updatesApplied += 1;
      logger.info?.(
        `[Watcher] PR BEHIND base — issued gh pr update-branch (#${updatesApplied}/${maxUpdates}); re-polling required checks.`,
      );
      await sleepFn(pollIntervalMs);
      // The new head invalidates the previous terminal outcomes.
      outcomes = {};
      for (const name of requiredChecks) outcomes[name] = 'pending';
    }

    // Re-arm only when pending-but-not-failed with resume budget left.
    if (allTerminal(outcomes) || hasFailingCheck(outcomes)) break;
    if (resumesApplied >= maxResumes) break;
    resumesApplied += 1;
    polls = 0;
    logger.info?.(
      `[Watcher] poll cap reached with checks still pending; re-arming watch (resume #${resumesApplied}/${maxResumes}).`,
    );
  }

  const terminal = allTerminal(outcomes);
  const failing = hasFailingCheck(outcomes);
  // Never `'timed_out'` — the auto-merge predicate would read it as failure.
  const stillRunning = !terminal && !failing;
  const finalOutcomes = terminal
    ? outcomes
    : promotePendingToStillRunning(outcomes);
  return {
    outcomes: finalOutcomes,
    requiredChecks,
    polls,
    updatesApplied,
    resumesApplied,
    terminal,
    green: terminal && allGreen(finalOutcomes),
    stillRunning,
  };
}
