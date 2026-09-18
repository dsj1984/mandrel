#!/usr/bin/env node
/**
 * pr-watch-with-update.js — the single CI-watch CLI for Story delivery.
 * Polls the PR's required checks to a terminal state via `watchPrToTerminal`,
 * recovering from `BEHIND` with bounded `gh pr update-branch` calls.
 *
 * No-rerun enforcement (`rules/ci-remediation.md` § Verifier) acts on the
 * FIRST red, because native auto-merge fires server-side and races any
 * post-green detection: red disarms auto-merge and records the head SHA in a
 * digest; a later green on the SAME SHA is a forbidden re-run, on a NEW SHA a
 * fix at source (digest retired, auto-merge re-armed).
 *
 * Usage:
 *   node .agents/scripts/pr-watch-with-update.js --pr <n> --story <id>
 *     [--repo owner/repo] [--max-updates N] [--poll-interval-ms MS]
 *     [--max-polls N] [--max-resumes N] [--attach-window-ms MS]
 */
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { gh as defaultGh } from './lib/gh-exec.js';
import { Logger } from './lib/Logger.js';
import {
  blockStoryDelivery,
  classifyFailure,
  classifyGreenVerdict,
  formatRerunViolation,
  readCiDigest,
  resolveDigestScope,
  resolvePrHeadSha,
  retireCiDigest,
  writeCiDigest,
} from './lib/orchestration/ci-rerun-guard.js';
import { watchPrToTerminal } from './lib/orchestration/pr-watch.js';
import {
  disarmAutoMerge,
  enableAutoMergeWith,
} from './lib/orchestration/single-story-close/phases/auto-merge.js';
import { sleep as defaultSleep } from './lib/util/poll-loop.js';

/** Exit code reserved for the slow-but-not-red `still-running` verdict. */
export const STILL_RUNNING_EXIT_CODE = 2;

/**
 * How long an EMPTY required-context probe keeps being retried. Rulesets
 * attach contexts asynchronously and an aggregator context gated on every
 * other tier arrives last (~17 min measured), so the default covers that with
 * margin: waiting costs wall-clock, giving up early costs the delivery.
 */
export const REQUIRED_CONTEXT_ATTACH_WINDOW_MS = 1_200_000;

/** Framework fallbacks when no CLI flag supplies a value. */
export const WATCH_DEFAULTS = Object.freeze({
  pollIntervalMs: 10_000,
  maxPolls: 180,
  maxUpdates: 3,
  maxResumes: 3,
  attachWindowMs: REQUIRED_CONTEXT_ATTACH_WINDOW_MS,
});

/**
 * Merge states that confirm an observed all-green required set. `BLOCKED`
 * means branch protection enforces a context the watch never observed (it
 * attached after the first probe); `UNKNOWN`/unreadable is absent evidence.
 */
const RECONCILED_MERGE_STATES = Object.freeze(
  new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BEHIND', 'DRAFT']),
);

/**
 * @param {{ observedRequired?: string[], mergeStateStatus?: string|null }} args
 * @returns {{ reconciled: boolean, mergeStateStatus: string|null, reason: string }}
 */
export function reconcileGreenVerdict({
  observedRequired = [],
  mergeStateStatus,
} = {}) {
  const state = String(mergeStateStatus ?? '')
    .trim()
    .toUpperCase();
  const observed = observedRequired.length;
  if (!state) {
    return {
      reconciled: false,
      mergeStateStatus: null,
      reason:
        `observed ${observed} required check(s) green, but the repository's merge state ` +
        'could not be read — the observed set cannot be reconciled, so the green verdict is withheld',
    };
  }
  if (RECONCILED_MERGE_STATES.has(state)) {
    return {
      reconciled: true,
      mergeStateStatus: state,
      reason: `observed ${observed} required check(s) green and the repository reports mergeStateStatus=${state}`,
    };
  }
  return {
    reconciled: false,
    mergeStateStatus: state,
    reason:
      `observed ${observed} required check(s) green, but the repository reports ` +
      `mergeStateStatus=${state} — branch protection is enforcing a context this watch did not observe`,
  };
}

