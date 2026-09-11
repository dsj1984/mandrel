#!/usr/bin/env node
/**
 * pr-watch-with-update.js — the single CI-watch mechanism for the Story
 * delivery path (`helpers/deliver-story.md` Step 4). Story #4358 retired
 * the bare `gh pr checks --watch` so every caller drives this one CLI.
 *
 * Polls the PR's required checks to a terminal state and auto-recovers
 * from `mergeStateStatus: BEHIND` (via bounded `gh pr update-branch`
 * calls) by delegating to the `watchPrToTerminal` primitive in
 * `lib/orchestration/pr-watch.js`. That primitive was shared with the
 * `Watcher` bus listener until Story #5006 deleted it (nothing emitted at
 * it); this CLI is now its only caller. Story #5024 retired the bus
 * outright, so there is no bus to create — this is a direct, synchronous
 * watch with a real exit code.
 *
 * Slow-vs-failed semantics (Story #4358):
 *   - GREEN — every required check terminal + green → exit 0, unless the
 *             no-rerun guard says otherwise (below).
 *   - RED   — one or more required checks genuinely failed → exit 1
 *             IMMEDIATELY, consuming no resume budget. On red the CLI
 *             disarms native auto-merge and writes
 *             `temp/story-<id>-ci-digest.{json,md}` (failing check name,
 *             head SHA, run id + run link, a `gh run view --log-failed`
 *             tail, and a coarse classification). The digest is scoped by
 *             filename, so it requires `--story` (Story #4539: the digest
 *             was Epic-scoped and therefore never written on the only
 *             delivery path v2 has).
 *   - STILL-RUNNING — the poll cap fired with checks still pending and
 *             none failed; the watcher re-armed up to
 *             `delivery.ci.watch.maxResumes` times, then returned a
 *             `still-running` verdict → exit 2 (NEVER 1, NEVER
 *             `timed_out`). The CLI prints the `gh pr checks --watch`
 *             handoff so the host can keep polling on its own cadence.
 *   - UNRESOLVED — every observed required check is green but the observed
 *             set does not reconcile with the repository's own verdict
 *             (Story #4873) → exit 2, same "keep watching" semantics as
 *             still-running. Withholding is the point: this watcher has
 *             reported green on a PR GitHub was reporting as BLOCKED.
 *   - NOT-YET-STARTED — the attach window was spent and NO required context
 *             ever attached, while the pull request itself kept reading back
 *             fine (Story #4890) → exit 2, the same "keep watching"
 *             semantics. This used to map onto the red exit code, which
 *             misroutes the caller twice over: the module reserves exit 1 for
 *             a required check that GENUINELY FAILED, and the red path writes
 *             a CI digest naming the failing check — so a caller routed onto
 *             it by a set that was merely empty found nothing to read. A
 *             still-empty required set is a slow condition, and the module
 *             already models slow as exit 2. A `gh` fault the PR probe cannot
 *             see past is still exit 1.
 *
 * Two GitHub oracles are deliberately not trusted on a single reading
 * (Story #4873). An EMPTY `gh pr checks --required` probe is re-resolved
 * within {@link REQUIRED_CONTEXT_ATTACH_WINDOW_MS} before it is believed —
 * a ruleset attaches its required contexts asynchronously, and a required
 * context that is an aggregator job gated on every other tier is by
 * construction the LAST to appear (#4890 measured 16m52s), so a watch launched
 * right after `gh pr create` used to fail a delivery whose CI had not been
 * asked to start yet. And a GREEN verdict is issued only after
 * {@link reconcileGreenVerdict} confirms the repository agrees; an
 * unreconcilable set reports unresolved instead of green.
 *
 * No-rerun enforcement (Story #4865). `rules/ci-remediation.md` § Verifier
 * forbids re-running a failed job to reach green; this CLI is the point
 * that enforces it. Enforcement acts on the **first red** — GitHub's native
 * auto-merge fires server-side and races any post-green detection, so a
 * green can already have merged by the time it is observed. On red the
 * watcher disarms auto-merge and records the head SHA; on green it reads
 * the digest and adjudicates: a green on the SAME head SHA is a forbidden
 * re-run (exit 1, `agent::blocked`, a `file-ci-gap.js` intake filing
 *             required), while
 * a green on a NEW head SHA is a fix at source — the digest is retired,
 * auto-merge is re-armed, and the delivery proceeds. A delivery that never
 * went red has no digest and is untouched. Mechanism:
 * `lib/orchestration/ci-rerun-guard.js`.
 *
 * Config (Story #4356 namespace, read via `getCiDelivery`):
 *   - `delivery.ci.watch.pollIntervalMs`
 *   - `delivery.ci.watch.maxPolls`
 *   - `delivery.ci.watch.maxResumes`
 *   - `delivery.ci.watch.attachWindowMs` (Story #4890)
 *   CLI flags override config; config overrides the framework fallback.
 *
 * Usage:
 *   node .agents/scripts/pr-watch-with-update.js --pr <n> --story <id>
 *     [--repo owner/repo] [--max-updates N] [--poll-interval-ms MS]
 *     [--max-polls N] [--max-resumes N] [--attach-window-ms MS]
 */
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { getCiDelivery } from './lib/config/ci.js';
import { resolveConfig } from './lib/config-resolver.js';
import { gh as defaultGh } from './lib/gh-exec.js';
import { Logger } from './lib/Logger.js';
import {
  blockStoryDelivery,
  classifyFailure,
  classifyGreenVerdict,
  disarmAutoMerge,
  formatRerunViolation,
  readCiDigest,
  resolveDigestScope,
  resolvePrHeadSha,
  retireCiDigest,
  writeCiDigest,
} from './lib/orchestration/ci-rerun-guard.js';
import { watchPrToTerminal } from './lib/orchestration/pr-watch.js';
import { enableAutoMergeWith } from './lib/orchestration/single-story-close/phases/auto-merge.js';
import { sleep as defaultSleep } from './lib/util/poll-loop.js';

