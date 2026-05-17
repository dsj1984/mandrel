#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * pr-watch-with-update.js — shared watch-and-recover helper for long-lived
 * PR loops in `/single-story-deliver` Step 4 and `/epic-deliver` Phase 7.
 *
 * Wraps the equivalent of `gh pr checks <pr> --watch` but recovers from
 * `mergeStateStatus: "BEHIND"` automatically: when every required check
 * has gone green AND the PR head is behind its base, calls
 * `gh pr update-branch <pr>` so the base merges into the head, then
 * resumes polling against the fresh CI cycle. Caps the number of
 * `update-branch` invocations per watch session to avoid ping-ponging
 * against a racing base branch.
 *
 * The helper is strictly a **watch-and-recover** surface — PR creation,
 * auto-merge arming, and the post-watch merge decision remain in
 * `single-story-close.js`, `epic-deliver-finalize.js`, and
 * `epic-deliver-automerge.js`. The helper exits 0 when the PR is merged
 * or reaches a clean+green state; it throws on terminal check failure,
 * PR closure without merging, or when the update-branch cap is exhausted.
 *
 * Usage:
 *   node .agents/scripts/pr-watch-with-update.js --pr <prNumber> \
 *     [--repo owner/repo] [--max-updates N] [--poll-interval-ms MS] \
 *     [--dry-run]
 */

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

const HELP = `Usage: node .agents/scripts/pr-watch-with-update.js \\
  --pr <prNumber> [--repo owner/repo] [--max-updates N] \\
  [--poll-interval-ms MS] [--dry-run]

Polls a PR's checks + mergeStateStatus until merged or terminally failed.
Recovers from BEHIND state by calling \`gh pr update-branch\` once every
required check is green. Caps update-branch calls at --max-updates
(default 3) per session.
`;

const DEFAULT_MAX_UPDATES = 3;
const DEFAULT_POLL_INTERVAL_MS = 10000;

/**
 * Green: counts as a passing required check.
 * Failure: terminal — caller must stop and remediate.
 * Anything else: pending / in-flight.
 */
const GREEN_RESULTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILURE_RESULTS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

const CLEAN_MERGE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);
const BEHIND_MERGE_STATE = 'BEHIND';

/**
 * Pure: parse argv. Exported for tests.
 */
export function parsePrWatchArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: 'string' },
      repo: { type: 'string' },
      'max-updates': { type: 'string' },
      'poll-interval-ms': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  const prNumber = Number.parseInt(values.pr ?? '', 10);
  const maxUpdatesRaw = Number.parseInt(values['max-updates'] ?? '', 10);
  const pollIntervalRaw = Number.parseInt(values['poll-interval-ms'] ?? '', 10);
  return {
    prNumber: Number.isNaN(prNumber) || prNumber <= 0 ? null : prNumber,
    repo: typeof values.repo === 'string' ? values.repo : null,
    maxUpdates:
      Number.isNaN(maxUpdatesRaw) || maxUpdatesRaw < 0
        ? DEFAULT_MAX_UPDATES
        : maxUpdatesRaw,
    pollIntervalMs:
      Number.isNaN(pollIntervalRaw) || pollIntervalRaw <= 0
        ? DEFAULT_POLL_INTERVAL_MS
        : pollIntervalRaw,
    dryRun: values['dry-run'] === true,
    help: values.help === true,
  };
}

/**
 * Pure: classify parsed CLI args into a runnable intent.
 *
 * Shapes:
 *   - { kind: 'help' }
 *   - { kind: 'usage-error', messages: string[] }
 *   - { kind: 'run', prNumber, repo, maxUpdates, pollIntervalMs, dryRun }
 */
export function classifyPrWatchInvocation(args) {
  if (args?.help) return { kind: 'help' };
  if (args?.prNumber === null) {
    return {
      kind: 'usage-error',
      messages: [
        '[pr-watch-with-update] ERROR: --pr <prNumber> is required.',
        HELP,
      ],
    };
  }
  return {
    kind: 'run',
    prNumber: args.prNumber,
    repo: args.repo,
    maxUpdates: args.maxUpdates,
    pollIntervalMs: args.pollIntervalMs,
    dryRun: args.dryRun,
  };
}