/** Default merge-state probe: one `gh pr view --json mergeStateStatus`. */
async function defaultMergeStateProbe({ prRef }) {
  try {
    const view = await defaultGh.pr.view(prRef, ['mergeStateStatus']);
    return typeof view?.mergeStateStatus === 'string'
      ? view.mergeStateStatus
      : null;
  } catch {
    return null;
  }
}

/** Reuse an injected `ghPrViewFn` port as the merge-state probe. */
function mergeStateProbeFromView(ghPrViewFn) {
  return async ({ prUrl, repo, cwd }) => {
    try {
      const view = await ghPrViewFn({ prUrl, repo, cwd });
      if (view?.status !== 0) return null;
      const parsed = JSON.parse(String(view.stdout ?? '').trim());
      return typeof parsed?.mergeStateStatus === 'string'
        ? parsed.mergeStateStatus
        : null;
    } catch {
      return null;
    }
  };
}

/**
 * Run the watch, re-running the whole call while the required set is EMPTY
 * (names resolve once per call, so a late context needs a fresh call) until
 * the attach window is spent. `probePrResolvable` separates CI-not-started
 * (PR reads back) from a `gh` fault (it does not) structurally — never from
 * stderr prose.
 *
 * @returns {Promise<object>} the watch result plus `attachRetries`, and
 *   `prResolvable` whenever the required set stayed empty.
 */
async function watchWithAttachWindow({
  watchArgs,
  attachWindowMs,
  retryIntervalMs,
  sleepFn,
  nowMsFn,
  probePrResolvable,
  logger,
}) {
  const deadline = nowMsFn() + attachWindowMs;
  // Cap retries too (cadence floored at 5s) so a zero poll interval cannot
  // spin the wall-clock window as a tight loop.
  const maxRetries = Math.ceil(
    attachWindowMs / Math.max(retryIntervalMs, 5000),
  );
  let result = await watchPrToTerminal(watchArgs);
  let retries = 0;
  let prResolvable;
  while (result.requiredChecksEmpty) {
    prResolvable = await probePrResolvable();
    if (!prResolvable) break;
    if (retries >= maxRetries || nowMsFn() >= deadline) break;
    retries += 1;
    logger?.warn?.(
      `[pr-watch] no required context has attached yet (${result.error}) — the pull request reads ` +
        'back fine, so this is CI that has not started; re-resolving the required set within the ' +
        `${Math.round(attachWindowMs / 1000)}s attach window (attempt ${retries}).`,
    );
    await sleepFn(retryIntervalMs);
    result = await watchPrToTerminal(watchArgs);
  }
  return {
    ...result,
    attachRetries: retries,
    ...(result.requiredChecksEmpty
      ? { prResolvable: Boolean(prResolvable) }
      : {}),
  };
}

function parsePositiveInt(raw, fallback) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve poll knobs: a nullish or malformed flag falls back to
 * {@link WATCH_DEFAULTS}.
 *
 * @param {object} opts
 * @param {object} [opts.flags]
 * @returns {{ pollIntervalMs: number, maxPolls: number, maxResumes: number, maxUpdates: number, attachWindowMs: number }}
 */
export function resolveWatchKnobs({ flags = {} } = {}) {
  const knobs = {};
  for (const [key, fallback] of Object.entries(WATCH_DEFAULTS)) {
    knobs[key] = parsePositiveInt(flags[key], fallback);
  }
  return knobs;
}

/** Default re-arm: the sanctioned auto-merge enablement path. */
function defaultReArm({ cwd, prNumber }) {
  return enableAutoMergeWith({ cwd, prNumber });
}