/** Exit code reserved for the slow-but-not-red `still-running` verdict. */
export const STILL_RUNNING_EXIT_CODE = 2;

/**
 * How long a probe that resolved NO required contexts keeps being retried
 * before the watch stops waiting for one (Stories #4873, #4890).
 *
 * A repository ruleset attaches its required contexts to a pull request
 * asynchronously, and the arrival latency is set by the SLOWEST context in the
 * set. Story #4873 measured tens of seconds on a cold repo and calibrated the
 * window at 90s; #4890 measured **16m52s** on this repository, because its
 * required context is an aggregator job gated on every other tier and is
 * therefore, by construction, the last check to appear. A 90s window still
 * exhausted, so the watch still aborted on a PR whose CI was working exactly
 * as designed.
 *
 * The default therefore covers a late aggregator with margin rather than a
 * fast ruleset, and it is operator-tunable on the `delivery.ci.watch.*` ladder
 * (`attachWindowMs`) for a repository whose contexts arrive on a different
 * cadence. Spending the window costs nothing but wall-clock on a PR nobody
 * could merge yet; exhausting it too early costs the whole delivery.
 */
export const REQUIRED_CONTEXT_ATTACH_WINDOW_MS = 1_200_000;

/** Framework fallbacks when neither a CLI flag nor config supplies a value. */
export const WATCH_DEFAULTS = Object.freeze({
  pollIntervalMs: 10_000,
  maxPolls: 180,
  maxUpdates: 3,
  maxResumes: 3,
  attachWindowMs: REQUIRED_CONTEXT_ATTACH_WINDOW_MS,
});

/**
 * Merge-state values that reconcile an observed all-green required set with
 * the repository's own view of the pull request (Story #4873).
 *
 * `BLOCKED` is the measured false-green: the watcher's `gh pr checks
 * --required` set came back SMALLER than branch protection's — a context
 * attached after the first probe, so it was never in `requiredChecks` — every
 * check the watcher knew about was green, and it reported green while GitHub
 * still refused the merge. `UNKNOWN` / an unreadable probe is not a
 * reconciliation either: it is the absence of the second opinion, and a green
 * verdict is exactly the verdict that must not be issued on absent evidence.
 */
const RECONCILED_MERGE_STATES = Object.freeze(
  new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BEHIND', 'DRAFT']),
);