/**
 * Pure: normalize a single statusCheckRollup entry to a single result
 * string. gh returns two shapes:
 *   - status checks: { state: "SUCCESS"|"FAILURE"|"PENDING"|... }
 *   - check runs (GHA): { status: "QUEUED"|"IN_PROGRESS"|"COMPLETED",
 *                         conclusion: "SUCCESS"|"FAILURE"|null }
 *
 * Returns the most-meaningful single value:
 *   - check-run that has finished → its `conclusion`.
 *   - check-run that hasn't finished → its `status`.
 *   - status-check → its `state`.
 *   - anything missing → 'PENDING' (conservative; treat unknowns as
 *     still in flight rather than green or failing).
 */
export function normalizeCheckResult(entry) {
  if (!entry || typeof entry !== 'object') return 'PENDING';
  const conclusion =
    typeof entry.conclusion === 'string' ? entry.conclusion : null;
  const status = typeof entry.status === 'string' ? entry.status : null;
  const state = typeof entry.state === 'string' ? entry.state : null;
  if (status === 'COMPLETED' && conclusion) return conclusion;
  if (conclusion) return conclusion;
  if (state) return state;
  if (status) return status;
  return 'PENDING';
}

/**
 * Pure: classify a single poll's PR state into the next action.
 *
 * Shapes:
 *   - { kind: 'merged' }
 *   - { kind: 'closed' }                                     // terminal — throw
 *   - { kind: 'check-failure', failed: string[] }            // terminal — throw
 *   - { kind: 'green-clean' }                                // exit 0
 *   - { kind: 'green-behind' }                               // call update-branch
 *   - { kind: 'wait' }                                       // keep polling
 */
export function classifyPollResult(prState) {
  if (!prState || typeof prState !== 'object') return { kind: 'wait' };
  if (prState.state === 'MERGED') return { kind: 'merged' };
  if (prState.state === 'CLOSED') return { kind: 'closed' };

  const rollup = Array.isArray(prState.statusCheckRollup)
    ? prState.statusCheckRollup
    : [];
  const results = rollup.map(normalizeCheckResult);

  const failed = [];
  for (let i = 0; i < rollup.length; i += 1) {
    if (FAILURE_RESULTS.has(results[i])) {
      const name = rollup[i]?.name ?? rollup[i]?.context ?? '(unnamed)';
      failed.push(`${name}: ${results[i]}`);
    }
  }
  if (failed.length > 0) return { kind: 'check-failure', failed };

  const allGreen =
    rollup.length > 0 && results.every((r) => GREEN_RESULTS.has(r));
  if (!allGreen) return { kind: 'wait' };

  if (prState.mergeStateStatus === BEHIND_MERGE_STATE) {
    return { kind: 'green-behind' };
  }
  if (CLEAN_MERGE_STATES.has(prState.mergeStateStatus)) {
    return { kind: 'green-clean' };
  }
  return { kind: 'wait' };
}