/**
 * Red path: disarm auto-merge FIRST (the race-free moment), then record the
 * digest keyed to the red head SHA. A disarm failure blocks — an armed PR
 * merges the instant a re-run turns it green.
 *
 * @returns {Promise<{ headSha: string|null, disarm: object, digestPaths: object|null, blocked: boolean }>}
 */
async function handleRedWatch({
  storyId,
  prNumber,
  prRef,
  failures,
  tempRoot,
  cwd,
  writeDigestFn,
  headShaFn,
  disarmFn,
  blockFn,
  logger,
}) {
  const disarm = await disarmFn({ prRef });
  const scope = resolveDigestScope({ storyId });
  const headSha = scope ? headShaFn({ prRef, cwd }) : null;
  let digestPaths = null;
  try {
    digestPaths = writeDigestFn({
      storyId,
      prNumber,
      headSha,
      failures,
      tempRoot,
      cwd,
      prRef,
    });
  } catch (err) {
    logger.warn?.(
      `[pr-watch] failed to write CI digest (non-fatal): ${err?.message ?? err}`,
    );
  }
  let blocked = false;
  if (!disarm.disarmed) {
    logger.error?.(
      `[pr-watch] BLOCKER: auto-merge could NOT be disarmed on PR #${prNumber} (${disarm.detail}). ` +
        'An armed PR can merge the moment a re-run turns it green — the no-rerun rule cannot be enforced.',
    );
    const outcome = await blockFn({
      storyId,
      body: [
        '### Auto-merge could not be disarmed after a red check — delivery blocked',
        '',
        `A required check went red on PR #${prNumber}, but disarming native auto-merge failed:`,
        '',
        `> ${disarm.detail}`,
        '',
        'While the PR stays armed, GitHub can merge it server-side the instant the',
        'checks read green — including a green reached by re-running the failed job,',
        'which `.agents/rules/ci-remediation.md` § Verifier forbids. Disarm the PR by',
        'hand (or fix the `gh` fault), then resume the delivery.',
      ].join('\n'),
    });
    blocked = Boolean(outcome?.blocked);
  } else {
    logger.error?.(
      `[pr-watch] native auto-merge ${disarm.alreadyUnarmed ? 'was already un-armed' : 'DISARMED'} on PR #${prNumber} — ` +
        'it is re-armed only by a green on a NEW head SHA.',
    );
  }
  if (digestPaths) {
    logger.error?.(`[pr-watch] CI failure digest → ${digestPaths.jsonPath}`);
  }
  return { headSha, disarm, digestPaths, blocked };
}

/**
 * Green path: adjudicate the green against any recorded red digest.
 *
 * @returns {Promise<{ verdict: string, reason: string, exitCode: number, headSha: string|null, reArmed?: boolean, blocked?: boolean }>}
 */