/**
 * Does an observed-green required set reconcile with the repository's own
 * verdict on the PR? Pure — exported so the rule is reviewable as code.
 *
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

/**
 * Adapt the watch loop's own `ghPrViewFn` port — which already spawns
 * `gh pr view --json mergeStateStatus` for BEHIND recovery — into the
 * reconciliation probe, so a caller that injected one port does not have to
 * inject a second for the same `gh` call.
 */
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
 * Run the watch, re-resolving a required-check set that came back EMPTY until
 * the attach window is spent (Stories #4873 AC-3, #4890 AC-1). Every other
 * terminal — green, red, still-running — returns on the first arm exactly as
 * before.
 *
 * Re-arming the whole call is what makes convergence possible: the required
 * check NAMES are resolved once per `watchPrToTerminal` call, so a context that
 * attaches minutes later is only ever seen by a fresh call.
 *
 * `probePrResolvable` is the **structural** classifier, re-read every round: a
 * required set that is empty while the pull request itself reads back fine is
 * CI that has not started, so the window is worth spending; a pull request that
 * does not read back at all is a `gh` fault, so the window is not spent on it
 * and the caller reports the failure immediately. `gh` overloads its exit code
 * across both conditions, and this deliberately does not fall back to matching
 * its stderr prose — a human-readable string is not a classification contract.
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
  // The window is wall-clock, but the retry count is also capped: a caller
  // running with a zero poll interval (every unit test, and a config that
  // sets one) would otherwise spin the window out as a tight loop. Flooring
  // the assumed cadence at 5s bounds the attempts without changing the
  // wall-clock bound that governs a real watch.
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
 * Resolve the effective poll knobs: CLI flag → `delivery.ci.watch.*` →
 * framework fallback. Pure (given a config bag) — exported for tests so
 * the precedence ladder is reviewable. `flags` are the raw string values
 * from `parseArgs` (or numbers, in tests); a nullish flag falls through
 * to config, and a nullish config field falls through to the default.
 *
 * @param {object} opts
 * @param {object|null} [opts.config]  resolved config (or a bare bag).
 * @param {object} [opts.flags]        `{ pollIntervalMs, maxPolls, maxResumes, maxUpdates, attachWindowMs }`.
 * @returns {{ pollIntervalMs: number, maxPolls: number, maxResumes: number, maxUpdates: number, attachWindowMs: number }}
 */
export function resolveWatchKnobs({ config, flags = {} } = {}) {
  const watch = getCiDelivery(config).watch ?? {};
  const pick = (flag, cfg, dflt) =>
    parsePositiveInt(flag, Number.isInteger(cfg) && cfg >= 0 ? cfg : dflt);
  return {
    pollIntervalMs: pick(
      flags.pollIntervalMs,
      watch.pollIntervalMs,
      WATCH_DEFAULTS.pollIntervalMs,
    ),
    maxPolls: pick(flags.maxPolls, watch.maxPolls, WATCH_DEFAULTS.maxPolls),
    maxResumes: pick(
      flags.maxResumes,
      watch.maxResumes,
      WATCH_DEFAULTS.maxResumes,
    ),
    maxUpdates: pick(flags.maxUpdates, undefined, WATCH_DEFAULTS.maxUpdates),
    attachWindowMs: pick(
      flags.attachWindowMs,
      watch.attachWindowMs,
      WATCH_DEFAULTS.attachWindowMs,
    ),
  };
}

/** Default re-arm: the sanctioned auto-merge enablement path. */
function defaultReArm({ cwd, prNumber }) {
  return enableAutoMergeWith({ cwd, prNumber });
}

/**
 * Red path (Story #4865). Disarm native auto-merge FIRST — that is the
 * race-free moment, before any green can exist — then record the digest so
 * the green path can adjudicate against the head SHA the red happened on.
 *
 * A disarm failure is a **blocker**, not a warning: an armed PR whose
 * required check went red can still be merged by GitHub the instant a
 * re-run turns it green, which is precisely what this guard exists to stop.
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
  const disarm = disarmFn({ prRef, cwd });
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
 * Green path (Story #4865). Adjudicate the green against any digest the
 * scope recorded, and return the exit code with the report the caller
 * prints.
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
  if (verdict === 'fix-at-source') {
    retireDigestFn({ storyId, tempRoot, cwd });
    const reArm = await reArmFn({ cwd, prNumber });
    const reArmed = Boolean(reArm?.enabled);
    logger.info?.(
      `[pr-watch] green on a NEW head SHA (${reason}) — fix at source; digest retired, ` +
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
 * Resolve the knobs, temp root and working directory one watch run needs.
 *
 * Split out of `runPrWatch` because config resolution must not abort the
 * watch: a broken `.agentrc` should degrade to defaults, not turn a CI probe
 * into a crash.
 *
 * @param {{ config?: object, tempRoot?: string, logger: object, flags: object }} params
 * @returns {{ knobs: object, effectiveTempRoot: string, cwd: string }}
 */
function resolveWatchContext({ config, tempRoot, logger, flags }) {
  const resolvedConfig =
    config !== undefined ? config : safeResolveConfig(logger);
  const knobs = resolveWatchKnobs({ config: resolvedConfig, flags });
  const effectiveTempRoot =
    tempRoot ?? resolvedConfig?.project?.paths?.tempRoot ?? 'temp';
  return { knobs, effectiveTempRoot, cwd: process.cwd() };
}

/**
 * Build the argument bag for the underlying watch port.
 *
 * Each injectable port is spread in only when supplied so the port keeps its
 * own default — passing `undefined` explicitly would override a default with
 * nothing and break every caller that relies on it.
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
 * One terminal outcome of the watch: the attach window is spent and no
 * required check ever attached, or the pull request could not be read at all.
 *
 * The two are distinguished structurally — never against `gh`'s stderr prose
 * (Story #4890) — because they route oppositely: CI that has not started is
 * slow (exit 2, keep watching), while an unreadable PR is a `gh` / access
 * fault (exit 1).
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
 * Settle a watch whose observed required checks all came back green.
 *
 * Never green on an undercount (Story #4873): the observed set is whatever
 * `gh pr checks --required` returned on the FIRST probe, so a context a
 * ruleset attached later can leave every check we knew about green while
 * GitHub still refuses the merge. An unreconcilable set reports unresolved
 * (exit 2, keep watching) rather than a false green or a false red.
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
 * Slow-but-not-red: the poll cap AND the resume budget are exhausted with
 * checks still pending and none failed. Never exit 1, never `timed_out` —
 * hand off to the host's interval loop and exit 2.
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
 * The failing checks, excluding every non-failing state **and**
 * `still-running`: when the cap fires with a mixed failed+pending map,
 * `promotePendingToStillRunning` has rewritten the pending entries, and a
 * still-running check is slow, not red — including it here would let it become
 * the digest's "primary" failing check and mispoint the diagnosis.
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
 * Genuine red check — exit 1 immediately, disarm auto-merge, write the digest,
 * and surface the fix-loop handoff.
 *
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
 * Run the watch loop and resolve to the exit code. Exported for tests so
 * the green / red / still-running / BEHIND paths can be exercised with
 * injected `gh` spawns and no `process.exit`.
 *
 *   0 → all required checks green (and the no-rerun guard cleared them).
 *   1 → a required check genuinely failed (red), OR the green was reached
 *       by a forbidden re-run of the same commit, OR the pull request itself
 *       could not be read (a `gh` / access fault).
 *   2 → slow-but-not-red: still-running (cap + resume budget exhausted, none
 *       red), an unreconcilable green, or no required context attached within
 *       the attach window while the PR kept reading back fine (#4890).
 *
 * @param {object} opts
 * @param {number} opts.prNumber
 * @param {string|null} [opts.repo]           `owner/repo`; passed to `gh` as `--repo`.
 * @param {number|string} [opts.maxUpdates]
 * @param {number|string} [opts.pollIntervalMs]
 * @param {number|string} [opts.maxPolls]
 * @param {number|string} [opts.maxResumes]
 * @param {number|string} [opts.attachWindowMs] override the required-context
 *   attach window for one run (flag → `delivery.ci.watch.attachWindowMs` →
 *   {@link REQUIRED_CONTEXT_ATTACH_WINDOW_MS}).
 * @param {object|null} [opts.config]         resolved config (defaults to resolveConfig()).
 * @param {string} [opts.tempRoot]            digest output dir (default `temp`).
 * @param {Function} [opts.ghPrChecksFn]      inject for tests
 * @param {Function} [opts.ghPrViewFn]        inject for tests
 * @param {Function} [opts.ghPrUpdateBranchFn] inject for tests
 * @param {Function} [opts.sleepFn]           inject for tests
 * @param {Function} [opts.writeDigestFn]     inject for tests (default writeCiDigest)
 * @param {Function} [opts.readDigestFn]      inject for tests (default readCiDigest)
 * @param {Function} [opts.retireDigestFn]    inject for tests (default retireCiDigest)
 * @param {Function} [opts.headShaFn]         inject for tests (default resolvePrHeadSha)
 * @param {Function} [opts.disarmAutoMergeFn] inject for tests (default disarmAutoMerge)
 * @param {Function} [opts.reArmAutoMergeFn]  inject for tests (default enableAutoMergeWith)
 * @param {Function} [opts.blockDeliveryFn]   inject for tests (default blockStoryDelivery)
 * @param {object} [opts.logger]
 * @param {(line: string) => void} [opts.print] stdout sink (default process.stdout)
 * @returns {Promise<number>} process exit code.
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

  // `gh` has NO `<owner/repo>#<number>` argument form — it parses that string
  // as a BRANCH NAME, which is why every `--repo` invocation used to fail at
  // the first probe with a misleading `gh-checks-failed:status=1` (#4890). The
  // repository therefore travels two sanctioned ways, never as a composed ref:
  //   - a real `--repo` flag on the watch ports, which build their own argv;
  //   - a canonical PR URL for the no-rerun-guard helpers, which take a bare
  //     ref and no repository of their own.
  // With `--repo` omitted, `gh` infers the repository from the cwd's remote.
  const prRef = String(prNumber);
  const guardPrRef = repo
    ? `https://github.com/${repo}/pull/${prNumber}`
    : prRef;

  // One merge-state probe, resolved once and used for both readings that need
  // the repository's own view of the PR: the empty-required-set classification
  // below, and the green-verdict reconciliation further down.
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
    // Structural, not prose: the PR reads back ⇒ `gh` works and the empty
    // required set is CI that has not started yet.
    probePrResolvable: async () => (await readMergeState()) !== null,
    logger,
  });

  // Always print the final outcomes map so the operator (and the
  // workflow log) can see exactly which check blocked.
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