function defaultGhView(prNumber, repo) {
  const args = ['pr', 'view', String(prNumber)];
  if (repo) args.push('--repo', repo);
  args.push('--json', 'state,mergeStateStatus,statusCheckRollup');
  const result = spawnSync('gh', args, {
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: `gh pr view exit ${result.status}: ${result.stderr ?? ''}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (err) {
    return {
      ok: false,
      error: `gh pr view JSON parse failed: ${err?.message ?? err}`,
    };
  }
}

function defaultGhUpdateBranch(prNumber, repo) {
  const args = ['pr', 'update-branch', String(prNumber)];
  if (repo) args.push('--repo', repo);
  const result = spawnSync('gh', args, {
    encoding: 'utf-8',
    shell: false,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runner. DI-friendly — every side effect routes through an injected
 * function so tests can drive the state machine deterministically.
 *
 * Returns one of:
 *   - { kind: 'merged', prNumber, updatesApplied }
 *   - { kind: 'green-clean', prNumber, updatesApplied }
 *
 * Throws on:
 *   - PR closed without merging
 *   - Any required check transitioning to FAILURE / TIMED_OUT / CANCELLED /
 *     ACTION_REQUIRED / STARTUP_FAILURE
 *   - update-branch cap exhausted
 *   - gh view error
 *   - gh update-branch error (during a non-dry-run)
 */
export async function runPrWatchWithUpdate({
  prNumber,
  repo = null,
  maxUpdates = DEFAULT_MAX_UPDATES,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  dryRun = false,
  ghViewFn = defaultGhView,
  ghUpdateBranchFn = defaultGhUpdateBranch,
  sleepFn = defaultSleep,
  logger = Logger,
  maxPolls = Number.POSITIVE_INFINITY,
}) {
  let updatesApplied = 0;
  let polls = 0;

  logger.info?.(
    `[pr-watch-with-update] Watching PR #${prNumber}${repo ? ` (${repo})` : ''} ` +
      `— pollInterval=${pollIntervalMs}ms, maxUpdates=${maxUpdates}, dryRun=${dryRun}.`,
  );

  while (polls < maxPolls) {
    polls += 1;
    const view = ghViewFn(prNumber, repo);
    if (!view.ok) {
      throw new Error(`[pr-watch-with-update] ${view.error}`);
    }

    const verdict = classifyPollResult(view.value);

    if (verdict.kind === 'merged') {
      logger.info?.(
        `[pr-watch-with-update] PR #${prNumber} is MERGED. Exiting clean.`,
      );
      return { kind: 'merged', prNumber, updatesApplied };
    }
    if (verdict.kind === 'closed') {
      throw new Error(
        `[pr-watch-with-update] PR #${prNumber} was closed without merging.`,
      );
    }
    if (verdict.kind === 'check-failure') {
      throw new Error(
        `[pr-watch-with-update] PR #${prNumber} has failed required check(s): ` +
          verdict.failed.join(', '),
      );
    }
    if (verdict.kind === 'green-clean') {
      logger.info?.(
        `[pr-watch-with-update] PR #${prNumber} green + mergeable. Exiting clean.`,
      );
      return { kind: 'green-clean', prNumber, updatesApplied };
    }
    if (verdict.kind === 'green-behind') {
      if (updatesApplied >= maxUpdates) {
        throw new Error(
          `[pr-watch-with-update] PR #${prNumber} still BEHIND after ` +
            `${maxUpdates} update-branch call(s). The base branch is racing — ` +
            'merge manually via the GitHub UI or re-run with --max-updates ' +
            'set higher once the base has settled.',
        );
      }
      logger.info?.(
        `[pr-watch-with-update] PR #${prNumber} green + BEHIND — ` +
          `calling \`gh pr update-branch\` (#${updatesApplied + 1}/${maxUpdates})...`,
      );
      if (dryRun) {
        logger.info?.(
          '[pr-watch-with-update] --dry-run set; skipping update-branch call.',
        );
        return { kind: 'green-clean', prNumber, updatesApplied };
      }
      const updateResult = ghUpdateBranchFn(prNumber, repo);
      if (!updateResult.ok) {
        throw new Error(
          `[pr-watch-with-update] gh pr update-branch exit ${updateResult.status}: ${updateResult.stderr}`,
        );
      }
      updatesApplied += 1;
      await sleepFn(pollIntervalMs);
      continue;
    }
    // verdict.kind === 'wait'
    await sleepFn(pollIntervalMs);
  }

  throw new Error(
    `[pr-watch-with-update] PR #${prNumber} did not reach a terminal state ` +
      `within ${maxPolls} poll(s).`,
  );
}

async function main() {
  const intent = classifyPrWatchInvocation(
    parsePrWatchArgs(process.argv.slice(2)),
  );
  if (intent.kind === 'help') {
    Logger.info(HELP);
    return;
  }
  if (intent.kind === 'usage-error') {
    for (const m of intent.messages) Logger.error(m);
    process.exit(2);
  }
  const out = await runPrWatchWithUpdate({
    prNumber: intent.prNumber,
    repo: intent.repo,
    maxUpdates: intent.maxUpdates,
    pollIntervalMs: intent.pollIntervalMs,
    dryRun: intent.dryRun,
  });
  Logger.info(JSON.stringify(out, null, 2));
}

runAsCli(import.meta.url, main, { source: 'pr-watch-with-update' });