async function evaluateGreenWatch({
  storyId,
  prNumber,
  prRef,
  tempRoot,
  cwd,
  readDigestFn,
  retireDigestFn,
  headShaFn,
  reArmFn,
  blockFn,
  logger,
}) {
  const scope = resolveDigestScope({ storyId });
  if (!scope) {
    return {
      verdict: 'clean',
      reason: 'no --story scope: no digest can be keyed, guard inert',
      exitCode: 0,
      headSha: null,
    };
  }
  const digest = readDigestFn({ storyId, tempRoot, cwd });
  if (!digest) {
    return {
      verdict: 'clean',
      reason: 'no digest for this scope: this delivery never went red',
      exitCode: 0,
      headSha: null,
    };
  }
  const headSha = headShaFn({ prRef, cwd });
  const { verdict, reason } = classifyGreenVerdict({ digest, headSha });
  if (verdict === 'fix-at-source' || verdict === 'rerun-permitted') {
    // `rerun-permitted`: `file-ci-gap.js` proved a capacity/unreproducible
    // verdict for THIS head. Retiring the digest spends the one allowance.
    retireDigestFn({ storyId, tempRoot, cwd });
    const reArm = await reArmFn({ cwd, prNumber });
    const reArmed = Boolean(reArm?.enabled);
    logger.info?.(
      `[pr-watch] ${verdict === 'rerun-permitted' ? 'green admitted on the SAME head SHA' : 'green on a NEW head SHA'} ` +
        `(${reason}) — digest retired, ` +
        `auto-merge ${reArmed ? 're-armed' : `NOT re-armed (${reArm?.reason ?? 'unknown'})`}.`,
    );
    return { verdict, reason, exitCode: 0, headSha, reArmed };
  }
  const body = formatRerunViolation({ digest, headSha, prNumber, reason });
  logger.error?.(
    `[pr-watch] FORBIDDEN CI RE-RUN: ${reason}. Required check \`${digest.failingCheck}\` was red on this exact commit.`,
  );
  logger.error?.(
    `[pr-watch] run link: ${digest.runUrl ?? `run id ${digest.runId ?? 'unresolved'}`} — classification: ${digest.classification ?? 'unknown'}`,
  );
  logger.error?.(
    '[pr-watch] fix the root cause and push a new commit, or — when the root cause is outside this delivery — run `node .agents/scripts/file-ci-gap.js --story <id> --verdict <verdict> --owner <bucket> --block` to file the routed, deduped intake issue.',
  );
  const outcome = await blockFn({ storyId, body });
  return {
    verdict,
    reason,
    exitCode: 1,
    headSha,
    blocked: Boolean(outcome?.blocked),
  };
}

/**
 * A broken `.agentrc` degrades to defaults rather than aborting the watch.
 *
 * @param {{ config?: object, tempRoot?: string, logger: object, flags: object }} params
 * @returns {{ knobs: object, effectiveTempRoot: string, cwd: string }}
 */
function resolveWatchContext({ config, tempRoot, logger, flags }) {
  const resolvedConfig =
    config !== undefined ? config : safeResolveConfig(logger);
  const knobs = resolveWatchKnobs({ flags });
  const effectiveTempRoot =
    tempRoot ?? resolvedConfig?.project?.paths?.tempRoot ?? 'temp';
  return { knobs, effectiveTempRoot, cwd: process.cwd() };
}

/**
 * Ports are spread in only when supplied so the watch keeps its own defaults.
 *
 * @param {object} params
 * @returns {object}
 */
function buildWatchArgs({
  prRef,
  repo,
  cwd,
  knobs,
  ghPrChecksFn,
  ghPrViewFn,
  ghPrUpdateBranchFn,
  sleepFn,
  logger,
}) {
  return {
    prUrl: prRef,
    repo,
    cwd,
    maxPolls: knobs.maxPolls,
    maxUpdates: knobs.maxUpdates,
    maxResumes: knobs.maxResumes,
    pollIntervalMs: knobs.pollIntervalMs,
    ...(ghPrChecksFn ? { ghPrChecksFn } : {}),
    ...(ghPrViewFn ? { ghPrViewFn } : {}),
    ...(ghPrUpdateBranchFn ? { ghPrUpdateBranchFn } : {}),
    ...(sleepFn ? { sleepFn } : {}),
    logger,
  };
}

/**
 * No required check attached (slow, exit 2) vs. unreadable PR (`gh` fault,
 * exit 1).
 *
 * @param {object} params
 * @returns {number} exit code
 */
function reportUnattachedOrError({
  result,
  envelope,
  prNumber,
  knobs,
  logger,
  print,
}) {
  const notYetStarted = Boolean(
    result.requiredChecksEmpty && result.prResolvable,
  );
  print(
    JSON.stringify({
      ...envelope,
      requiredChecksEmpty: Boolean(result.requiredChecksEmpty),
      notYetStarted,
    }),
  );
  if (notYetStarted) {
    logger.warn?.(
      `[pr-watch] no required check has attached to PR #${prNumber} within the ` +
        `${Math.round(knobs.attachWindowMs / 1000)}s attach window (${result.attachRetries} re-resolutions), ` +
        'and the pull request still reads back fine — this is CI that has not started, NOT a red check. ' +
        'Keep polling natively:',
    );
    logger.warn?.('[pr-watch]   gh pr checks <pr> --watch');
    return STILL_RUNNING_EXIT_CODE;
  }
  logger.error?.(
    `[pr-watch] could not resolve required checks: ${result.error} — the pull request itself could ` +
      'not be read, so this is a `gh` / access fault rather than CI that has not started.',
  );
  return 1;
}

/**
 * Settle an all-green watch. The observed set is from the FIRST probe and may
 * undercount, so an unreconcilable set exits 2 rather than a false green.
 *
 * @param {object} params
 * @returns {Promise<number>} exit code
 */
async function settleGreenWatch({
  result,
  envelope,
  readMergeState,
  storyId,
  prNumber,
  guardPrRef,
  effectiveTempRoot,
  cwd,
  readDigestFn,
  retireDigestFn,
  headShaFn,
  reArmAutoMergeFn,
  blockDeliveryFn,
  logger,
  print,
}) {
  const reconciliation = reconcileGreenVerdict({
    observedRequired: result.requiredChecks,
    mergeStateStatus: await readMergeState(),
  });
  if (!reconciliation.reconciled) {
    print(JSON.stringify({ ...envelope, reconciliation }));
    logger.warn?.(
      `[pr-watch] withholding the green verdict: ${reconciliation.reason}. ` +
        'Re-run the watch once the repository settles, or inspect branch protection for a context this watch never saw.',
    );
    return STILL_RUNNING_EXIT_CODE;
  }
  const guard = await evaluateGreenWatch({
    storyId,
    prNumber,
    prRef: guardPrRef,
    tempRoot: effectiveTempRoot,
    cwd,
    readDigestFn,
    retireDigestFn,
    headShaFn,
    reArmFn: reArmAutoMergeFn,
    blockFn: blockDeliveryFn,
    logger,
  });
  print(JSON.stringify({ ...envelope, reconciliation, rerunGuard: guard }));
  if (guard.exitCode === 0) {
    logger.info?.('[pr-watch] all required checks green.');
  }
  return guard.exitCode;
}

/**
 * Poll cap and resume budget exhausted, none red: hand off, exit 2.
 *
 * @param {object} params
 * @returns {number} exit code
 */
function reportStillRunning({ result, envelope, logger, print }) {
  print(JSON.stringify(envelope));
  const stillPending = Object.entries(result.outcomes)
    .filter(([, v]) => v === 'still-running')
    .map(([k]) => k)
    .join(', ');
  logger.warn?.(
    `[pr-watch] required check(s) still running after ${result.polls} polls + ${result.resumesApplied} resumes: ${stillPending}. Keep polling natively:`,
  );
  logger.warn?.('[pr-watch]   gh pr checks <pr> --watch');
  return STILL_RUNNING_EXIT_CODE;
}

/**
 * Failing checks. `still-running` is excluded: it is slow, not red, and would
 * otherwise become the digest's primary failing check.
 *
 * @param {Record<string, string>} outcomes
 * @returns {Array<{ name: string, outcome: string }>}
 */
function collectFailures(outcomes) {
  return Object.entries(outcomes)
    .filter(
      ([, v]) =>
        v !== 'success' &&
        v !== 'neutral' &&
        v !== 'skipped' &&
        v !== 'still-running',
    )
    .map(([name, outcome]) => ({ name, outcome }));
}

/**
 * @param {object} params
 * @returns {Promise<number>} exit code
 */
async function settleRedWatch({
  result,
  envelope,
  storyId,
  prNumber,
  guardPrRef,
  effectiveTempRoot,
  cwd,
  writeDigestFn,
  headShaFn,
  disarmAutoMergeFn,
  blockDeliveryFn,
  logger,
  print,
}) {
  const failures = collectFailures(result.outcomes);
  const red = failures.map((f) => `${f.name}=${f.outcome}`).join(', ');
  logger.error?.(`[pr-watch] required check(s) not green: ${red}`);
  const redOutcome = await handleRedWatch({
    storyId,
    prNumber,
    prRef: guardPrRef,
    failures,
    tempRoot: effectiveTempRoot,
    cwd,
    writeDigestFn,
    headShaFn,
    disarmFn: disarmAutoMergeFn,
    blockFn: blockDeliveryFn,
    logger,
  });
  print(
    JSON.stringify({
      ...envelope,
      classification: classifyFailure(failures[0]?.name),
      rerunGuard: {
        verdict: 'red',
        headSha: redOutcome.headSha,
        autoMergeDisarmed: redOutcome.disarm.disarmed,
        disarmDetail: redOutcome.disarm.detail,
        digestPath: redOutcome.digestPaths?.jsonPath ?? null,
        blocked: redOutcome.blocked,
      },
    }),
  );
  logger.error?.(
    '[pr-watch] a required check failed. Read the digest, reproduce the failure, and apply the smallest fix at source, ' +
      'then push a new commit — re-running the failed job is forbidden (`.agents/rules/ci-remediation.md` § Verifier).',
  );
  return 1;
}

/**
 * Run the watch and resolve to the exit code: 0 green (guard cleared);
 * 1 red, forbidden same-SHA re-run, or unreadable PR; 2 slow-but-not-red
 * (still running, unreconcilable green, or no context attached in the window).
 *
 * @param {object} opts
 * @param {number} opts.prNumber
 * @param {string|null} [opts.repo]
 * @param {number|string} [opts.maxUpdates]
 * @param {number|string} [opts.pollIntervalMs]
 * @param {number|string} [opts.maxPolls]
 * @param {number|string} [opts.maxResumes]
 * @param {number|string} [opts.attachWindowMs]
 * @param {object|null} [opts.config]
 * @param {string} [opts.tempRoot]
 * @param {Function} [opts.ghPrChecksFn]
 * @param {Function} [opts.ghPrViewFn]
 * @param {Function} [opts.ghPrUpdateBranchFn]
 * @param {Function} [opts.sleepFn]
 * @param {Function} [opts.writeDigestFn]
 * @param {Function} [opts.readDigestFn]
 * @param {Function} [opts.retireDigestFn]
 * @param {Function} [opts.headShaFn]
 * @param {Function} [opts.disarmAutoMergeFn]
 * @param {Function} [opts.reArmAutoMergeFn]
 * @param {Function} [opts.blockDeliveryFn]
 * @param {object} [opts.logger]
 * @param {(line: string) => void} [opts.print]
 * @returns {Promise<number>}
 */
export async function runPrWatch({
  prNumber,
  repo = null,
  storyId = null,
  maxUpdates,
  pollIntervalMs,
  maxPolls,
  maxResumes,
  config,
  tempRoot,
  ghPrChecksFn,
  ghPrViewFn,
  ghPrUpdateBranchFn,
  sleepFn,
  writeDigestFn = writeCiDigest,
  readDigestFn = readCiDigest,
  retireDigestFn = retireCiDigest,
  headShaFn = resolvePrHeadSha,
  disarmAutoMergeFn = disarmAutoMerge,
  reArmAutoMergeFn = defaultReArm,
  blockDeliveryFn = blockStoryDelivery,
  mergeStateProbeFn,
  attachWindowMs,
  nowMsFn = Date.now,
  logger = Logger,
  print = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (!Number.isInteger(prNumber) || prNumber < 1)
    throw new TypeError('runPrWatch: --pr requires a positive integer');

  const { knobs, effectiveTempRoot, cwd } = resolveWatchContext({
    config,
    tempRoot,
    logger,
    flags: { pollIntervalMs, maxPolls, maxResumes, maxUpdates, attachWindowMs },
  });

  // `gh` parses `<owner/repo>#<n>` as a branch name, so the repo travels as a
  // `--repo` flag on watch ports and as a PR URL for the guard helpers.
  const prRef = String(prNumber);
  const guardPrRef = repo
    ? `https://github.com/${repo}/pull/${prNumber}`
    : prRef;

  const probeMergeState =
    mergeStateProbeFn ??
    (ghPrViewFn ? mergeStateProbeFromView(ghPrViewFn) : defaultMergeStateProbe);
  const readMergeState = () =>
    probeMergeState({ prRef: guardPrRef, prUrl: prRef, repo, cwd, prNumber });

  const result = await watchWithAttachWindow({
    watchArgs: buildWatchArgs({
      prRef,
      repo,
      cwd,
      knobs,
      ghPrChecksFn,
      ghPrViewFn,
      ghPrUpdateBranchFn,
      sleepFn,
      logger,
    }),
    attachWindowMs: knobs.attachWindowMs,
    retryIntervalMs: knobs.pollIntervalMs,
    sleepFn: sleepFn ?? defaultSleep,
    nowMsFn,
    probePrResolvable: async () => (await readMergeState()) !== null,
    logger,
  });

  const envelope = {
    prNumber,
    checkOutcomes: result.outcomes,
    requiredChecks: result.requiredChecks,
    polls: result.polls,
    updatesApplied: result.updatesApplied,
    resumesApplied: result.resumesApplied,
    terminal: result.terminal,
    green: result.green,
    stillRunning: result.stillRunning,
    ...(result.attachRetries ? { attachRetries: result.attachRetries } : {}),
    ...(result.error ? { error: result.error } : {}),
  };

  if (result.requiredChecksEmpty || result.error) {
    return reportUnattachedOrError({
      result,
      envelope,
      prNumber,
      knobs,
      logger,
      print,
    });
  }

  if (result.green) {
    return await settleGreenWatch({
      result,
      envelope,
      readMergeState,
      storyId,
      prNumber,
      guardPrRef,
      effectiveTempRoot,
      cwd,
      readDigestFn,
      retireDigestFn,
      headShaFn,
      reArmAutoMergeFn,
      blockDeliveryFn,
      logger,
      print,
    });
  }

  if (result.stillRunning) {
    return reportStillRunning({ result, envelope, logger, print });
  }

  return await settleRedWatch({
    result,
    envelope,
    storyId,
    prNumber,
    guardPrRef,
    effectiveTempRoot,
    cwd,
    writeDigestFn,
    headShaFn,
    disarmAutoMergeFn,
    blockDeliveryFn,
    logger,
    print,
  });
}

/** Resolve config without letting a config error abort the watch. */
function safeResolveConfig(logger) {
  try {
    return resolveConfig();
  } catch (err) {
    logger?.warn?.(
      `[pr-watch] config resolve failed; using framework watch defaults: ${err?.message ?? err}`,
    );
    return null;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      pr: { type: 'string' },
      repo: { type: 'string' },
      story: { type: 'string' },
      'max-updates': { type: 'string' },
      'poll-interval-ms': { type: 'string' },
      'max-polls': { type: 'string' },
      'max-resumes': { type: 'string' },
      'attach-window-ms': { type: 'string' },
    },
    strict: false,
  });
  return runPrWatch({
    prNumber: Number.parseInt(values.pr ?? '', 10),
    repo: values.repo ?? null,
    storyId: values.story ?? null,
    maxUpdates: values['max-updates'],
    pollIntervalMs: values['poll-interval-ms'],
    maxPolls: values['max-polls'],
    maxResumes: values['max-resumes'],
    attachWindowMs: values['attach-window-ms'],
  });
}

runAsCli(import.meta.url, main, {
  source: 'pr-watch-with-update',
  propagateExitCode: true,
});
